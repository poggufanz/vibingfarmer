import { useState } from 'react'
import ZoneFrame from './ZoneFrame.jsx'
import WithdrawModal from '../WithdrawModal.jsx'
import { agoText } from './consoleUtils.js'
import { toDisplay } from '../../stellar/format.js'

export default function PositionsZone({
  positions = {},
  vaultMeta = {},
  lastUpdated = null,
  nowMs,
  userAddress,
  withdrawEnabled = true,
  onWithdrawSuccess,
  onNewStrategy,
}) {
  const [withdrawing, setWithdrawing] = useState(null)
  const list = Object.entries(positions).sort(
    ([, a], [, b]) => Number(b.balance) - Number(a.balance)
  )
  const total = list.reduce((s, [, p]) => s + Number(p.balance || 0), 0)
  const apyOf = (addr) => vaultMeta[addr.toLowerCase()]?.apy || 0

  return (
    <ZoneFrame
      title="positions"
      hue="neutral"
      led={list.length ? 'ok' : 'idle'}
      className="console-positions"
      meta={lastUpdated ? agoText(lastUpdated, nowMs) : null}
    >
      {list.length === 0 ? (
        <div className="zone-empty">
          no active positions
          <br />
          <button className="btn btn-ghost pos-cta" onClick={onNewStrategy}>
            deploy from strategy flow →
          </button>
        </div>
      ) : (
        list.map(([addr, p]) => {
          const apy = apyOf(addr)
          const bal = toDisplay(p.balance)
          const pct = total > 0 ? (Number(p.balance) / total) * 100 : 0
          const meta = vaultMeta[addr.toLowerCase()] || {}
          return (
            <div key={addr} className="pos-card">
              <div className="pos-head">
                <div className="pos-name">{p.vaultName}</div>
                <span className="pos-bal tnum">{bal.toFixed(2)}</span>
              </div>
              <div className="pos-sub mono">
                {meta.protocol ? `${meta.protocol} · ` : ''}
                {apy.toFixed(1)}% apy · +{((bal * (apy / 100)) / 365).toFixed(4)}/day
              </div>
              <div className="pos-alloc">
                <div className="pos-alloc-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="pos-foot">
                <span className="mono pos-pct tnum">{pct.toFixed(0)}% of portfolio</span>
                <button
                  className="btn btn-ghost pos-cta"
                  disabled={!withdrawEnabled}
                  onClick={() =>
                    setWithdrawing({
                      vault: {
                        name: p.vaultName,
                        address: addr,
                        protocol: meta.protocol || '',
                        apy,
                      },
                      balance: p.balance,
                      unclaimedRewards: p.unclaimedRewards,
                    })
                  }
                >
                  withdraw →
                </button>
              </div>
            </div>
          )
        })
      )}
      {withdrawing && (
        <WithdrawModal
          vault={withdrawing.vault}
          balance={withdrawing.balance}
          unclaimedRewards={withdrawing.unclaimedRewards}
          userAddress={userAddress}
          onClose={() => setWithdrawing(null)}
          onSuccess={onWithdrawSuccess || (() => {})}
        />
      )}
    </ZoneFrame>
  )
}
