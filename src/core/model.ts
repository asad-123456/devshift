import type { Category, InstalledTool, Mode, OperationItem, Phase, PowerPlan, Settings, TimelineEntry, Workload } from '../shared/contracts.js'

export interface RawProcess {
  name: string
  pid: number
  parentPid: number
  path: string | null
  started: string | null
  memoryBytes: number | null
  privateMemoryBytes: number | null
  cpuTicks: number | null
  args: string[] | null
}

export interface ServiceLink { name: string; state: string }

export interface Service {
  name: string
  label: string
  state: string
  pid: number
  path: string | null
  fingerprint: string
  supported: boolean
  canControl: boolean
  acceptStop: boolean
  limitation: string | null
  requires: ServiceLink[]
  dependents: ServiceLink[]
}

export interface WindowsScan {
  processes: RawProcess[]
  services: Service[]
  power: { active: string; plans: PowerPlan[] }
  installed: InstalledTool[]
  build: number
}

export interface NodeWorkload {
  id: string
  label: string
  executable: string
  entry: string
  executableHash: string
  entryHash: string
  dependencies: string[]
}

export interface NodeSession {
  id: string
  key: string
  bootstrap: string
  pid: number | null
}

export interface NodeObservation {
  configuration: NodeWorkload
  state: 'stopped' | 'running' | 'unknown'
  ready: boolean
  process: RawProcess | null
  sessionId: string | null
  detail: string
}

export interface Device {
  scan: WindowsScan
  nodes: NodeObservation[]
  workloads: Workload[]
  scannedAt: string
}

export interface ChangeResult { changed: boolean }

export interface Host {
  read: (includeInstalled?: boolean) => Promise<Device>
  changeService: (name: string, fingerprint: string, action: 'start' | 'stop', expectedPid: number) => Promise<ChangeResult>
  changePower: (expected: string, next: string) => Promise<ChangeResult>
  stopNode: (configuration: NodeWorkload, sessionId: string, process: RawProcess) => Promise<ChangeResult>
  startNode: (configuration: NodeWorkload, scan: WindowsScan) => Promise<ChangeResult>
}

export type Captured =
  | { kind: 'power'; before: string; after: string }
  | { kind: 'service'; name: string; fingerprint: string; pid: number; requires: string[]; dependents: string[] }
  | { kind: 'node'; configuration: NodeWorkload; sessionId: string; identity: Pick<RawProcess, 'pid' | 'started' | 'path'> }

export interface Outcome {
  status: OperationItem['status']
  message: string
  effect: 'none' | 'possible' | 'verified'
  time: string | null
}

export interface JournalStep {
  id: string
  label: string
  forward: string
  backward: string
  captured: Captured
  gaming: Outcome
  development: Outcome
}

export interface Cycle {
  schema: 1
  id: string
  originalMode: 'development'
  originalPower: string
  createdAt: string
  updatedAt: string
  direction: Mode
  phase: Phase
  notices: string[]
  blocked: string[]
  steps: JournalStep[]
  history: TimelineEntry[]
  summary: string
}

export const defaultSettings: Settings = { gamingPlan: null, scanInterval: 10_000, minimizeToTray: true }
export const nodeCategory: Category = 'Runtime'
export const serviceKey = (name: string) => 'service:' + name.toLowerCase()
export const pending = (): Outcome => ({ status: 'pending', message: '', effect: 'none', time: null })
export const timestamp = () => new Date().toISOString()
export const ongoing = new Set<Phase>([
  'PREPARING_GAMING', 'SWITCHING_TO_GAMING', 'PREPARING_DEVELOPMENT', 'RESTORING_DEVELOPMENT',
])

export class UserError extends Error {
  constructor(message: string, readonly unchanged = false) { super(message) }
}

export function errorMessage(error: unknown, fallback: string) {
  return error instanceof UserError ? error.message : fallback
}

export function sameIdentity(left: Pick<RawProcess, 'pid' | 'started' | 'path'>, right: RawProcess) {
  return !!left.started && !!left.path && left.pid === right.pid && left.started === right.started
    && left.path.toLowerCase() === right.path?.toLowerCase()
}
