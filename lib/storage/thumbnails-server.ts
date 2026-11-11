import "server-only"

import { createHash } from "node:crypto"
import sharp from "sharp"

import type { ConnectionRef } from "@/lib/storage/connection-ref"
import { resolveFiles } from "@/lib/storage/connections-server"
import { normalizeError } from "@/lib/storage/file-operations"
import type { FilesClient } from "@/lib/storage/files-client"
import {
  ENV_HANDLE_PREFIX,
  type ThumbnailWidth,
} from "@/lib/storage/thumbnails"

/**
 * No server-side cache on purpose: on serverless, consecutive requests land on
 * different instances, so anything kept in a process almost never hits while
 * still costing the memory it retains. The content-addressed URL lets the
 * browser cache indefinitely instead.
 */

const MAX_SOURCE_BYTES = 25 * 1024 * 1024
/** Decompression-bomb guard. */
const MAX_SOURCE_PIXELS = 100_000_000
const WEBP_QUALITY = 80
const MAX_CONCURRENT_DECODES = 4
/**
 * Each active download retains at most MAX_SOURCE_BYTES of source data.
 * Keep the slot until the stream has finished or has been cancelled.
 */
const MAX_CONCURRENT_DOWNLOADS = 4

sharp.cache(false)
sharp.concurrency(1)

export type Thumbnail = {
  body: ArrayBuffer
  contentType: string
  etag: string
}

export function resolveThumbnailConnection(
  handle: string
): ConnectionRef | null {
  if (!handle.startsWith(ENV_HANDLE_PREFIX)) return null
  const id = handle.slice(ENV_HANDLE_PREFIX.length)
  return id ? { source: "env", id } : null
}

function semaphore(limit: number) {
  let active = 0
  const waiting: Array<() => void> = []

  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve))
    }
    active += 1
    try {
      return await task()
    } finally {
      active -= 1
      waiting.shift()?.()
    }
  }
}

const withDecodeSlot = semaphore(MAX_CONCURRENT_DECODES)
const withDownloadSlot = semaphore(MAX_CONCURRENT_DOWNLOADS)

/** Not a cache — entries drop as they settle — just request coalescing. */
const inFlight = new Map<string, Promise<Thumbnail>>()

export class ThumbnailTooLargeError extends Error {
  constructor(size: number) {
    super(`Source object is ${size} bytes, above the thumbnail limit.`)
    this.name = "ThumbnailTooLargeError"
  }
}

async function downloadSource(
  files: FilesClient,
  key: string
): Promise<Buffer> {
  return withDownloadSlot(async () => {
    try {
      const metadata = await files.head(key)
      if (metadata.size > MAX_SOURCE_BYTES) {
        throw new ThumbnailTooLargeError(metadata.size)
      }

      const stored = await files.download(key, { as: "stream" })
      const reader = stored.stream().getReader()
      try {
        if (stored.size > MAX_SOURCE_BYTES) {
          throw new ThumbnailTooLargeError(stored.size)
        }

        // A fixed buffer also bounds overhead from arbitrarily tiny chunks.
        const source = Buffer.allocUnsafe(MAX_SOURCE_BYTES)
        let size = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) return source.subarray(0, size)
          size += value.byteLength
          if (size > MAX_SOURCE_BYTES) {
            throw new ThumbnailTooLargeError(size)
          }
          source.set(value, size - value.byteLength)
        }
      } finally {
        // Preserve the original error if the upstream is already broken.
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    } catch (error) {
      throw normalizeError(error)
    }
  })
}

async function render(
  ref: ConnectionRef,
  key: string,
  width: ThumbnailWidth
): Promise<Thumbnail> {
  const source = await downloadSource(resolveFiles(ref), key)

  return withDecodeSlot(async () => {
    const body = await sharp(source, {
      // Truncated images are common in real buckets; render what decodes.
      failOn: "none",
      limitInputPixels: MAX_SOURCE_PIXELS,
    })
      // Applies EXIF orientation; must precede `resize` to be honored.
      .rotate()
      // `outside` because tiles display with `object-cover`, which scales to
      // cover both dimensions; `inside` only guarantees the longest side and
      // left anything non-square to be upscaled by the browser.
      .resize(width, width, { fit: "outside", withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer()

    // Copy out of sharp's pooled Buffer so the response does not pin the pool.
    const bytes = new Uint8Array(body)

    return {
      body: bytes.buffer as ArrayBuffer,
      contentType: "image/webp",
      etag: `"${createHash("sha1").update(body).digest("base64url")}"`,
    }
  })
}

export function getThumbnail(
  handle: string,
  ref: ConnectionRef,
  key: string,
  width: ThumbnailWidth
): Promise<Thumbnail> {
  const id = `${handle} ${key} ${width}`

  const running = inFlight.get(id)
  if (running) return running

  const pending = render(ref, key, width).finally(() => {
    inFlight.delete(id)
  })

  inFlight.set(id, pending)
  return pending
}
