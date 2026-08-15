// frontend/src/components/pocket/Primitives.jsx
// Pocket Crew interface primitives shared across screens (Foundation Task 5): MoneyFigure,
// StatusNotice, TechnicalDetails, VenueTruth, StageShell, and Dialog. Truthful by construction --
// MoneyFigure never coerces a missing value to 0, VenueTruth never invents an APY for the Base
// custody proxy, and Dialog only ever closes through the caller's own onClose.
import { useEffect, useId, useLayoutEffect, useRef } from 'react'
import {
  formatTokenUnits,
  normalizeAmount,
  normalizeFact,
  statusNoticeModel,
  toFreshnessView,
} from '../../design/pocket-crew-foundation.js'
import { NetworkRoute } from './NetworkIdentity.jsx'

// ---------------------------------------------------------------------------------------------
// MoneyFigure
// ---------------------------------------------------------------------------------------------

const MONEY_PLACEHOLDER = Object.freeze({
  loading: 'Loading',
  empty: 'No balance yet',
  error: 'Could not load',
  unknown: 'Unknown',
  unavailable: 'Unavailable',
})

const AMOUNT_KEYS = Object.freeze(['token', 'units', 'decimals'])
const APY_KEYS = Object.freeze(['state', 'value', 'source', 'freshness'])

function snapshotPlainDataRecord(record, allowedKeys, exactKeys = false) {
  try {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) return null

    const prototype = Object.getPrototypeOf(record)
    if (prototype !== Object.prototype && prototype !== null) return null

    const keys = Reflect.ownKeys(record)
    if (keys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))) return null
    if (
      exactKeys &&
      (keys.length !== allowedKeys.length || allowedKeys.some((key) => !keys.includes(key)))
    ) {
      return null
    }

    const snapshot = {}
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key)
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null
      snapshot[key] = descriptor.value
    }
    return snapshot
  } catch {
    return null
  }
}

function canonicalAmount(amount) {
  const snapshot = snapshotPlainDataRecord(amount, AMOUNT_KEYS, true)
  if (!snapshot) return null
  try {
    return normalizeAmount(snapshot)
  } catch {
    return null
  }
}

function freshnessLabel(freshness) {
  if (typeof freshness === 'string') return freshness
  if (freshness === null || typeof freshness !== 'object') return ''
  return freshness.label || freshness.checkedAt || freshness.state || ''
}

function groupFormattedUnits(formatted) {
  const match = /^(\d+)(\.\d+)?$/.exec(formatted)
  if (!match) return formatted
  const [, integer, fraction = ''] = match
  return `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction}`
}

export function MoneyFigure({ state, amount, freshness, className = '' }) {
  // Object.hasOwn (not `in`): `state="toString"`/`"constructor"` etc. must never resolve through
  // the prototype chain to a built-in function and render it as if it were a real money state.
  if (Object.hasOwn(MONEY_PLACEHOLDER, state)) {
    return (
      <span
        className={`pc-money pc-money--${state}${className ? ` ${className}` : ''}`}
        role={state === 'error' ? 'alert' : 'status'}
      >
        {MONEY_PLACEHOLDER[state]}
      </span>
    )
  }

  const normalized = canonicalAmount(amount)
  if (!normalized || !['current', 'stale'].includes(state)) {
    return (
      <span
        className={`pc-money pc-money--unavailable${className ? ` ${className}` : ''}`}
        role="status"
      >
        Unavailable
      </span>
    )
  }

  let formatted
  try {
    // BigInt arithmetic is deliberately confined to formatTokenUnits. The view model only ever
    // receives the formatter's decimal string, so no transient BigInt can leak into the DOM data.
    formatted = groupFormattedUnits(formatTokenUnits(normalized.units, normalized.decimals))
  } catch {
    return (
      <span
        className={`pc-money pc-money--unavailable${className ? ` ${className}` : ''}`}
        role="status"
      >
        Unavailable
      </span>
    )
  }

  const freshnessText = freshnessLabel(freshness)
  return (
    <span
      className={`pc-money pc-money--${state}${className ? ` ${className}` : ''}`}
      data-freshness={freshnessText || undefined}
    >
      {formatted} {normalized.token}
      {state === 'stale' && <span className="pc-money-stale-flag"> (stale)</span>}
      {freshnessText && <span className="pc-money-freshness">{freshnessText}</span>}
    </span>
  )
}

// ---------------------------------------------------------------------------------------------
// StatusNotice
// ---------------------------------------------------------------------------------------------

const STATUS_ICON = Object.freeze({ info: 'i', success: 'OK', warning: '!', danger: 'X' })

const LEGACY_STATUS_TONES = Object.freeze({
  info: 'info',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
})

const present = (value) => value !== null && value !== undefined && value !== ''

function factFreshness(fact) {
  if (!fact) return null
  try {
    return toFreshnessView(fact)
  } catch {
    return null
  }
}

export function StatusNotice({ fact, state = 'info', title, children, action }) {
  const hasFact = fact !== null && typeof fact === 'object'
  let model = null
  let freshness = null
  if (hasFact) {
    try {
      const normalized = normalizeFact(fact)
      model = statusNoticeModel(normalized)
      freshness = factFreshness(normalized)
    } catch {
      model = statusNoticeModel({ state: 'unavailable' })
      freshness = factFreshness({ state: 'unavailable' })
    }
  }

  const tone = model?.tone || LEGACY_STATUS_TONES[state] || 'info'
  const role = tone === 'danger' || tone === 'warning' ? 'alert' : 'status'
  return (
    <div
      className={`pc-status-notice pc-status-notice--${tone}`}
      role={role}
      data-state={model?.state || undefined}
    >
      <span className="pc-status-notice-icon" aria-hidden="true">
        {STATUS_ICON[tone] || STATUS_ICON.info}
      </span>
      <div className="pc-status-notice-body">
        {title && <p className="pc-status-notice-title">{title}</p>}
        {model && <p className="pc-status-notice-label">{model.label}</p>}
        {model?.consequence && <p className="pc-status-notice-consequence">{model.consequence}</p>}
        {model?.nextAction && <p className="pc-status-notice-next-action">{model.nextAction}</p>}
        {model?.source && (
          <p className="pc-status-notice-source">
            Source: <span>{model.source}</span>
          </p>
        )}
        {freshness && (present(freshness.checkedAt) || present(freshness.staleAfterMs)) && (
          <p className="pc-status-notice-freshness">
            Checked at: <span>{freshness.checkedAt ?? 'Unavailable'}</span>
            {present(freshness.staleAfterMs) && (
              <>
                {' '}
                Stale after: <span>{freshness.staleAfterMs}</span>
              </>
            )}
          </p>
        )}
        {children && <div className="pc-status-notice-content">{children}</div>}
      </div>
      {action && <div className="pc-status-notice-action">{action}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// TechnicalDetails
// ---------------------------------------------------------------------------------------------

const technicalValue = (value) => (present(value) ? String(value) : 'Unavailable')

export function TechnicalDetails({ summary = 'Technical details', fact, children, open = false }) {
  const freshness = factFreshness(fact)
  return (
    <details
      className="pc-technical-details"
      open={open}
      data-fact-phase={freshness?.phase || undefined}
      data-fact-state={freshness?.state || undefined}
    >
      <summary className="pc-technical-details-summary">{summary}</summary>
      <div className="pc-technical-details-body">
        {freshness && (
          <dl className="pc-technical-details-fact">
            <div>
              <dt>Phase</dt>
              <dd className="pc-technical" data-fact-field="phase">
                {technicalValue(freshness.phase)}
              </dd>
            </div>
            <div>
              <dt>State</dt>
              <dd className="pc-technical" data-fact-field="state">
                {technicalValue(freshness.state)}
              </dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd className="pc-technical" data-fact-field="source">
                {technicalValue(freshness.source)}
              </dd>
            </div>
            <div>
              <dt>Checked at</dt>
              <dd className="pc-technical" data-fact-field="checkedAt">
                {technicalValue(freshness.checkedAt)}
              </dd>
            </div>
            <div>
              <dt>Stale after</dt>
              <dd className="pc-technical" data-fact-field="staleAfterMs">
                {technicalValue(freshness.staleAfterMs)}
              </dd>
            </div>
            <div>
              <dt>Confirmed ledger</dt>
              <dd className="pc-technical" data-fact-field="confirmedLedger">
                {technicalValue(freshness.confirmedLedger)}
              </dd>
            </div>
            <div>
              <dt>Confirmed block</dt>
              <dd className="pc-technical" data-fact-field="confirmedBlock">
                {technicalValue(freshness.confirmedBlock)}
              </dd>
            </div>
          </dl>
        )}
        {children}
      </div>
    </details>
  )
}

// ---------------------------------------------------------------------------------------------
// VenueTruth
// ---------------------------------------------------------------------------------------------

// The Base Sepolia leg is custody-only -- it never carries protocol yield, so its copy is fixed
// and `apy` is always ignored for it (a dev warning fires if a caller passes one anyway).
const BASE_PROXY_COPY = 'Base Sepolia proxy. Custody only. No protocol yield.'

function snapshotApy(apy) {
  const snapshot = snapshotPlainDataRecord(apy, APY_KEYS)
  if (!snapshot || !['live', 'estimated'].includes(snapshot.state)) return null

  const valueIsRenderable =
    (typeof snapshot.value === 'number' && Number.isFinite(snapshot.value)) ||
    (typeof snapshot.value === 'string' &&
      snapshot.value.trim() !== '' &&
      Number.isFinite(Number(snapshot.value)))
  if (!valueIsRenderable) return null

  for (const key of ['source', 'freshness']) {
    const value = snapshot[key]
    if (value !== null && value !== undefined && typeof value !== 'string') return null
  }

  return Object.freeze(snapshot)
}

function canShowApy(apy) {
  if (!apy || apy.state !== 'live') return false
  if (typeof apy.value === 'number') return Number.isFinite(apy.value)
  return (
    typeof apy.value === 'string' && apy.value.trim() !== '' && Number.isFinite(Number(apy.value))
  )
}

export function VenueTruth({ kind, venue, networkContext, apy, fact }) {
  const isLive = kind === 'stellar-live'
  const isProxy = kind === 'base-proxy'
  const isUnknown = !isLive && !isProxy
  const hasFact = fact !== null && fact !== undefined
  const freshness = factFreshness(fact)
  const normalizedApy = snapshotApy(apy)
  const apySource = hasFact ? freshness?.source : normalizedApy?.source
  const apyFreshness = hasFact ? freshness?.checkedAt : normalizedApy?.freshness
  const factAllowsApy =
    !hasFact || freshness?.state === 'current' || freshness?.state === 'confirmed'
  const showApy =
    isLive && factAllowsApy && canShowApy(normalizedApy) && Boolean(apySource && apyFreshness)

  if (isProxy && apy != null && import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.warn(
      'VenueTruth(base-proxy): `apy` is ignored -- the Base Sepolia proxy is custody-only and ' +
        'never carries protocol yield.'
    )
  }

  return (
    <div
      className={`pc-venue-truth pc-venue-truth--${isProxy ? 'proxy' : isUnknown ? 'unknown' : 'live'}`}
      data-fact-state={freshness?.state || undefined}
    >
      {isProxy ? (
        <p className="pc-venue-truth-copy">{BASE_PROXY_COPY}</p>
      ) : isUnknown ? (
        <p className="pc-venue-truth-copy">Unknown venue</p>
      ) : (
        <>
          <p className="pc-venue-truth-copy">{venue || 'Autofarm Vault'} supplies to Blend</p>
          {showApy && (
            <p className="pc-venue-truth-apy" data-apy-state={normalizedApy.state}>
              {normalizedApy.value}% APY{' '}
              <span className="pc-venue-truth-apy-source">Source: {apySource}</span>{' '}
              <span className="pc-venue-truth-apy-freshness">Checked at: {apyFreshness}</span>
            </p>
          )}
        </>
      )}
      {freshness && (
        <dl className="pc-venue-truth-freshness">
          <div>
            <dt>Source</dt>
            <dd className="pc-technical">{technicalValue(freshness.source)}</dd>
          </div>
          <div>
            <dt>Checked at</dt>
            <dd className="pc-technical">{technicalValue(freshness.checkedAt)}</dd>
          </div>
          <div>
            <dt>Stale after</dt>
            <dd className="pc-technical">{technicalValue(freshness.staleAfterMs)}</dd>
          </div>
        </dl>
      )}
      {networkContext && <NetworkRoute context={networkContext} compact />}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// StageShell
// ---------------------------------------------------------------------------------------------

export function StageShell({ eyebrow, title, description, aside, children, actions, state }) {
  const titleId = `pc-stage-title-${useId()}`
  const descriptionId = `pc-stage-description-${useId()}`
  const stateClass = typeof state === 'string' && state.trim() ? ` pc-stage-shell--${state}` : ''
  return (
    <section
      className={`pc-stage-shell${stateClass}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      data-state={state || undefined}
    >
      <div className="pc-stage-shell-surface">
        <header className="pc-stage-shell-header">
          {eyebrow && <p className="pc-stage-eyebrow">{eyebrow}</p>}
          <h1 id={titleId} className="pc-stage-title">
            {title}
          </h1>
          {description && (
            <p id={descriptionId} className="pc-stage-description">
              {description}
            </p>
          )}
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

// Dialog isolation is owned here rather than by each route. Every open Dialog acquires one
// reference-counted lock: background siblings on the path from the dialog to <body> are inert
// and hidden from assistive technology, while the body keeps its preexisting inline style until
// the last lock is released. A WeakMap keeps separate documents (iframes/tests) independent and
// lets the manager disappear with a document instead of leaking global DOM references.
const dialogIsolationStates = new WeakMap()

function snapshotAttribute(element, name) {
  return {
    present: element.hasAttribute(name),
    value: element.getAttribute(name),
  }
}

function restoreAttribute(element, name, snapshot) {
  if (snapshot.present) element.setAttribute(name, snapshot.value ?? '')
  else element.removeAttribute(name)
}

function collectDialogBackground(dialog, activeDialogs) {
  const doc = dialog?.ownerDocument
  const body = doc?.body
  if (!doc || !body || !body.contains(dialog)) return []

  const background = new Set()
  let pathNode = dialog
  let parent = dialog.parentElement

  // Walk only through <body>. The dialog and every ancestor containing it are the kept path;
  // each sibling at each level is outside that path and therefore background content. In
  // particular, this never hides the dialog itself or a wrapper that owns it.
  while (parent) {
    for (const sibling of parent.children) {
      if (
        sibling !== pathNode &&
        !activeDialogs.some(
          (activeDialog) => sibling === activeDialog || sibling.contains(activeDialog)
        )
      ) {
        background.add(sibling)
      }
    }
    if (parent === body) break
    pathNode = parent
    parent = parent.parentElement
  }

  return [...background]
}

function isolationStateFor(doc) {
  let state = dialogIsolationStates.get(doc)
  if (!state) {
    state = {
      body: null,
      bodyStyle: null,
      dialogs: new Map(),
      elements: new Map(),
    }
    dialogIsolationStates.set(doc, state)
  }
  return state
}

function restoreInertProperty(element, record) {
  if (record.inertOwnDescriptor) {
    Object.defineProperty(element, 'inert', record.inertOwnDescriptor)
  } else if (record.inertInPrototype) {
    try {
      element.inert = record.inertValue
    } catch {
      // Attribute restoration below is still exact if the host property cannot be assigned.
    }
  } else {
    try {
      delete element.inert
    } catch {
      // Ignore a non-configurable host expando; the standards attribute remains authoritative.
    }
  }
}

function forceElementInert(element) {
  // The attribute is the portable fallback (and is what jsdom exposes). In browsers that expose
  // HTMLElement.inert, setting the property also activates the platform's non-interactivity
  // semantics; the attribute write keeps the contract explicit in every DOM implementation.
  try {
    element.inert = true
  } catch {
    // A host element with a read-only inert property still accepts the standards attribute.
  }
  element.setAttribute('inert', '')
  element.setAttribute('aria-hidden', 'true')
}

function restoreElementInert(element, record) {
  // Restore an own inert descriptor exactly when one existed. Otherwise, restore an inherited
  // property value when the platform supplies one, or remove the jsdom/test expando we created.
  restoreInertProperty(element, record)
  restoreAttribute(element, 'inert', record.inertAttribute)
  restoreAttribute(element, 'aria-hidden', record.ariaHiddenAttribute)
}

function reconcileDialogIsolation(state) {
  const activeDialogs = [...state.dialogs.keys()]
  const desired = new Set()
  for (const dialog of activeDialogs) {
    for (const element of collectDialogBackground(dialog, activeDialogs)) desired.add(element)
  }

  for (const [element, record] of state.elements) {
    if (!desired.has(element)) {
      restoreElementInert(element, record)
      state.elements.delete(element)
    }
  }

  for (const element of desired) {
    if (!state.elements.has(element)) {
      const record = {
        inertAttribute: snapshotAttribute(element, 'inert'),
        ariaHiddenAttribute: snapshotAttribute(element, 'aria-hidden'),
        inertOwnDescriptor: Object.getOwnPropertyDescriptor(element, 'inert'),
        inertInPrototype: 'inert' in element,
        inertValue: element.inert,
      }
      state.elements.set(element, record)
    }
    forceElementInert(element)
  }
}

function lockedBodyStyleValue(doc, bodyStyle) {
  const styleProbe = doc.createElement('div')
  if (bodyStyle.present) styleProbe.setAttribute('style', bodyStyle.value ?? '')
  styleProbe.style.setProperty('overflow', 'hidden')
  return styleProbe.getAttribute('style') ?? 'overflow: hidden;'
}

function acquireDialogIsolation(dialog) {
  const doc = dialog?.ownerDocument
  const body = doc?.body
  if (!doc || !body || !body.contains(dialog)) return () => {}

  const state = isolationStateFor(doc)
  if (state.dialogs.size === 0) {
    state.body = body
    state.bodyStyle = {
      present: body.hasAttribute('style'),
      value: body.getAttribute('style'),
    }
    body.setAttribute('style', lockedBodyStyleValue(doc, state.bodyStyle))
  }
  const dialogRecord = state.dialogs.get(dialog)
  if (dialogRecord) dialogRecord.locks += 1
  else state.dialogs.set(dialog, { locks: 1 })
  reconcileDialogIsolation(state)

  let released = false
  return () => {
    if (released) return
    released = true

    const currentDialogRecord = state.dialogs.get(dialog)
    if (currentDialogRecord) {
      currentDialogRecord.locks -= 1
      if (currentDialogRecord.locks === 0) state.dialogs.delete(dialog)
    }
    reconcileDialogIsolation(state)

    if (state.dialogs.size === 0) {
      const lockedBody = state.body
      const bodyStyle = state.bodyStyle
      if (lockedBody && bodyStyle) {
        if (bodyStyle.present) lockedBody.setAttribute('style', bodyStyle.value ?? '')
        else lockedBody.removeAttribute('style')
      }
      state.body = null
      state.bodyStyle = null
      state.dialogs.clear()
      state.elements.clear()
      dialogIsolationStates.delete(doc)
    }
  }
}

function isFocusTargetBlocked(target) {
  let node = target
  while (node && node.nodeType === Node.ELEMENT_NODE) {
    if (node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true') return true
    node = node.parentElement
  }
  return false
}

// Escape and Tab are dispatched by one owner-document manager rather than one document listener
// per Dialog. The deepest active descendant is the topmost Dialog; otherwise, a sibling opened
// later is topmost. A close refusal leaves its record in place, so the same Dialog remains the
// only recipient until the caller actually changes `open`.
const dialogFocusStates = new WeakMap()

function focusStateFor(doc) {
  let state = dialogFocusStates.get(doc)
  if (state) return state

  state = {
    dialogs: [],
    onKeydown: null,
  }
  state.onKeydown = (event) => {
    let active = null
    for (const candidate of state.dialogs) {
      if (!active || active.panel.contains(candidate.panel)) active = candidate
      else if (!candidate.panel.contains(active.panel)) active = candidate
    }
    if (!active) return

    if (event.key === 'Escape') {
      event.preventDefault()
      active.requestCloseRef.current?.()
      return
    }
    if (event.key !== 'Tab') return

    const focusable = Array.from(active.panel.querySelectorAll(FOCUSABLE_SELECTOR))
    event.preventDefault()
    if (focusable.length === 0) return

    const currentIndex = focusable.indexOf(doc.activeElement)
    let nextIndex
    if (event.shiftKey) {
      nextIndex = currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1
    } else {
      nextIndex =
        currentIndex === focusable.length - 1 || currentIndex === -1 ? 0 : currentIndex + 1
    }
    focusable[nextIndex].focus()
  }
  dialogFocusStates.set(doc, state)
  return state
}

function registerDialogFocus({ panel, requestCloseRef, initialFocusRef }) {
  const doc = panel?.ownerDocument
  if (!doc || !panel) return () => {}

  const state = focusStateFor(doc)
  const record = { panel, requestCloseRef }
  state.dialogs.push(record)
  if (state.dialogs.length === 1) doc.addEventListener('keydown', state.onKeydown)

  const toFocus = initialFocusRef?.current || panel.querySelector(FOCUSABLE_SELECTOR) || panel
  toFocus?.focus?.()

  let released = false
  return () => {
    if (released) return
    released = true
    const index = state.dialogs.indexOf(record)
    if (index !== -1) state.dialogs.splice(index, 1)
    if (state.dialogs.length === 0) {
      doc.removeEventListener('keydown', state.onKeydown)
      dialogFocusStates.delete(doc)
    }
  }
}

function useDialogOpenerCapture({ open, openerRef }) {
  const wasOpenRef = useRef(false)

  useLayoutEffect(() => {
    if (open) {
      if (!wasOpenRef.current) openerRef.current = document.activeElement
      wasOpenRef.current = true
    } else {
      wasOpenRef.current = false
    }
  }, [open, openerRef])
}

function useDialogLifecycle({ open, dialogRef, openerRef, requestCloseRef }) {
  useLayoutEffect(() => {
    if (!open || !dialogRef.current) return undefined

    const node = dialogRef.current
    let releaseIsolation = () => {}
    let closed = false
    const restoreFocus = () => {
      const opener = openerRef.current
      if (opener?.isConnected && !isFocusTargetBlocked(opener)) opener.focus?.()
    }
    const close = () => {
      if (closed) return
      closed = true
      if (SUPPORTS_NATIVE_DIALOG && node.open) node.close()
      releaseIsolation()
      restoreFocus()
    }
    const onCancel = (event) => {
      event.preventDefault()
      requestCloseRef.current?.()
    }

    if (SUPPORTS_NATIVE_DIALOG) {
      node.addEventListener('cancel', onCancel)
      if (!node.open) node.showModal()
    }
    releaseIsolation = acquireDialogIsolation(node)

    return () => {
      if (SUPPORTS_NATIVE_DIALOG) node.removeEventListener('cancel', onCancel)
      close()
    }
  }, [open, dialogRef, openerRef, requestCloseRef])
}

// One shared focus-trap implementation for both the native <dialog> path and the role="dialog"
// fallback -- mode only ever changes CSS classes below, never this behavior. Opener capture and
// restoration belong to useDialogOpenerCapture/useDialogLifecycle so the native close happens
// before isolation release and focus restoration, including when Chromium dispatches cancel.
function useDialogFocusTrap({ open, requestCloseRef, initialFocusRef, panelRef }) {
  useEffect(() => {
    if (!open) return undefined

    return registerDialogFocus({
      panel: panelRef.current,
      requestCloseRef,
      initialFocusRef,
    })
  }, [open, initialFocusRef, panelRef, requestCloseRef])
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
  const openerRef = useRef(null)
  const requestCloseRef = useRef(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  requestCloseRef.current = () => {
    onCloseRef.current?.()
  }

  // Hook order is intentional: capture the opener before the lifecycle calls showModal(), then
  // let the lifecycle own native close -> isolation release -> opener focus restoration. The
  // focus trap only manages keyboard containment and never races that close sequence.
  useDialogOpenerCapture({ open, openerRef })
  useDialogLifecycle({ open, dialogRef, openerRef, requestCloseRef })
  useDialogFocusTrap({ open, requestCloseRef, initialFocusRef, panelRef: dialogRef })

  if (!open) return null

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) requestCloseRef.current?.()
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
