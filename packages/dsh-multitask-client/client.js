window.__ModuleLoader__.load({
  id: 'dsh-multitask-client',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    // One placeholder occupant on the ambient seat below the composer card —
    // the same list slot the PPT chooser mounts — proves the client module is
    // served and composed. It is the scaffold's entire UI surface; later
    // multitask tickets replace it with real surfaces.
    const PLACEHOLDER_SLOT = 'conversation.composer.dock'
    const PLACEHOLDER_ID = 'dsh-multitask-placeholder'

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

    const inject = ['slots']
    function apply(ctx) {
      ctx.slots.inject(PLACEHOLDER_SLOT, () =>
        ctx.slots.register(
          { name: PLACEHOLDER_SLOT, id: PLACEHOLDER_ID, order: 90 },
          MultitaskPlaceholder
        )
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
