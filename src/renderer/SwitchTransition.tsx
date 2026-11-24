import logo from '../../assets/devshift.png'
import type { Mode, SwitchState } from '../shared/contracts.js'

export function SwitchTransition({ direction, state, error }: {
  direction: Mode; state: SwitchState | null; error: string | null
}) {
  const gaming = direction === 'gaming'
  const attention = Boolean(error) || Boolean(state && !state.busy && ['FAILED', 'PARTIAL_SUCCESS', 'RECOVERY_REQUIRED'].includes(state.phase))
  const summary = error ? 'The switch needs attention.' : state?.summary ?? 'Checking the reviewed workloads…'
  return (
    <section className={'switch-scene switch-' + direction + (attention ? ' switch-attention' : '')} aria-label="Mode transition">
      <div className="switch-copy">
        <h3>{gaming ? 'Gaming Mode' : 'Development Mode'}</h3>
        <p aria-live="polite">{summary}</p>
      </div>
      <div className="switch-motion" aria-hidden="true">
        {attention ? <img className="switch-mark" src={logo} alt="" /> : gaming ? <>
          <div className="boost-wake"><i /><i /><i /></div>
          <img className="switch-mark boost-echo" src={logo} alt="" />
          <img className="switch-mark boost-mark" src={logo} alt="" />
        </> : <>
          <span className="dev-bracket bracket-left" /><span className="dev-bracket bracket-right" />
          <img className="switch-mark dev-upper" src={logo} alt="" />
          <img className="switch-mark dev-lower" src={logo} alt="" />
          <span className="dev-scan" />
        </>}
      </div>
    </section>
  )
}
