window.__ModuleLoader__.load({
  id: 'dsh-multitask-client',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const TASK_PHASES = Object.freeze([
      'queued',
      'researching',
      'orchestrating',
      'writing',
      'verifying',
      'done',
      'failed'
    ])
    const NARROW_MAX_WIDTH = 640
    const HANDOFF_PATTERN = /orchestrator handoff for (MT-[1-9][0-9]*)/i
    const TASK_ID_PATTERN = /MT-[1-9][0-9]*/g
    const CLAIM_PROJECTION = 'multitask/claims'
    const BASH_TIER2_SCOPE_NOTE = 'Native write/edit tools are guarded; Bash writes are not covered by tier 2.'
    const PLACEHOLDER_SLOT = 'conversation.composer.dock'
    const PLACEHOLDER_ID = 'dsh-multitask-placeholder'

    const published = { tasks: [], listeners: new Set() }

    function publishTasks(tasks) {
      published.tasks = tasks
      for (const listener of published.listeners) listener()
    }

    function displayPhase(phase) {
      switch (String(phase ?? '')) {
        case 'queued':
          return 'queued'
        case 'researching':
          return 'researching'
        case 'researched':
          return 'orchestrating'
        case 'research-failed':
          return 'failed'
        case 'orchestrating':
        case 'writing':
        case 'verifying':
        case 'done':
        case 'failed':
          return phase
        default:
          return String(phase ?? 'queued')
      }
    }

    function extractTaskId(text) {
      const matches = String(text ?? '').match(TASK_ID_PATTERN)
      return matches?.[matches.length - 1]
    }

    function normalizeClaimPath(input) {
      return String(input ?? '')
        .replace(/\\/g, '/')
        .replace(/^(?:\.\/)+/u, '')
        .replace(/\/+$/u, '')
    }

    function queueRowKind(text) {
      return HANDOFF_PATTERN.test(String(text ?? '')) ? 'orchestrator-handoff' : 'user'
    }

    function claimBadgeForPath(path, claims) {
      const normalized = normalizeClaimPath(path)
      const hit = (claims ?? []).find((claim) => (
        claim.state !== 'released' && normalizeClaimPath(claim.path) === normalized
      ))
      if (hit === undefined) return null
      return {
        path: normalizeClaimPath(hit.path),
        taskId: hit.taskId,
        ownerSessionId: hit.ownerSessionId
      }
    }

    function emptyTask(id) {
      return {
        id,
        objective: '',
        phase: 'queued',
        failed: false,
        childIds: [],
        claims: [],
        notes: [],
        interventions: 0,
        commandIds: []
      }
    }

    function applyEvent(task, event) {
      const data = event.data ?? {}
      if (event.type === 'command/run' && data.name === 'multitask') {
        if (data.commandId !== undefined && !task.commandIds.includes(data.commandId)) {
          task.commandIds.push(data.commandId)
        }
        if (task.objective === '' && typeof data.args === 'string') {
          task.objective = data.args.trim()
        }
        return task
      }
      if (event.type === 'command/done') {
        const fromText = extractTaskId(data.text ?? '')
        if (fromText !== undefined && task.id === undefined) task.id = fromText
        return task
      }
      if (event.type === 'multitask/claims') {
        const path = normalizeClaimPath(data.path)
        const next = (task.claims ?? []).filter((claim) => claim.path !== path)
        if (data.state !== 'released') {
          next.push({
            path,
            taskId: data.taskId,
            ownerSessionId: data.ownerSessionId
          })
        }
        task.claims = next
        return task
      }
      if (event.type === 'multitask/denial') {
        const reason = String(data.reason ?? data.note ?? '')
        if (reason !== '') {
          task.notes = [...(task.notes ?? []), reason]
          task.interventions = (task.interventions ?? 0) + 1
        }
        return task
      }
      if (typeof event.type === 'string' && event.type.startsWith('multitask/')) {
        if (typeof data.objective === 'string' && data.objective !== '') task.objective = data.objective
        if (data.id !== undefined) task.id = data.id
        if (data.phase !== undefined) {
          const next = displayPhase(data.phase)
          task.phase = next
          if (next === 'failed' || data.phase === 'research-failed') task.failed = true
          else if (next === 'done') task.failed = false
        }
        if (typeof data.childId === 'string' && data.childId !== '' && !task.childIds.includes(data.childId)) {
          task.childIds.push(data.childId)
        }
        const note = typeof data.note === 'string' && data.note !== ''
          ? data.note
          : (typeof data.reason === 'string' && data.reason !== '' && data.reason !== 'researcher' && data.reason !== 'writer'
            ? data.reason
            : '')
        if (note !== '' && !(task.notes ?? []).includes(note)) {
          task.notes = [...(task.notes ?? []), note]
        }
      }
      return task
    }

    function eventTaskId(event) {
      const data = event.data ?? {}
      if (event.type === 'multitask/claims') return data.taskId
      if (event.type === 'multitask/denial') return data.id ?? data.taskId
      if (event.type === 'command/done') return extractTaskId(data.text ?? '')
      if (event.type === 'command/run') return undefined
      if (typeof event.type === 'string' && event.type.startsWith('multitask/')) return data.id
      return undefined
    }

    function foldTasks(events) {
      const tasks = new Map()
      for (const event of events) {
        const id = eventTaskId(event)
        if (id === undefined) continue
        const current = tasks.get(id) ?? emptyTask(id)
        tasks.set(id, applyEvent(current, event))
      }
      return [...tasks.values()]
    }

    function formatTaskCardText(task) {
      const claims = (task.claims ?? [])
        .map((claim) => claim.path)
        .filter(Boolean)
      const children = task.childIds ?? []
      const notes = (task.notes ?? []).map((note) => {
        const text = String(note)
        if (text.startsWith('Boundary intervention:')) return text
        if (/fail/i.test(text)) return text
        return `Boundary intervention: ${text}`
      })
      return [
        `Task ${task.id}`,
        `Phase: ${task.phase}`,
        `Objective: ${task.objective}`,
        children.length > 0 ? `Children: ${children.join(', ')}` : '',
        claims.length > 0 ? `Claims: ${claims.join(', ')}` : '',
        ...notes,
        BASH_TIER2_SCOPE_NOTE,
        task.failed ? 'State: failed' : (task.phase === 'done' ? 'State: done' : '')
      ].filter((line) => line !== '').join('\n')
    }

    function matchTaskEvent(event) {
      if (event.type === 'multitask/task' && event.data?.id) {
        return { id: String(event.data.id), role: 'start' }
      }
      if (event.type === 'command/done') {
        const id = extractTaskId(event.data?.text ?? '')
        return id === undefined ? null : { id, role: 'update' }
      }
      if (event.type === 'multitask/claims' && event.data?.taskId) {
        return { id: String(event.data.taskId), role: 'update' }
      }
      if (event.type === 'multitask/denial' && (event.data?.id || event.data?.taskId)) {
        return { id: String(event.data.id ?? event.data.taskId), role: 'update' }
      }
      if (event.type === 'command/run') return null
      if (typeof event.type === 'string' && event.type.startsWith('multitask/') && event.data?.id) {
        return { id: String(event.data.id), role: 'update' }
      }
      return null
    }

    function startTask(_context, match) {
      return applyEvent(emptyTask(match.event.data?.id), match.event)
    }

    function updateTask(context, match) {
      return applyEvent({
        ...context.state,
        childIds: [...(context.state.childIds ?? [])],
        claims: [...(context.state.claims ?? [])],
        notes: [...(context.state.notes ?? [])],
        interventions: context.state.interventions ?? 0,
        commandIds: [...(context.state.commandIds ?? [])]
      }, match.event)
    }

    function buildTaskViewNode(context) {
      if (context.state === undefined || context.state.id === undefined) return null
      return {
        key: context.key,
        kind: 'multitask-task',
        id: context.state.id,
        target: 'chat',
        anchorSeq: context.start?.event?.seq ?? 0,
        location: context.start?.location ?? { kind: 'unresolved' },
        visibility: 'visible',
        data: context.state
      }
    }

    const taskCardDefinition = {
      kind: 'multitask-task',
      target: 'chat',
      match: matchTaskEvent,
      start: startTask,
      update: updateTask,
      buildViewNode: buildTaskViewNode
    }

    function useNarrow() {
      return React.useSyncExternalStore((onStoreChange) => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
        const media = window.matchMedia(`(max-width: ${NARROW_MAX_WIDTH}px)`)
        media.addEventListener('change', onStoreChange)
        window.addEventListener('resize', onStoreChange)
        return () => {
          media.removeEventListener('change', onStoreChange)
          window.removeEventListener('resize', onStoreChange)
        }
      }, () => (typeof window === 'undefined' ? false : window.innerWidth <= NARROW_MAX_WIDTH))
    }

    function claimsFromProjection(useProjection) {
      if (typeof useProjection !== 'function') return []
      const view = useProjection(CLAIM_PROJECTION)
      return Array.isArray(view?.claims) ? view.claims : []
    }

    function mergeClaims(task, claims) {
      const mine = claims.filter((claim) => claim.taskId === task.id && claim.state !== 'released')
      if (mine.length === 0) return task.claims ?? []
      const byPath = new Map((task.claims ?? []).map((claim) => [claim.path, claim]))
      for (const claim of mine) {
        byPath.set(normalizeClaimPath(claim.path), {
          path: normalizeClaimPath(claim.path),
          taskId: claim.taskId,
          ownerSessionId: claim.ownerSessionId
        })
      }
      return [...byPath.values()]
    }

    function chipStyle(current, failed) {
      return {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '1px 8px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l3, rgba(128,128,128,.35))',
        fontSize: '11px',
        lineHeight: '16px',
        background: current
          ? (failed ? 'var(--dsw-alias-state-error-primary, #c00)' : 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16))')
          : 'transparent',
        color: current && failed ? '#fff' : 'var(--dsw-alias-label-secondary, #666)'
      }
    }

    function TaskCard({ task, claims = [], t }) {
      const narrow = useNarrow()
      const merged = { ...task, claims: mergeClaims(task, claims) }
      React.useEffect(() => {
        const next = [...published.tasks.filter((row) => row.id !== merged.id), merged]
        publishTasks(next)
        return () => publishTasks(published.tasks.filter((row) => row.id !== merged.id))
      }, [merged.id, merged.phase, merged.objective, merged.failed, (merged.childIds ?? []).join(','), (merged.claims ?? []).map((claim) => claim.path).join(','), (merged.notes ?? []).join('|')])
      if (narrow) {
        return React.createElement(
          'pre',
          {
            'data-dsh-multitask-task-card': '',
            'data-task-id': merged.id,
            'data-phase': merged.phase,
            'data-failed': merged.failed ? 'true' : 'false',
            'data-narrow': 'true',
            style: {
              margin: '8px 0',
              padding: '8px 10px',
              whiteSpace: 'pre-wrap',
              font: '12px/18px ui-monospace, SFMono-Regular, Menlo, monospace',
              color: 'var(--dsw-alias-label-primary, #222)',
              background: 'var(--dsw-alias-bg-module-platform, transparent)',
              borderRadius: '10px'
            }
          },
          formatTaskCardText(merged)
        )
      }
      return React.createElement(
        'div',
        {
          'data-dsh-multitask-task-card': '',
          'data-task-id': merged.id,
          'data-phase': merged.phase,
          'data-failed': merged.failed ? 'true' : 'false',
          'data-narrow': 'false',
          role: 'group',
          'aria-label': typeof t === 'function' ? t('card.aria') : `Multitask ${merged.id}`,
          style: {
            margin: '8px 0',
            padding: '10px 12px',
            borderRadius: '14px',
            border: '1px solid var(--dsw-alias-border-l3, rgba(128,128,128,.35))',
            background: 'var(--dsw-alias-bg-module-platform, transparent)',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            maxWidth: 'min(748px, 100%)'
          }
        },
        React.createElement(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
          ...TASK_PHASES.map((phase) => React.createElement(
            'span',
            {
              key: phase,
              'data-dsh-multitask-phase-chip': '',
              'data-phase': phase,
              'data-current': phase === merged.phase ? 'true' : 'false',
              style: chipStyle(phase === merged.phase, merged.failed && phase === 'failed')
            },
            phase
          ))
        ),
        React.createElement('div', { style: { fontSize: '13px', fontWeight: 600 } }, merged.id),
        React.createElement('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #555)' } }, merged.objective),
        (merged.childIds ?? []).length > 0
          ? React.createElement(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', fontSize: '12px' } },
            ...(merged.childIds ?? []).map((childId) => React.createElement(
              'span',
              { key: childId, 'data-dsh-multitask-child': '', 'data-child-id': childId },
              childId
            ))
          )
          : null,
        (merged.claims ?? []).map((claim) => React.createElement(
          ClaimBadge,
          { key: `${claim.path}:${claim.taskId}`, claim }
        )),
        (merged.notes ?? []).map((note, index) => React.createElement(
          'div',
          {
            key: `note:${index}`,
            'data-dsh-multitask-intervention': '',
            style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #555)' }
          },
          String(note).startsWith('Boundary intervention:') ? String(note) : `Boundary intervention: ${note}`
        )),
        React.createElement(
          'div',
          {
            'data-dsh-multitask-bash-scope': '',
            style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #888)' }
          },
          BASH_TIER2_SCOPE_NOTE
        )
      )
    }

    function ClaimBadge({ claim }) {
      return React.createElement(
        'span',
        {
          'data-dsh-multitask-claim-badge': '',
          'data-path': claim.path,
          'data-task-id': claim.taskId,
          'data-owner': claim.ownerSessionId,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            padding: '1px 7px',
            borderRadius: '999px',
            border: '1px solid var(--dsw-alias-border-l3, rgba(128,128,128,.35))',
            fontSize: '11px',
            color: 'var(--dsw-alias-label-secondary, #666)'
          }
        },
        `claimed ${claim.path} · ${claim.taskId}`
      )
    }

    function TaskCardNode({ node, useProjection, t }) {
      const claims = claimsFromProjection(useProjection)
      return React.createElement(TaskCard, { task: node.data, claims, t })
    }

    function MultitaskCommandView() {
      return null
    }

    function queueRowPreview(row) {
      if (typeof row?.preview === 'string') return row.preview
      if (typeof row?.text === 'string') return row.text
      const content = row?.message?.content
      if (Array.isArray(content)) {
        const parts = []
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
        }
        return parts.join(' ')
      }
      return ''
    }

    function QueueLabelRail({ useInput, session }) {
      const input = typeof useInput === 'function' ? useInput((state) => state) : undefined
      const snapshot = session ?? input
      const queue = snapshot?.queue ?? []
      const admitted = new Set(queue.flatMap((row) => (row.rpcId === undefined ? [] : [row.rpcId])))
      const pending = (snapshot?.pendingSubmissions ?? []).filter((row) => (
        row.placement === 'queued' && !admitted.has(row.requestId)
      ))
      // An idle session has a drained inbox: a queue row or an unretired
      // submission echo at rest is stale client state, and rendering it kept
      // the "Queued message: …" label pinned after the message was delivered.
      if (snapshot?.running === false) return null
      const rows = [...queue, ...pending]
      if (rows.length === 0) return null
      return React.createElement(
        'div',
        {
          'data-dsh-multitask-queue-labels': '',
          style: { display: 'flex', flexDirection: 'column', gap: '4px', margin: '0 0 6px', fontSize: '11px' }
        },
        ...rows.map((row, index) => {
          const preview = queueRowPreview(row)
          const kind = queueRowKind(preview)
          return React.createElement(
            'div',
            {
              key: row.id ?? row.requestId ?? `${kind}:${index}`,
              'data-dsh-multitask-queue-label': '',
              'data-kind': kind
            },
            kind === 'orchestrator-handoff' ? `Orchestrator handoff: ${preview}` : `Queued message: ${preview}`
          )
        })
      )
    }

    function LineageChip() {
      const tasks = React.useSyncExternalStore((onStoreChange) => {
        published.listeners.add(onStoreChange)
        return () => published.listeners.delete(onStoreChange)
      }, () => published.tasks)
      const unique = []
      const seen = new Set()
      for (const task of tasks) {
        if (seen.has(task.id)) continue
        seen.add(task.id)
        unique.push(task)
      }
      const visible = unique.slice(-2)
      if (visible.length === 0) return null
      return React.createElement(
        'div',
        {
          'data-dsh-multitask-lineage': '',
          style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px' }
        },
        ...visible.map((task) => React.createElement(
          'span',
          { key: task.id, 'data-task-id': task.id },
          task.id
        ))
      )
    }

    function ClaimToolRow({ toolName, block, useProjection }) {
      const claims = claimsFromProjection(useProjection)
      const raw = JSON.stringify(block ?? {})
      const badge = claims
        .map((claim) => claimBadgeForPath(claim.path, claims))
        .find((hit) => hit !== null && raw.includes(hit.path))
        ?? claims.find((claim) => claim.state !== 'released' && raw.includes(claim.path))
      const normalized = badge === undefined || badge === null
        ? null
        : { path: badge.path, taskId: badge.taskId, ownerSessionId: badge.ownerSessionId }
      return React.createElement(
        'div',
        { 'data-dsh-multitask-claim-tool': '', 'data-tool': toolName, style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12px' } },
        toolName,
        normalized === null ? null : React.createElement(ClaimBadge, { claim: normalized })
      )
    }

    function stampClaimBadges(claims) {
      if (typeof document === 'undefined') return
      const live = (claims ?? []).filter((claim) => claim.state !== 'released')
      for (const row of document.querySelectorAll('[data-chat-call-id]')) {
        for (const claim of live) {
          const path = normalizeClaimPath(claim.path)
          if (!row.textContent.includes(path)) continue
          const existing = row.querySelector(`[data-dsh-multitask-claim-badge][data-path="${CSS.escape(path)}"]`)
          if (existing !== null) continue
          const badge = document.createElement('span')
          badge.setAttribute('data-dsh-multitask-claim-badge', '')
          badge.setAttribute('data-path', path)
          badge.setAttribute('data-task-id', claim.taskId)
          badge.setAttribute('data-owner', claim.ownerSessionId)
          badge.textContent = `claimed ${path} · ${claim.taskId}`
          badge.style.cssText = 'display:inline-flex;margin-left:8px;padding:1px 7px;border-radius:999px;border:1px solid rgba(128,128,128,.35);font-size:11px'
          row.appendChild(badge)
        }
      }
    }

    function ClaimBadgeLayer({ useProjection }) {
      const claims = claimsFromProjection(useProjection)
      React.useEffect(() => {
        stampClaimBadges(claims)
        if (typeof MutationObserver !== 'function') return undefined
        const observer = new MutationObserver(() => stampClaimBadges(claims))
        observer.observe(document.body, { childList: true, subtree: true })
        return () => observer.disconnect()
      }, [claims])
      return React.createElement('span', { 'data-dsh-multitask-claim-layer': '', hidden: true })
    }

    function MultitaskPlaceholder() {
      return React.createElement(
        'div',
        {
          'data-dsh-multitask-placeholder': '',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            margin: '8px auto 0',
            padding: '2px 12px',
            borderRadius: '999px',
            border: '1px solid var(--dsw-alias-border-l3, rgba(128,128,128,.35))',
            color: 'var(--dsw-alias-label-tertiary, #999)',
            fontSize: '12px',
            lineHeight: '18px',
            opacity: 0.85,
            userSelect: 'none'
          }
        },
        'Multitask'
      )
    }

    function registerLiveSurfaces(ctx) {
      ctx.uiConversation.events.register(taskCardDefinition)
      ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
        { name: 'conversation.chat.node', key: 'multitask-task' },
        TaskCardNode
      ))
      ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register(
        { name: 'conversation.chat.commandview', key: 'multitask' },
        MultitaskCommandView
      ))
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
        { name: 'conversation.input.dock', id: 'dsh-multitask-queue-label', order: 21 },
        QueueLabelRail
      ))
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(
        { name: 'conversation.session.header.actions', id: 'dsh-multitask-lineage', order: 40 },
        LineageChip
      ))
      ctx.slots.inject('tool.call.toolview', function* () {
        for (const key of ['claim_files', 'release_files', 'list_file_claims']) {
          yield ctx.slots.register({ name: 'tool.call.toolview', key }, ClaimToolRow)
        }
      })
    }

    const inject = typeof document === 'undefined' ? ['slots'] : ['slots', 'uiConversation']
    function apply(ctx) {
      let live = false
      const startLive = (liveCtx) => {
        live = true
        registerLiveSurfaces(liveCtx)
      }
      if (typeof document !== 'undefined') startLive(ctx)
      else if (typeof ctx.inject === 'function') ctx.inject(['uiConversation'], startLive)
      ctx.slots.inject(PLACEHOLDER_SLOT, () => ctx.slots.register(
        {
          name: PLACEHOLDER_SLOT,
          id: live ? 'dsh-multitask-claim-layer' : PLACEHOLDER_ID,
          order: 90
        },
        live ? ClaimBadgeLayer : MultitaskPlaceholder
      ))
    }

    exports.apply = apply
    exports.inject = inject
    exports.foldTasks = foldTasks
    exports.displayPhase = displayPhase
    exports.queueRowKind = queueRowKind
    exports.queueRowPreview = queueRowPreview
    exports.claimBadgeForPath = claimBadgeForPath
    exports.formatTaskCardText = formatTaskCardText
    exports.extractTaskId = extractTaskId
    exports.TASK_PHASES = TASK_PHASES
    exports.NARROW_MAX_WIDTH = NARROW_MAX_WIDTH
    exports.HANDOFF_PATTERN = HANDOFF_PATTERN
    return module.exports
  }
})
