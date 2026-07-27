// frontend/src/components/pocket/Primitives.jsx
// Pocket Crew interface primitives shared across screens (Foundation Task 5): MoneyFigure,
// StatusNotice, TechnicalDetails, VenueTruth, StageShell, and Dialog. Truthful by construction --
// MoneyFigure never coerces a missing value to 0, VenueTruth never invents an APY for the Base
// custody proxy, and Dialog only ever closes through the caller's own onClose.
import { useEffect, useId, useRef } from 'react'
import { NetworkRoute } from './NetworkIdentity.jsx'

// ---------------------------------------------------------------------------------------------
// MoneyFigure
// ---------------------------------------------------------------------------------------------

const MONEY_PLACEHOLDER = Object.freeze({
  loading: 'Loading',
  empty: 'No balance yet',
  error: 'Could not load',
  unknown: 'Unknown',
})

export function MoneyFigure({ state, value, currency = 'USDC', freshness }) {
  // Object.hasOwn (not `in`): `state="toString"`/`"constructor"` etc. must never resolve through
  // the prototype chain to a built-in function and render it as if it were a real money state.
  if (Object.hasOwn(MONEY_PLACEHOLDER, state)) {
    return (
      <span className={`pc-money pc-money--${state}`} role={state === 'error' ? 'alert' : 'status'}>
        {MONEY_PLACEHOLDER[state]}
      </span>
    )
  }

  // `current`/`stale` (or any other state) still fall through here -- but a missing/non-numeric
  // value under a "here is a number" state is never silently displayed as 0; it is truthfully
  // unknown instead.
  const numeric = value === null || value === undefined ? NaN : Number(value)
  if (Number.isNaN(numeric)) {
    return <span className="pc-money pc-money--unknown">Unknown</span>
  }

  return (
    <span className={`pc-money pc-money--${state}`} data-freshness={freshness || undefined}>
      {numeric.toLocaleString()} {currency}
      {state === 'stale' && <span className="pc-money-stale-flag"> (stale)</span>}
      {freshness && <span className="pc-money-freshness">{freshness}</span>}
    </span>
  )
}

// ---------------------------------------------------------------------------------------------
// StatusNotice
// ---------------------------------------------------------------------------------------------

const STATUS_ICON = Object.freeze({ info: 'i', success: 'OK', warning: '!', danger: 'X' })

export function StatusNotice({ state = 'info', title, children, action }) {
  const role = state === 'danger' || state === 'warning' ? 'alert' : 'status'
  return (
    <div className={`pc-status-notice pc-status-notice--${state}`} role={role}>
      <span className="pc-status-notice-icon" aria-hidden="true">
        {STATUS_ICON[state] || STATUS_ICON.info}
      </span>
      <div className="pc-status-notice-body">
        {title && <p className="pc-status-notice-title">{title}</p>}
        {children && <div className="pc-status-notice-content">{children}</div>}
      </div>
      {action && <div className="pc-status-notice-action">{action}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// TechnicalDetails
// ---------------------------------------------------------------------------------------------

export function TechnicalDetails({ summary = 'Technical details', children, open = false }) {
  return (
    <details className="pc-technical-details" open={open}>
      <summary className="pc-technical-details-summary">{summary}</summary>
      <div className="pc-technical-details-body">{children}</div>
    </details>
  )
}

// ---------------------------------------------------------------------------------------------
// VenueTruth
// ---------------------------------------------------------------------------------------------

// The Base Sepolia leg is custody-only -- it never carries protocol yield, so its copy is fixed
// and `apy` is always ignored for it (a dev warning fires if a caller passes one anyway).
const BASE_PROXY_COPY = 'Base Sepolia proxy. Custody only. No protocol yield.'

function canShowApy(apy) {
  if (!apy || apy.value === null || apy.value === undefined) return false
  if (apy.state === 'live') return true
  return apy.state === 'estimated' && Boolean(apy.source || apy.freshness)
}

export function VenueTruth({ kind, venue, networkContext, apy }) {
  const isProxy = kind === 'base-proxy'

  if (isProxy && apy != null && import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.warn(
      'VenueTruth(base-proxy): `apy` is ignored -- the Base Sepolia proxy is custody-only and ' +
        'never carries protocol yield.'
    )
  }

  const showApy = !isProxy && canShowApy(apy)

  return (
    <div className={`pc-venue-truth pc-venue-truth--${isProxy ? 'proxy' : 'live'}`}>
      {isProxy ? (
        <p className="pc-venue-truth-copy">{BASE_PROXY_COPY}</p>
      ) : (
        <>
          <p className="pc-venue-truth-copy">{venue || 'Autofarm Vault'} supplies to Blend</p>
          {showApy && (
            <p className="pc-venue-truth-apy" data-apy-state={apy.state}>
              {apy.value}% APY
              {apy.state === 'estimated' ? ` (estimated, ${apy.source || apy.freshness})` : ''}
            </p>
          )}
        </>
      )}
      {networkContext && <NetworkRoute context={networkContext} compact />}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// StageShell
// ---------------------------------------------------------------------------------------------

export function StageShell({ eyebrow, title, description, aside, children, actions }) {
  return (
    <section className="pc-stage-shell">
      <div className="pc-stage-shell-surface">
        <header className="pc-stage-shell-header">
          {eyebrow && <p className="pc-stage-eyebrow">{eyebrow}</p>}
          <h1 className="pc-stage-title">{title}</h1>
          {description && <p className="pc-stage-description">{description}</p>}
        </header>
        {children && <div className="pc-stage-body">{children}</div>}
        {aside && <div className="pc-stage-aside">{aside}</div>}
        {actions && <div className="pc-stage-actions">{actions}</div>}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------------------------

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), ' +
  'select:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Feature detection, computed once: jsdom (this repo's test env, as of jsdom 29) has no
// showModal() at all, so tests always exercise the role="dialog" fallback below -- which is by
// design the same code path a browser without <dialog> support would take.
const SUPPORTS_NATIVE_DIALOG =
  typeof HTMLDialogElement !== 'undefined' &&
  typeof HTMLDialogElement.prototype.showModal === 'function'

// One shared focus/restore implementation for both the native <dialog> path and the
// role="dialog" fallback -- mode only ever changes CSS classes below, never this behavior.
//
// `onClose` comes in via a ref, and the effect depends only on `open` (+ initialFocusRef): a
// typical caller passes a fresh inline `onClose` closure every render (`onClose={() =>
// setOpen(false)}`), and depending on that value directly would tear down + re-run this effect
// on every parent re-render while the dialog is open -- moving focus to the trigger and back to
// initialFocus on every keystroke of a parent-controlled input inside the dialog. panelRef is a
// stable ref object (identity never changes), so it doesn't need to be a dependency either.
function useDialogFocusTrap({ open, onClose, initialFocusRef, panelRef }) {
  const triggerRef = useRef(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return undefined
    triggerRef.current = document.activeElement

    const getFocusable = () =>
      panelRef.current ? Array.from(panelRef.current.querySelectorAll(FOCUSABLE_SELECTOR)) : []

    const toFocus = initialFocusRef?.current || getFocusable()[0] || panelRef.current
    toFocus?.focus?.()

    function onKeydown(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCloseRef.current?.()
        return
      }
      if (e.key !== 'Tab') return
      const focusable = getFocusable()
      if (focusable.length === 0) {
        e.preventDefault()
        return
      }
      e.preventDefault()
      const currentIndex = focusable.indexOf(document.activeElement)
      let nextIndex
      if (e.shiftKey) {
        nextIndex = currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1
      } else {
        nextIndex =
          currentIndex === focusable.length - 1 || currentIndex === -1 ? 0 : currentIndex + 1
      }
      focusable[nextIndex].focus()
    }

    document.addEventListener('keydown', onKeydown)
    return () => {
      document.removeEventListener('keydown', onKeydown)
      triggerRef.current?.focus?.()
    }
    // `onCloseRef`/`onClose` intentionally excluded (read via the ref instead -- see the comment
    // above the function). `panelRef` is a `useRef()` result whose identity never changes for the
    // life of the Dialog instance it belongs to, so including it below is safe and adds no
    // re-runs; it's listed only to satisfy the linter, which can't trace a ref through a custom
    // hook's parameter the way it recognizes a literal local `useRef()` call.
  }, [open, initialFocusRef, panelRef])
}

export function Dialog({
  open,
  title,
  description,
  onClose,
  children,
  actions,
  mode = 'auto',
  initialFocusRef,
  className = '',
}) {
  const dialogRef = useRef(null)
  const titleId = useId()
  const descriptionId = useId()
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useDialogFocusTrap({ open, onClose, initialFocusRef, panelRef: dialogRef })

  // Native path only: showModal()/close() are imperative -- React's `open` attribute alone only
  // gives non-modal show() semantics (no top-layer stacking, no native ::backdrop). The 'cancel'
  // event is the browser's own Escape handling for a modal <dialog>; it is redirected through
  // onClose too, so there is exactly one way this ever closes, matching the fallback path.
  // Depends only on `open` (onClose via ref) for the same reason as useDialogFocusTrap above --
  // a fresh inline onClose every parent render must not re-run showModal()/close() churn.
  useEffect(() => {
    if (!SUPPORTS_NATIVE_DIALOG || !open) return undefined
    const node = dialogRef.current
    if (!node) return undefined
    if (!node.open) node.showModal()
    const onCancel = (e) => {
      e.preventDefault()
      onCloseRef.current?.()
    }
    node.addEventListener('cancel', onCancel)
    return () => {
      node.removeEventListener('cancel', onCancel)
      if (node.open) node.close()
    }
  }, [open])

  if (!open) return null

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) onCloseRef.current?.()
  }

  const Tag = SUPPORTS_NATIVE_DIALOG ? 'dialog' : 'div'
  const fallbackSemantics = SUPPORTS_NATIVE_DIALOG ? null : { role: 'dialog' }

  return (
    <Tag
      ref={dialogRef}
      // The focus-trap's last-resort focus target when there are zero focusable children
      // (see useDialogFocusTrap's `getFocusable()[0] || panelRef.current`) -- without this, a
      // plain <div>/<dialog> isn't focusable at all, `.focus()` is a silent no-op, and a
      // keyboard user is left parked on whatever was focused before the dialog opened.
      tabIndex={-1}
      // `className` is how a route carries its own dialog scope onto the dialog element itself.
      // It has to live here rather than on an ancestor: app.jsx mounts a route's dialogs as
      // SIBLINGS of the route (see /agent), and this component uses no portal, so a descendant
      // selector keyed off a route wrapper silently matches nothing for exactly the dialogs that
      // are mounted at route level. Foundation's own geometry is unchanged when it is omitted.
      className={`pc-dialog pc-dialog--${mode}${className ? ` ${className}` : ''}`}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onClick={handleOverlayClick}
      {...fallbackSemantics}
    >
      <div className="pc-dialog-panel">
        <h2 id={titleId} className="pc-dialog-title">
          {title}
        </h2>
        {description && (
          <p id={descriptionId} className="pc-dialog-description">
            {description}
          </p>
        )}
        <div className="pc-dialog-body">{children}</div>
        {actions && <div className="pc-dialog-actions">{actions}</div>}
      </div>
    </Tag>
  )
}
