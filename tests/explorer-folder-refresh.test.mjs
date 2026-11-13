import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { test } from "node:test"

// Execute the component's actual callbacks without mounting its unrelated UI.
const source = readFileSync(
  new URL("../components/explorer/file-system.tsx", import.meta.url),
  "utf8"
)
const callbacks = source.slice(
  source.indexOf("  const ensureChildren ="),
  source.indexOf("  const navigateTo =")
)
const createCallbacks = new Function(
  "React",
  "index",
  "loadChildren",
  "requestedFoldersRef",
  "setLoadingFolders",
  "setLoadedItems",
  stripTypeScriptTypes(callbacks) + "\nreturn { ensureChildren, refetchFolder }"
)
const folder = (path) => ({ kind: "folder", path, hasChildren: true })
const file = (path) => ({ kind: "file", path })
const tick = () => new Promise((resolve) => setImmediate(resolve))

function harness(loadChildren) {
  const roots = [folder("parent/"), folder("parentish/")]
  let items = []
  let loading = new Set()
  const requested = { current: new Set() }
  const index = {
    get folders() {
      return new Map(
        [...roots, ...items]
          .filter((item) => item.kind === "folder")
          .map((item) => [item.path, item])
      )
    },
    get children() {
      const children = new Map()
      for (const item of items) {
        const path = item.path.replace(/[^/]+\/?$/, "")
        children.set(path, [...(children.get(path) ?? []), item])
      }
      return children
    },
  }
  const callbacks = createCallbacks(
    { useCallback: (callback) => callback },
    index,
    loadChildren,
    requested,
    (update) => {
      loading = update(loading)
    },
    (update) => {
      items = update(items)
    }
  )
  return {
    ...callbacks,
    requested,
    get items() {
      return items
    },
    get loading() {
      return loading
    },
  }
}

for (const childItems of [[file("parent/child/a.txt")], []]) {
  test(`visited ${childItems.length ? "populated" : "empty"} child reloads after repeated parent mutations`, async () => {
    let childRequests = 0
    const h = harness(async ({ path }) => {
      if (path === "parent/child/") {
        childRequests++
        return { items: childItems }
      }
      return { items: [folder("parent/child/")] }
    })
    await h.refetchFolder("parent/")
    for (let round = 0; round < 3; round++) {
      h.ensureChildren("parent/child/")
      h.ensureChildren("parent/child/")
      await tick()
      assert.equal(childRequests, round + 1)
      assert.equal(
        h.items.filter((item) => item.kind === "file").length,
        childItems.length
      )
      await h.refetchFolder("parent/")
      assert.equal(h.requested.current.has("parent/child/"), false)
      assert.equal(h.loading.size, 0)
    }
  })
}

test("invalidates every descendant marker while preserving the parent and sibling prefix", async () => {
  const h = harness(async () => ({ items: [folder("parent/child/")] }))
  h.requested.current = new Set([
    "parent/",
    "parent/child/",
    "parent/child/deep/",
    "parentish/child/",
  ])
  await h.refetchFolder("parent/")
  assert.deepEqual([...h.requested.current], ["parent/", "parentish/child/"])
})

test("a failed paginated child load can retry without partial or duplicate entries", async () => {
  let fail = true
  const h = harness(async ({ path, cursor }) => {
    if (path === "parent/") return { items: [folder("parent/child/")] }
    if (!cursor)
      return { items: [file("parent/child/a.txt")], nextCursor: "page2" }
    if (fail) throw new Error("temporary failure")
    return { items: [file("parent/child/b.txt")] }
  })
  await h.refetchFolder("parent/")
  h.ensureChildren("parent/child/")
  await tick()
  assert.equal(h.requested.current.has("parent/child/"), false)
  assert.equal(h.items.length, 1)
  fail = false
  h.ensureChildren("parent/child/")
  await tick()
  h.ensureChildren("parent/child/")
  await tick()
  assert.deepEqual(
    h.items.map((item) => item.path),
    ["parent/child/", "parent/child/a.txt", "parent/child/b.txt"]
  )
  assert.equal(h.loading.size, 0)
})

test("failed parent refresh preserves cached children and can be retried", async () => {
  let fail = false
  const h = harness(async ({ path }) => {
    if (fail) throw new Error("temporary failure")
    return {
      items:
        path === "parent/"
          ? [folder("parent/child/")]
          : [file("parent/child/a.txt")],
    }
  })
  await h.refetchFolder("parent/")
  h.ensureChildren("parent/child/")
  await tick()
  const before = h.items
  fail = true
  await h.refetchFolder("parent/")
  assert.equal(h.items, before)
  assert.equal(h.requested.current.has("parent/child/"), true)
  assert.equal(h.loading.size, 0)
  fail = false
  await h.refetchFolder("parent/")
  assert.equal(h.requested.current.has("parent/child/"), false)
})
