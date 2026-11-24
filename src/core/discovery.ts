import { basename, win32 } from 'node:path'
import type { Category, Workload } from '../shared/contracts.js'
import type { NodeObservation, RawProcess, Service, WindowsScan } from './model.js'
import { nodeCategory, serviceKey } from './model.js'

const editors = /^(devenv|code(?: - insiders)?|idea64|webstorm64|pycharm64|rider64|clion64|goland64|phpstorm64|rubymine64|datagrip64|rustrover64|studio64|fleet)\.exe$/i
const runtimes = /^(node|node64|python(?:w|\d+(?:\.\d+)?)?|dotnet|javaw?)\.exe$/i
const databases = /^(sqlservr|postgres|pg_ctl|mysqld|mariadbd|mongod|redis-server|memurai)\.exe$/i
const infra = /^(docker desktop|com\.docker\.backend|docker|wsl|wslhost|wslservice|vmmemwsl)\.exe$/i
const build = /^(msbuild|cmake|ninja|gradle|mvn|tsc|iisexpress|mspdbsrv|vbcscompiler)\.exe$/i
const emulators = /^(emulator|adb|qemu-system-.+)\.exe$/i
const devEntry = /(?:^|[\\/@.-])(vite|webpack-dev-server|react-scripts|nodemon|tsx|ts-node|next|nuxt|uvicorn|gunicorn|flask|django|gradlew|mvnw|spring-boot|msbuild)(?:[./\\-]|$)/i

const labels: Record<string, string> = {
  'code.exe': 'Visual Studio Code', 'code - insiders.exe': 'VS Code Insiders', 'devenv.exe': 'Visual Studio',
  'idea64.exe': 'IntelliJ IDEA', 'webstorm64.exe': 'WebStorm', 'pycharm64.exe': 'PyCharm',
  'rider64.exe': 'Rider', 'clion64.exe': 'CLion', 'goland64.exe': 'GoLand', 'phpstorm64.exe': 'PhpStorm',
  'rubymine64.exe': 'RubyMine', 'datagrip64.exe': 'DataGrip', 'rustrover64.exe': 'RustRover',
  'studio64.exe': 'Android Studio', 'sqlservr.exe': 'SQL Server', 'postgres.exe': 'PostgreSQL',
  'mysqld.exe': 'MySQL', 'mariadbd.exe': 'MariaDB', 'mongod.exe': 'MongoDB', 'redis-server.exe': 'Redis',
  'docker desktop.exe': 'Docker Desktop', 'com.docker.backend.exe': 'Docker Desktop backend',
  'vmmemwsl.exe': 'WSL virtual machine', 'wslhost.exe': 'WSL host', 'wsl.exe': 'WSL',
  'emulator.exe': 'Android Emulator', 'adb.exe': 'Android Debug Bridge',
}

export function classify(process: RawProcess, processes: Map<number, RawProcess>): Category | null {
  const { name, args } = process
  if (editors.test(name)) return 'Editor'
  if (databases.test(name)) return 'Database'
  if (infra.test(name)) return 'Infrastructure'
  if (build.test(name)) return 'Build tool'
  if (emulators.test(name)) return 'Emulator'
  if (!runtimes.test(name) || !args) return null

  const target = args.slice(1).some(value => devEntry.test(value)
    || /(?:^|[\\/])manage\.py$/i.test(value)
    || (/^dotnet\.exe$/i.test(name) && ['watch', 'run', 'build', 'test'].includes(value)))
  if (target) return 'Runtime'

  const parent = processes.get(process.parentPid)
  const isParent = parent?.started && process.started && parent.started <= process.started
  return isParent && /^devenv\.exe$/i.test(parent.name) && /^dotnet\.exe$/i.test(name) && args.length > 1
    ? 'Runtime'
    : null
}

function editorRole(args: string[] | null) {
  if (!args) return undefined
  if (args.includes('--utility-sub-type=network.mojom.NetworkService')) return 'Network service'
  const type = args.find(arg => arg.startsWith('--type='))
  switch (type) {
    case '--type=renderer': return 'Renderer'
    case '--type=gpu-process': return 'GPU process'
    case '--type=utility': return 'Utility process'
    case '--type=crashpad-handler': return 'Crash handler'
    default: return undefined
  }
}

export function sameFile(first: string, second: string) {
  return win32.normalize(first).toLowerCase() === win32.normalize(second).toLowerCase()
}

export function matchingNode(processes: RawProcess[], executable: string, entry: string) {
  return processes.filter(process => process.path && sameFile(process.path, executable)
    && process.args?.slice(1).some(arg => win32.isAbsolute(arg) && sameFile(arg, entry)))
}

export function workloadRows(
  scan: WindowsScan, nodes: NodeObservation[], approvals: Record<string, string>, cpu: (process: RawProcess) => number | null,
): Workload[] {
  const processes = new Map(scan.processes.map(process => [process.pid, process]))
  const associated = new Set<number>()
  const measures = (process?: RawProcess | null) => ({
    pid: process?.pid ?? null,
    parentPid: process?.parentPid ?? null,
    startedAt: process?.started ?? null,
    privateMemoryBytes: process?.privateMemoryBytes ?? null,
    memoryBytes: process?.memoryBytes ?? null,
    cpu: process ? cpu(process) : null,
  })

  const managed: Workload[] = nodes.map(node => {
    if (node.process) associated.add(node.process.pid)
    return {
      ...measures(node.process), id: node.configuration.id, label: node.configuration.label,
      category: nodeCategory, kind: 'node', path: node.configuration.entry, state: node.state,
      approved: true, canApprove: false, canLaunch: node.state === 'stopped', canRemove: node.state === 'stopped',
      restoration: 'Relaunch and check project readiness', detail: node.detail,
    }
  })

  const services: Workload[] = scan.services.map(service => {
    const id = serviceKey(service.name)
    const process = processes.get(service.pid)
    if (service.pid) associated.add(service.pid)
    const approved = approvals[id] === service.fingerprint
    const state = service.state === 'running' || service.state === 'stopped' ? service.state : 'pending'
    return {
      ...measures(process), pid: service.pid || null, id, label: service.label,
      category: service.supported || !/wsl|docker|lxss/i.test(service.name) ? 'Database' : 'Infrastructure',
      kind: 'service', path: service.path, state, approved,
      canApprove: service.supported && service.canControl, canLaunch: false, canRemove: false,
      restoration: service.supported ? 'Restart through Windows Service Control Manager' : 'Observation only',
      detail: service.limitation ?? (approved
        ? 'Approved Windows service'
        : approvals[id] ? 'Service configuration changed. Review and approve it again.' : 'Approval required for switching'),
    }
  })

  const discovered: Workload[] = scan.processes.flatMap(process => {
    if (associated.has(process.pid)) return []
    const category = classify(process, processes)
    if (!category) return []
    const label = labels[process.name.toLowerCase()] ?? basename(process.name, '.exe')
    return [{
      ...measures(process), id: 'process:' + process.pid + ':' + (process.started ?? ''), label, category, kind: 'process' as const,
      processRole: category === 'Editor' ? editorRole(process.args) : undefined,
      path: process.path, state: 'running' as const, approved: false, canApprove: false, canLaunch: false, canRemove: false,
      restoration: 'Observation only',
      detail: category === 'Editor' ? 'Unsaved work cannot be verified. DevShift leaves this application open.'
        : 'A supported, verified shutdown and restore method is unavailable.',
    }]
  })

  return [...managed, ...services, ...discovered]
}

export function stopOrder(candidates: Service[]) {
  const byName = new Map(candidates.map(service => [service.name.toLowerCase(), service]))
  const remaining = new Set(byName.keys())
  const ordered: Service[] = []
  while (remaining.size) {
    const next = [...remaining].find(name => byName.get(name)?.dependents.every(link => {
      const dependent = link.name.toLowerCase()
      return link.state === 'stopped' || (byName.has(dependent) && !remaining.has(dependent))
    }))
    if (!next) break
    remaining.delete(next)
    ordered.push(byName.get(next)!)
  }
  return { ordered, blocked: [...remaining].map(name => byName.get(name)!) }
}
