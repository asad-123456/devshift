import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { performanceGapMs, performanceWindowMs, type PerformanceSample } from '../shared/contracts.js'

function openMonitor(helper: string) {
  return spawn(helper, ['monitor'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
}

function readSample(line: string): PerformanceSample | null {
  try {
    const { sampledAt, cpu, usedMemory, totalMemory } = JSON.parse(line)
    const validCpu = cpu === null || (Number.isFinite(cpu) && cpu >= 0 && cpu <= 100)
    const validMemory = (totalMemory === null && usedMemory === null)
      || (Number.isSafeInteger(totalMemory) && totalMemory > 0 && Number.isSafeInteger(usedMemory) && usedMemory >= 0 && usedMemory <= totalMemory)
    if (Number.isSafeInteger(sampledAt) && sampledAt > 0 && validCpu && validMemory)
      return { sampledAt, cpu, usedMemory, totalMemory }
  } catch {}
  return null
}

export class PerformanceMonitor {
  private timer: NodeJS.Timeout | null = null
  private child: ReturnType<typeof openMonitor> | null = null
  private requestedAt: number | null = null
  private samples: PerformanceSample[] = []
  private retryAt = 0

  constructor(private readonly helper: string, private readonly publish: (samples: PerformanceSample[]) => void) {}

  start() {
    if (this.timer) return
    this.retryAt = 0
    this.timer = setInterval(() => this.tick(), 1000)
    this.tick()
  }

  stop() {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
    this.disconnect()
    this.samples = []
    this.publish([])
  }

  private disconnect() {
    const child = this.child
    this.child = null
    this.requestedAt = null
    if (!child) return
    child.stdin.end()
    if (child.exitCode !== null || child.signalCode !== null) return
    const deadline = setTimeout(() => child.kill(), performanceGapMs)
    deadline.unref()
    child.once('close', () => clearTimeout(deadline))
  }

  private append(sample: PerformanceSample) {
    const previous = this.samples.at(-1)
    if (previous && sample.sampledAt <= previous.sampledAt) this.samples = []
    this.samples = this.samples.filter(point => point.sampledAt >= sample.sampledAt - performanceWindowMs)
    this.samples.push(sample)
    this.publish(this.samples)
  }

  private unavailable() {
    this.disconnect()
    this.retryAt = performance.now() + 5000
    this.append({ sampledAt: Date.now(), cpu: null, usedMemory: null, totalMemory: null })
  }

  private tick() {
    if (performance.now() < this.retryAt) return
    if (this.requestedAt !== null) {
      if (performance.now() - this.requestedAt > performanceGapMs) this.unavailable()
      return
    }
    if (!this.child) {
      const child = openMonitor(this.helper)
      this.child = child
      const failed = () => { if (this.child === child) this.unavailable() }
      child.once('error', failed)
      child.once('exit', failed)
      child.stdin.on('error', failed)
      child.stdout.on('error', failed)
      const output = createInterface({ input: child.stdout })
      output.on('error', failed)
      output.on('line', line => {
        if (this.child !== child || this.requestedAt === null) return
        const sample = readSample(line)
        if (!sample || performance.now() - this.requestedAt > performanceGapMs) { this.unavailable(); return }
        this.requestedAt = null
        this.append(sample)
      })
    }
    this.requestedAt = performance.now()
    this.child.stdin.write('\n')
  }
}
