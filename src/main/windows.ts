import { execFile } from 'node:child_process'
import { cpus } from 'node:os'
import type { ChangeResult, Device, Host, NodeWorkload, RawProcess, WindowsScan } from '../core/model.js'
import { UserError } from '../core/model.js'
import { workloadRows } from '../core/discovery.js'
import type { Store } from '../core/store.js'
import type { NodeRuntime } from './node-runtime.js'

type Reply<T> = { ok: true; value: T } | { ok: false; message: string; code: string }

const noChange = new Set([
  'invalid-request', 'unsupported-service', 'service-missing', 'service-changed', 'service-access',
  'state-changed', 'service-dependent', 'service-prerequisite', 'service-control', 'plan-missing', 'power-apply',
])

export class Windows {
  constructor(private readonly helper: string) {}

  private call<T>(args: string[]): Promise<T> {
    return new Promise((resolve, reject) => {
      execFile(this.helper, args, { windowsHide: true, timeout: 32_000, maxBuffer: 8_000_000 }, (error, stdout) => {
        let reply: Reply<T> | null = null
        try { reply = JSON.parse(stdout.trim()) as Reply<T> } catch {}
        if (reply && 'ok' in reply && reply.ok === false) return reject(new UserError(reply.message, noChange.has(reply.code)))
        if (error || reply?.ok !== true) return reject(new UserError('Windows did not return a verified response. Check the workload state before retrying.'))
        resolve(reply.value)
      })
    })
  }

  scan(includeInstalled = false) { return this.call<WindowsScan>([includeInstalled ? 'scan' : 'scan-live']) }
  process(pid: number) { return this.call<RawProcess | null>(['process', String(pid)]) }
  service(name: string, fingerprint: string, action: 'start' | 'stop', pid: number) {
    return this.call<ChangeResult>(['service', action, name, fingerprint, String(pid)])
  }
  power(expected: string, next: string) { return this.call<ChangeResult>(['power', expected, next]) }
}

export class WindowsHost implements Host {
  private installed: WindowsScan['installed'] = []
  private previous: { time: number; processes: Map<string, number> } | null = null

  constructor(private readonly windows: Windows, private readonly runtime: NodeRuntime, private readonly store: Store) {}

  async read(includeInstalled = false): Promise<Device> {
    const scan = await this.windows.scan(includeInstalled)
    const time = performance.now()
    const scannedAt = new Date().toISOString()
    if (includeInstalled) this.installed = scan.installed
    else scan.installed = this.installed

    const nodes = await Promise.all(this.store.configurations.map(config => this.runtime.observe(config, scan.processes)))
    const processors = cpus().length
    const prior = this.previous
    const elapsed = prior ? time - prior.time : 0
    const percentages = new Map<number, number>()
    if (!prior || elapsed >= 750) {
      const times = new Map<string, number>()
      for (const process of scan.processes) {
        if (process.cpuTicks === null || !process.started) continue
        const key = process.pid + '@' + process.started
        times.set(key, process.cpuTicks)
        const previous = prior?.processes.get(key)
        if (previous !== undefined && process.cpuTicks >= previous && processors) {
          const percentage = (process.cpuTicks - previous) / (elapsed * 10_000 * processors) * 100
          percentages.set(process.pid, Math.min(100, percentage))
        }
      }
      this.previous = { time, processes: times }
    }

    return {
      scan, nodes, workloads: workloadRows(scan, nodes, this.store.approvals, process => percentages.get(process.pid) ?? null),
      scannedAt,
    }
  }

  changeService(name: string, fingerprint: string, action: 'start' | 'stop', pid: number) {
    return this.windows.service(name, fingerprint, action, pid)
  }

  changePower(expected: string, next: string) { return this.windows.power(expected, next) }
  stopNode(config: NodeWorkload, sessionId: string, process: RawProcess) { return this.runtime.stop(config, sessionId, process) }
  startNode(config: NodeWorkload, scan: WindowsScan) { return this.runtime.start(config, scan) }
}
