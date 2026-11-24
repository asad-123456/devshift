import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'))
const desktop = spawn(electronPath, [root], { cwd: root, env, stdio: 'inherit' })
desktop.once('error', error => {
  console.error(error.message)
  process.exitCode = 1
})
desktop.once('exit', code => { process.exitCode = code ?? 1 })
