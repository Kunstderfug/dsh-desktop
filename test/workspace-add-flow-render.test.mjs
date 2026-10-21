// Behavioral regression for the CMD+O / "+" directory-picker update spiral.
//
// Production defect (0.2.1-rc.2): clicking "+" (or CMD+O) made the whole
// project list vanish. Root cause: WorkspacePickFlow's auto-open effect
// depends on `openDirectoryFlow`, whose identity followed an inline `onClose`
// arrow at the call site, so every re-render re-armed the effect; combined
// with `closeAddWorkspace` allocating a new snapshot even when nothing
// changed, the effect reopened the directory flow repeatedly until React hit
// "Maximum update depth exceeded" (#185) and the slot host unmounted
// sidebar.workspaces.
//
// This test loads the real plugin bundle through `apply(ctx)` (fake ctx, real
// react/react-dom/jsdom, real @deepseek-ai/dsh-client-store and cordis),
// captures the registered sidebar.workspaces component plus its real injected
// record, renders it, clicks the "+" button, and asserts the deterministic
// post-fix guarantees:
//   - the directory flow opens exactly once per user action,
//   - closeAddWorkspace runs exactly once (no snapshot churn),
//   - nothing throws (no #185),
//   - the sidebar stays rendered,
//   - when the flow conversation ends by itself (host reports an error) the
//     browser does not re-open the flow on its own.
//
// Run against the pre-fix library with:
//   DSH_WORKSPACE_LIB=/tmp/client-before-fix.js npx vitest run <this file>
// to reproduce the pre-fix churn (fail-first evidence).

import { describe, expect, it } from "vitest"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import vm from "node:vm"
import path from "node:path"
import { JSDOM } from "jsdom"

const require = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const LIB_PATH =
  process.env.DSH_WORKSPACE_LIB ??
  path.join(REPO_ROOT, "node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js")

// ---------------------------------------------------------------------------
// jsdom globals must exist before React touches the DOM.
// ---------------------------------------------------------------------------

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
})
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
})) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const react = require("react")
const reactDomClient = require("react-dom/client")
const { jsx, jsxs } = require("react/jsx-runtime")
const { createSnapshotStore } = require("@deepseek-ai/dsh-client-store")

// ---------------------------------------------------------------------------
// Fake @deepseek-ai/dsh-client-ui-primitives: just enough surface for the
// workspace browser to render, with real <button> elements so clicks work.
// ---------------------------------------------------------------------------

function stubButton({ variant, ...rest }) {
  return jsx("button", { type: "button", ...rest })
}

function stubMenu({ open, items, onSelect }) {
  if (!open) return null
  return jsx(
    "div",
    { "data-menu-stub": true },
    (items ?? []).map((item) =>
      jsx(
        "button",
        { "data-menu-item": item.id, onClick: () => onSelect?.(item.id) },
        item.label,
      ),
    ),
  )
}

function stubModal({ open, title, children, footer }) {
  if (!open) return null
  return jsxs("div", { "data-modal-stub": true, "data-modal-title": title, children: [children, footer] })
}

const primitives = {
  Button: stubButton,
  Menu: stubMenu,
  MenuItemButton: stubButton,
  Modal: stubModal,
  Tooltip: ({ children }) => children,
  HoverCard: ({ children }) => children,
  HoverCardGroup: ({ children }) => children,
  StateDot: () => null,
  Toast: () => null,
  relativeTime: () => "",
  writeClipboard: () => {},
}
for (const key of [
  "IconArchiveCheckOutlineRegular", "IconArchiveOffOutlineRegular", "IconArchiveOutlineRegular",
  "IconBranchOutlineRegular", "IconChevronsUpDownOutlineRegular", "IconClockOutlineRegular",
  "IconCloseFillRegular", "IconCopyOutlineRegular", "IconEditOutlineRegular",
  "IconEllipsisOutlineRegular", "IconFlatListOutlineRegular", "IconFolderCloseRegular",
  "IconFolderOpenRegular", "IconNewChatOutlineRegular", "IconPinFillRegular",
  "IconPinOutlineRegular", "IconPlusOutlineRegular", "IconProjectAddOutlineRegular",
  "IconQueueOutlineRegular", "IconSearchOutlineRegular", "IconSlidersTwoOutlineRegular",
  "IconTrashOutlineRegular", "IconTriangleRightFillRegular", "IconUnarchiveOutlineRegular",
  "IconWarningOutlineRegular", "IconWorkspaceTreeOutlineRegular",
]) {
  primitives[key] = () => jsx("span", { "data-icon": key })
}

// ---------------------------------------------------------------------------
// Plugin loading: vm + fake __ModuleLoader__ + curated require map.
// ---------------------------------------------------------------------------

let cachedExports
async function loadPlugin() {
  if (cachedExports) return cachedExports
  const code = await readFile(LIB_PATH, "utf8")
  let moduleExports
  const loaderWindow = {
    __ModuleLoader__: {
      load({ factory }) {
        moduleExports = factory((name) => {
          switch (name) {
            case "react": return react
            case "react/jsx-runtime": return require("react/jsx-runtime")
            case "@deepseek-ai/dsh-client-store": return require("@deepseek-ai/dsh-client-store")
            case "@deepseek-ai/cordis": return require("@deepseek-ai/cordis")
            case "@deepseek-ai/dsh-client-ui-primitives": return primitives
            default: throw new Error(`unexpected require in workspace lib: ${name}`)
          }
        })
      },
    },
  }
  vm.runInNewContext(code, {
    window: loaderWindow,
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    console,
    localStorage: dom.window.localStorage,
    sessionStorage: dom.window.sessionStorage,
    navigator: dom.window.navigator,
  }, { filename: LIB_PATH })
  if (!moduleExports?.apply) throw new Error("workspace lib did not export apply")
  cachedExports = moduleExports
  return moduleExports
}

// ---------------------------------------------------------------------------
// Fake plugin context. Captures slot registrations; everything else is inert.
// ---------------------------------------------------------------------------

function createFakeCtx({ sessionsStore, workspacesStore }) {
  const registrations = []
  const effects = []
  const noopSubscribe = () => () => {}
  const ctx = {
    registrations,
    effects,
    get(name) {
      if (name === "sessions") return ctx.sessions
      if (name === "workspaces") return ctx.workspaces
      throw new Error(`fake ctx.get: unexpected service ${name}`)
    },
    effect(fn) {
      effects.push(fn)
      return () => {}
    },
    locale: {
      register() {},
      bind: () => (key) => key,
    },
    on: () => noopSubscribe,
    reflect: { provide() {} },
    layout: { panelInfo: { getSnapshot: () => ({ activePanelId: null }) } },
    remote: {
      $host: { home: "/tmp/dsh-test-home" },
      directoryPicker: {
        pick: async () => ({ ok: false, error: { code: "cancelled", message: "cancelled" } }),
      },
    },
    remoteAccess: { source: () => "test" },
    shortcuts: {
      register() {},
      catalog: { getSnapshot: () => [], subscribe: noopSubscribe },
    },
    slots: {
      provideRoot() {},
      registerFactory() {},
      register(decl, component) {
        registrations.push({ decl, component })
        return { dispose() {} }
      },
      inject(name, provider) {
        // The real slot host pulls each registration when the slot mounts.
        provider()
      },
      entries(hole) {
        return hole.includes("directoryFlow") ? [{}] : []
      },
      subscribe: () => noopSubscribe(),
    },
    sessions: {
      list: sessionsStore,
      searchResultLimit: 8,
      search: async () => ({ ok: false, error: { message: "unavailable" } }),
      using: async () => {
        throw new Error("not used in this test")
      },
    },
    workspaces: {
      list: workspacesStore,
      create: async () => {
        throw new Error("directory unavailable")
      },
      rename: async () => {},
      insertBefore: async () => {},
    },
  }
  return ctx
}

// ---------------------------------------------------------------------------
// Harness: apply(), capture the browser slot, render it, click "+".
// ---------------------------------------------------------------------------

function sourceHook(source) {
  return (selector) => react.useSyncExternalStore(
    source.subscribe,
    () => selector(source.getSnapshot()),
  )
}

async function mountBrowser({ autoCloseFlow }) {
  const plugin = await loadPlugin()
  const sessionsStore = createSnapshotStore({ ids: [], byId: {}, phase: "ready" })
  const workspacesStore = createSnapshotStore({
    items: [{ workspaceId: "ws-notes", title: "Notes", sessionIds: [] }],
    phase: "ready",
    state: "idle",
    pinnedSessionIds: [],
    archivedSessionIds: [],
  })
  const ctx = createFakeCtx({ sessionsStore, workspacesStore })
  plugin.apply(ctx)

  const browserEntry = ctx.registrations.find((entry) => entry.decl.name === "sidebar.workspaces")
  if (!browserEntry) throw new Error("sidebar.workspaces was not registered")
  const injected = browserEntry.decl.inject()

  // Counters on the exact wiring under test.
  const counters = { closeAdd: 0, requestAdd: 0, setDirectoryBusy: 0 }

  const flowOpenEpisodes = { count: 0 }
  const flowOwnerLog = []
  let lastOwnerOpen = false
  const renderSlotLog = []
  const renderSlot = (hole, owner) => {
    renderSlotLog.push({ hole, owner })
    if (renderSlotLog.length > 64) {
      // Pre-fix this loop re-rendered 50+ times per click (React #185 in
      // production). Fail fast instead of hanging when the spiral re-forms.
      throw new Error(
        `update spiral detected: ${renderSlotLog.length} slot renders after a single "+" click`,
      )
    }
    if (hole === "sidebar.workspaces.directoryFlow") {
      const open = Boolean(owner?.open)
      if (open && !lastOwnerOpen) flowOpenEpisodes.count += 1
      lastOwnerOpen = open
      flowOwnerLog.push(owner)
      return jsxs("div", {
        children: [
          jsx("div", { "data-slot-hole": hole, "data-owner-open": String(open) }),
          jsx(HostFlow, { owner }),
        ],
      })
    }
    return jsx("div", { "data-slot-hole": hole, "data-owner-open": String(Boolean(owner?.open)) })
  }

  // The host-side flow conversation: renders nothing while closed, and can
  // end itself (production: backend error / closed picker) via the owner
  // callbacks, which must not retrigger the auto-open.
  let autoCloseArmed = autoCloseFlow
  const HostFlow = ({ owner }) => {
    react.useEffect(() => {
      if (owner.open && autoCloseArmed) {
        autoCloseArmed = false
        owner.onError("directory unavailable")
      }
    })
    if (!owner.open) return null
    return jsx("div", { "data-host-flow": "open" })
  }

  const flowHoleStore = createSnapshotStore(true)
  const staticSource = (value) => ({ getSnapshot: () => value, subscribe: () => () => {} })
  const viewStore = createSnapshotStore({
    groupBy: "workspace",
    orderBy: "updated",
    groupExpansion: {},
    sessionOrderByAccount: {},
    unreadSessionIds: [],
    archivedFilter: "default",
  })

  const closeAddWorkspace = () => {
    counters.closeAdd += 1
    injected.closeAddWorkspace()
  }
  const requestAddWorkspace = () => {
    counters.requestAdd += 1
    injected.requestAddWorkspace()
  }
  const setDirectoryBusy = (busy) => {
    counters.setDirectoryBusy += 1
    injected.setDirectoryBusy(busy)
  }

  const actions = new Proxy(
    { setArchivedFilter() {}, markSessionUnread() {}, markSessionRead() {}, syncSessionOrders() {} },
    {
      get(target, key) {
        if (key in target) return target[key]
        return () => {}
      },
    },
  )

  const events = []
  const record = (name) => (...args) => {
    events.push({ name, args })
  }

  const usePanelInfo = () => undefined
  const Browser = (props) => browserEntry.component(props)

  const container = document.getElementById("root")
  const root = reactDomClient.createRoot(container)
  const props = {
    wide: false,
    usePanelInfo,
    expandSidebar: record("expandSidebar"),
    useSessions: sourceHook(sessionsStore),
    useSessionStatus: () => undefined,
    useWorkspaces: sourceHook(workspacesStore),
    useStore: sourceHook(viewStore),
    actions,
    startSession: record("startSession"),
    open: record("open"),
    requestSessionRename: injected.requestSessionRename,
    notifyArchivedNotOpenable: record("notifyArchivedNotOpenable"),
    renameWorkspace: async () => {},
    deleteWorkspace: async () => {},
    insertWorkspaceBefore: async () => {},
    unarchiveSession: async () => {},
    createWorkspace: async () => {
      throw new Error("directory unavailable")
    },
    searchSessions: async () => [],
    searchResultLimit: 8,
    isSessionVisible: () => true,
    isWorkspaceVisible: () => true,
    useDirectoryFlow: sourceHook(flowHoleStore),
    useHostInfo: sourceHook(staticSource({ home: "/tmp/dsh-test-home" })),
    useSessionVisibility: sourceHook(staticSource(0)),
    useWorkspaceVisibility: sourceHook(staticSource(0)),
    useShortcuts: sourceHook(staticSource([])),
    useWorkspaceShortcuts: sourceHook(injected.hooks.workspaceShortcuts),
    requestSearch: injected.requestSearch,
    requestAddWorkspace,
    closeAddWorkspace,
    setDirectoryBusy,
    dismissForkError: record("dismissForkError"),
    renderSlot,
    t: (key) => key,
  }

  await react.act(async () => {
    root.render(jsx(Browser, props))
    await Promise.resolve()
  })

  const addButton = () => container.querySelector("[data-dsh-workspace-add]")
  if (!addButton()) throw new Error("workspace add button did not render")

  await react.act(async () => {
    addButton().dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })

  return {
    container,
    counters,
    flowOpenEpisodes,
    flowOwnerLog,
    renderSlotLog,
    hostFlowPresent: () => Boolean(container.querySelector("[data-host-flow]")),
    sidebarIntact: () => Boolean(addButton()),
    errorModalOpen: () => Boolean(container.querySelector("[data-modal-stub]")),
    cleanup: async () => {
      await react.act(async () => {
        root.unmount()
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("workspace add flow renders without an update spiral", () => {
  it("opens the directory flow exactly once per click and keeps the sidebar", async () => {
    const harness = await mountBrowser({ autoCloseFlow: false })
    try {
      expect(harness.counters.requestAdd).toBe(1)
      expect(harness.flowOpenEpisodes.count).toBe(1)
      expect(harness.counters.closeAdd).toBe(1)
      expect(harness.hostFlowPresent()).toBe(true)
      expect(harness.sidebarIntact()).toBe(true)
      expect(harness.errorModalOpen()).toBe(false)
    } finally {
      await harness.cleanup()
    }
  })

  it("does not reopen the flow when the flow conversation ends by itself", async () => {
    const harness = await mountBrowser({ autoCloseFlow: true })
    try {
      expect(harness.flowOpenEpisodes.count).toBe(1)
      expect(harness.counters.closeAdd).toBe(1)
      expect(harness.errorModalOpen()).toBe(true)
      expect(harness.hostFlowPresent()).toBe(false)
      expect(harness.sidebarIntact()).toBe(true)
    } finally {
      await harness.cleanup()
    }
  })
})
