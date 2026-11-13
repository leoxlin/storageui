import { beforeEach, expect, mock, test } from "bun:test"

const fixtures = [
  [
    "attack.html",
    "text/html",
    '<script>localStorage.setItem("storageui-marker", "html")</script>',
  ],
  [
    "attack.svg",
    "image/svg+xml",
    "<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"localStorage.setItem('storageui-marker', 'svg')\"/>",
  ],
]
let body
let contentType
let metadataType
const downloads = []

mock.module("@/lib/storage/connections-server", () => ({
  refFromRequest: (_request, id) => ({ source: "env", id }),
  resolveFiles: () => ({
    head: () => Promise.resolve({ size: body.length, type: metadataType }),
    download: (_key, options) => {
      downloads.push(options)
      const bytes = options.range
        ? body.slice(options.range.start, options.range.end + 1)
        : body
      return Promise.resolve({
        type: contentType,
        size: bytes.length,
        stream: () => new Blob([bytes]).stream(),
      })
    },
  }),
}))

const { GET } = await import("../app/api/file/route.ts")

beforeEach(() => {
  body = new TextEncoder().encode("preview content")
  contentType = "text/plain"
  metadataType = ""
  downloads.length = 0
})

function request(key, { range = false, download = false } = {}) {
  const params = new URLSearchParams({ c: "test", key })
  if (download) params.set("download", "1")
  return new Request(`https://storageui.test/api/file?${params}`, {
    headers: range ? { Range: `bytes=0-${body.length - 1}` } : {},
  })
}

function expectIsolation(response) {
  // No sandbox permissions: scripts are disabled and the document has an opaque origin.
  const policy = response.headers.get("Content-Security-Policy")
  expect(policy?.split(";").map((part) => part.trim())).toContain("sandbox")
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff")
}

for (const [key, type, marker] of fixtures) {
  for (const range of [false, true]) {
    for (const source of ["download", "metadata", "extension"]) {
      test(`${key} is isolated on ${range ? 206 : 200} with ${source} MIME`, async () => {
        body = new TextEncoder().encode(marker)
        contentType = source === "download" ? type : ""
        metadataType = source === "metadata" ? type : ""
        const response = await GET(request(key, { range }))
        expect(response.status).toBe(range ? 206 : 200)
        expect(response.headers.get("Content-Type")).toBe(type)
        expectIsolation(response)
        expect(await response.text()).toBe(marker)
      })
    }
  }
}

for (const type of [
  "image/png",
  "video/mp4",
  "text/plain",
  "application/pdf",
]) {
  for (const range of [false, true]) {
    test(`${type} preview preserves content and range support (${range})`, async () => {
      contentType = type
      const response = await GET(request("preview", { range }))
      expect(response.status).toBe(range ? 206 : 200)
      expect(response.headers.get("Content-Type")).toBe(type)
      expect(response.headers.get("Content-Disposition")).toBeNull()
      expect(response.headers.get("Accept-Ranges")).toBe("bytes")
      expectIsolation(response)
      if (range) {
        expect(response.headers.get("Content-Range")).toBe(
          `bytes 0-${body.length - 1}/${body.length}`
        )
        expect(downloads[0].range).toEqual({ start: 0, end: body.length - 1 })
      }
      expect(response.headers.get("Content-Length")).toBe(String(body.length))
      expect(await response.text()).toBe("preview content")
    })
  }
}

for (const range of [false, true]) {
  test(`explicit downloads remain attachments (${range})`, async () => {
    const response = await GET(
      request('folder/a"b.txt', { range, download: true })
    )
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="a_b.txt"; filename*=UTF-8''a%22b.txt`
    )
    expectIsolation(response)
    expect(await response.text()).toBe("preview content")
  })

  test(`unsupported document types are attachments (${range})`, async () => {
    contentType = "application/x-shockwave-flash"
    const response = await GET(request("active.swf", { range }))
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="active.swf"; filename*=UTF-8''active.swf`
    )
    expectIsolation(response)
  })
}

test("partial video range preserves the requested slice", async () => {
  contentType = "video/mp4"
  const response = await GET(
    new Request("https://storageui.test/api/file?c=test&key=video.mp4", {
      headers: { Range: "bytes=2-6" },
    })
  )
  expect(response.status).toBe(206)
  expectIsolation(response)
  expect(response.headers.get("Content-Range")).toBe(`bytes 2-6/${body.length}`)
  expect(response.headers.get("Content-Length")).toBe("5")
  expect(await response.text()).toBe("eview")
})

for (const [name, fallback] of [
  ["报告.txt", "__.txt"],
  ["😀.txt", "__.txt"],
  ['a"b.txt', "a_b.txt"],
  ["report.txt", "report.txt"],
  ["control\r\n\t\0\x7f.txt", "control_____.txt"],
]) {
  for (const range of [false, true]) {
    test(`text download retains filename ${JSON.stringify(name)} (${range ? 206 : 200})`, async () => {
      const params = new URLSearchParams({
        c: "env-1",
        key: `folder/${name}`,
        download: "1",
      })
      const response = await GET(
        new Request(`https://storageui.test/api/file?${params}`, {
          headers: range ? { Range: "bytes=2-6" } : {},
        })
      )
      expect(response.status).toBe(range ? 206 : 200)
      const disposition = response.headers.get("Content-Disposition")
      expect(disposition).toStartWith(
        `attachment; filename="${fallback}"; filename*=UTF-8''`
      )
      expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1])).toBe(
        name
      )
      expect(response.headers.get("Content-Type")).toBe("text/plain")
      expect(response.headers.get("Content-Length")).toBe(
        String(range ? 5 : body.length)
      )
      if (range) {
        expect(response.headers.get("Content-Range")).toBe(
          `bytes 2-6/${body.length}`
        )
      }
      expect(await response.text()).toBe(range ? "eview" : "preview content")
    })
  }
}

const filenameCases = [
  ["report.xlsx", "report.xlsx", "report.xlsx"],
  ["報告.xlsx", "__.xlsx", "%E5%A0%B1%E5%91%8A.xlsx"],
  ["résumé 😀.docx", "r_sum_ __.docx", "r%C3%A9sum%C3%A9%20%F0%9F%98%80.docx"],
  [
    'a"b\\c\r\n\t\0\x7f.xlsx',
    "a_b_c_____.xlsx",
    "a%22b%5Cc%0D%0A%09%00%7F.xlsx",
  ],
  ["a'()*%;.xlsx", "a'()*%;.xlsx", "a%27%28%29%2A%25%3B.xlsx"],
]

for (const [name, fallback, encoded] of filenameCases) {
  for (const range of [false, true]) {
    for (const download of [false, true]) {
      test(`safe filename ${JSON.stringify(name)} (${range ? 206 : 200}, download=${download})`, async () => {
        contentType = name.endsWith(".docx")
          ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        const response = await GET(
          request(`folder/${name}`, { range, download })
        )
        expect(response.status).toBe(range ? 206 : 200)
        expect(response.headers.get("Content-Disposition")).toBe(
          `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
        )
        expectIsolation(response)
        expect(await response.text()).toBe("preview content")
      })
    }
  }
}
