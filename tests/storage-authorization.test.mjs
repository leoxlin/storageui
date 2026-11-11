import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server"
import { afterAll, beforeEach, expect, mock, test } from "bun:test"

// Keep the real auth verifier, action bodies and route handlers. Replace only
// Next's request context and storage so rejected requests cannot touch a backend.
let session
let readOnly = false
const backend = mock(() => {})
const connections = [{ id: "env", source: "env" }]
const files = {
  list: () => {
    backend()
    return { items: [] }
  },
  listAll: async function* ({ prefix }) {
    backend()
    if ("folder/file.txt".startsWith(prefix)) yield { key: "folder/file.txt" }
  },
  url: () => {
    backend()
    return "https://storage.example/signed"
  },
  signedUploadUrl: () => {
    backend()
    return { url: "https://storage.example/upload" }
  },
  upload: () => {
    backend()
  },
  delete: () => {
    backend()
  },
  move: () => {
    backend()
  },
  head: () => {
    backend()
    return { size: 4, type: "text/plain" }
  },
  download: () => {
    backend()
    return { size: 4, stream: () => new Blob(["data"]).stream() }
  },
  zip: () => {
    backend()
    return new Blob(["zip"]).stream()
  },
}
const resolveFiles = mock(() => files)
const listPublicEnvConnections = mock(() => connections)
const assertConnectionWritable = mock(() => {
  if (readOnly) throw new Error("This bucket is read-only.")
})
const thumbnail = mock(() => ({
  body: new Uint8Array([1]).buffer,
  contentType: "image/webp",
  etag: '"test"',
}))
mock.module("server-only", () => ({}))
mock.module("next/headers", () => ({
  cookies: async () => ({
    get: () => (session ? { value: session } : undefined),
  }),
}))
mock.module("@/lib/storage/connections-server", () => ({
  resolveFiles,
  listPublicEnvConnections,
  assertConnectionWritable,
  refFromRequest: () => ({ source: "env", id: "env" }),
  connectionReissuesRequests: () => false,
}))
mock.module("@/lib/storage/thumbnails-server", () => ({
  getThumbnail: thumbnail,
  resolveThumbnailConnection: () => ({ source: "env", id: "env" }),
  ThumbnailTooLargeError: class extends Error {},
}))

const { createSessionToken } = await import("../lib/auth/core.ts")
const actions = await import("../app/actions/files.ts")
const { config, proxy } = await import("../proxy.ts")
const { NextRequest } = await import("next/server")
const routes = [
  [
    (await import("../app/api/file/route.ts")).GET,
    "/api/file?c=env&key=file.txt",
  ],
  [(await import("../app/api/zip/route.ts")).GET, "/api/zip?c=env&path=folder"],
  [
    (await import("../app/api/thumbnail/route.ts")).GET,
    "/api/thumbnail?c=e_env&k=file.png&w=128",
  ],
  [
    (await import("../app/api/upload/route.ts")).POST,
    "/api/upload?key=file.txt",
  ],
]
const ref = { source: "env", id: "env" }
const entry = { kind: "file", key: "source.txt", path: "source.txt" }
const actionArgs = {
  listEnvConnectionsAction: [],
  testConnectionAction: [ref],
  listFolderAction: [ref, "", null],
  signFileUrlAction: [ref, "file.txt"],
  signFileUrlsAction: [ref, ["file.txt"]],
  signUploadUrlAction: [ref, "file.txt", "text/plain"],
  createFolderAction: [ref, "folder"],
  deleteEntryAction: [ref, entry],
  renameEntryAction: [ref, entry, "renamed.txt"],
  moveEntryAction: [ref, entry, "destination/"],
}
const originalEnv = { ...process.env }
beforeEach(() => {
  process.env.AUTH_USERNAME = "test-user"
  process.env.AUTH_PASSWORD = "test-password"
  session = undefined
  readOnly = false
  for (const spy of [
    backend,
    resolveFiles,
    listPublicEnvConnections,
    assertConnectionWritable,
    thumbnail,
  ])
    spy.mockClear()
})
afterAll(() => {
  process.env = originalEnv
})

for (const token of [undefined, "invalid-token"]) {
  test(`every action rejects ${token ?? "missing"} sessions before storage access`, async () => {
    session = token
    expect(Object.keys(actions).sort()).toEqual(Object.keys(actionArgs).sort())
    for (const [name, args] of Object.entries(actionArgs)) {
      await expect(actions[name](...args)).rejects.toThrow("Unauthorized.")
    }
    expect(resolveFiles).not.toHaveBeenCalled()
    expect(listPublicEnvConnections).not.toHaveBeenCalled()
    expect(assertConnectionWritable).not.toHaveBeenCalled()
    expect(backend).not.toHaveBeenCalled()
  })
  test(`every protected route rejects ${token ?? "missing"} sessions before storage access`, async () => {
    for (const [handler, path] of routes) {
      const response = await handler(requestFor(path, token))
      expect(response.status).toBe(401)
    }
    expect(resolveFiles).not.toHaveBeenCalled()
    expect(thumbnail).not.toHaveBeenCalled()
    expect(backend).not.toHaveBeenCalled()
  })
}

function requestFor(path, token) {
  return new Request(`http://localhost${path}`, {
    method: path.startsWith("/api/upload") ? "POST" : "GET",
    headers: {
      ...(token ? { cookie: `fs_session=${token}` } : {}),
      "x-storage-ref": Buffer.from(JSON.stringify(ref)).toString("base64"),
    },
  })
}

for (const mode of ["authenticated", "auth-disabled"]) {
  test(`${mode} actions and routes can still access storage`, async () => {
    if (mode === "auth-disabled") {
      delete process.env.AUTH_USERNAME
      delete process.env.AUTH_PASSWORD
    } else session = await createSessionToken()
    for (const [name, args] of Object.entries(actionArgs))
      await actions[name](...args)
    expect(listPublicEnvConnections).toHaveBeenCalledTimes(1)
    expect(backend).toHaveBeenCalled()
    for (const [handler, path] of routes) {
      expect((await handler(requestFor(path, session))).status).toBe(200)
    }
    expect(thumbnail).toHaveBeenCalledTimes(1)
  })
}

test("authenticated mutations still enforce read-only connections", async () => {
  session = await createSessionToken()
  readOnly = true
  for (const name of [
    "signUploadUrlAction",
    "createFolderAction",
    "deleteEntryAction",
    "renameEntryAction",
    "moveEntryAction",
  ]) {
    await expect(actions[name](...actionArgs[name])).rejects.toThrow(
      "read-only"
    )
  }
  expect(backend).not.toHaveBeenCalled()
})

test("only exact public assets bypass the proxy; lookalike paths require login", async () => {
  const assets = [
    "favicon.ico",
    "icon.svg",
    "icon-dark.svg",
    "icon.png",
    "apple-icon.png",
    "site.webmanifest",
    "opengraph-image.png",
    "robots.txt",
    "sitemap.xml",
  ]
  for (const asset of assets) {
    expect(unstable_doesMiddlewareMatch({ config, url: `/${asset}` })).toBe(
      false
    )
    for (const path of [
      `/${asset}/audit`,
      `/${asset}evil`,
      `/${asset.replaceAll(".", "x")}`,
    ]) {
      expect(unstable_doesMiddlewareMatch({ config, url: path })).toBe(true)
      const response = await proxy(new NextRequest(`http://localhost${path}`))
      expect(response.status).toBe(307)
      expect(response.headers.get("location")).toBe("http://localhost/login")
    }
  }
  for (const path of [
    "/_next/static/chunk.js",
    "/_next/image?url=x",
    "/api/upload",
  ]) {
    expect(unstable_doesMiddlewareMatch({ config, url: path })).toBe(false)
  }
  for (const path of [
    "/",
    "/login",
    "/api/file",
    "/api/zip",
    "/api/thumbnail",
    "/api/upload/audit",
    "/_next/static-audit",
    "/_next/image/audit",
  ]) {
    expect(unstable_doesMiddlewareMatch({ config, url: path })).toBe(true)
  }
})
