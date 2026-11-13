import assert from "node:assert/strict"
import { createServer } from "node:http"
import { Readable } from "node:stream"
import { after, before, beforeEach, test } from "node:test"
import { createFiles } from "files-sdk"
import { webdav } from "files-sdk/webdav"

import {
  collectZipKeys,
  createFolder,
  listFolder,
  moveEntry,
  renameEntry,
  webdavUploadTarget,
} from "./file-operations.ts"

const requests = []
const server = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  requests.push({
    method: request.method,
    path: request.url,
    destination: request.headers.destination,
    body: Buffer.concat(chunks).toString(),
  })

  if (request.method === "PROPFIND") {
    if (request.headers.depth === "0" && request.url !== "/allowed") {
      response.writeHead(404).end()
      return
    }
    response.writeHead(207, { "Content-Type": "application/xml" })
    response.end(`<?xml version="1.0"?>
      <d:multistatus xmlns:d="DAV:">
        <d:response><d:href>${request.url}</d:href><d:propstat><d:prop>
          <d:resourcetype><d:collection/></d:resourcetype>
        </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
      </d:multistatus>`)
    return
  }
  response.writeHead(201).end()
})
let files

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  files = createFiles({
    adapter: webdav({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      root: "/allowed",
      authType: "none",
    }),
  })
})
after(() => new Promise((resolve) => server.close(resolve)))
beforeEach(() => {
  requests.length = 0
})

async function streamUpload(key) {
  const target = webdavUploadTarget(files, key)
  if (target.parentRemotePath) {
    await target.client.createDirectory(target.parentRemotePath, {
      recursive: true,
    })
  }
  await target.client.customRequest(target.remotePath, {
    method: "PUT",
    data: Readable.from(["probe"]),
    headers: { "Content-Length": "5" },
  })
}

const operations = {
  listing: (key) => listFolder(files, key, null),
  MKCOL: (key) => createFolder(files, key),
  "rename existence probe": (key) =>
    renameEntry(files, { kind: "file", path: "source" }, key),
  "move existence probe": (key) =>
    moveEntry(files, { kind: "file", path: "source" }, key),
  "ZIP listing": (key) => collectZipKeys(files, key),
  "streaming PUT": streamUpload,
}

for (const key of [
  "../outside/probe",
  "a/../../outside/probe",
  "/../outside/probe",
  "a//../probe",
  "..",
  "a/..",
  "a/\0probe",
  "..\\outside\\probe",
  "..\\\\outside\\\\probe",
  "..__PATH_SEPARATOR_POSIX__outside/probe",
  "..__PATH_SEPARATOR_WINDOWS__outside/probe",
]) {
  for (const [name, operation] of Object.entries(operations)) {
    test(`${name} rejects ${JSON.stringify(key)} without upstream requests`, async () => {
      await assert.rejects(() => operation(key), /Invalid WebDAV key/)
      assert.deepEqual(requests, [])
    })
  }
}

for (const key of [
  "nested/file",
  "space dir/文档 😀.txt",
  "literal/%2e%2e/%2f%00.txt",
]) {
  test(`normal operations stay under the root for ${key}`, async () => {
    assert.deepEqual(await listFolder(files, key, null), {
      items: [],
      nextCursor: null,
    })
    const encodedPath = `/allowed/${key.split("/").map(encodeURIComponent).join("/")}`
    assert.equal(requests[0].path, `${encodedPath}/`)
    await createFolder(files, key)
    await renameEntry(files, { kind: "file", path: "source" }, key)
    await moveEntry(files, { kind: "file", path: "source" }, key)
    await streamUpload(key)
    for (const method of ["PROPFIND", "MKCOL", "PUT"]) {
      assert.ok(
        requests.some(
          (request) =>
            request.method === method &&
            request.path === `${encodedPath}${method === "MKCOL" ? "/" : ""}`
        ),
        method
      )
    }
    assert.ok(
      requests.some(
        (request) =>
          request.method === "MOVE" &&
          new URL(request.destination).pathname === encodedPath
      )
    )
    assert.equal(
      requests.find((request) => request.method === "PUT").body,
      "probe"
    )
    assert.ok(
      requests.every(
        (request) =>
          request.path === "/allowed" || request.path.startsWith("/allowed/")
      )
    )
  })
}

test("empty and slash prefixes still list the configured root", async () => {
  for (const prefix of ["", "/"]) await listFolder(files, prefix, null)
  assert.deepEqual(
    requests.map(({ path }) => path),
    ["/allowed/", "/allowed/"]
  )
})
