import { isRequestAuthorized } from "@/lib/auth/core"
import { isThumbnailWidth } from "@/lib/storage/thumbnails"
import {
  getThumbnail,
  resolveThumbnailConnection,
  ThumbnailTooLargeError,
} from "@/lib/storage/thumbnails-server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// With `v` the URL is content-addressed and can be kept indefinitely; without
// one a replaced object would go unnoticed. Never `public` — user's own data.
const IMMUTABLE_CACHE_CONTROL = "private, max-age=31536000, immutable"
const REVALIDATING_CACHE_CONTROL =
  "private, max-age=300, stale-while-revalidate=3600"

/** Failures must not stick in the cache. */
function failure(message: string, status: number) {
  return new Response(message, {
    status,
    headers: { "Cache-Control": "no-store" },
  })
}

export async function GET(request: Request) {
  if (!(await isRequestAuthorized(request))) {
    return failure("Unauthorized.", 401)
  }

  const params = new URL(request.url).searchParams
  const handle = params.get("c")
  const key = params.get("k")
  const width = Number(params.get("w"))
  const cacheControl = params.get("v")
    ? IMMUTABLE_CACHE_CONTROL
    : REVALIDATING_CACHE_CONTROL

  if (!handle || !key || !isThumbnailWidth(width)) {
    return failure("Invalid request.", 400)
  }

  const ref = resolveThumbnailConnection(handle)
  if (!ref) return failure("Unknown connection.", 404)

  let thumbnail
  try {
    thumbnail = await getThumbnail(handle, ref, key, width)
  } catch (error) {
    if (error instanceof ThumbnailTooLargeError) {
      return failure("Image too large to preview.", 413)
    }
    return failure(
      error instanceof Error ? error.message : "Could not render thumbnail.",
      502
    )
  }

  if (request.headers.get("if-none-match") === thumbnail.etag) {
    return new Response(null, {
      status: 304,
      headers: { "Cache-Control": cacheControl, ETag: thumbnail.etag },
    })
  }

  return new Response(thumbnail.body, {
    headers: {
      "Cache-Control": cacheControl,
      "Content-Length": String(thumbnail.body.byteLength),
      "Content-Type": thumbnail.contentType,
      ETag: thumbnail.etag,
    },
  })
}
