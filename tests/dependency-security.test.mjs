import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { JSONC } from "bun"
import { expect, test } from "bun:test"

const require = createRequire(import.meta.url)
const lock = JSONC.parse(
  readFileSync(new URL("../bun.lock", import.meta.url), "utf8")
)

function expectPatched(version, minimum) {
  expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  expect(
    version.localeCompare(minimum, "en", { numeric: true })
  ).toBeGreaterThanOrEqual(0)
}

test("all locked Next.js and Sharp copies include the issue #2 patches", () => {
  const minimums = {
    next: "16.4.1",
    "eslint-config-next": "16.4.1",
    sharp: "0.35.5",
  }
  const checked = new Set()
  for (const [resolved] of Object.values(lock.packages)) {
    const separator = resolved.lastIndexOf("@")
    const name = resolved.slice(0, separator)
    const version = resolved.slice(separator + 1)
    const minimum = name.startsWith("@img/sharp-libvips-")
      ? "1.3.4"
      : name.startsWith("@img/sharp-")
        ? "0.35.5"
        : minimums[name]
    if (minimum) {
      expectPatched(version, minimum)
      checked.add(name)
    }
  }
  for (const name of [
    ...Object.keys(minimums),
    "@img/sharp-linux-x64",
    "@img/sharp-linux-arm64",
    "@img/sharp-libvips-linux-x64",
    "@img/sharp-libvips-linux-arm64",
  ]) {
    expect(checked.has(name)).toBe(true)
  }
  expect(require("next/package.json").version).toBe(
    require("eslint-config-next/package.json").version
  )
})

// Check both entry points: upgrading only the direct dependency left Next's
// nested Sharp copy vulnerable in the original lockfile.
for (const [entry, loader] of [
  ["application", require],
  ["Next.js", createRequire(require.resolve("next/package.json"))],
]) {
  test(`${entry} loads patched Sharp/librsvg and decodes preview images`, async () => {
    const sharp = loader("sharp")
    expectPatched(sharp.versions.sharp, "0.35.5")
    expectPatched(sharp.versions.rsvg, "2.63.2")
    console.info(entry, sharp.versions)

    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><rect width="320" height="160" fill="red"/></svg>'
    )
    const inputs = [svg]
    for (const format of ["png", "jpeg", "webp"]) {
      inputs.push(await sharp(svg).toFormat(format).toBuffer())
    }
    for (const input of inputs) {
      const { data, info } = await sharp(input, {
        failOn: "none",
        limitInputPixels: 100_000_000,
      })
        .rotate()
        .resize(160, 160, { fit: "outside", withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer({ resolveWithObject: true })
      expect(info.format).toBe("webp")
      expect(info.width).toBe(320)
      expect(info.height).toBe(160)
      expect((await sharp(data).metadata()).format).toBe("webp")
    }
    await expect(
      sharp(Buffer.from("invalid image")).toBuffer()
    ).rejects.toThrow()
  })
}
