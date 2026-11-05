import { describe, expect, test } from "bun:test"
import path from "node:path"
import { findReferenceEdit, readToolCalls } from "../e2e/tool-events"

const WORKDIR = "/work"
const REFERENCES = ["character.png", "character-v2.png"]
const TARGET = "together.png"

// One `opencode run --format json` tool event in the OpenCode 1 shape: the saved path is in state.metadata.out.
function toolEvent(tool: string, input: Record<string, unknown>, metadata?: Record<string, unknown>): string {
  const state: Record<string, unknown> = { status: "completed", input, output: "Generated image saved." }
  if (metadata) state.metadata = metadata
  return JSON.stringify({ type: "tool_use", part: { type: "tool", tool, state } })
}

function editEvent(images: string[], requested: string, saved?: string): string {
  return toolEvent(
    "imageedit",
    { prompt: "combine", out: requested, images },
    saved === undefined ? undefined : { out: saved, versioned: saved !== requested, truncated: false },
  )
}

function find(lines: string[]) {
  return findReferenceEdit(readToolCalls(lines.join("\n")), REFERENCES, TARGET, WORKDIR)
}

describe("findReferenceEdit", () => {
  test.each([
    ["absolute", "/work/together.png"],
    ["relative", "together.png"],
  ])("returns the edit that passed both references and saved the target (%s saved path)", (_, saved) => {
    const result = find([editEvent(["./character.png", "/work/character-v2.png"], TARGET, saved)])

    expect(result.call.tool).toBe("imageedit")
    expect(result.out).toBe(path.join(WORKDIR, TARGET))
  })

  test("skips an earlier draft edit and returns the edit that saved the target", () => {
    const result = find([editEvent(REFERENCES, "draft.png", "/work/draft.png"), editEvent(REFERENCES, TARGET, TARGET)])

    expect(result.call.metadata.out).toBe(TARGET)
    expect(result.out).toBe(path.join(WORKDIR, TARGET))
  })

  test.each([
    ["a generation that wrote the target", [toolEvent("imagegen", { prompt: "two", out: TARGET }, { out: TARGET })]],
    ["an edit that passed only one reference", [editEvent(["character.png"], TARGET, "/work/together.png")]],
    ["an edit that reports no saved path", [editEvent(REFERENCES, TARGET)]],
    [
      // The requested out names the target, but the tool versioned the save because another tool wrote it first.
      "an edit whose save was versioned away from the target",
      [
        toolEvent("imagegen", { prompt: "two", out: TARGET }, { out: "/work/together.png" }),
        editEvent(REFERENCES, TARGET, "/work/together-v2.png"),
      ],
    ],
  ])("rejects %s", (_, lines) => {
    expect(() => find(lines)).toThrow("no completed imageedit call with references")
  })
})
