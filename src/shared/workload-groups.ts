import type { Workload } from './contracts.js'

export interface WorkloadGroup {
  root: Workload
  members: Workload[]
  cpu: number | null
  privateMemoryBytes: number | null
}

function editorRoot(row: Workload, editors: Map<number, Workload>) {
  if (row.kind !== 'process' || row.category !== 'Editor' || !row.path || !row.startedAt) return row
  const path = row.path.toLowerCase()
  const visited = new Set([row.id])
  let current = row
  while (current.parentPid !== null) {
    const parent = editors.get(current.parentPid)
    if (!parent?.startedAt || !current.startedAt || parent.startedAt > current.startedAt || parent.path?.toLowerCase() !== path) break
    if (visited.has(parent.id)) return row
    visited.add(parent.id)
    current = parent
  }
  return current
}

function sumReading(members: Workload[], field: 'cpu' | 'privateMemoryBytes') {
  let sum = 0
  for (const member of members) {
    const value = member[field]
    if (value == null) return null
    sum += value
  }
  return field === 'cpu' ? Math.min(100, sum) : sum
}

export function groupWorkloads(rows: Workload[]): WorkloadGroup[] {
  const editors = new Map<number, Workload>()
  for (const row of rows) {
    if (row.kind === 'process' && row.category === 'Editor' && row.pid !== null) editors.set(row.pid, row)
  }
  const families = new Map<Workload, Workload[]>()
  for (const row of rows) {
    const root = editorRoot(row, editors)
    const members = families.get(root)
    if (!members) families.set(root, row === root ? [root] : [root, row])
    else if (row !== root) members.push(row)
  }
  return Array.from(families, ([root, members]) => ({
    root, members, cpu: sumReading(members, 'cpu'), privateMemoryBytes: sumReading(members, 'privateMemoryBytes'),
  }))
}
