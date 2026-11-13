const encoder = new TextEncoder()

export const SESSION_COOKIE_NAME = "fs_session"
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7 // 7 days

/** Auth is active only when both credentials are configured. */
export function isAuthEnabled(): boolean {
  return Boolean(process.env.AUTH_USERNAME && process.env.AUTH_PASSWORD)
}

function sessionSecret(): string {
  return [
    process.env.AUTH_SECRET ?? "",
    process.env.AUTH_USERNAME ?? "",
    process.env.AUTH_PASSWORD ?? "",
  ]
    .map((part) => `${part.length}:${part}`)
    .join("")
}

export function verifyCredentials(username: string, password: string): boolean {
  const expectedUser = process.env.AUTH_USERNAME ?? ""
  const expectedPass = process.env.AUTH_PASSWORD ?? ""
  if (!expectedUser || !expectedPass) return false
  return (
    timingSafeEqual(username, expectedUser) &&
    timingSafeEqual(password, expectedPass)
  )
}

export async function createSessionToken(): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000)
  const expiresAt = issuedAt + SESSION_MAX_AGE_SECONDS
  const sessionId = toHex(crypto.getRandomValues(new Uint8Array(16)))
  const payload = `v2.${issuedAt}.${expiresAt}.${sessionId}`
  return `${payload}.${await signSessionPayload(payload)}`
}

async function signSessionPayload(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(sessionSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload)
  )
  return toHex(new Uint8Array(signature))
}

export async function verifySessionToken(
  token: string | undefined | null
): Promise<boolean> {
  if (!token) return false
  const parts =
    /^(v2\.([1-9][0-9]{0,15})\.([1-9][0-9]{0,15})\.[a-f0-9]{32})\.([a-f0-9]{64})$/.exec(
      token
    )
  if (!parts || parts[0] !== token) return false

  const [, payload, issuedAtText, expiresAtText, signature] = parts
  const issuedAt = Number(issuedAtText)
  const expiresAt = Number(expiresAtText)
  const now = Math.floor(Date.now() / 1000)
  if (
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    issuedAt > now ||
    expiresAt !== issuedAt + SESSION_MAX_AGE_SECONDS ||
    now >= expiresAt
  )
    return false

  return timingSafeEqual(signature, await signSessionPayload(payload))
}

/**
 * Session check for routes that opt out of the global proxy. `/api/upload` has
 * to: whenever middleware runs for a path, Next clones the request body and
 * truncates it at `middlewareClientMaxBodySize` (10MB by default), which breaks
 * every upload past that size. Raising the limit is not the answer — it would
 * buffer whole files in memory just to hand middleware a copy it never reads.
 */
export async function isRequestAuthorized(request: Request): Promise<boolean> {
  if (!isAuthEnabled()) return true
  return verifySessionToken(readCookie(request, SESSION_COOKIE_NAME))
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie")
  if (!header) return null

  for (const part of header.split(";")) {
    const separator = part.indexOf("=")
    if (separator < 0) continue
    if (part.slice(0, separator).trim() !== name) continue
    return decodeURIComponent(part.slice(separator + 1).trim())
  }
  return null
}

function toHex(bytes: Uint8Array): string {
  let out = ""
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0")
  return out
}

function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = encoder.encode(a)
  const bBytes = encoder.encode(b)
  let diff = aBytes.length ^ bBytes.length
  const length = Math.max(aBytes.length, bBytes.length)
  for (let i = 0; i < length; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0)
  }
  return diff === 0
}
