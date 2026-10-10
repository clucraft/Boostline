import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CaretDownIcon, CloseIcon } from './icons'
import { useApp } from '../store'

export interface MenuItem {
  label: string
  icon?: ReactNode
  onClick?: () => void
  disabled?: boolean
  separator?: boolean
  heading?: boolean
  /** Read-only label/value row (e.g. vehicle details). */
  value?: string
}

/** Fixed-position menu at a screen point; closes on outside click or Escape. */
export function Menu({
  x,
  y,
  items,
  onClose,
  className
}: {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      x: Math.min(x, window.innerWidth - r.width - 8),
      y: y + r.height > window.innerHeight - 8 ? Math.max(8, y - r.height) : y
    })
  }, [x, y])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const id = setTimeout(() => window.addEventListener('mousedown', onDown))
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(id)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return createPortal(
    <div className={`menu ${className ?? ''}`} ref={ref} style={{ left: pos.x, top: pos.y }}>
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="sep" />
        ) : item.heading ? (
          <div key={i} className="menu-label">
            {item.label}
          </div>
        ) : item.value !== undefined ? (
          <div key={i} className="menu-info">
            {item.label}
            <b>{item.value}</b>
          </div>
        ) : (
          <button
            key={i}
            disabled={item.disabled}
            onClick={() => {
              onClose()
              item.onClick?.()
            }}
          >
            {item.icon}
            {item.label}
          </button>
        )
      )}
    </div>,
    document.body
  )
}

/** A button that opens a dropdown menu beneath itself. */
export function MenuButton({
  label,
  icon,
  items,
  className = 'btn sm',
  disabled
}: {
  label: string
  icon?: ReactNode
  items: MenuItem[] | (() => MenuItem[])
  className?: string
  disabled?: boolean
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  return (
    <>
      <button
        className={className}
        disabled={disabled}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setAt({ x: r.left, y: r.bottom + 4 })
        }}
      >
        {icon}
        {label}
        <CaretDownIcon size={12} weight="bold" />
      </button>
      {at && <Menu x={at.x} y={at.y} items={typeof items === 'function' ? items() : items} onClose={() => setAt(null)} />}
    </>
  )
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`}>
        <div className="modal-head">
          {title}
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body
  )
}

/** Prompt for a short text value (names of presets, graphs, runs). */
export function PromptModal({
  title,
  label,
  initial,
  onSubmit,
  onClose
}: {
  title: string
  label: string
  initial: string
  onSubmit: (value: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState(initial)
  const submit = (): void => {
    if (!value.trim()) return
    onSubmit(value.trim())
    onClose()
  }
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit}>
            Save
          </button>
        </>
      }
    >
      <div className="field">
        <label>{label}</label>
        <input
          className="input"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </div>
    </Modal>
  )
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts)
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  )
}

export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return <button className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)} aria-pressed={on} />
}

export function NumberField({
  label,
  value,
  onChange,
  step = 1,
  min,
  max
}: {
  label: string
  value: number
  onChange: (v: number) => void
  step?: number
  min?: number
  max?: number
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  return (
    <div className="field">
      <label>{label}</label>
      <input
        className="input"
        type="number"
        value={text}
        step={step}
        min={min}
        max={max}
        onChange={(e) => {
          setText(e.target.value)
          const v = parseFloat(e.target.value)
          if (Number.isFinite(v)) onChange(v)
        }}
      />
    </div>
  )
}

export function Collapsible({ title, children, defaultOpen = false }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div>
      <div className="collapsible-head" onClick={() => setOpen(!open)}>
        <span className="chevron">
          <CaretDownIcon size={12} weight="bold" style={{ transform: open ? 'rotate(180deg)' : undefined }} />
        </span>
        {title}
      </div>
      {open && <div style={{ paddingTop: 6 }}>{children}</div>}
    </div>
  )
}

/** Boostline mark: an amber tile with a rising trace. */
export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" fill="#ffad33" />
      <path d="M7 22.5 L12.5 17 L16.5 19.5 L24.5 10" fill="none" stroke="#1a0f00" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="24.5" cy="10" r="2.6" fill="#1a0f00" />
    </svg>
  )
}

export function Logo() {
  return (
    <div className="brand">
      <LogoMark />
      <span>boostline</span>
    </div>
  )
}
