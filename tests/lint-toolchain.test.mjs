import assert from "node:assert/strict"
import test from "node:test"
import { ESLint } from "eslint"

test("the repository React rules report diagnostics without crashing", async () => {
  const eslint = new ESLint()
  const [result] = await eslint.lintText(
    'import React from "react"; export default React.memo(() => <div />)',
    { filePath: "components/lint-regression.tsx" }
  )

  assert.equal(result.fatalErrorCount, 0)
  assert.ok(
    result.messages.some(
      (message) =>
        message.ruleId === "react/display-name" && message.severity === 2
    ),
    "react/display-name must remain enabled and report the anonymous component"
  )
})
