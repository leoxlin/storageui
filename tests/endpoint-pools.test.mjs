import assert from "node:assert/strict"
import dns from "node:dns"
import { once } from "node:events"
import { readFileSync } from "node:fs"
import http from "node:http"
import https from "node:https"
import { syncBuiltinESMExports } from "node:module"
import { Socket } from "node:net"
import { test } from "node:test"
import { setImmediate } from "node:timers/promises"

import {
  ENDPOINT_REQUEST_TIMEOUT_MS,
  publicEndpointAgents,
} from "../lib/storage/endpoint-policy.ts"

// Self-signed test CA/key; used only by the isolated loopback HTTPS server.
const cert = readFileSync(
  new URL("./fixtures/endpoint-pool.crt", import.meta.url)
)
const key = readFileSync(
  new URL("./fixtures/endpoint-pool.key", import.meta.url)
)

function routeToLoopback(t) {
  t.mock.method(dns, "lookup", (hostname, options, callback) => {
    callback(null, [{ address: "8.8.8.8", family: 4 }])
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const connect = Socket.prototype.connect
  t.mock.method(Socket.prototype, "connect", function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : args[0]
    this.connecting = true
    options.lookup(options.host, { all: true }, (error, addresses) => {
      assert.ifError(error)
      assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }])
      // Only reroute after checking the actual socket's vetted DNS result.
      connect.call(this, { ...options, host: "127.0.0.1", lookup: undefined })
    })
    return this
  })
}

for (const [protocol, transport, agent] of [
  ["http", http, publicEndpointAgents.httpAgent],
  ["https", https, publicEndpointAgents.httpsAgent],
]) {
  async function listen(t, handler) {
    const server =
      protocol === "https"
        ? https.createServer({ key, cert }, handler)
        : http.createServer(handler)
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    t.after(async () => {
      agent.destroy()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    })
    return server.address().port
  }

  function get(port, origin, onResponse = () => {}) {
    return new Promise((resolve, reject) => {
      const request = transport.get(
        `${protocol}://${origin}.example.test:${port}`,
        { agent, ca: cert },
        (response) => {
          onResponse(response)
          response.on("error", reject)
          response.on("end", resolve)
          response.resume()
        }
      )
      request.on("error", reject)
    })
  }

  test(`${protocol}: 400 distinct origins stay within the global socket cap and idle sockets expire`, async (t) => {
    const origins = new Set()
    const port = await listen(t, (request, response) => {
      origins.add(request.headers.host)
      response.end("ok")
    })
    routeToLoopback(t)
    assert.ok(
      Number.isFinite(agent.maxTotalSockets) && agent.maxTotalSockets <= 64
    )
    assert.ok(agent.options.timeout > 0 && agent.options.timeout <= 15_000)
    // Shorten only the idle interval; exercise the production pool's real cap.
    const originalTimeout = agent.options.timeout
    agent.options.timeout = 100
    t.after(() => {
      agent.options.timeout = originalTimeout
    })
    let peak = 0
    for (let index = 0; index < 400; index++) {
      await get(port, `origin-${index}`)
      peak = Math.max(peak, agent.totalSocketCount)
      assert.ok(agent.totalSocketCount <= agent.maxTotalSockets)
    }
    assert.equal(origins.size, 400)
    assert.ok(peak > 1)
    await setImmediate()
    const idle = Object.values(agent.freeSockets).flat()
    assert.ok(
      idle.length > 0,
      "keep-alive should retain some sockets before expiry"
    )
    await Promise.all(
      idle.map((socket) =>
        once(socket, "close", { signal: AbortSignal.timeout(2_000) })
      )
    )
    await setImmediate()
    assert.equal(agent.totalSocketCount, 0)
    assert.equal(Object.keys(agent.freeSockets).length, 0)
    assert.equal(Object.keys(agent.requests).length, 0)
  })

  test(`${protocol}: active and queued distinct-origin requests hit the request deadline`, async (t) => {
    let accepted = 0
    let allAccepted
    const ready = new Promise((resolve) => {
      allAccepted = resolve
    })
    const port = await listen(t, () => {
      if (++accepted === agent.maxTotalSockets) allAccepted()
    })
    routeToLoopback(t)
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const results = Promise.allSettled(
      Array.from({ length: agent.maxTotalSockets + 1 }, (_, index) =>
        get(port, `stalled-${index}`)
      )
    )
    await ready
    assert.equal(agent.totalSocketCount, agent.maxTotalSockets)
    assert.equal(Object.values(agent.requests).flat().length, 1)
    t.mock.timers.tick(ENDPOINT_REQUEST_TIMEOUT_MS)
    for (const result of await results) {
      assert.equal(result.status, "rejected")
      assert.match(result.reason.message, /Storage endpoint request timed out/)
    }
    await setImmediate()
    assert.equal(accepted, agent.maxTotalSockets)
  })

  test(`${protocol}: response traffic cannot extend the request deadline`, async (t) => {
    let serverResponse
    const port = await listen(t, (request, response) => {
      serverResponse = response
      response.write("first chunk")
    })
    routeToLoopback(t)
    t.mock.timers.enable({ apis: ["setTimeout"] })
    let clientResponse
    let received
    const ready = new Promise((resolve) => {
      received = resolve
    })
    const result = assert.rejects(
      get(port, "trickle", (response) => {
        clientResponse = response
        response.once("data", received)
      }),
      /Storage endpoint request timed out|aborted/
    )
    await ready
    t.mock.timers.tick(ENDPOINT_REQUEST_TIMEOUT_MS - 1)
    const nextChunk = once(clientResponse, "data")
    serverResponse.write("still sending")
    await nextChunk
    t.mock.timers.tick(1)
    await result
  })
}
