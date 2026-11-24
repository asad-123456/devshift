import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Engine } from '../dist/core/engine.js'
import { defaultSettings } from '../dist/core/model.js'
import { Store } from '../dist/core/store.js'
import { Windows, WindowsHost } from '../dist/main/windows.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const windows = new Windows(join(root, 'dist', 'native', 'DevShift.Windows.exe'))
const exec = promisify(execFile)
const power = (...args) => exec(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'powercfg.exe'), args, { windowsHide: true })

test('applies and restores a temporary copy of the current Windows power plan', { skip: process.platform !== 'win32', timeout: 45_000 }, async () => {
  const initial = await windows.scan()
  const original = initial.power.active
  const originalName = initial.power.plans.find(plan => plan.id === original)?.name
  assert.ok(originalName)

  const copied = randomUUID()
  const folder = await mkdtemp(join(tmpdir(), 'devshift-power-'))
  let store
  let created = false
  try {
    await power('/duplicatescheme', original, copied)
    created = true
    await power('/changename', copied, 'DevShift temporary verification plan')
    store = new Store(join(folder, 'isolated.sqlite'))
    const runtime = {}
    const host = new WindowsHost(windows, runtime, store)
    const engine = new Engine(store, host)

    await engine.preferences({ ...defaultSettings, gamingPlan: copied })
    const gaming = await engine.review('gaming')
    assert.deepEqual(gaming.items.map(item => item.label), ['Power plan'])
    const result = await engine.execute(gaming.token)
    assert.equal(result.phase, 'GAMING', result.progress[0]?.message ?? result.summary)
    assert.equal((await windows.scan()).power.active, copied)
    assert.equal(store.active().originalPower, original)

    const restore = await engine.review('development')
    assert.deepEqual(restore.items.map(item => item.label), ['Power plan'])
    assert.equal((await engine.execute(restore.token)).phase, 'DEVELOPMENT')
    assert.equal((await windows.scan()).power.active, original)
    console.log(JSON.stringify({ original: originalName, temporaryPlanApplied: true, originalPlanRestored: true }))
  } finally {
    try {
      if (created) {
        const current = (await windows.scan()).power.active
        if (current === copied) await windows.power(copied, original)
        await power('/delete', copied)
        assert.ok(!(await windows.scan()).power.plans.some(plan => plan.id === copied))
      }
    } finally {
      store?.close()
      await rm(folder, { recursive: true, force: true })
    }
  }
})
