import assert from "node:assert/strict"
import dns from "node:dns"
import { createServer } from "node:http"
import { registerHooks, syncBuiltinESMExports } from "node:module"
import { Socket } from "node:net"
import { after, before, test } from "node:test"

// Run the real server modules with Node's TypeScript support, outside Next.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: "data:text/javascript,export {}", shortCircuit: true }
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(
        new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href,
        context
      )
    }
    return nextResolve(specifier, context)
  },
})

const { resolveFiles, buildFilesForConnection } =
  await import("../lib/storage/connections-server.ts")
const { probeConnection } = await import("../lib/storage/file-operations.ts")
const { assertPublicHostname, assertEndpointAllowed, publicEndpointAgents } =
  await import("../lib/storage/endpoint-policy.ts")

const savedEnv = { ...process.env }
let hits = 0
let destination = "/"
const server = createServer((request, response) => {
  hits++
  if (destination !== "/") {
    response.writeHead(302, { Location: destination }).end()
    return
  }
  if (request.method === "GET") {
    response
      .writeHead(200, { "Content-Type": "application/xml" })
      .end(
        '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated><Contents/></ListBucketResult>'
      )
    return
  }
  response
    .writeHead(207, { "Content-Type": "application/xml" })
    .end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>')
})
let port
before(async () => {
  process.env.NODE_ENV = "production"
  delete process.env.ALLOW_PRIVATE_ENDPOINTS
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = server.address().port
})
after(async () => {
  publicEndpointAgents.httpAgent.destroy()
  publicEndpointAgents.httpsAgent.destroy()
  await new Promise((resolve) => server.close(resolve))
  process.env = savedEnv
})

function connection(endpoint, provider = "webdav") {
  return {
    id: "test",
    name: "test",
    provider,
    endpoint,
    bucket: "test",
    region: "us-east-1",
    accountId: "test",
    accessKeyId: "user",
    secretAccessKey: "password",
    forcePathStyle: true,
  }
}
function local(endpoint, provider) {
  return resolveFiles({
    source: "local",
    connection: connection(endpoint, provider),
  })
}

const privateHosts = [
  "127.0.0.1",
  "0.0.0.0",
  "10.0.0.1",
  "172.16.0.1",
  "192.168.0.1",
  "169.254.169.254",
  "100.64.0.1",
  "[::]",
  "[::1]",
  "[fc00::1]",
  "[fe80::1]",
  "[::ffff:127.0.0.1]",
  "[::ffff:7f00:1]",
  "[::ffff:a00:1]",
  "[::ffff:a9fe:a9fe]",
  "localhost.",
  "nas.local",
]
for (const host of privateHosts) {
  test(`rejects private literal/name ${host}`, () => {
    assert.throws(() => local(`http://${host}:${port}`), /private address/)
  })
}
test("normalizes alternate IPv4 URL spellings", () => {
  for (const host of ["2130706433", "0x7f000001", "127.1"]) {
    assert.throws(() => local(`http://${host}`), /private address/)
  }
})
test("accepts public IPv4, IPv6, mapped public IPv6 and hostnames", () => {
  for (const host of [
    "8.8.8.8",
    "2606:4700:4700::1111",
    "::ffff:808:808",
    "storage.example.com",
  ]) {
    assert.doesNotThrow(() => assertPublicHostname(host))
  }
  assert.throws(
    () => assertEndpointAllowed("file:///etc/passwd", "Endpoint"),
    /http or https/
  )
})

test("DNS private and mixed answers never reach the server, for WebDAV and S3", async (t) => {
  const originalHits = hits
  for (const addresses of [
    ["127.0.0.1"],
    ["::ffff:7f00:1"],
    ["8.8.8.8", "10.0.0.1"],
  ]) {
    const mock = t.mock.method(dns, "lookup", (host, options, callback) => {
      callback(
        null,
        addresses.map((address) => ({
          address,
          family: address.includes(":") ? 6 : 4,
        }))
      )
    })
    syncBuiltinESMExports()
    for (const provider of [
      "webdav",
      "s3-compatible",
      "s3",
      "minio",
      "alibaba",
      "tencent",
      "backblaze-b2",
      "r2",
    ]) {
      await assert.rejects(
        probeConnection(local(`http://dns.test:${port}`, provider)),
        /private address/
      )
    }
    mock.mock.restore()
    syncBuiltinESMExports()
  }
  assert.equal(hits, originalHits)
})

test("public DNS is checked once and its vetted result goes directly to the socket; private redirects fail", async (t) => {
  let lookups = 0
  const dnsMock = t.mock.method(dns, "lookup", (host, options, callback) => {
    lookups++
    callback(null, [
      { address: lookups === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 },
    ])
  })
  syncBuiltinESMExports()
  const connect = Socket.prototype.connect
  // Route the vetted public address to our isolated mock server. No external
  // service is contacted; inspect the actual socket's lookup callback first.
  t.mock.method(Socket.prototype, "connect", function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : args[0]
    this.connecting = true
    options.lookup(options.host, { all: true }, (error, addresses) => {
      if (error) {
        queueMicrotask(() => this.destroy(error))
        return
      }
      assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }])
      connect.call(this, { ...options, host: "127.0.0.1", lookup: undefined })
    })
    return this
  })
  await probeConnection(local(`http://public.test:${port}`))
  assert.equal(lookups, 1)
  publicEndpointAgents.httpAgent.destroy()
  lookups = 0
  await probeConnection(local(`http://public.test:${port}`, "s3-compatible"))
  assert.equal(lookups, 1)
  publicEndpointAgents.httpAgent.destroy()
  for (const target of [
    "http://127.0.0.1",
    "http://[::ffff:7f00:1]",
    "http://private.test",
    "https://[::ffff:7f00:1]",
  ]) {
    lookups = 0
    destination = `${target}:${port}/private`
    const originalHits = hits
    await assert.rejects(
      probeConnection(local(`http://public.test:${port}`)),
      /private address/
    )
    assert.equal(hits, originalHits + 1)
    publicEndpointAgents.httpAgent.destroy()
  }
  destination = "/"
  dnsMock.mock.restore()
  syncBuiltinESMExports()
})

test("explicit opt-in and trusted env connections can access a private server", async () => {
  const endpoint = `http://127.0.0.1:${port}`
  process.env.ALLOW_PRIVATE_ENDPOINTS = "true"
  await probeConnection(local(endpoint))
  delete process.env.ALLOW_PRIVATE_ENDPOINTS
  process.env.STORAGE_1_PROVIDER = "webdav"
  process.env.STORAGE_1_ENDPOINT = endpoint
  await probeConnection(resolveFiles({ source: "env", id: "env-1" }))
})
test("standalone server builder enforces the same policy", () => {
  assert.throws(
    () => buildFilesForConnection(connection("http://[::ffff:127.0.0.1]")),
    /private address/
  )
})

test("unsupported Bun transport fails closed unless explicitly opted in", () => {
  Object.defineProperty(process.versions, "bun", {
    value: "1.3.14",
    configurable: true,
  })
  try {
    assert.throws(
      () => local("https://storage.example.com"),
      /requires Node.js/
    )
    process.env.ALLOW_PRIVATE_ENDPOINTS = "true"
    assert.doesNotThrow(() => local("https://storage.example.com"))
  } finally {
    delete process.versions.bun
    delete process.env.ALLOW_PRIVATE_ENDPOINTS
  }
})
