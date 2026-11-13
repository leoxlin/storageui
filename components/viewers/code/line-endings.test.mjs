import assert from "node:assert/strict"
import { test } from "node:test"
import { EditorState } from "@codemirror/state"

import { sourceLineSeparator } from "./line-endings.ts"

for (const separator of ["\r\n", "\n", "\r"]) {
  for (const trailing of ["", separator, separator + separator]) {
    test(`one-character UTF-8 edit preserves ${JSON.stringify({ separator, trailing })}`, async () => {
      const source = `first${separator}第二行 café${trailing}`
      const state = EditorState.create({
        doc: source,
        extensions: [EditorState.lineSeparator.of(sourceLineSeparator(source))],
      })
      assert.equal(state.sliceDoc(), source)
      const edited = state.update({
        changes: { from: 0, to: 1, insert: "F" },
      }).state
      const file = new File([edited.sliceDoc()], "fixture.txt")
      assert.deepEqual(
        new Uint8Array(await file.arrayBuffer()),
        new TextEncoder().encode(source.replace("first", "First"))
      )
      const reverted = edited.update({
        changes: { from: 0, to: edited.doc.length, insert: state.doc },
      }).state
      assert.equal(reverted.sliceDoc(), source)
    })
  }
  test(`inserted newlines use ${JSON.stringify(separator)}`, () => {
    const state = EditorState.create({
      doc: `first${separator}second`,
      extensions: [EditorState.lineSeparator.of(separator)],
    })
    const edited = state.update({
      changes: {
        from: state.doc.length,
        insert: state.toText(separator + "third"),
      },
    }).state
    assert.equal(edited.sliceDoc(), `first${separator}second${separator}third`)
  })
}

test("empty and single-line files default to LF", () => {
  assert.equal(sourceLineSeparator(""), "\n")
  assert.equal(sourceLineSeparator("no newline"), "\n")
})

test("mixed endings are identified for read-only preview", () => {
  for (const source of ["a\r\nb\nc", "a\nb\r\nc", "a\rb\nc", "a\r\nb\rc"]) {
    assert.equal(sourceLineSeparator(source), null)
  }
})
