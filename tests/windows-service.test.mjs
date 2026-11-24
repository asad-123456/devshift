import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Engine } from '../dist/core/engine.js'
import { Store } from '../dist/core/store.js'
import { Windows, WindowsHost } from '../dist/main/windows.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
const windows = new Windows(join(root, 'dist', 'native', 'DevShift.Windows.exe'))
const exec = promisify(execFile)
const sc = (...args) => exec(join(system, 'sc.exe'), args, { windowsHide: true, timeout: 12_000 })

async function waitState(names, state) {
  const end = Date.now() + 12_000
  while (Date.now() < end) {
    const { services } = await windows.scan()
    if (names.every(name => services.find(service => service.name === name)?.state === state)) return
    await delay(250)
  }
  assert.fail('Fixture services did not reach state ' + state)
}

test('approved Windows services stop in dependency order and restore through the SCM', {
  skip: process.platform !== 'win32', timeout: 90_000,
}, async () => {
  const folder = await mkdtemp(join(process.env.ProgramData ?? 'C:\\ProgramData', 'devshift-scm-'))
  const number = randomInt(10_000_000, 80_000_000)
  const parent = 'postgresql-x64-' + number
  const dependent = 'postgresql-x64-' + (number + 1)
  const created = []
  const executable = join(folder, 'pg_ctl.exe')
  let store
  const evidence = { stopped: false, restored: false, removed: false }
  try {
    const { services } = await windows.scan()
    assert.ok(!services.some(service => [parent, dependent].includes(service.name)))
    await copyFile(join(root, 'artifacts', 'service-fixture', 'pg_ctl.exe'), executable)
    for (const name of [parent, dependent]) {
      await sc('create', name, 'binPath=', '"' + executable + '" ' + name, 'start=', 'demand',
        'obj=', 'NT AUTHORITY\\LocalService', ...(name === dependent ? ['depend=', parent] : []))
      created.push(name)
    }
    await sc('start', parent)
    await sc('start', dependent)
    await waitState(created, 'running')

    store = new Store(join(folder, 'fixture.sqlite'))
    const engine = new Engine(store, new WindowsHost(windows, {}, store))
    await engine.approve('service:' + parent, true)
    const blocked = await engine.review('gaming')
    assert.equal(blocked.items.length, 0)
    assert.ok(blocked.notices.some(notice => notice.includes('dependent service')))
    await engine.approve('service:' + dependent, true)
    const gaming = await engine.review('gaming')
    assert.deepEqual(gaming.items.map(item => item.id), ['service:' + dependent, 'service:' + parent])
    const gamingResult = await engine.execute(gaming.token)
    assert.equal(gamingResult.phase, 'GAMING', JSON.stringify(gamingResult.progress))
    await waitState(created, 'stopped')
    evidence.stopped = true

    const development = await engine.review('development')
    assert.deepEqual(development.items.map(item => item.id), ['service:' + parent, 'service:' + dependent])
    const restored = await engine.execute(development.token)
    assert.equal(restored.phase, 'DEVELOPMENT', JSON.stringify(restored.progress))
    await waitState(created, 'running')
    evidence.restored = true
  } finally {
    store?.close()
    const clean = [...created].reverse()
    const { services } = await windows.scan()
    for (const name of clean) {
      const service = services.find(item => item.name === name)
      if (service?.state === 'running') {
        await sc('stop', name)
        await waitState([name], 'stopped')
      }
      await sc('delete', name)
    }
    const cleaned = await windows.scan()
    assert.ok(!cleaned.services.some(service => created.includes(service.name)))
    evidence.removed = true
    await rm(folder, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 })
    await writeFile(join(root, 'artifacts', 'windows-service-result.json'), JSON.stringify(evidence))
  }
  console.log(JSON.stringify(evidence))
})
