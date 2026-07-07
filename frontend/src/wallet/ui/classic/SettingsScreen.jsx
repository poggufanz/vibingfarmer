export default function SettingsScreen({ onLock, onExport, autoLockMin, onSetAutoLock }) {
  return (
    <div className="vf-screen vf-settings">
      <h2>Settings</h2>

      <div style={{
        display: 'flex', flexDirection: 'column', gap: '2px',
        background: 'var(--bg-elev)', borderRadius: 'var(--r-lg)',
        border: '1px solid var(--border)', overflow: 'hidden'
      }}>
        <button
          className="vf-btn"
          style={{
            borderRadius: 0, border: 'none', borderBottom: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'flex-start',
            background: 'transparent', padding: '14px 14px'
          }}
          onClick={onLock}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
          </svg>
          Lock now
        </button>

        <label style={{
          padding: '14px', borderBottom: '1px solid var(--border)',
          display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '8px'
        }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 6 12 12 16 14"></polyline>
          </svg>
          <span style={{ flex: 1 }}>Auto-lock (min)</span>
          <input
            type="number"
            min={1}
            max={60}
            value={autoLockMin}
            onChange={(e) => onSetAutoLock(Number(e.target.value))}
            style={{ width: 56, textAlign: 'center' }}
          />
        </label>

        <button
          className="vf-btn ghost"
          style={{
            borderRadius: 0, border: 'none',
            display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'flex-start',
            padding: '14px 14px'
          }}
          onClick={onExport}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="17 8 12 3 7 8"></polyline>
            <line x1="12" y1="3" x2="12" y2="15"></line>
          </svg>
          Export secret
        </button>
      </div>
    </div>
  )
}
