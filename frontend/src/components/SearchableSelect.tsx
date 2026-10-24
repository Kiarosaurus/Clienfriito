import { useState, useEffect, useRef, useId } from 'react'
import { Search, X } from 'lucide-react'

export interface SelectOption {
  value: string
  label: string
}

// Approx rendered height of one option row (px-3 py-2.5 text-sm + 1px divider),
// used to cap the popover at `maxVisibleItems` rows before it scrolls.
const ITEM_HEIGHT = 41

interface Props {
  options: SelectOption[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  label?: string
  icon?: React.ReactNode
  maxVisibleItems?: number   // visible rows before the list scrolls
}

export default function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = 'Selecciona…',
  label,
  icon,
  maxVisibleItems = 5,
}: Props) {
  const [inputText, setInputText] = useState('')
  const [open, setOpen] = useState(false)
  // Index into `filtered` for keyboard navigation; -1 = nothing highlighted.
  const [highlighted, setHighlighted] = useState(-1)
  const listId = useId()
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    if (!value) { setInputText(''); return }
    const found = optionsRef.current.find(o => o.value === value)
    if (found) setInputText(found.label)
  }, [value])

  const filtered = inputText.trim()
    ? options.filter(o => o.label.toLowerCase().includes(inputText.toLowerCase()))
    : options

  // Keep the highlighted option visible when navigating with the keyboard.
  useEffect(() => {
    if (!open || highlighted < 0) return
    document.getElementById(`${listId}-opt-${highlighted}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, highlighted, listId])

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setInputText(e.target.value)
    setOpen(true)
    setHighlighted(0)
    if (value) onChange('')
  }

  function handleSelect(opt: SelectOption) {
    setOpen(false)
    setHighlighted(-1)
    onChange(opt.value)
  }

  function handleBlur() {
    setTimeout(() => {
      setOpen(false)
      setHighlighted(-1)
      if (!value) {
        setInputText('')
      } else {
        const found = optionsRef.current.find(o => o.value === value)
        setInputText(found?.label ?? '')
      }
    }, 150)
  }

  function moveHighlight(delta: number) {
    if (!open) { setOpen(true); setHighlighted(0); return }
    if (!filtered.length) { setHighlighted(-1); return }
    setHighlighted(h => {
      const next = h + delta
      if (next < 0) return filtered.length - 1
      if (next >= filtered.length) return 0
      return next
    })
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveHighlight(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveHighlight(-1)
    } else if (e.key === 'Enter') {
      if (open && highlighted >= 0 && highlighted < filtered.length) {
        e.preventDefault()   // select instead of submitting the surrounding form
        handleSelect(filtered[highlighted])
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault()
        setOpen(false)
        setHighlighted(-1)
      }
    } else if (e.key === 'Tab') {
      setOpen(false)
      setHighlighted(-1)
    }
  }

  const leftIcon = icon ?? <Search size={15} />
  const inputPl = icon ? 'pl-10' : 'pl-9'
  const listOpen = open && filtered.length > 0

  return (
    <div>
      {label && (
        <p className="text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">
          {label}
        </p>
      )}
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none z-10 flex items-center">
          {leftIcon}
        </span>

        <input
          type="text"
          autoComplete="off"
          role="combobox"
          aria-expanded={listOpen}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            listOpen && highlighted >= 0 ? `${listId}-opt-${highlighted}` : undefined
          }
          value={inputText}
          onChange={handleChange}
          onFocus={() => setOpen(true)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className={`w-full bg-slate-900 border border-slate-600 rounded-lg ${inputPl} pr-8 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/50 transition placeholder-slate-500`}
        />

        {value && (
          <button
            type="button"
            aria-label="Limpiar selección"
            onMouseDown={e => { e.preventDefault(); onChange(''); setInputText('') }}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 transition-colors"
          >
            <X size={13} />
          </button>
        )}

        {listOpen && (
          <ul
            id={listId}
            role="listbox"
            style={{ maxHeight: `${maxVisibleItems * ITEM_HEIGHT}px` }}
            className="absolute z-50 left-0 right-0 mt-1 bg-slate-900 border border-slate-600 rounded-lg shadow-2xl overflow-y-auto overscroll-contain"
          >
            {filtered.map((opt, idx) => (
              <li
                key={opt.value}
                id={`${listId}-opt-${idx}`}
                role="option"
                aria-selected={opt.value === value}
                onMouseDown={() => handleSelect(opt)}
                onMouseEnter={() => setHighlighted(idx)}
                className={`px-3 py-2.5 text-sm cursor-pointer border-b border-slate-700/50 last:border-0 transition-colors ${
                  opt.value === value
                    ? 'bg-blue-600/20 text-blue-200'
                    : idx === highlighted
                      ? 'bg-slate-800 text-slate-100'
                      : 'text-slate-200 hover:bg-slate-800'
                }`}
              >
                {opt.label}
              </li>
            ))}
          </ul>
        )}

        {open && inputText.trim() && filtered.length === 0 && (
          <div className="absolute z-50 left-0 right-0 mt-1 bg-slate-900 border border-slate-600 rounded-lg shadow-xl px-3 py-3 text-sm text-slate-500">
            Sin resultados para "{inputText}"
          </div>
        )}
      </div>
    </div>
  )
}
