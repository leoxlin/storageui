import { lookup } from "node:dns"
import {
  Agent as HttpAgent,
  type ClientRequest,
  type RequestOptions,
} from "node:http"
import { Agent as HttpsAgent } from "node:https"
import type { LookupFunction } from "node:net"
import ipaddr from "ipaddr.js"

export function privateEndpointsAllowed(): boolean {
  if (
    process.env.ALLOW_PRIVATE_ENDPOINTS === "true" ||
    process.env.NODE_ENV !== "production"
  )
    return true
  // Bun 1.3 ignores Agent.createConnection, so it cannot enforce this policy.
  if (process.versions.bun) {
    throw new Error(
      "Private endpoint protection requires Node.js. Run npm start with Node.js or explicitly set ALLOW_PRIVATE_ENDPOINTS=true."
    )
  }
  return false
}

const PRIVATE_ENDPOINT_MESSAGE =
  "Endpoint points at a private address. Set ALLOW_PRIVATE_ENDPOINTS=true on the server to allow it."

export function assertPublicHostname(hostname: string): void {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    (ipaddr.isValid(host) && ipaddr.process(host).range() !== "unicast")
  ) {
    throw new Error(PRIVATE_ENDPOINT_MESSAGE)
  }
}

export function assertEndpointAllowed(
  value: string | undefined,
  label: string
): void {
  if (!value) return
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use http or https.`)
  }
  if (!privateEndpointsAllowed()) assertPublicHostname(url.hostname)
}

// Return the vetted DNS result directly to the socket: no second lookup that
// could rebind to a private address between validation and connection.
const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "")
    try {
      for (const { address } of addresses) assertPublicHostname(address)
    } catch (error) {
      return callback(error as Error, "")
    }
    if (options.all) callback(null, addresses)
    else callback(null, addresses[0].address, addresses[0].family)
  })
}

export const ENDPOINT_REQUEST_TIMEOUT_MS = 120_000

function publicAgent<T extends HttpAgent>(agent: T): T {
  // Start before Agent queues the request: a saturated pool must not make
  // callers wait indefinitely. Keep the deadline through the response body.
  const boundedAgent = agent as T & {
    addRequest(request: ClientRequest, options: RequestOptions): void
  }
  const addRequest = boundedAgent.addRequest
  boundedAgent.addRequest = function (request, options) {
    const timer = setTimeout(() => {
      request.destroy(new Error("Storage endpoint request timed out."))
    }, ENDPOINT_REQUEST_TIMEOUT_MS)
    timer.unref()
    request.once("close", () => clearTimeout(timer))
    addRequest.call(this, request, options)
  }
  const connect = agent.createConnection
  agent.createConnection = function (options, callback) {
    // Literal IPs skip Node's lookup hook; check them here as well. This runs
    // for every new socket, including sockets opened while following redirects.
    try {
      assertPublicHostname(String(options.hostname ?? options.host))
    } catch (error) {
      queueMicrotask(() => callback?.(error as Error, null!))
      return
    }
    return connect.call(this, { ...options, lookup: publicLookup }, callback)
  }
  return agent
}

// Process-owned pools, used only by untrusted local connections. Env connections
// and the operator's explicit private-endpoint opt-in retain their transports.
const poolOptions = {
  keepAlive: true,
  maxTotalSockets: 64,
  maxSockets: 16,
  maxFreeSockets: 2,
  timeout: 15_000,
}

export const publicEndpointAgents = {
  httpAgent: publicAgent(new HttpAgent(poolOptions)),
  httpsAgent: publicAgent(new HttpsAgent(poolOptions)),
}
