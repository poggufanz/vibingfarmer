export default function SettingsScreen({ onLock, onExport, autoLockMin, onSetAutoLock }) {
  return (
    <div className="vf-screen vf-settings">
      <h2>Settings</h2>
      <button className="vf-btn" onClick={onLock}>
        Lock now
      </button>
      <label>
        Auto-lock (minutes)
        <input
          type="number"
          min={1}
          max={60}
          value={autoLockMin}
          onChange={(e) => onSetAutoLock(Number(e.target.value))}
        />
      </label>
      <button className="vf-btn ghost" onClick={onExport}>
        Export secret (password required, shown once)
      </button>
    </div>
  )
}
