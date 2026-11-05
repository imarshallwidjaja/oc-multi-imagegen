import path from "node:path"

export interface ToolCall {
  tool: string
  status: string
  input: Record<string, unknown>
  metadata: Record<string, unknown>
}

// Reads the tool calls from `opencode run --format json` output, one JSON event per line.
// A line that is not a JSON event, or a tool event without a tool name and status, fails the read.
export function readToolCalls(output: string): ToolCall[] {
  const calls: ToolCall[] = []
  for (const [index, line] of output.split("\n").entries()) {
    if (line.trim() === "") continue
    let event: {
      type?: unknown
      part?: { tool?: unknown; state?: { status?: unknown; input?: unknown; metadata?: unknown } }
    }
    try {
      event = JSON.parse(line)
    } catch {
      throw new Error(`opencode output line ${index + 1} is not a JSON event`)
    }
    if (event.type !== "tool_use") continue
    const tool = event.part?.tool
    const status = event.part?.state?.status
    if (typeof tool !== "string" || typeof status !== "string") {
      throw new Error(`opencode output line ${index + 1} is a tool event without a tool name and status`)
    }
    calls.push({
      tool,
      status,
      input: asRecord(event.part?.state?.input),
      metadata: asRecord(event.part?.state?.metadata),
    })
  }
  return calls
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

// Returns the completed imageedit call that passed every one of `references` as a reference image and
// reports saving to `target` (`metadata.out` on OpenCode 1), with `out`, that saved absolute path.
// All three conditions identify the same call, so an earlier draft edit or a versioned save does not count,
// and the requested `input.out` is never trusted. Relative paths resolve against `workdir`, as the tool resolves them.
export function findReferenceEdit(
  calls: ToolCall[],
  references: string[],
  target: string,
  workdir: string,
): { call: ToolCall; out: string } {
  const expected = references.map((reference) => path.resolve(workdir, reference))
  const expectedOut = path.resolve(workdir, target)
  const match = calls
    .filter((call) => {
      if (call.tool !== "imageedit" || call.status !== "completed") return false
      const images = call.input.images
      if (!Array.isArray(images)) return false
      const passed = images.map((image) => (typeof image === "string" ? path.resolve(workdir, image) : ""))
      if (!expected.every((reference) => passed.includes(reference))) return false
      const out = call.metadata.out
      return typeof out === "string" && out !== "" && path.resolve(workdir, out) === expectedOut
    })
    .at(-1)
  if (!match) {
    const seen = calls.map(
      (call) =>
        `${call.tool} ${call.status} images=${JSON.stringify(call.input.images ?? null)} saved=${JSON.stringify(call.metadata.out ?? null)}`,
    )
    throw new Error(
      `no completed imageedit call with references ${JSON.stringify(expected)} that saved ${expectedOut}; ` +
        `tool calls: ${seen.join("; ") || "none"}`,
    )
  }
  return { call: match, out: expectedOut }
}
