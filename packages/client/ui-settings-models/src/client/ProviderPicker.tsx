/** Editable provider combobox with locally ranked suggestions and an anchored listbox. */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconChevronDownOutlineRegular, MenuSurface, rankByName, useAnchoredPosition } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './ModelsSection.module.css'

/** One selectable provider identity. */
interface ProviderChoice {
  id: string
  label: string
}

/**
 * Select a provider by typing its name or ID, or by navigating the visible suggestions.
 * @param props - current choice, available providers, localized labels, and selection callbacks.
 * @returns one editable combobox and its body-portaled suggestions while expanded.
 */
export function ProviderPicker({ value, options, disabled, label, placeholder, emptyLabel, onSelect, query, onQueryChange }: {
  value: string
  options: readonly ProviderChoice[]
  disabled: boolean
  label: string
  placeholder: string
  emptyLabel: string
  onSelect: (id: string) => void
  query: string | null
  onQueryChange: (query: string | null) => void
}) {
  const [highlight, setHighlight] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const id = useId()
  const expanded = query !== null && !disabled
  const matches = rankByName(options.map(option => ({ ...option, name: option.id })), (query ?? '').trim())
  const active = matches[Math.min(highlight, matches.length - 1)]
  const position = useAnchoredPosition({ open: expanded, anchorRef: input, panelRef: list,
    gap: 4, margin: 12, minWidthFromAnchor: true, layoutKey: query ?? '' })
  const close = useCallback(() => { onQueryChange(null) }, [onQueryChange])
  const begin = (): void => { setHighlight(0); onQueryChange('') }
  const choose = (choice: ProviderChoice): void => { onSelect(choice.id); close() }
  useEffect(() => {
    if (!expanded) return
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && event.target !== input.current && !list.current?.contains(event.target)) close()
    }
    document.addEventListener('pointerdown', outside)
    return () => { document.removeEventListener('pointerdown', outside) }
  }, [expanded, close])
  return <>
    <div className={styles['providerPicker']}>
      <input ref={input} type="text" role="combobox" className={`${styles['input']} ${styles['providerSearch']}`}
        aria-label={label} placeholder={placeholder} autoComplete="off" spellCheck={false}
        aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={expanded} aria-controls={expanded ? `${id}-list` : undefined}
        aria-activedescendant={expanded && active !== undefined ? `${id}-${active.id}` : undefined}
        value={expanded ? query : options.find(option => option.id === value)?.label ?? ''} disabled={disabled}
        onFocus={begin} onClick={() => { if (!expanded) begin() }}
        onBlur={(event) => { if (!(event.relatedTarget instanceof Node) || !list.current?.contains(event.relatedTarget)) close() }}
        onChange={(event) => {
          onQueryChange(event.target.value); setHighlight(0)
          if (list.current !== null) list.current.scrollTop = 0
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.ctrlKey || event.altKey || event.metaKey) return
          if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); close(); return }
          if (event.key === 'Tab') { close(); return }
          if (event.key === 'Enter' && expanded) {
            event.preventDefault()
            if (active !== undefined) choose(active)
            return
          }
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          if (!expanded) { begin(); return }
          if (matches.length === 0) return
          const next = (Math.min(highlight, matches.length - 1) + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length
          setHighlight(next)
          list.current?.querySelector<HTMLElement>(`[data-provider-index="${next}"]`)?.scrollIntoView({ block: 'nearest' })
        }} />
      <IconChevronDownOutlineRegular className={styles['providerChevron']} aria-hidden="true" />
    </div>
    {expanded && createPortal(<MenuSurface ref={list} id={`${id}-list`} role="listbox" aria-label={label}
      className={styles['providerSuggestions']} style={position ?? { visibility: 'hidden', left: 0, top: 0 }}>
      {matches.length === 0 ? <div className={styles['providerEmpty']} role="status">{emptyLabel}</div>
        : matches.map((choice, index) => <button key={choice.id} id={`${id}-${choice.id}`} type="button" role="option"
          tabIndex={-1} aria-selected={choice.id === value} data-provider-index={index}
          data-active={choice.id === active?.id} className={styles['providerOption']} title={choice.label}
          onMouseDown={(event) => { event.preventDefault() }}
          onPointerMove={(event) => { if (event.pointerType === 'mouse') setHighlight(index) }}
          onClick={() => { choose(choice) }}>{choice.label}</button>)}
    </MenuSurface>, document.body)}
  </>
}
