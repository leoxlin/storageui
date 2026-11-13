import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { mock, test } from "bun:test"
import ts from "typescript"

// Exercise the hooks across renders without a DOM or a storage service.
let current
function slot(create) {
  const index = current.cursor++
  if (!(index in current.slots)) current.slots[index] = create()
  return [current.slots[index], index]
}
function memo(factory, deps) {
  const [previous, index] = slot(() => null)
  if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
    current.slots[index] = { value: factory(), deps }
  }
  return current.slots[index].value
}
const hookReact = {
  useState(initial) {
    const owner = current
    const [value, index] = slot(() =>
      typeof initial === "function" ? initial() : initial
    )
    return [
      value,
      (next) => {
        owner.slots[index] =
          typeof next === "function" ? next(owner.slots[index]) : next
      },
    ]
  },
  useRef: (value) => slot(() => ({ current: value }))[0],
  useMemo: memo,
  useCallback: (callback, deps) => memo(() => callback, deps),
  useEffect(effect, deps) {
    const [previous, index] = slot(() => null)
    if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
      current.effects.push(() => {
        previous?.cleanup?.()
        current.slots[index] = { deps, cleanup: effect() }
      })
    }
  },
}
mock.module("react", () => hookReact)
let listFolder
mock.module("@/app/actions/files", () => ({
  listFolderAction: (...args) => listFolder(...args),
  ...Object.fromEntries(
    [
      "createFolderAction",
      "deleteEntryAction",
      "moveEntryAction",
      "renameEntryAction",
      "signFileUrlAction",
      "signFileUrlsAction",
      "signUploadUrlAction",
    ].map((name) => [name, () => {}])
  ),
}))
mock.module("@/lib/storage/file-operations", () => ({}))
mock.module("@/lib/storage/thumbnails", () => ({
  thumbnailHandleFor: () => null,
}))
mock.module("@/lib/store/preferences-store", () => ({
  usePreferencesStore: (select) => select({ directClientRequests: false }),
}))
const { useUploads } = await import("../lib/storage/hooks/use-uploads.ts")
const { useS3FileSystem } =
  await import("../lib/storage/hooks/use-file-system.ts")

function harness(hook) {
  const owner = { slots: [], effects: [], cursor: 0 }
  return (props) => {
    current = owner
    owner.cursor = 0
    owner.effects = []
    const result = hook(props)
    for (const effect of owner.effects) effect()
    return result
  }
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const flush = () => new Promise((resolve) => setImmediate(resolve))
const items = (...names) =>
  names.map((path) => ({ path, file: new File([path], path) }))

test("queued and overlapping batches retain uploader, prefix, destination and completion owner", async () => {
  const render = harness(useUploads)
  const first = deferred()
  const calls = []
  const completions = []
  const a = {
    destination: "private (bucket-a)",
    uploadFile: async (key, file, progress) => {
      calls.push(["A", key])
      if (file.name === "one.txt") await first.promise
      progress?.({ loaded: file.size, total: file.size })
    },
    onBatchComplete: () => completions.push("A"),
  }
  const b = {
    destination: "public (bucket-b)",
    uploadFile: async (key) => {
      calls.push(["B", key])
    },
    onBatchComplete: () => completions.push("B"),
  }
  const originalEnqueue = render(a).enqueue
  originalEnqueue(items("one.txt", "two.txt"), "/private")
  render(b).enqueue(items("other.txt"), "public/")
  // Directory expansion can finish after the drop handler's render has changed.
  originalEnqueue(items("late.txt"), "/private")
  await flush()
  first.resolve()
  await flush()
  const tasks = render(b).tasks
  assert.deepEqual(calls, [
    ["A", "private/one.txt"],
    ["B", "public/other.txt"],
    ["A", "private/late.txt"],
    ["A", "private/two.txt"],
  ])
  assert.deepEqual(completions, ["B"])
  assert.equal(tasks[0].destination, "private (bucket-a) /private/")
  assert.equal(tasks[2].destination, "public (bucket-b) /public/")
  assert.ok(
    tasks.every((task) => task.status === "done" && task.loaded === task.total)
  )
})

test("editing the same connection keeps the old batch snapshot; failed files do not stop the queue", async () => {
  const render = harness(useUploads)
  const first = deferred()
  const calls = []
  let oldRefreshes = 0,
    newRefreshes = 0
  const old = {
    destination: "same-id (old-bucket)",
    uploadFile: async (key) => {
      calls.push(["old", key])
      if (key === "one.txt") {
        await first.promise
        throw new Error("failed")
      }
    },
    onBatchComplete: () => oldRefreshes++,
  }
  const edited = {
    destination: "same-id (new-bucket)",
    uploadFile: async (key) => {
      calls.push(["new", key])
    },
    onBatchComplete: () => newRefreshes++,
  }
  render(old).enqueue(items("one.txt", "two.txt"), "")
  render(edited).enqueue(items("new.txt"), "")
  first.resolve()
  await flush()
  const tasks = render(edited).tasks
  assert.deepEqual(calls, [
    ["old", "one.txt"],
    ["new", "new.txt"],
    ["old", "two.txt"],
  ])
  assert.equal(tasks[0].status, "error")
  assert.equal(tasks[1].status, "done")
  assert.equal(tasks[1].destination, "same-id (old-bucket) /")
  assert.equal(oldRefreshes, 0)
  assert.equal(newRefreshes, 1)
})

for (const fails of [false, true]) {
  test(`old in-flight refresh cannot replace current connection listing or error (fails=${fails})`, async () => {
    const render = harness(useS3FileSystem)
    const pending = deferred()
    let aCalls = 0
    listFolder = (ref) => {
      if (ref.connection.id === "a" && ++aCalls > 1) return pending.promise
      return Promise.resolve({ items: [{ name: ref.connection.bucket }] })
    }
    const a = { id: "a", bucket: "old", source: "local", provider: "s3" }
    const b = { ...a, id: "b", bucket: "current" }
    render(a)
    await flush()
    const oldRefresh = render(a).refresh
    oldRefresh()
    await flush()
    render(b)
    await flush()
    oldRefresh() // A captured batch callback must also be harmless after switching.
    if (fails) pending.reject(new Error("old connection error"))
    else pending.resolve({ items: [{ name: "stale" }] })
    await flush()
    const result = render(b)
    assert.deepEqual(result.items, [{ name: "current" }])
    assert.equal(result.error, null)
    assert.equal(aCalls, 2)
  })
}

test("a batch on the active connection refreshes through its captured completion callback", async () => {
  const render = harness(useUploads)
  const pending = deferred()
  const completions = []
  const uploadFile = () => pending.promise
  render({
    uploadFile,
    destination: "A",
    onBatchComplete: () => completions.push("original"),
  }).enqueue(items("one.txt"), "folder")
  render({
    uploadFile,
    destination: "A",
    onBatchComplete: () => completions.push("later render"),
  })
  pending.resolve()
  await flush()
  assert.deepEqual(completions, ["original"])
})

// Run the component's real folder-loading callbacks without its unrelated UI.
const explorerSource = readFileSync(
  new URL("../components/explorer/file-system.tsx", import.meta.url),
  "utf8"
)
const folderCallbacks = new Function(
  "React",
  "index",
  "loadChildren",
  "setLoadedItems",
  ts.transpile(
    explorerSource.slice(
      explorerSource.indexOf("  const requestedFoldersRef ="),
      explorerSource.indexOf("  const navigateTo =")
    ) + "\nreturn { ensureChildren, refetchFolder, loadingFolders }",
    { target: ts.ScriptTarget.ESNext }
  )
)
for (const operation of ["ensureChildren", "refetchFolder"]) {
  test(`${operation} discards old responses and cached children after a same-ID connection edit`, async () => {
    const render = harness((loadChildren) => {
      const [loadedItems, setLoadedItems] = hookReact.useState([])
      const callbacks = folderCallbacks(
        hookReact,
        {
          folders: new Map([
            ["folder/", { hasChildren: true }],
            ["pending/", { hasChildren: true }],
          ]),
          children: new Map(),
        },
        loadChildren,
        setLoadedItems
      )
      return { ...callbacks, loadedItems }
    })
    const pending = deferred()
    let calls = 0
    const oldLoader = () =>
      ++calls === 1
        ? Promise.resolve({ items: [{ path: "folder/cached-old.txt" }] })
        : pending.promise
    const newLoader = () =>
      Promise.resolve({ items: [{ path: "pending/current.txt" }] })
    render(oldLoader)
    render(oldLoader).refetchFolder("folder/")
    await flush()
    assert.deepEqual(render(oldLoader).loadedItems, [
      { path: "folder/cached-old.txt" },
    ])
    // A real refresh may be pending when the connection's bucket/root is edited.
    void render(oldLoader)[operation]("pending/")
    render(newLoader)
    assert.deepEqual(render(newLoader).loadedItems, [])
    render(newLoader)[operation]("pending/")
    await flush()
    pending.resolve({
      items: [{ path: "pending/stale.txt" }],
      nextCursor: "old-next-page",
    })
    await flush()
    const result = render(newLoader)
    assert.deepEqual(result.loadedItems, [{ path: "pending/current.txt" }])
    assert.equal(result.loadingFolders.size, 0)
    assert.equal(calls, 2)
  })
}
