import { expect, mock, test } from "bun:test"

// Exercise the real hook with deterministic hook state and controllable I/O.
let slots, position, effects, connection, current
const same = (a, b) =>
  a?.length === b.length && b.every((v, i) => Object.is(v, a[i]))
function memo(factory, deps) {
  const index = position++
  if (!slots[index] || !same(slots[index].deps, deps)) {
    slots[index] = { deps, value: factory() }
  }
  return slots[index].value
}
mock.module("react", () => ({
  useState(initial) {
    const index = position++
    if (!(index in slots)) slots[index] = initial
    return [
      slots[index],
      (value) => {
        slots[index] = typeof value === "function" ? value(slots[index]) : value
      },
    ]
  },
  useRef: (value) => memo(() => ({ current: value }), []),
  useMemo: memo,
  useCallback: (fn, deps) => memo(() => fn, deps),
  useEffect(fn, deps) {
    const index = position++
    if (!slots[index] || !same(slots[index].deps, deps)) {
      effects.push(() => {
        slots[index]?.cleanup?.()
        slots[index] = { deps, cleanup: fn() }
      })
    }
  },
}))
let list
mock.module("@/app/actions/files", () => ({
  listFolderAction: (...args) => list(...args),
  createFolderAction() {},
  deleteEntryAction() {},
  moveEntryAction() {},
  renameEntryAction() {},
  signFileUrlAction() {},
  signFileUrlsAction() {},
  signUploadUrlAction() {},
}))
mock.module("@/lib/storage/file-operations", () => ({}))
mock.module("@/lib/storage/thumbnails", () => ({
  thumbnailHandleFor: () => null,
}))
mock.module("@/lib/store/preferences-store", () => ({
  usePreferencesStore: (select) => select({ directClientRequests: false }),
}))
const { useS3FileSystem } = await import("../lib/storage/hooks/use-file-system")
const a = { id: "a", source: "env", provider: "s3" }
const b = { ...a, id: "b" }
const file = (path) => ({ kind: "file", path, name: path })
const folder = { kind: "folder", path: "folder/", name: "folder" }
function render() {
  position = 0
  effects = []
  // This harness supplies the hook dispatcher above.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  current = useS3FileSystem(connection)
  effects.forEach((effect) => effect())
  return current
}
function start(backend) {
  slots = []
  connection = a
  list = backend
  render()
}
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  return render()
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

test("initial load and refresh consume all pages including folder prefixes", async () => {
  const first = Array.from({ length: 1000 }, (_, i) => file(`file-${i}`))
  const calls = []
  let refreshed = false
  start(async (_ref, path, cursor) => {
    calls.push([path, cursor])
    return cursor === null
      ? { items: first, nextCursor: "page-2" }
      : {
          items: [folder, file(refreshed ? "new-last" : "last")],
          nextCursor: null,
        }
  })
  expect((await settle()).items).toEqual([...first, folder, file("last")])
  expect(current.isLoading).toBe(false)
  refreshed = true
  current.refresh()
  expect((await settle()).items).toEqual([...first, folder, file("new-last")])
  expect(calls).toEqual([
    ["", null],
    ["", "page-2"],
    ["", null],
    ["", "page-2"],
  ])
})

for (const refresh of [false, true]) {
  test(`${refresh ? "refresh" : "initial"} pagination failure is visible and retry clears it`, async () => {
    let fail = !refresh
    start(async (_ref, _path, cursor) => {
      if (cursor && fail) throw new Error("page failed")
      return {
        items: [file(cursor ? "last" : "first")],
        nextCursor: cursor ? null : "next",
      }
    })
    await settle()
    if (refresh) {
      fail = true
      current.refresh()
      await settle()
    }
    expect(current.error).toBe("page failed")
    expect(current.isLoading).toBe(false)
    fail = false
    current.refresh()
    await settle()
    expect(current.error).toBe(null)
    expect(current.items).toEqual([file("first"), file("last")])
  })
}

for (const refresh of [false, true]) {
  for (const reject of [false, true]) {
    test(`connection switch ignores stale ${refresh ? "refresh" : "initial"} page ${reject ? "failure" : "success"}`, async () => {
      const pending = deferred()
      let block = !refresh
      start(async (ref, _path, cursor) => {
        if (ref.id === "b") return { items: [file("b")], nextCursor: null }
        if (cursor && block) return pending.promise
        return { items: [file("a")], nextCursor: cursor ? null : "next" }
      })
      await settle()
      if (refresh) {
        block = true
        current.refresh()
        await settle()
      }
      connection = b
      render()
      await settle()
      if (reject) pending.reject(new Error("stale failure"))
      else pending.resolve({ items: [file("stale")], nextCursor: "unused" })
      await settle()
      expect(current.items).toEqual([file("b")])
      expect(current.error).toBe(null)
      expect(current.isLoading).toBe(false)
    })
  }
}

test("a newer refresh wins over an older request", async () => {
  const pending = deferred()
  let requests = 0
  start(() =>
    ++requests === 1
      ? pending.promise
      : Promise.resolve({ items: [file("new")], nextCursor: null })
  )
  await settle()
  current.refresh()
  await settle()
  pending.resolve({ items: [file("old")], nextCursor: "unused" })
  await settle()
  expect(current.items).toEqual([file("new")])
  expect(requests).toBe(2)
})
