'use strict'

const { createServer } = require('node:net')
const { createHmac, timingSafeEqual } = require('node:crypto')

const id = process.env.DEVSHIFT_CONTROL_ID
const key = process.env.DEVSHIFT_CONTROL_KEY
delete process.env.DEVSHIFT_CONTROL_ID
delete process.env.DEVSHIFT_CONTROL_KEY

let shutdown
let stopping = false

function registerShutdown(handler) {
  if (typeof handler !== 'function' || shutdown) throw new TypeError('Register one graceful shutdown handler.')
  shutdown = handler
}

function sign(value) {
  return createHmac('sha256', key).update(value).digest('hex')
}

if (id && key) {
  const server = createServer(socket => {
    socket.setEncoding('utf8')
    socket.setTimeout(18_000, () => socket.destroy())
    socket.on('error', () => socket.destroy())
    let input = ''

    function reply(request, accepted) {
      const ready = Boolean(shutdown) && !stopping
      const proof = sign([request.nonce, request.operation, process.pid, ready, accepted].join('|'))
      socket.end(JSON.stringify({ pid: process.pid, ready, accepted, proof }) + '\n')
    }

    socket.on('data', async chunk => {
      input += chunk
      if (input.length > 1024) return socket.destroy()
      if (!input.endsWith('\n')) return
      socket.pause()

      let request
      try { request = JSON.parse(input) } catch { return socket.destroy() }
      if (!request || !['ping', 'stop'].includes(request.operation) || typeof request.nonce !== 'string'
        || !/^[a-f0-9]{32}$/.test(request.nonce) || typeof request.proof !== 'string'
        || !/^[a-f0-9]{64}$/.test(request.proof)) return socket.destroy()

      const expected = sign(request.operation + '|' + request.nonce)
      if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(request.proof, 'hex'))) return socket.destroy()

      if (request.operation === 'ping') return reply(request, false)
      if (!shutdown || stopping) return reply(request, false)

      stopping = true
      try {
        await shutdown()
      } catch {
        stopping = false
        return reply(request, false)
      }
      reply(request, true)
      server.close()
    })
  })

  server.on('error', () => { shutdown = undefined })
  server.listen('\\\\.\\pipe\\devshift-' + id, () => server.unref())
}

module.exports = { registerShutdown }
