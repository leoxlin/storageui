import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { createFiles } from "files-sdk"
import { s3 } from "files-sdk/s3"
import { webdav } from "files-sdk/webdav"
import sharp from "sharp"

mock.module("server-only", () => ({}))
const clients = new Map()
mock.module("@/lib/storage/connections-server", () => ({
  resolveFiles: (ref) => clients.get(ref.id),
}))
const { getThumbnail, ThumbnailTooLargeError } =
  await import("./thumbnails-server.ts")
const { GET } = await import("../../app/api/thumbnail/route.ts")

const LIMIT = 25 * 1024 * 1024
let sequence = 0
function thumbnail(client) {
  const id = `test-${sequence++}`
  clients.set(id, client)
  return getThumbnail(`e_${id}`, { source: "env", id }, "image.png", 128)
}

function source({ headSize, storedSize = 0, chunks, readError, cancelError }) {
  const state = { reads: 0, cancelled: false, stream: null }
  const client = {
    head: mock(() => Promise.resolve({ size: headSize })),
    download: mock((_key, options) => {
      expect(options).toEqual({ as: "stream" })
      state.stream = new ReadableStream(
        {
          pull(controller) {
            state.reads++
            if (readError) return controller.error(readError)
            const next = chunks.next()
            if (next.done) controller.close()
            else controller.enqueue(next.value)
          },
          cancel() {
            state.cancelled = true
            if (cancelError) throw cancelError
          },
        },
        { highWaterMark: 0 }
      )
      return Promise.resolve({
        size: storedSize,
        stream: () => state.stream,
        arrayBuffer: () => {
          throw new Error("unbounded buffering must never be used")
        },
      })
    }),
  }
  return { client, state }
}

function* oversizedChunks() {
  // Model a huge remote object without allocating or exhausting it.
  for (let i = 0; i < 1024; i++) yield new Uint8Array(1024 * 1024)
}

afterEach(() => clients.clear())

test("oversized metadata rejects before downloading", async () => {
  const { client } = source({ headSize: LIMIT + 1, chunks: oversizedChunks() })
  await expect(thumbnail(client)).rejects.toBeInstanceOf(ThumbnailTooLargeError)
  expect(client.download).not.toHaveBeenCalled()
})

test("fresh oversized download metadata cancels without reading", async () => {
  const { client, state } = source({
    headSize: 1,
    storedSize: LIMIT + 1,
    chunks: oversizedChunks(),
  })
  await expect(thumbnail(client)).rejects.toBeInstanceOf(ThumbnailTooLargeError)
  expect(state.reads).toBe(0)
  expect(state.cancelled).toBe(true)
  expect(state.stream.locked).toBe(false)
})

test("one byte over the limit is rejected before reading the rest", async () => {
  const { client, state } = source({
    chunks: (function* () {
      yield new Uint8Array(LIMIT)
      yield new Uint8Array(1)
      throw new Error("must not read beyond the limit")
    })(),
  })
  await expect(thumbnail(client)).rejects.toBeInstanceOf(ThumbnailTooLargeError)
  expect(state.reads).toBe(2)
  expect(state.cancelled).toBe(true)
})

for (const size of [undefined, 1]) {
  test(`missing or false size (${size}) stops at the first excess byte`, async () => {
    const { client, state } = source({
      headSize: size,
      storedSize: size,
      chunks: oversizedChunks(),
    })
    await expect(thumbnail(client)).rejects.toBeInstanceOf(
      ThumbnailTooLargeError
    )
    expect(state.reads).toBe(26)
    expect(state.cancelled).toBe(true)
    expect(state.stream.locked).toBe(false)
  })
}

test("cancellation failure preserves the size error", async () => {
  const { client, state } = source({
    chunks: oversizedChunks(),
    cancelError: new Error("upstream disconnected"),
  })
  await expect(thumbnail(client)).rejects.toBeInstanceOf(ThumbnailTooLargeError)
  expect(state.stream.locked).toBe(false)
})

test("valid images and images exactly at the byte limit render WebP", async () => {
  const png = await sharp({
    create: { width: 256, height: 256, channels: 3, background: "red" },
  })
    .png()
    .toBuffer()
  for (const size of [png.length, LIMIT]) {
    const { client } = source({
      headSize: size,
      storedSize: size,
      chunks: (function* () {
        yield png
        if (size > png.length) yield new Uint8Array(size - png.length)
      })(),
    })
    const result = await thumbnail(client)
    expect(result.contentType).toBe("image/webp")
    expect(result.etag).toMatch(/^".+"$/)
    const metadata = await sharp(Buffer.from(result.body)).metadata()
    expect(metadata.format).toBe("webp")
    expect(metadata.width).toBe(128)
    expect(metadata.height).toBe(128)
  }
})

test("stream failures release slots for subsequent requests", async () => {
  const { client, state } = source({
    chunks: oversizedChunks(),
    readError: new Error("stream failed"),
  })
  await expect(thumbnail(client)).rejects.toThrow("stream failed")
  expect(state.stream.locked).toBe(false)
  const oversized = source({ headSize: LIMIT + 1, chunks: oversizedChunks() })
  await expect(thumbnail(oversized.client)).rejects.toBeInstanceOf(
    ThumbnailTooLargeError
  )
})

test("concurrent downloads stay capped at four until cancellation completes", async () => {
  let active = 0
  let peak = 0
  const releases = []
  const client = {
    head: () => Promise.resolve({ size: 0 }),
    download: mock((_key, options) => {
      expect(options).toEqual({ as: "stream" })
      active++
      peak = Math.max(peak, active)
      return Promise.resolve({
        size: LIMIT + 1,
        stream: () =>
          new ReadableStream(
            {
              cancel: () =>
                new Promise((resolve) => {
                  releases.push(() => {
                    active--
                    resolve()
                  })
                }),
            },
            { highWaterMark: 0 }
          ),
      })
    }),
  }
  const pending = Promise.allSettled(
    Array.from({ length: 12 }, () => thumbnail(client))
  )
  for (let batch = 0; batch < 3; batch++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(active).toBe(4)
    expect(client.download).toHaveBeenCalledTimes((batch + 1) * 4)
    releases.splice(0).forEach((release) => release())
  }
  const results = await pending
  expect(peak).toBe(4)
  expect(active).toBe(0)
  for (const result of results) {
    expect(result.status).toBe("rejected")
    expect(result.reason).toBeInstanceOf(ThumbnailTooLargeError)
  }
})

test("oversized sources return an uncacheable HTTP 413", async () => {
  const { client, state } = source({ chunks: oversizedChunks() })
  clients.set("route", client)
  const response = await GET(
    new Request("http://localhost/api/thumbnail?c=e_route&k=image.png&w=128")
  )
  expect(response.status).toBe(413)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(state.cancelled).toBe(true)
})

for (const provider of ["s3", "webdav"]) {
  test(`${provider} SDK adapter streams and propagates cancellation`, async () => {
    const { client, state } = source({ chunks: oversizedChunks() })
    const streamed = () => client.download("image.png", { as: "stream" })
    let adapter
    if (provider === "s3") {
      adapter = s3({ bucket: "test", region: "us-east-1" })
      adapter.raw.send = async (command) => {
        if (command.constructor.name === "HeadObjectCommand") return {}
        expect(command.constructor.name).toBe("GetObjectCommand")
        const stored = await streamed()
        return {
          Body: {
            transformToWebStream: () => stored.stream(),
            transformToByteArray: () => {
              throw new Error("S3 must not buffer the object")
            },
          },
        }
      }
    } else {
      adapter = webdav({
        client: {
          stat: () => Promise.resolve({ type: "file", size: 1 }),
          customRequest: async (_path, options) => {
            expect(options.method).toBe("GET")
            return new Response((await streamed()).stream())
          },
          getFileContents: () => {
            throw new Error("WebDAV must not buffer the object")
          },
        },
      })
    }
    await expect(thumbnail(createFiles({ adapter }))).rejects.toBeInstanceOf(
      ThumbnailTooLargeError
    )
    expect(state.reads).toBe(26)
    expect(state.cancelled).toBe(true)
    expect(state.stream.locked).toBe(false)
  })
}

test("small sources queued behind four decodes retain only populated bytes", async () => {
  const png = await sharp({
    create: { width: 32, height: 32, channels: 3, background: "blue" },
  })
    .png()
    .toBuffer()
  const inputs = []
  const toBuffer = sharp.prototype.toBuffer
  const decodeGate = Promise.withResolvers()
  const downloadsDone = Promise.withResolvers()
  let completedDownloads = 0
  const decode = spyOn(sharp.prototype, "toBuffer").mockImplementation(
    function () {
      inputs.push(this.options.input.buffer)
      return decodeGate.promise.then(() => toBuffer.call(this))
    }
  )
  const pending = Promise.all(
    Array.from({ length: 12 }, () => {
      const { client } = source({
        chunks: (function* () {
          yield png
          completedDownloads++
          if (completedDownloads === 12) downloadsDone.resolve()
        })(),
      })
      return thumbnail(client)
    })
  )

  try {
    await downloadsDone.promise
    // Let stream cleanup and decode admission settle without unblocking Sharp.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(completedDownloads).toBe(12)
    expect(inputs).toHaveLength(4)
    for (const input of inputs) {
      expect(input.equals(png)).toBe(true)
      expect(input.buffer.byteLength).toBe(png.length)
    }
    decodeGate.resolve()
    const results = await pending
    expect(results).toHaveLength(12)
    expect(inputs).toHaveLength(12)
    // Includes the eight sources that had to wait in the decode queue.
    for (const input of inputs) {
      expect(input.equals(png)).toBe(true)
      expect(input.buffer.byteLength).toBe(png.length)
    }
  } finally {
    decodeGate.resolve()
    await pending
    decode.mockRestore()
  }
})
