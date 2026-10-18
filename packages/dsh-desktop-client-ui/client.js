window.__ModuleLoader__.load({
  id: 'dsh-desktop-client-ui',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const {
      BrandWordmark,
      Button,
      FishLogo,
      IconBranchOutlineMedium,
      IconChevronDownOutlineMedium,
      IconPlusOutlineMedium,
      IconWarningOutlineMedium,
      Input,
      Menu,
      MenuItemButton,
      Modal,
      Toast
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    // Tight bounds of the mark inside its 1000x1000 source artwork.
    const BRAND_MARK_VIEWBOX = { x: 42, y: 218, width: 898, height: 564 }
    // DSH Desktop whale mark: a window with a tail, drawn in currentColor so
    // it follows the sidebar text color in both themes.
    const BRAND_MARK_PATH = "M478.318 218C605.318 218 683.318 287 687.318 404L691.318 472C693.318 525 697.319 556 726.318 574C746.318 587 774.318 585 790.318 562C799.318 550 802.318 539 792.318 534C747.319 513 727.318 472 738.318 428C739.652 420 742.652 418.667 747.318 424C774.318 450 815.318 460 831.318 501C855.318 457 898.318 456 930.318 436C936.318 431.333 939.318 433.333 939.318 442C938.318 496 903.318 535 850.318 547C841.318 570 833.318 592 819.318 622C773.318 723 661.318 782 491.318 782H294.318C161.319 782 74.3183 714 53.3184 592C41.3184 526 38.3184 433 50.3184 375C70.3184 277 113.82 218 234.32 218H478.318ZM571.82 350.5C469.82 333.5 277.82 329.5 164.82 350.5C138.82 355.5 114.318 379 110.318 404C100.318 451 102.318 551 124.318 596C155.318 660 214.319 697 315.318 705C324.318 678 346.319 662 376.318 662C404.318 662 427.318 678 435.318 705C493.318 699 526.318 680 562.318 652C621.318 606 633.749 527.103 633.749 424C633.749 385.144 604.82 355.5 571.82 350.5ZM179.32 264C167.722 264 158.32 273.402 158.32 285C158.32 296.598 167.722 306 179.32 306C190.918 306 200.32 296.598 200.32 285C200.32 273.402 190.918 264 179.32 264ZM245.551 264C233.953 264 224.551 273.402 224.551 285C224.551 296.598 233.953 306 245.551 306C257.149 306 266.551 296.598 266.551 285C266.551 273.402 257.149 264 245.551 264ZM311.782 264C300.184 264 290.782 273.402 290.782 285C290.782 296.598 300.184 306 311.782 306C323.38 306 332.782 296.598 332.782 285C332.782 273.402 323.38 264 311.782 264Z"

    function DesktopBrandMark() {
      const height = 17
      return React.createElement(
        'svg',
        {
          width: height * BRAND_MARK_VIEWBOX.width / BRAND_MARK_VIEWBOX.height,
          height,
          viewBox: `${BRAND_MARK_VIEWBOX.x} ${BRAND_MARK_VIEWBOX.y} ${BRAND_MARK_VIEWBOX.width} ${BRAND_MARK_VIEWBOX.height}`,
          fill: 'none',
          'aria-hidden': 'true'
        },
        React.createElement('path', { d: BRAND_MARK_PATH, fill: 'currentColor' })
      )
    }

    function DesktopBrandName() {
      return React.createElement(BrandWordmark, { includeMark: false })
    }

    function ConversationBrandMark(props) {
      return React.createElement(FishLogo, props)
    }

    function OpenUnpreviewableFile({ absolutePath, openWorkspacePath }) {
      const [error, setError] = React.useState('')
      const label = document.documentElement.lang?.toLowerCase().startsWith('zh')
        ? '用本地应用打开'
        : 'Open with local app'
      return React.createElement(
        React.Fragment,
        null,
        React.createElement('button', {
          type: 'button',
          'data-textpreview-open-local': true,
          onClick: () => {
            setError('')
            void openWorkspacePath(absolutePath).catch((reason) => {
              setError(reason instanceof Error ? reason.message : String(reason))
            })
          }
        }, label),
        error && React.createElement('span', { role: 'alert' }, error)
      )
    }

    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, deleteSession }) {
      const [, setMenuOpen] = useMenuOpenState()
      const chinese = document.documentElement.lang?.toLowerCase().startsWith('zh')
      const label = chinese ? '永久删除会话' : 'Delete session permanently'
      const warning = chinese
        ? `确定删除“${displayTitle || sessionId}”？工作区文件会保留。此操作无法撤销。`
        : `Delete “${displayTitle || sessionId}”? Workspace files are kept. This can’t be undone.`
      return React.createElement(MenuItemButton, {
        danger: true,
        onSelect: () => {
          setMenuOpen(false)
          if (!window.confirm(warning)) return
          void Promise.resolve().then(() => deleteSession(sessionId)).catch((reason) => {
            window.alert(reason instanceof Error ? reason.message : String(reason))
          })
        }
      }, label)
    }

    function OpenSessionFolderMenuItem({ sessionId, useMenuOpenState, openInFinder }) {
      const [, setMenuOpen] = useMenuOpenState()
      if (typeof window.dshDesktop?.openInFinder !== 'function') return null
      const chinese = document.documentElement.lang?.toLowerCase().startsWith('zh')
      const label = chinese ? '在文件管理器中打开' : 'Open in file manager'
      return React.createElement(MenuItemButton, {
        onSelect: () => {
          setMenuOpen(false)
          void Promise.resolve().then(() => openInFinder(sessionId)).catch((reason) => {
            window.alert(reason instanceof Error ? reason.message : String(reason))
          })
        }
      }, label)
    }

    function UnreadSessionMenuItem({ sessionId, unread, onUnreadChange, useMenuOpenState }) {
      const [, setMenuOpen] = useMenuOpenState()
      const chinese = document.documentElement.lang?.toLowerCase().startsWith('zh')
      return React.createElement(MenuItemButton, {
        onSelect: () => {
          setMenuOpen(false)
          onUnreadChange(sessionId, !unread)
        }
      }, unread ? (chinese ? '标为已读' : 'Mark as read') : (chinese ? '标为未读' : 'Mark as unread'))
    }

    // Git branch switching in the composer footer. Local branches only: the
    // control reads the session directory, asks the shell for the repository
    // state, and never touches the working tree beyond git's own switch
    // safety checks (no force, no stash).
    const GIT_NS = 'desktop-git-branch'
    const GIT_CREATE_ID = '__dsh-desktop-create-branch__'
    const GIT_ZH = {
      'branch.aria': 'Git 分支：{name}',
      'branch.busy': '会话运行中，结束后可切换分支',
      'branch.detached': '游离 HEAD · {sha}',
      'branch.loading': '正在读取分支…',
      'branch.create': '新建分支…',
      'branch.pending': '正在切换…',
      'branch.switched': '已切换到 {name}',
      'branch.created': '已创建并切换到 {name}',
      'create.title': '新建分支',
      'create.description': '从 {name} 创建并切换过去',
      'create.descriptionDetached': '从当前提交 {sha} 创建并切换过去',
      'create.label': '分支名称',
      'create.placeholder': '例如 feature/login',
      'create.action': '创建并切换',
      'create.pending': '正在创建…',
      'close': '关闭',
      'cancel': '取消',
      'error.empty': '请输入分支名称',
      'error.invalid': 'git 不接受这个分支名称',
      'error.exists': '同名分支已存在',
      'error.notFound': '找不到这个分支，可能已被删除',
      'error.worktree': '有未提交的改动会被覆盖，请先提交或暂存',
      'error.inProgress': '仓库正在合并或变基，完成后再切换分支',
      'error.unavailable': '没有找到 git，请先安装 git',
      'error.notRepo': '这个工作区不是 git 仓库',
      'error.failed': 'git 操作失败'
    }
    const GIT_EN = {
      'branch.aria': 'Git branch: {name}',
      'branch.busy': 'Branch switching is unavailable while this session runs',
      'branch.detached': 'Detached HEAD · {sha}',
      'branch.loading': 'Reading branches…',
      'branch.create': 'New branch…',
      'branch.pending': 'Switching…',
      'branch.switched': 'Switched to {name}',
      'branch.created': 'Created and switched to {name}',
      'create.title': 'New branch',
      'create.description': 'Create a branch from {name} and switch to it',
      'create.descriptionDetached': 'Create a branch from {sha} and switch to it',
      'create.label': 'Branch name',
      'create.placeholder': 'e.g. feature/login',
      'create.action': 'Create and switch',
      'create.pending': 'Creating…',
      'close': 'Close',
      'cancel': 'Cancel',
      'error.empty': 'Enter a branch name',
      'error.invalid': 'git does not accept this branch name',
      'error.exists': 'A branch with this name already exists',
      'error.notFound': 'That branch no longer exists',
      'error.worktree': 'Uncommitted changes would be overwritten; commit or stash them first',
      'error.inProgress': 'The repository is merging or rebasing; finish that first',
      'error.unavailable': 'git was not found; install git and try again',
      'error.notRepo': 'This workspace is not a git repository',
      'error.failed': 'The git operation failed'
    }

    const GIT_CSS = `
.dgb-trigger{display:inline-flex;align-items:center;gap:4px;max-width:220px;height:28px;padding:0 4px 0 8px;border:none;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;line-height:20px;cursor:pointer;outline:none}
.dgb-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dgb-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.dgb-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.dgb-trigger svg{width:14px;height:14px;flex:none}
.dgb-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dgb-chevron{display:inline-flex;transition:transform 120ms ease}
.dgb-chevron[data-open=true]{transform:rotate(180deg)}
.dgb-menu{max-width:min(360px,calc(100vw - 32px))}
.dgb-form{display:flex;flex-direction:column;gap:10px}
.dgb-field{width:100%}
.dgb-error{display:flex;flex-wrap:wrap;align-items:flex-start;gap:6px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.dgb-error svg{flex:none;width:14px;height:14px;margin-top:2px}
.dgb-error-text{min-width:0}
.dgb-error-detail{flex-basis:100%;max-height:80px;overflow:auto;color:var(--dsw-alias-label-caption);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;white-space:pre-wrap;overflow-wrap:anywhere}
@media(prefers-reduced-motion:reduce){.dgb-chevron{transition:none}}
`

    function gitReasonText(reason) {
      return reason instanceof Error ? reason.message : String(reason)
    }

    // Frozen bridge methods are resolved per call so a preload that predates
    // this plugin (older install) simply hides the control instead of throwing.
    function createGitClient() {
      function method(name) {
        const bridge = window.dshDesktop
        const candidate = bridge === undefined || bridge === null ? undefined : bridge[name]
        return typeof candidate === 'function' ? candidate.bind(bridge) : null
      }
      function state(path) {
        const call = method('gitRepositoryState')
        if (call === null) return Promise.resolve({ kind: 'git-unavailable' })
        return Promise.resolve().then(() => call(path)).catch(() => ({ kind: 'git-unavailable' }))
      }
      function branches(path) {
        const call = method('gitListBranches')
        if (call === null) return Promise.resolve({ kind: 'git-unavailable' })
        return Promise.resolve()
          .then(() => call(path))
          .catch((reason) => ({ kind: 'git-failed', detail: gitReasonText(reason) }))
      }
      function mutation(name, path, branch) {
        const call = method(name)
        if (call === null) return Promise.resolve({ ok: false, reason: 'git-unavailable', detail: null })
        return Promise.resolve()
          .then(() => call(path, branch))
          .catch((reason) => ({ ok: false, reason: 'git-failed', detail: gitReasonText(reason) }))
      }
      return {
        state,
        branches,
        switchBranch: (path, branch) => mutation('gitSwitchBranch', path, branch),
        createBranch: (path, branch) => mutation('gitCreateBranch', path, branch)
      }
    }

    function gitFailureText(result, t) {
      switch (result.reason) {
        case 'invalid-branch-name': return t('error.invalid')
        case 'branch-exists': return t('error.exists')
        case 'branch-not-found': return t('error.notFound')
        case 'worktree-changed': return t('error.worktree')
        case 'operation-in-progress': return t('error.inProgress')
        case 'git-unavailable': return t('error.unavailable')
        case 'not-a-repository': return t('error.notRepo')
        default: return t('error.failed')
      }
    }

    function branchListFailureText(result, t) {
      if (result.kind === 'git-unavailable') return t('error.unavailable')
      if (result.kind === 'not-repository') return t('error.notRepo')
      return t('error.failed')
    }

    function CreateBranchDialog({ path, repository, git, t, onCreated, onCancel }) {
      const [draft, setDraft] = React.useState('')
      const [error, setError] = React.useState(null)
      const [creating, setCreating] = React.useState(false)
      const composing = React.useRef(false)
      const trimmed = draft.trim()
      const blocked = creating || trimmed === ''

      function submit() {
        if (creating) return
        if (trimmed === '') {
          setError({ text: t('error.empty'), detail: null })
          return
        }
        setCreating(true)
        setError(null)
        git.createBranch(path, trimmed).then((result) => {
          if (result.ok) {
            onCreated(result.branch)
            return
          }
          setCreating(false)
          setError({
            text: gitFailureText(result, t),
            detail: result.reason === 'git-failed' ? result.detail : null
          })
        }, (reason) => {
          setCreating(false)
          setError({ text: t('error.failed'), detail: gitReasonText(reason) })
        })
      }

      return React.createElement(
        Modal,
        {
          open: true,
          // Busy dialogs keep their state: git is already changing the
          // repository, so closing would hide the only progress report.
          onClose: creating ? () => {} : onCancel,
          closeLabel: t('close'),
          title: t('create.title'),
          description: repository.branch === null
            ? t('create.descriptionDetached', { sha: repository.headSha ?? '?' })
            : t('create.description', { name: repository.branch }),
          footer: React.createElement(
            React.Fragment,
            null,
            React.createElement(Button, {
              variant: 'outline',
              disabled: creating,
              onClick: onCancel
            }, t('cancel')),
            React.createElement(Button, {
              variant: 'primary',
              disabled: blocked,
              onClick: submit
            }, creating ? t('create.pending') : t('create.action'))
          )
        },
        React.createElement(
          'div',
          { className: 'dgb-form' },
          React.createElement(Input, {
            className: 'dgb-field',
            value: draft,
            placeholder: t('create.placeholder'),
            'aria-label': t('create.label'),
            'aria-invalid': error !== null,
            'aria-describedby': error === null ? undefined : 'dsh-desktop-branch-error',
            'data-modal-autofocus': true,
            autoComplete: 'off',
            spellCheck: false,
            disabled: creating,
            onFocus: (event) => event.target.select(),
            onCompositionStart: () => { composing.current = true },
            onCompositionEnd: () => { composing.current = false },
            onChange: (event) => {
              setDraft(event.target.value)
              setError(null)
            },
            onKeyDown: (event) => {
              // A composed Enter commits the IME candidate, not the dialog.
              if (event.key !== 'Enter' || composing.current) return
              event.preventDefault()
              submit()
            }
          }),
          error === null
            ? null
            : React.createElement(
              'div',
              { className: 'dgb-error', id: 'dsh-desktop-branch-error', role: 'alert' },
              React.createElement(IconWarningOutlineMedium, { 'aria-hidden': true }),
              React.createElement('span', { className: 'dgb-error-text' }, error.text),
              typeof error.detail === 'string' && error.detail !== ''
                ? React.createElement('span', { className: 'dgb-error-detail' }, error.detail)
                : null
            )
        )
      )
    }

    function GitBranchControl({ sessionId, useSessions, useSession, t, git }) {
      const cwd = useSessions((state) => (
        sessionId === undefined ? undefined : state.byId[sessionId]?.cwd
      ))
      const running = useSession((state) => state.running)
      const [repository, setRepository] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [branches, setBranches] = React.useState(null)
      const [switching, setSwitching] = React.useState(false)
      const [creatingBranch, setCreatingBranch] = React.useState(false)
      const [toast, setToast] = React.useState(null)
      const toastSequence = React.useRef(0)
      const triggerRef = React.useRef(null)
      const wasRunning = React.useRef(running)
      const path = typeof cwd === 'string' && cwd !== '' ? cwd : null

      function notify(text, success) {
        toastSequence.current += 1
        setToast({ id: toastSequence.current, text, success })
      }

      // Repository state follows the session directory. Re-reading on a
      // directory change also covers forks whose worktree differs.
      React.useEffect(() => {
        setOpen(false)
        if (path === null) {
          setRepository(null)
          return undefined
        }
        let live = true
        git.state(path).then((next) => {
          if (live) setRepository(next)
        }, () => {
          if (live) setRepository(null)
        })
        return () => { live = false }
      }, [path, git])

      // The agent's own `git switch` (or a commit) only becomes visible once
      // the run ends. Skipping the start keeps the menu from closing itself.
      React.useEffect(() => {
        const finished = wasRunning.current && !running
        wasRunning.current = running
        if (!finished || path === null) return undefined
        let live = true
        git.state(path).then((next) => {
          if (live) setRepository(next)
        }, () => {
          // Keep the previous reading; the next open re-reads anyway.
        })
        return () => { live = false }
      }, [running, path, git])

      React.useEffect(() => {
        if (!open || path === null) return undefined
        let live = true
        setBranches(null)
        git.branches(path).then((result) => {
          if (!live) return
          if (result.kind === 'branches') {
            setBranches(result.branches)
            return
          }
          setOpen(false)
          notify(branchListFailureText(result, t), false)
        }, () => {
          if (!live) return
          setOpen(false)
          notify(t('error.failed'), false)
        })
        return () => { live = false }
      }, [open, path, git])

      if (repository === null || repository.kind !== 'repository') return null

      const currentBranch = repository.branch
      const sha = repository.headSha === null ? '?' : repository.headSha
      const label = switching
        ? t('branch.pending')
        : currentBranch === null ? sha : currentBranch
      const fullLabel = currentBranch === null ? t('branch.detached', { sha }) : currentBranch
      const busy = running || switching
      // Toasts follow the composer card so they center over the chat column;
      // the chip alone would pull them to the left edge.
      const anchor = triggerRef.current === null
        ? null
        : triggerRef.current.closest('[data-composer-card]') ?? triggerRef.current

      function choose(id) {
        setOpen(false)
        if (id === GIT_CREATE_ID) {
          setCreatingBranch(true)
          return
        }
        if (path === null || switching || id === currentBranch) return
        setSwitching(true)
        git.switchBranch(path, id).then((result) => {
          setSwitching(false)
          if (result.ok) {
            setRepository({ kind: 'repository', branch: result.branch, headSha: null })
            notify(t('branch.switched', { name: result.branch }), true)
            return
          }
          notify(gitFailureText(result, t), false)
        }, () => {
          setSwitching(false)
          notify(t('error.failed'), false)
        })
      }

      const rows = branches === null
        ? [{ type: 'label', id: 'dsh-desktop-branches-loading', text: t('branch.loading') }]
        : branches.map((branch) => ({ id: branch.name, label: branch.name }))

      return React.createElement(
        React.Fragment,
        null,
        React.createElement(Menu, {
          open,
          anchor: React.createElement(
            'button',
            {
              ref: triggerRef,
              type: 'button',
              className: 'dgb-trigger',
              'aria-label': t('branch.aria', { name: fullLabel }),
              'aria-haspopup': 'menu',
              'aria-expanded': open,
              'aria-busy': switching ? true : undefined,
              title: busy
                ? t(switching ? 'branch.pending' : 'branch.busy')
                : fullLabel,
              disabled: busy,
              onClick: () => setOpen(!open)
            },
            React.createElement(
              'span',
              { 'aria-hidden': true },
              React.createElement(IconBranchOutlineMedium, null)
            ),
            React.createElement('span', { className: 'dgb-label' }, label),
            React.createElement(
              'span',
              { className: 'dgb-chevron', 'data-open': open, 'aria-hidden': true },
              React.createElement(IconChevronDownOutlineMedium, null)
            )
          ),
          items: rows,
          footer: [
            {
              id: GIT_CREATE_ID,
              label: t('branch.create'),
              icon: React.createElement(IconPlusOutlineMedium, null)
            }
          ],
          selectedId: currentBranch === null ? undefined : currentBranch,
          onSelect: choose,
          onClose: () => setOpen(false),
          side: 'top',
          portal: true,
          listClassName: 'dgb-menu'
        }),
        creatingBranch && path !== null
          ? React.createElement(CreateBranchDialog, {
            path,
            repository,
            git,
            t,
            onCancel: () => setCreatingBranch(false),
            onCreated: (branch) => {
              setCreatingBranch(false)
              setRepository({ kind: 'repository', branch, headSha: null })
              notify(t('branch.created', { name: branch }), true)
            }
          })
          : null,
        toast === null
          ? null
          : React.createElement(Toast, {
            key: toast.id,
            text: toast.text,
            tone: toast.success ? 'success' : undefined,
            icon: toast.success
              ? undefined
              : React.createElement(IconWarningOutlineMedium, { 'aria-hidden': true }),
            anchor,
            holdMs: toast.success ? undefined : 6000,
            onDone: () => setToast(null)
          })
      )
    }

    const inject = ['slots', 'locale', 'remote.session', 'sessions', 'uiWorkspace']
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(GIT_NS, { zh: GIT_ZH, en: GIT_EN }), 'Git branch dictionaries')
      ctx.effect(() => {
        const id = 'dsh-desktop-git-style'
        if (document.getElementById(id)) return
        const style = document.createElement('style')
        style.id = id
        style.textContent = GIT_CSS
        document.head.appendChild(style)
        return () => style.remove()
      })
      ctx.effect(() => {
        const id = 'dsh-desktop-preset-toolbar-style'
        if (document.getElementById(id)) return
        const style = document.createElement('style')
        style.id = id
        style.textContent = `
          :root { --dsh-page-title-top-spacing:56px; }
          /* Top-level page titles align with the sidebar brand row. Keep
             conversation chrome and detail/dialog headers in their own layout. */
          [data-plugin-panel] > header[data-window-drag] {
            padding-top:var(--dsh-page-title-top-spacing);
          }
          [data-dsh-preset-heading] { display:flex; align-items:center; flex-wrap:wrap; gap:12px 16px; }
          [data-dsh-preset-heading] h2 { margin:0; }
          [data-dsh-preset-actions] { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-left:auto; }
          [data-dsh-preset-actions] button { white-space:nowrap; }
          [data-dsh-preset-search] { margin-bottom:16px; }
          [data-dsh-preset-search] input[type=search] {
            box-sizing:border-box; width:100%; min-width:0; height:36px;
            border:1px solid var(--dsw-alias-border-l2); border-radius:10px;
            background:var(--dsw-alias-bg-module-platform); color:var(--dsw-alias-label-primary);
            padding:0 12px; font:inherit; font-size:13px;
          }
          [data-dsh-preset-search] input[type=search]::placeholder { color:var(--dsw-alias-label-caption); }
          [data-dsh-preset-search] input[type=search]:focus-visible {
            outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:2px;
            background:var(--dsw-alias-bg-base);
          }
        `
        document.head.appendChild(style)
        return () => style.remove()
      })
      ctx.slots.inject('sidebar.brand.mark', () =>
        ctx.slots.inject('sidebar.brand.name', () =>
          ctx.slots.inject('conversation.hero.brand.mark', function* () {
            yield ctx.slots.register({ name: 'sidebar.brand.mark' }, DesktopBrandMark)
            yield ctx.slots.register({ name: 'sidebar.brand.name' }, DesktopBrandName)
            yield ctx.slots.register(
              { name: 'conversation.hero.brand.mark' },
              ConversationBrandMark
            )
          })
        )
      )
      // Desktop ⌘N / Ctrl+N (File → New Session): the shell forwards the
      // accelerator over its preload bridge; start the session flow for the
      // current or most recent workspace. Deferred inject so the brand seats
      // never wait on the workspace service.
      ctx.inject(['uiWorkspace'], (scope) => {
        const actions = window.dshDesktopActions
        if (!actions || typeof actions.onNewSession !== 'function') return
        actions.onNewSession(() => scope.uiWorkspace.startSession())
        // Desktop ⌘O / Ctrl+O (File → Add Directory…): the keyboard twin of the
        // sidebar `+` button. `uiWorkspace` exposes no add-directory API, so the
        // shell-owned accelerator activates the patched button instead. The
        // button flips `wsPickerOpen`, so pressing it again while the picker is
        // already open would close it — hence the `aria-expanded` guard.
        if (typeof actions.onAddDirectory !== 'function') return
        actions.onAddDirectory(() => {
          const addButton = document.querySelector('[data-dsh-workspace-add]')
          if (!addButton) return
          if (addButton.getAttribute('aria-expanded') === 'true') return
          addButton.click()
        })
      })
      ctx.slots.inject('sidebar.right.tab.document.unpreviewable', () =>
        ctx.slots.register({
          name: 'sidebar.right.tab.document.unpreviewable',
          id: 'desktop-open-local',
          inject: () => ({
            openWorkspacePath: (path) => ctx.remote.session.openWorkspacePath({ path })
          })
        }, OpenUnpreviewableFile)
      )
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'desktop-delete-session',
          order: 900,
          inject: () => ({
            deleteSession: (sessionId) => {
              const workspace = ctx.get('uiWorkspace')
              if (!workspace) throw new Error('Workspace navigation is unavailable')
              return workspace.deleteSession(sessionId)
            }
          })
        }, DeleteSessionMenuItem)
      )
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'desktop-open-session-folder',
          order: 800,
          inject: () => ({
            openInFinder: (sessionId) => {
              const cwd = ctx.get('sessions').list.getSnapshot().byId[sessionId]?.cwd
              if (!cwd) throw new Error('Session workspace directory is unavailable')
              return window.dshDesktop.openInFinder(cwd)
            }
          })
        }, OpenSessionFolderMenuItem)
      )
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'desktop-unread-session',
          order: 350
        }, UnreadSessionMenuItem)
      )
      // Composer footer, right after the permission mode seat: switching
      // branches is a per-session act, so the control reads the session cwd
      // and hides itself outside a git repository.
      const gitClient = createGitClient()
      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register({
          name: 'conversation.input.left',
          id: 'desktop-git-branch',
          order: 10,
          locale: GIT_NS,
          inject: () => ({ git: gitClient })
        }, GitBranchControl)
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
