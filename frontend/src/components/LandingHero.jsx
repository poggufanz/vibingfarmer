import { useRef } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import NavBar from './NavBar.jsx'
import LandingFx from './LandingFx.jsx'
import './LandingHero.css'

const BOUNDS = [
  {
    title: 'Budget',
    copy: 'SEP-41 caps the router total. Each worker also enforces a per-period amount cap and only approved contract functions.',
    className: 'vf-bound--budget',
  },
  {
    title: 'One vault',
    copy: 'Each worker is deployed for one approved vault. Its session key cannot redirect deposits elsewhere.',
    className: 'vf-bound--vault',
  },
  {
    title: 'Expiry',
    copy: 'Agent scope and token allowance stop working after their on-chain expiry.',
    className: 'vf-bound--expiry',
  },
  {
    title: 'Revoke',
    copy: 'Set the router allowance to zero with your wallet. The global spending leash closes immediately.',
    className: 'vf-bound--revoke',
  },
]

const RUN_FLOW = [
  {
    title: 'Set your intent',
    copy: 'Choose a USDC amount, risk level, and number of worker agents.',
  },
  {
    title: 'Review the plan',
    copy: 'The strategist proposes an allocation. Review and edit every worker skill before approval.',
  },
  {
    title: 'Grant once',
    copy: 'One wallet signature creates the budget, expiry, and fresh scoped agent accounts.',
  },
  {
    title: 'Let workers execute',
    copy: 'Failure-isolated workers pull only their share and deposit through the sponsored relay.',
  },
  {
    title: 'Keep earning',
    copy: 'The vault supplies Blend. The keeper compounds, while Lifeboat watches for mandate-authorized de-risking.',
  },
]

const PROOF = [
  { value: '1', label: 'wallet signature for the initial grant' },
  { value: '0 XLM', label: 'paid by you on sponsored calls' },
  { value: '1 vault', label: 'maximum target per worker' },
  { value: '~6 sec', label: 'Lifeboat market scan cadence' },
]

const CAPITAL_PATH = [
  { label: 'User intent', value: 'USDC budget' },
  { label: 'Scoped execution', value: 'Agent accounts' },
  { label: 'Share ledger', value: 'vfVLT vault' },
  { label: 'Yield source', value: 'Blend v2' },
]

const landingEaseOut = [0.23, 1, 0.32, 1]
const heroTransition = { duration: 0.5, ease: landingEaseOut }
const revealTransition = { duration: 0.4, ease: landingEaseOut }
const reducedRevealTransition = { duration: 0.2, ease: landingEaseOut }

const capitalPathVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.06 } },
}

function Reveal({ children, className = '', delay = 0, rise = false }) {
  const reduceMotion = useReducedMotion()
  const transform = !reduceMotion && rise ? 'translateY(16px)' : 'translateY(0px)'

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, transform }}
      whileInView={{ opacity: 1, transform: 'translateY(0px)' }}
      viewport={{ once: true, amount: 0.18 }}
      transition={{
        ...(reduceMotion ? reducedRevealTransition : revealTransition),
        delay: reduceMotion ? 0 : delay,
      }}
    >
      {children}
    </motion.div>
  )
}

function CapitalPath() {
  const reduceMotion = useReducedMotion()
  const stepVariants = {
    hidden: {
      opacity: 0,
      transform: reduceMotion ? 'translateX(0px)' : 'translateX(8px)',
    },
    visible: {
      opacity: 1,
      transform: 'translateX(0px)',
      transition: reduceMotion ? reducedRevealTransition : revealTransition,
    },
  }

  return (
    <motion.div
      className="vf-capital-path"
      variants={capitalPathVariants}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.3 }}
    >
      {CAPITAL_PATH.map((step) => (
        <motion.div key={step.label} variants={stepVariants}>
          <span>{step.label}</span>
          <strong>{step.value}</strong>
        </motion.div>
      ))}
    </motion.div>
  )
}

export function Player({ src, reduceMotion = false, label = 'Video', priority = false }) {
  return (
    <figure className="vf-media">
      <video
        src={src}
        aria-label={label}
        autoPlay={!reduceMotion}
        loop={!reduceMotion}
        controls={reduceMotion}
        muted
        playsInline
        preload={priority ? 'auto' : 'metadata'}
      />
      <figcaption>{label}</figcaption>
    </figure>
  )
}

function ProductImage({ src, alt, caption, priority = false }) {
  return (
    <figure className="vf-media">
      <img src={src} alt={alt} width="1448" height="1086" loading={priority ? 'eager' : 'lazy'} />
      <figcaption>{caption}</figcaption>
    </figure>
  )
}

function Hero({ onStart, reduceMotion }) {
  const itemVariants = {
    hidden: {
      opacity: 0,
      transform: reduceMotion ? 'translateY(0px)' : 'translateY(20px)',
    },
    visible: {
      opacity: 1,
      transform: 'translateY(0px)',
      transition: reduceMotion ? reducedRevealTransition : heroTransition,
    },
  }

  return (
    <header className="vf-hero" data-xray>
      <motion.div
        className="vf-hero__copy"
        initial="hidden"
        animate="visible"
        variants={{
          hidden: {},
          visible: reduceMotion ? {} : { transition: { staggerChildren: 0.06 } },
        }}
      >
        <motion.p className="vf-kicker" variants={itemVariants}>
          Autonomous yield on Stellar
        </motion.p>
        <motion.h1 variants={itemVariants}>
          One signature.
          <span>Bounded workers.</span>
        </motion.h1>
        <motion.p className="vf-hero__lede" variants={itemVariants}>
          Set risk and a USDC budget. Scoped agents enter real Blend lending without repeated
          approvals or XLM on sponsored calls.
        </motion.p>
        <motion.div className="vf-hero__actions" variants={itemVariants}>
          <button className="vf-button vf-button--primary" onClick={onStart}>
            Launch app
          </button>
          <a className="vf-text-link" href="#how-it-works">
            See how it works
          </a>
        </motion.div>
      </motion.div>

      <motion.div
        className="vf-hero__media"
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, transform: 'translateX(32px)' }}
        animate={{ opacity: 1, transform: 'translateX(0px)' }}
        transition={reduceMotion ? reducedRevealTransition : { ...heroTransition, delay: 0.16 }}
      >
        <ProductImage
          src="/vf-bounded-swarm.png"
          alt="Four bounded execution paths carry capital through individual limiter gates into one vault"
          caption="Concept view: one grant routes capital through four independently scoped workers."
          priority
        />
      </motion.div>

      {/* Hidden schematic revealed by the x-ray cursor lens (see LandingFx). */}
      <div className="vf-hero__xray" aria-hidden="true">
        <div className="vf-xray-box vf-xray-box--grant">
          <span>funding_router.grant(budget, expiry)</span>
          <em>1 wallet signature — the only leash you hold</em>
        </div>
        <div className="vf-xray-box vf-xray-box--agents">
          <span>agent_account × N</span>
          <em>ephemeral ed25519 session keys · __check_auth enforced on-chain</em>
        </div>
        <div className="vf-xray-box vf-xray-box--relay">
          <span>/api/stellar-relay</span>
          <em>fee-bump sponsor · allowlisted ops only</em>
        </div>
        <div className="vf-xray-box vf-xray-box--vault">
          <span>vault.deposit → Blend v2</span>
          <em>real testnet lending, not a mock drip</em>
        </div>
        <div className="vf-xray-tag">X-RAY // the machine under the marketing</div>
      </div>
      <span className="vf-hero__xray-hint" aria-hidden="true">
        ( move your cursor — x-ray the machine )
      </span>
    </header>
  )
}

function ProofStrip() {
  return (
    <section className="vf-proof" aria-label="Product facts">
      {PROOF.map((item) => (
        <div className="vf-proof__item" key={item.label}>
          <strong>{item.value}</strong>
          <span>{item.label}</span>
        </div>
      ))}
    </section>
  )
}

function ProblemSection() {
  return (
    <section className="vf-section vf-problem" aria-labelledby="problem-title">
      <Reveal className="vf-problem__statement" rise>
        <p className="vf-kicker">Why it exists</p>
        <h2 id="problem-title">Yield farming should not feel like clerical work.</h2>
        <p>
          Traditional flows make you research, approve, deposit, harvest, and repeat. Full-wallet
          bots remove the clicks by removing the boundary.
        </p>
      </Reveal>

      <div className="vf-contrast">
        <div className="vf-contrast__column">
          <span className="vf-contrast__label">Typical flow</span>
          <p>Find a vault, check risk, approve, deposit, harvest, sign again, repeat.</p>
        </div>
        <div className="vf-contrast__column vf-contrast__column--vf">
          <span className="vf-contrast__label">Vibing Farmer</span>
          <p>Set intent, review the boundaries, sign once, watch scoped workers execute.</p>
        </div>
      </div>
    </section>
  )
}

function FlowSection() {
  return (
    <section className="vf-section vf-flow" id="how-it-works" aria-labelledby="flow-title">
      <Reveal className="vf-flow__intro" rise>
        <h2 id="flow-title">From intent to working capital.</h2>
        <p>
          The first grant turns one reviewed decision into a bounded workforce. Valid repeat runs
          can continue without another signature while scope and allowance remain active.
        </p>
      </Reveal>

      <div className="vf-flow__list">
        <span className="vf-flow__line" aria-hidden="true" />
        {RUN_FLOW.map((item, i) => (
          <div className="vf-flow__row" key={item.title}>
            <span className="vf-flow__num" aria-hidden="true">
              {String(i + 1).padStart(2, '0')}
            </span>
            <h3>{item.title}</h3>
            <p>{item.copy}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

function BoundsSection() {
  return (
    <section className="vf-section vf-bounds" aria-labelledby="bounds-title">
      <Reveal className="vf-bounds__header" rise>
        <h2 id="bounds-title">Autonomy, with a leash.</h2>
        <p>
          The AI proposes a plan. Soroban decides what each agent is allowed to do. The security
          boundary lives on-chain, not inside a prompt.
        </p>
      </Reveal>

      <div className="vf-bounds__wrap">
        {/* The leash, literally: a line draws itself around the bounds. */}
        <svg className="vf-bounds__leash" aria-hidden="true" preserveAspectRatio="none">
          <rect pathLength="100" />
        </svg>
        <div className="vf-bounds__grid">
          {BOUNDS.map((item) => (
            <div className={`vf-bound ${item.className}`} key={item.title}>
              <h3>{item.title}</h3>
              <p>{item.copy}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function IntelligenceSection() {
  return (
    <section className="vf-section vf-intelligence" aria-labelledby="intelligence-title">
      <Reveal className="vf-intelligence__copy" rise>
        <h2 id="intelligence-title">AI plans. Rules can say no.</h2>
        <p>
          Models propose allocations, but they never become the spending boundary. Deterministic
          checks and the user stay in the approval path.
        </p>
        <div className="vf-decision-stack">
          <div>
            <strong>Strategist</strong>
            <span>Uses live context, then falls back safely if an AI provider is unavailable.</span>
          </div>
          <div>
            <strong>Council</strong>
            <span>Yield, Risk, and Market specialists debate. Risk has hard veto power.</span>
          </div>
          <div>
            <strong>Eligibility gate</strong>
            <span>Missing or stale protocol facts cause rejection, not optimistic execution.</span>
          </div>
          <div>
            <strong>Simulation</strong>
            <span>A seeded 200-scenario check tests the allocation across a 30-day horizon.</span>
          </div>
        </div>
      </Reveal>

      <Reveal className="vf-intelligence__media" delay={0.08} rise>
        <ProductImage
          src="/vf-risk-gates.png"
          alt="A signal path passes through three physical inspection gates while a rejected branch remains closed"
          caption="Concept view: a proposal passes the strategist, council, and eligibility gate before execution."
        />
      </Reveal>
    </section>
  )
}

function YieldSection() {
  return (
    <section className="vf-section vf-yield" aria-labelledby="yield-title">
      <Reveal className="vf-yield__lead" rise>
        <p className="vf-kicker">Stellar testnet</p>
        <h2 id="yield-title">Real lending underneath.</h2>
        <p>
          Deposited USDC becomes vault shares, then the strategy supplies Blend Capital v2. Interest
          and BLND rewards are harvested rather than simulated in the interface.
        </p>
      </Reveal>

      <div className="vf-capital-wrap">
        <CapitalPath />
        <div className="vf-capital-flow" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>

      <div className="vf-operations">
        <div className="vf-operation">
          <span className="vf-operation__meta">Routine</span>
          <h3>The keeper compounds.</h3>
          <p>
            A separate keeper identity harvests and re-supplies gains on a schedule, within contract
            cooldowns and movement caps.
          </p>
        </div>
        <div className="vf-operation vf-operation--lifeboat">
          <span className="vf-operation__meta">Emergency</span>
          <h3>Lifeboat needs a mandate.</h3>
          <p>
            The radar scans each ledger. It can pull capital to vault-idle only while your
            time-boxed mandate is active. Otherwise it alarms and does nothing.
          </p>
        </div>
      </div>
    </section>
  )
}

function RelaySection() {
  return (
    <section className="vf-section vf-relay" aria-labelledby="relay-title">
      <div className="vf-relay__number">
        <strong>0 XLM</strong>
        <span>required from your wallet for sponsored calls</span>
      </div>
      <Reveal className="vf-relay__copy" delay={0.08} rise>
        <h2 id="relay-title">The relay pays. It does not control principal.</h2>
        <p>
          Vibing Farmer wraps approved Stellar transactions in a fee-bump. The server pays the
          network fee and rejects calls outside a short allowlist.
        </p>
        <p className="vf-note">
          For the initial grant, relay failure can fall back to direct user-paid submission instead
          of hiding the network fee. Worker failures remain isolated and visible.
        </p>
      </Reveal>
    </section>
  )
}

function ObservabilitySection() {
  return (
    <section className="vf-section vf-observe" aria-labelledby="observe-title">
      <Reveal className="vf-observe__copy" rise>
        <h2 id="observe-title">Watch the swarm work.</h2>
        <p>
          The operations console shows workers, council decisions, positions, keeper activity, and
          Lifeboat state. Strategy hashes can also be attested on-chain.
        </p>
      </Reveal>
      <div className="vf-observe__panel">
        <dl className="vf-observe__facts">
          <div>
            <dt>Execution</dt>
            <dd>Failure-isolated, with worker submissions paced for relay limits</dd>
          </div>
          <div>
            <dt>Memory</dt>
            <dd>Per-agent results and lessons stored for inspection and later runs</dd>
          </div>
          <div>
            <dt>Exit</dt>
            <dd>User redemption remains available independently of keeper automation</dd>
          </div>
        </dl>
      </div>
    </section>
  )
}

function HonestySection() {
  return (
    <section className="vf-section vf-honesty" aria-labelledby="honesty-title">
      <Reveal className="vf-honesty__intro" rise>
        <h2 id="honesty-title">Real where it counts. Clear where it is not.</h2>
        <p>
          The core route stays on Stellar testnet. An optional farm route bridges USDC through CCTP
          to Base Sepolia under a ZeroDev session-key policy, then reverses the corridor to unwind.
          Proven mechanisms and stand-ins stay clearly separated below.
        </p>
      </Reveal>

      <div className="vf-honesty__groups">
        <div className="vf-honesty__group">
          <h3>Live-proven on testnet</h3>
          <p>
            One-signature grant, Blend lending position, fee-bump relay, Lifeboat drill, and CCTP
            corridor.
          </p>
        </div>
        <div className="vf-honesty__group">
          <h3>Explicit stand-in</h3>
          <p>
            Base Sepolia pools custody bridged USDC one-to-one. They do not fabricate yield. The
            Aave adapter is built but not deployed there.
          </p>
        </div>
        <div className="vf-honesty__group">
          <h3>Precision note</h3>
          <p>
            Workers are independent but paced two seconds apart. One failure does not abort the
            others, which is the swarm property that matters.
          </p>
        </div>
      </div>
    </section>
  )
}

// Ecosystem strip: icons where the brand ships one (simple-icons, in each brand's own
// official color), styled wordmarks for the rest so the row still reads as one system.
// Exported so EcosystemPage renders the SAME set — one source of truth for the stack.
export const ECOSYSTEM = [
  // Soroban is Stellar's own smart-contract platform (same ecosystem, not a separate one) —
  // named together on one card, as the retired PARTNERS list already did.
  { name: 'Stellar / Soroban', icon: '/logos/stellar.svg' },
  { name: 'Blend Capital', icon: '/logos/blend.svg' },
  { name: 'Base', icon: '/logos/base.svg' },
  { name: 'Circle CCTP', icon: '/logos/circle.svg' },
  { name: 'OpenZeppelin', icon: '/logos/openzeppelin.svg' },
  { name: 'DeFiLlama', icon: '/logos/defillama.svg' },
  { name: 'ZeroDev', icon: '/logos/zerodev.svg' },
]

function EcosystemBand() {
  const sequence = (key) => (
    <span className="vf-marquee__seq" key={key}>
      {ECOSYSTEM.map((item) => (
        <span className="vf-marquee__logo" key={item.name}>
          {item.icon ? <img src={item.icon} alt="" loading="lazy" /> : null}
          {item.name}
        </span>
      ))}
    </span>
  )

  return (
    <div className="vf-marquee vf-marquee--logos" aria-hidden="true">
      <div className="vf-marquee__track">
        {sequence('a')}
        {sequence('b')}
      </div>
    </div>
  )
}

function FinalSection({ onStart }) {
  return (
    <section className="vf-final" aria-labelledby="final-title">
      <Reveal className="vf-final__inner" rise>
        <p className="vf-final__tagline">Set once. Vibe forever.</p>
        <h2 id="final-title">Set your bounds. Let the system do the work.</h2>
        <p>Choose the budget, risk, and workers. Review the plan. Sign once.</p>
        <button className="vf-button vf-button--secondary" onClick={onStart}>
          Launch app
        </button>
      </Reveal>
    </section>
  )
}

export default function LandingHero({ onStart }) {
  const reduceMotion = useReducedMotion()
  const rootRef = useRef(null)

  return (
    <div className="vf-landing" ref={rootRef}>
      <LandingFx rootRef={rootRef} />
      <NavBar onLaunch={onStart} />
      <main>
        <Hero onStart={onStart} reduceMotion={reduceMotion} />
        <ProofStrip />
        <ProblemSection />
        <FlowSection />
        <BoundsSection />
        <IntelligenceSection />
        <YieldSection />
        <RelaySection />
        <ObservabilitySection />
        <HonestySection />
        <EcosystemBand />
        <FinalSection onStart={onStart} />
      </main>
    </div>
  )
}
