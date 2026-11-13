import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { afterEach, beforeEach, mock, test } from "node:test"

import {
  createSessionToken,
  isRequestAuthorized,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  verifySessionToken,
} from "./core.ts"

const authKeys = ["AUTH_USERNAME", "AUTH_PASSWORD", "AUTH_SECRET"]
let originalEnv
const issuedAt = 1_800_000_000

beforeEach(() => {
  originalEnv = authKeys.map((key) => process.env[key])
  process.env.AUTH_USERNAME = "test-user"
  process.env.AUTH_PASSWORD = "test-password"
  process.env.AUTH_SECRET = "test-secret"
  mock.method(Date, "now", () => issuedAt * 1000)
})

afterEach(() => {
  mock.restoreAll()
  authKeys.forEach((key, index) => {
    if (originalEnv[index] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[index]
  })
})

function requestWithToken(token) {
  return new Request("https://storage.example/api/upload", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` },
  })
}

function sign(payload) {
  const key = ["AUTH_SECRET", "AUTH_USERNAME", "AUTH_PASSWORD"]
    .map((key) => `${process.env[key].length}:${process.env[key]}`)
    .join("")
  return `${payload}.${createHmac("sha256", key).update(payload).digest("hex")}`
}

test("separate logins at the same instant receive valid, distinct tokens", async () => {
  const first = await createSessionToken()
  const second = await createSessionToken()
  assert.notEqual(first, second)
  assert.equal(await verifySessionToken(first), true)
  assert.equal(await verifySessionToken(second), true)
  assert.equal(await isRequestAuthorized(requestWithToken(first)), true)
})

test("server rejects a manually supplied cookie at expiry and after 30 days", async () => {
  const token = await createSessionToken()
  Date.now.mock.mockImplementation(
    () => (issuedAt + SESSION_MAX_AGE_SECONDS) * 1000 - 1
  )
  assert.equal(await verifySessionToken(token), true)
  Date.now.mock.mockImplementation(
    () => (issuedAt + SESSION_MAX_AGE_SECONDS) * 1000
  )
  assert.equal(await verifySessionToken(token), false)
  assert.equal(await isRequestAuthorized(requestWithToken(token)), false)
  Date.now.mock.mockImplementation(() => (issuedAt + 30 * 86400) * 1000)
  assert.equal(await isRequestAuthorized(requestWithToken(token)), false)
})

test("missing, malformed, legacy, and tampered tokens fail closed", async () => {
  const token = await createSessionToken()
  const parts = token.split(".")
  const invalid = [
    undefined,
    null,
    "",
    "garbage",
    "a".repeat(64),
    sign("filesystem-auth-v1").split(".").at(-1),
    `${token}.extra`,
    `${token}\n`,
    token.replace(
      `.${issuedAt}.${issuedAt + SESSION_MAX_AGE_SECONDS}.`,
      `.${issuedAt - 1}.${issuedAt + SESSION_MAX_AGE_SECONDS - 1}.`
    ),
  ]
  for (let index = 0; index < parts.length; index++) {
    const changed = [...parts]
    changed[index] =
      index === 1 || index === 2
        ? String(Number(parts[index]) + 1)
        : `${parts[index][0] === "a" ? "b" : "a"}${parts[index].slice(1)}`
    invalid.push(changed.join("."))
  }
  for (const value of invalid) {
    assert.equal(await verifySessionToken(value), false)
  }
  assert.equal(
    await isRequestAuthorized(
      new Request("https://storage.example/api/upload")
    ),
    false
  )
})

test("even correctly signed invalid timestamps and session IDs fail closed", async () => {
  const id = "a".repeat(32)
  const expiry = issuedAt + SESSION_MAX_AGE_SECONDS
  for (const payload of [
    `v2.${issuedAt + 1}.${expiry + 1}.${id}`,
    `v2.${issuedAt}.${expiry + 1}.${id}`,
    `v2.${issuedAt}.${issuedAt}.${id}`,
    `v2.9007199254740992.9007199255345792.${id}`,
    `v2.NaN.${expiry}.${id}`,
    `v2.-1.${expiry}.${id}`,
    `v2.${issuedAt}.${expiry}.`,
    `v2.${issuedAt}.${expiry}.invalid`,
    `v1.${issuedAt}.${expiry}.${id}`,
  ]) {
    assert.equal(await verifySessionToken(sign(payload)), false)
  }
  assert.equal(
    await verifySessionToken(sign(`v2.${issuedAt}.${expiry}.${id}`)),
    true
  )
})

for (const key of authKeys) {
  test(`${key} rotation invalidates existing tokens`, async () => {
    const token = await createSessionToken()
    process.env[key] += "-rotated"
    assert.equal(await verifySessionToken(token), false)
    assert.equal(await verifySessionToken(await createSessionToken()), true)
  })
}

test("optional AUTH_SECRET and disabled authentication keep working", async () => {
  delete process.env.AUTH_SECRET
  assert.equal(await verifySessionToken(await createSessionToken()), true)
  delete process.env.AUTH_PASSWORD
  assert.equal(
    await isRequestAuthorized(
      new Request("https://storage.example/api/upload")
    ),
    true
  )
})
