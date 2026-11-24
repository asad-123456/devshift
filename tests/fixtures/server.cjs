const { createServer } = require('node:http')
const { existsSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

const marker = join(__dirname, 'ready.json')
const requested = join(__dirname, 'shutdown.requested')
rmSync(requested, { force: true })
const server = createServer((_request, response) => response.end(String(process.pid)))

function close() {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

server.listen({ host: '127.0.0.1', port: 0 }, () => {
  if (process.env.DEVSHIFT_SHUTDOWN_MODULE) {
    const { registerShutdown } = require(process.env.DEVSHIFT_SHUTDOWN_MODULE)
    registerShutdown(async () => {
      writeFileSync(requested, String(process.pid))
      await delay(1_200)
      await close()
    })
  }
  writeFileSync(marker, JSON.stringify({ pid: process.pid, port: server.address().port }))
})

const timer = setInterval(() => {
  if (existsSync(join(__dirname, 'cleanup.request'))) {
    clearInterval(timer)
    if (server.listening) void close()
  }
}, 100)
timer.unref()
