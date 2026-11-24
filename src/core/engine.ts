import { randomUUID } from 'node:crypto'
import type { Dashboard, Mode, OperationItem, Phase, ReviewTarget, Settings, SwitchPreview, SwitchState } from '../shared/contracts.js'
import { sameFile, stopOrder } from './discovery.js'
import {
  errorMessage, ongoing, pending, sameIdentity, serviceKey, timestamp, UserError,
} from './model.js'
import type { ChangeResult, Cycle, Device, Host, JournalStep, NodeWorkload, Outcome } from './model.js'
import type { Store } from './store.js'

interface Review {
  token: string
  expires: number
  target: ReviewTarget
  direction: Mode
  cycle: Cycle
  steps: JournalStep[]
}

const phaseName = (direction: Mode) => direction === 'gaming' ? 'Gaming Mode' : 'Development Mode'
const preparation = (direction: Mode): Phase => direction === 'gaming' ? 'PREPARING_GAMING' : 'PREPARING_DEVELOPMENT'
const switching = (direction: Mode): Phase => direction === 'gaming' ? 'SWITCHING_TO_GAMING' : 'RESTORING_DEVELOPMENT'
const canRetry = (step: JournalStep, direction: Mode) =>
  direction === 'gaming' ? ['pending', 'running', 'failed'].includes(step.gaming.status)
    : step.gaming.effect !== 'none' && !['succeeded', 'skipped'].includes(step.development.status)

function item(step: JournalStep, direction: Mode): OperationItem {
  const outcome = step[direction]
  return { id: step.id, label: step.label, detail: direction === 'gaming' ? step.forward : step.backward,
    status: outcome.status, message: outcome.message }
}

export class Engine {
  private busy = false
  private cycle: Cycle | null
  private reviewPlan: Review | null = null
  private device: Device | null = null
  private scanPromise: Promise<Device> | null = null
  private installedAt = 0

  constructor(private readonly store: Store, private readonly host: Host, private readonly publish: (state: SwitchState) => void = () => {}) {
    this.cycle = store.active()
    if (this.cycle && ongoing.has(this.cycle.phase)) {
      this.cycle.phase = 'RECOVERY_REQUIRED'
      this.cycle.summary = 'An earlier switch was interrupted. Review the saved actions before continuing.'
      this.log(this.cycle, 'Recovery required', this.cycle.summary, 'failed')
      this.save(this.cycle)
    }
  }

  state(): SwitchState {
    const cycle = this.cycle
    if (!cycle) {
      const last = this.store.latest()
      return {
        mode: 'development', phase: last?.phase === 'PARTIAL_SUCCESS' ? last.phase : 'DEVELOPMENT',
        direction: last?.direction ?? null, busy: this.busy, hasSnapshot: false,
        transactionId: last?.id ?? null, progress: last?.steps.filter(step => step.gaming.effect !== 'none')
          .map(step => item(step, 'development')) ?? [],
        updatedAt: last?.updatedAt ?? null, summary: last?.summary ?? 'Ready to review a switch.',
      }
    }
    const hasChanges = cycle.steps.some(step => step.gaming.effect !== 'none')
    const mode = cycle.phase === 'GAMING' || cycle.phase === 'PARTIAL_SUCCESS' || hasChanges ? 'gaming' : 'development'
    return {
      mode, phase: cycle.phase, direction: cycle.direction, busy: this.busy, hasSnapshot: true,
      transactionId: cycle.id,
      progress: [
        ...cycle.steps.filter(step => cycle.direction === 'gaming' || step.gaming.effect !== 'none').map(step => item(step, cycle.direction)),
        ...(cycle.direction === 'gaming' ? cycle.blocked.map((message, index) => ({
          id: 'blocked:' + index, label: 'Skipped approved change', detail: '', message, status: 'skipped' as const,
        })) : []),
      ],
      updatedAt: cycle.updatedAt, summary: cycle.summary,
    }
  }

  private async read(): Promise<Device> {
    if (this.scanPromise) return this.scanPromise
    const installed = Date.now() - this.installedAt > 120_000
    this.scanPromise = this.host.read(installed).then(device => {
      this.device = device
      if (installed) this.installedAt = Date.now()
      return device
    }).finally(() => { this.scanPromise = null })
    return this.scanPromise
  }

  async dashboard(refresh = false): Promise<Dashboard> {
    const age = this.device ? Date.now() - Date.parse(this.device.scannedAt) : Infinity
    const device = !this.device || (!this.busy && (refresh || age >= this.store.settings.scanInterval)) ? await this.read() : this.device
    return {
      state: this.state(), settings: this.store.settings, workloads: device.workloads,
      installed: device.scan.installed, power: device.scan.power, build: device.scan.build, scannedAt: device.scannedAt, history: this.store.recent(),
    }
  }

  private log(cycle: Cycle, title: string, message: string, status: OperationItem['status']) {
    cycle.history.push({ id: randomUUID(), time: timestamp(), title, message, status })
  }

  private save(cycle: Cycle, active = true) {
    cycle.updatedAt = timestamp()
    this.store.save(cycle, active)
    this.cycle = active ? cycle : null
    this.publish(this.state())
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) throw new UserError('DevShift is already working on another request.')
    this.busy = true
    try { return await work() } finally { this.busy = false; this.publish(this.state()) }
  }

  private prepareGaming(device: Device): Cycle {
    const cycle: Cycle = {
      schema: 1, id: randomUUID(), originalMode: 'development', originalPower: device.scan.power.active,
      createdAt: timestamp(), updatedAt: timestamp(), direction: 'gaming', phase: 'PREPARING_GAMING',
      notices: [], blocked: [], steps: [], history: [], summary: 'Saving a recovery snapshot.',
    }
    const add = (id: string, label: string, captured: JournalStep['captured'], forward: string, backward: string) =>
      cycle.steps.push({ id, label, captured, forward, backward, gaming: pending(), development: pending() })

    for (const node of device.nodes) {
      const { configuration, process, ready, sessionId } = node
      if (node.state === 'stopped') continue
      if (!ready || !process || !sessionId || !process.started || !process.path) {
        cycle.blocked.push(configuration.label + ' stays open. ' + node.detail)
        continue
      }
      add(configuration.id, configuration.label, {
        kind: 'node', configuration, sessionId, identity: { pid: process.pid, started: process.started, path: process.path },
      }, 'Request the project’s graceful shutdown.', 'Relaunch the project and wait for readiness.')
    }

    const approvals = this.store.approvals
    const services = device.scan.services.filter(service => approvals[serviceKey(service.name)] === service.fingerprint)
    const candidates = services.filter(service => {
      if (service.state === 'stopped') return false
      if (service.state === 'running' && service.supported && service.canControl && service.acceptStop && service.pid > 0) return true
      cycle.blocked.push(service.label + ' stays active. ' + (service.limitation ?? 'Windows cannot confirm a graceful stop.'))
      return false
    })
    const { ordered, blocked } = stopOrder(candidates)
    for (const service of blocked) cycle.blocked.push(service.label + ' stays active because it has an active dependent service.')
    for (const service of ordered) add(serviceKey(service.name), service.label, {
      kind: 'service', name: service.name, fingerprint: service.fingerprint, pid: service.pid,
      requires: service.requires.map(link => link.name), dependents: service.dependents.map(link => link.name),
    }, 'Stop this approved Windows service.', 'Start this Windows service and check its reported state.')

    const target = this.store.settings.gamingPlan
    const next = device.scan.power.plans.find(plan => plan.id === target)
    if (target && !next) cycle.blocked.push('The preferred gaming power plan is unavailable.')
    if (next && next.id !== cycle.originalPower) {
      const original = device.scan.power.plans.find(plan => plan.id === cycle.originalPower)?.name ?? 'original plan'
      add('power', 'Power plan', { kind: 'power', before: cycle.originalPower, after: next.id },
        original + ' to ' + next.name, next.name + ' to ' + original)
    }

    const observed = [...new Set(device.workloads.filter(row => row.state === 'running' && !row.approved).map(row => row.label))]
    if (observed.length) cycle.notices.push('Left running: ' + observed.join(', ') + '.')
    if (device.workloads.some(row => row.category === 'Editor' && row.state === 'running'))
      cycle.notices.push('DevShift cannot verify unsaved editor work. Open editors stay running.')
    if (cycle.steps.some(step => step.captured.kind === 'node'))
      cycle.notices.push('Restored projects start as fresh processes. In-memory state is unavailable.')
    if (cycle.steps.some(step => step.captured.kind === 'service'))
      cycle.notices.push('Confirm that other applications and clients can tolerate the selected service interruption.')
    return cycle
  }

  async review(target: ReviewTarget): Promise<SwitchPreview> {
    return this.exclusive(async () => {
      const active = this.cycle
      const keep = target === 'keep'
      if (keep) {
        if (!active || !['RECOVERY_REQUIRED', 'FAILED', 'PARTIAL_SUCCESS'].includes(active.phase))
          throw new UserError('There is no pending recovery to close.')
        const token = randomUUID()
        this.reviewPlan = { token, target, expires: Date.now() + 120_000, cycle: active, steps: [], direction: 'development' }
        return { token, direction: 'development', recovery: true, keep: true, items: [],
          notices: ['This closes recovery and keeps all current Windows settings and workloads. You can review the saved history afterward.'] }
      }
      const device = await this.read()
      let cycle: Cycle
      let direction: Mode
      if (!active && target === 'gaming') {
        cycle = this.prepareGaming(device)
        direction = 'gaming'
      } else if (active && target === 'development') {
        cycle = active
        direction = 'development'
      } else if (active && target === 'resume' && ['RECOVERY_REQUIRED', 'FAILED', 'PARTIAL_SUCCESS'].includes(active.phase)) {
        cycle = active
        direction = active.direction
      } else throw new UserError('This switch is unavailable in the current mode.')

      const steps = cycle.steps.filter(step => canRetry(step, direction))
      if (direction === 'development') steps.reverse()
      const token = randomUUID()
      this.reviewPlan = { token, target, expires: Date.now() + 120_000, cycle, steps, direction }
      const notices = direction === 'gaming' ? [...cycle.blocked, ...cycle.notices] : [
        'Projects and services from the saved snapshot restart only if their current configuration still matches.',
        'A different power plan selected since the switch stays in place.',
      ]
      if (active?.phase === 'RECOVERY_REQUIRED' || steps.some(step => step.gaming.effect === 'possible'))
        notices.unshift('A previous action may have changed Windows before verification. DevShift will check current state before applying recovery.')
      return {
        token, direction, recovery: active?.phase === 'RECOVERY_REQUIRED' || target === 'resume', keep: false,
        items: steps.map(step => ({ ...item(step, direction), status: 'pending', message: '' })), notices,
      }
    })
  }

  async execute(token: string): Promise<SwitchState> {
    await this.exclusive(async () => {
      const review = this.reviewPlan
      if (!review || review.token !== token || Date.now() > review.expires)
        throw new UserError('The switch preview expired. Review the current workload state again.')

      this.reviewPlan = null
      const { cycle, direction, steps } = review
      if (review.target === 'keep' && this.cycle?.id === cycle.id) {
        cycle.direction = 'development'
        cycle.phase = 'PARTIAL_SUCCESS'
        cycle.summary = 'Recovery closed. Current Windows settings and workloads were preserved.'
        for (const step of cycle.steps.filter(entry => canRetry(entry, 'development'))) {
          step.development = { ...step.development, status: 'skipped', message: 'Preserved the current state.', time: timestamp() }
        }
        this.log(cycle, 'Current state kept', cycle.summary, 'skipped')
        this.save(cycle, false)
        return
      }
      const device = await this.read()
      if (review.target === 'gaming' && !this.cycle) {
        const fresh = this.prepareGaming(device)
        if (JSON.stringify([fresh.steps, fresh.blocked, fresh.originalPower]) !== JSON.stringify([cycle.steps, cycle.blocked, cycle.originalPower]))
          throw new UserError('Approved workloads or power settings changed after review. Open an updated preview.')
      } else if (!this.cycle || this.cycle.id !== cycle.id) {
        throw new UserError('The saved transaction changed. Review it again.')
      }

      cycle.direction = direction
      cycle.phase = preparation(direction)
      cycle.summary = direction === 'gaming' ? 'Saving the recovery snapshot.' : 'Checking the saved recovery snapshot.'
      const firstAttempt = !this.cycle
      this.log(cycle, direction === 'gaming' ? 'Gaming switch requested' : 'Restore requested', cycle.summary, 'running')
      if (firstAttempt) for (const reason of cycle.blocked) this.log(cycle, 'Skipped approved change', reason, 'skipped')
      this.save(cycle)
      cycle.phase = switching(direction)
      cycle.summary = direction === 'gaming' ? 'Applying approved changes.' : 'Restoring captured workloads.'
      this.save(cycle)

      for (const step of steps) await this.apply(cycle, step, direction)
      let verificationFailed = false
      try { this.verify(cycle, direction, await this.read()) }
      catch (error) {
        verificationFailed = true
        this.log(cycle, 'Verification unavailable', errorMessage(error, 'DevShift could not read Windows after switching.'), 'failed')
      }

      const applicable = cycle.steps.filter(step => direction === 'gaming' || step.gaming.effect !== 'none')
      const failed = verificationFailed || applicable.some(step => step[direction].status === 'failed')
      const skipped = applicable.some(step => step[direction].status === 'skipped')
      const completed = applicable.filter(step => step[direction].status === 'succeeded').length
      const partial = skipped || (direction === 'gaming' && cycle.blocked.length > 0) || failed
      cycle.phase = failed && !completed ? 'FAILED' : partial ? 'PARTIAL_SUCCESS' : direction === 'gaming' ? 'GAMING' : 'DEVELOPMENT'
      cycle.summary = failed ? (completed ? 'Some actions completed. Review the failed steps and recovery options.'
        : 'DevShift could not complete the requested changes. Review the saved recovery options.')
        : partial ? phaseName(direction) + ' completed with skipped changes.'
          : !applicable.length ? phaseName(direction) + ' is active. No system changes were needed.'
            : phaseName(direction) + ' is active. Windows state was verified.'
      this.log(cycle, phaseName(direction), cycle.summary, failed ? 'failed' : partial ? 'skipped' : 'succeeded')
      this.save(cycle, direction === 'gaming' || failed)
    })
    return this.state()
  }

  private async apply(cycle: Cycle, step: JournalStep, direction: Mode) {
    const prior = step[direction]
    let effect = prior.effect
    const report = (status: OperationItem['status'], message: string) => {
      step[direction] = { status, message, effect, time: timestamp() }
      this.log(cycle, step.label, message, status)
      this.save(cycle)
    }
    const commit = async (action: () => Promise<ChangeResult>, success: string) => {
      effect = 'possible'
      step[direction] = { status: 'running', message: 'Waiting for Windows verification.', effect, time: timestamp() }
      this.save(cycle)
      const result = await action()
      effect = result.changed ? 'verified' : prior.effect
      report('succeeded', result.changed ? success : 'The requested state was already present.')
    }

    try {
      const device = await this.read()
      const capture = step.captured
      const gaming = direction === 'gaming'
      if (capture.kind === 'power') {
        const before = gaming ? capture.before : capture.after
        const after = gaming ? capture.after : capture.before
        if (device.scan.power.active === after) {
          if (prior.effect === 'possible') effect = 'verified'
          return report('succeeded', 'The requested power plan is already active.')
        }
        if (device.scan.power.active !== before) return report('skipped', 'Preserved the power plan selected in Windows.')
        return await commit(() => this.host.changePower(before, after), 'Verified the active power plan.')
      }

      if (capture.kind === 'service') {
        const service = device.scan.services.find(candidate => candidate.name.toLowerCase() === capture.name.toLowerCase())
        if (!service || service.fingerprint !== capture.fingerprint)
          return report('skipped', 'Preserved service changes made since the snapshot.')
        if (service.state === (gaming ? 'stopped' : 'running')) {
          if (prior.effect === 'possible') effect = 'verified'
          return report('succeeded', 'Windows already reports the requested service state.')
        }
        if (gaming) {
          if (service.state !== 'running' || service.pid !== capture.pid)
            return report('skipped', 'The original service instance changed. The new state was preserved.')
          const hasProject = device.nodes.some(node => node.state !== 'stopped'
            && node.configuration.dependencies.includes(service.name.toLowerCase()))
          if (hasProject) return report('skipped', 'A running approved project still needs this service.')
        }
        return await commit(
          () => this.host.changeService(service.name, service.fingerprint, gaming ? 'stop' : 'start', gaming ? capture.pid : 0),
          gaming ? 'Windows confirmed the service stopped.' : 'Windows confirmed the service is running.',
        )
      }

      const node = device.nodes.find(candidate => candidate.configuration.id === capture.configuration.id)
      if (!node) return report('skipped', 'The approved project configuration is unavailable.')
      if (gaming) {
        if (node.state === 'stopped') {
          if (prior.effect === 'possible') effect = 'verified'
          return report('succeeded', 'The captured process is no longer running.')
        }
        if (node.state === 'unknown') throw new UserError('Windows could not verify the captured process.')
        if (!node.process || !sameIdentity(capture.identity, node.process) || node.sessionId !== capture.sessionId)
          return report('skipped', 'A different process now matches the project. It was left running.')
        if (!node.ready) throw new UserError('The process is running without a verified shutdown handler.')
        const process = node.process
        return await commit(() => this.host.stopNode(capture.configuration, capture.sessionId, process),
          'The project confirmed graceful shutdown and its process exited.')
      }
      if (node.state === 'running' && node.ready) return report('succeeded', 'The project is running and confirmed readiness.')
      if (node.state === 'running' && !node.ready && !node.sessionId)
        return report('skipped', 'A matching project is already running. DevShift left it in place.')
      const current = node.configuration
      if (current.entryHash !== capture.configuration.entryHash || current.executableHash !== capture.configuration.executableHash
        || !sameFile(current.entry, capture.configuration.entry) || !sameFile(current.executable, capture.configuration.executable))
        return report('skipped', 'Preserved changes to the approved project configuration.')
      return await commit(() => this.host.startNode(capture.configuration, device.scan), 'Relaunched the project and confirmed readiness.')
    } catch (error) {
      if (error instanceof UserError && error.unchanged) effect = prior.effect
      if (step[direction].status === 'running' || step[direction].status === prior.status)
        report('failed', errorMessage(error, 'The action could not be verified. Inspect current Windows state before retrying.'))
      else throw error
    }
  }

  private verify(cycle: Cycle, direction: Mode, device: Device) {
    const gaming = direction === 'gaming'
    for (const step of cycle.steps.filter(entry => entry[direction].status === 'succeeded')) {
      const capture = step.captured
      const matches = capture.kind === 'power' ? device.scan.power.active === (gaming ? capture.after : capture.before)
        : capture.kind === 'service' ? device.scan.services.some(service => service.name.toLowerCase() === capture.name.toLowerCase()
          && service.fingerprint === capture.fingerprint && service.state === (gaming ? 'stopped' : 'running'))
          : device.nodes.some(node => node.configuration.id === capture.configuration.id
            && (gaming ? node.state === 'stopped' : node.state === 'running' && node.ready))
      if (matches) continue
      const message = 'The final check found a different state. Review Windows before retrying.'
      step[direction] = { ...step[direction], status: 'failed', message, time: timestamp() }
      this.log(cycle, step.label, message, 'failed')
      this.save(cycle)
    }
  }

  private editAllowed() {
    if (this.cycle) throw new UserError('Finish the current switch or restoration before changing approvals.')
    this.reviewPlan = null
  }

  async approve(id: string, approved: boolean) {
    await this.exclusive(async () => {
      this.editAllowed()
      if (approved) {
        const device = await this.read()
        const service = device.scan.services.find(candidate => serviceKey(candidate.name) === id)
        if (!service || !service.supported || !service.canControl)
          throw new UserError('This service cannot be approved with the current Windows permissions.')
        this.store.approve(id, service.fingerprint)
      } else this.store.approve(id, null)
      this.device = null
    })
  }

  async preferences(settings: Settings) {
    await this.exclusive(async () => {
      this.reviewPlan = null
      if (settings.gamingPlan && !(await this.read()).scan.power.plans.some(plan => plan.id === settings.gamingPlan))
        throw new UserError('Select a power plan currently installed in Windows.')
      this.store.settings = settings
    })
  }

  async registerNode(work: () => Promise<NodeWorkload>) {
    await this.exclusive(async () => {
      this.editAllowed()
      const config = await work()
      const device = await this.read()
      if (config.dependencies.some(name => !device.scan.services.some(service => service.supported && service.name.toLowerCase() === name)))
        throw new UserError('A selected service dependency is unavailable.')
      if (this.store.configurations.length >= 24) throw new UserError('Remove an unused project before adding another one.')
      if (this.store.configurations.some(existing => sameFile(existing.entry, config.entry)))
        throw new UserError('This project entry file is already approved.')
      this.store.configurations = [...this.store.configurations, config]
      this.device = null
    })
  }

  async launchNode(id: string) {
    await this.exclusive(async () => {
      this.editAllowed()
      const device = await this.read()
      const node = device.nodes.find(entry => entry.configuration.id === id)
      if (!node || node.state !== 'stopped') throw new UserError('This project is already running or unavailable.')
      try { await this.host.startNode(node.configuration, device.scan) }
      finally { this.device = null }
    })
  }

  async removeNode(id: string) {
    await this.exclusive(async () => {
      this.editAllowed()
      const node = (await this.read()).nodes.find(entry => entry.configuration.id === id)
      if (!node || node.state !== 'stopped') throw new UserError('The project must be stopped before its approval can be removed.')
      this.store.configurations = this.store.configurations.filter(config => config.id !== id)
      this.store.saveSession(id, null)
      this.device = null
    })
  }
}
