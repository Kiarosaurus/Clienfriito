import type { ReactNode } from 'react'

// Actionable empty state — never just describes the void, always points at the
// next step. `action` renders an inline button; `hint` carries the directive text.
export function EmptyState({
  icon, title, hint, action, className = '',
}: {
  icon?: ReactNode
  title: string
  hint?: string
  action?: { label: string; onClick: () => void }
  className?: string
}) {
  return (
    <div className={`flex flex-col items-center justify-center text-center gap-3 py-10 px-6 ${className}`}>
      {icon && (
        <span className="w-12 h-12 rounded-full bg-slate-700/50 border border-slate-600/60 flex items-center justify-center text-slate-400">
          {icon}
        </span>
      )}
      <div className="space-y-1 max-w-xs">
        <p className="text-slate-200 font-semibold text-sm">{title}</p>
        {hint && <p className="text-slate-400 text-xs leading-relaxed">{hint}</p>}
      </div>
      {action && (
        <button
          onClick={action.onClick}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-300 bg-blue-500/10 border border-blue-500/30 hover:bg-blue-500/20 hover:text-blue-200 px-3 py-1.5 rounded-lg transition-colors"
        >
          {action.label} <span aria-hidden="true">→</span>
        </button>
      )}
    </div>
  )
}
