import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"
import { IMAGEGEN_DESCRIPTION } from "../../src/imagegen"
import plugin from "../../src/index"
import { PNG_BASE64, PNG_BUFFER } from "./fixtures"
import { v1ToolContext } from "./hosts"

// Capture so this file's env edits don't leak into other test files sharing the bun test process.
const ORIGINAL_AUTH_CONTENT = process.env.OPENCODE_AUTH_CONTENT
const originalFetch = globalThis.fetch
let dir: string

beforeEach(async () => {
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "oauth", access: "tok", accountId: "acct-1" } })
  dir = await mkdtemp(path.join(os.tmpdir(), "v1-"))
})

afterEach(async () => {
  if (ORIGINAL_AUTH_CONTENT === undefined) {
    delete process.env.OPENCODE_AUTH_CONTENT
  } else {
    process.env.OPENCODE_AUTH_CONTENT = ORIGINAL_AUTH_CONTENT
  }
  globalThis.fetch = originalFetch
  await rm(dir, { recursive: true, force: true })
})

function stubFetch() {
  const fetchMock = mock(
    async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] })),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

async function loadTool() {
  const hooks = await plugin.server({} as never)
  const tool = hooks.tool?.imagegen
  if (!tool) throw new Error("imagegen is not registered")
  return tool
}

function recordAsks() {
  const asks: Array<Parameters<ToolContext["ask"]>[0]> = []
  const ask: ToolContext["ask"] = async (input) => {
    asks.push(input)
  }
  return { asks, ask }
}

describe("OpenCode 1 adapter", () => {
  test("registers one imagegen tool with the documented arguments", async () => {
    const hooks = await plugin.server({} as never)

    expect(Object.keys(hooks.tool ?? {})).toEqual(["imagegen"])
    expect(Object.keys((await loadTool()).args)).toEqual(["prompt", "out", "size", "images", "background"])
  })

  test("exposes the shared tool description and a description for every argument", async () => {
    const tool = await loadTool()

    expect(tool.description).toBe(IMAGEGEN_DESCRIPTION)
    for (const arg of Object.values(tool.args)) {
      // The SDK types args with its own Zod core type, which does not declare the description getter.
      expect((arg as { description?: string }).description).toEqual(expect.stringMatching(/\S/))
    }
  })

  test("returns the saved path as output text and { out, versioned } metadata", async () => {
    stubFetch()
    const tool = await loadTool()
    const { ask } = recordAsks()
    const ctx = v1ToolContext(dir, new AbortController().signal, ask)

    const result = await tool.execute({ prompt: "a cat", out: "cat.png", size: "1672x941" }, ctx)

    const savedPath = path.join(dir, "cat.png")
    expect(await readFile(savedPath)).toEqual(PNG_BUFFER)
    expect(result).toEqual({
      output: `Generated image saved to ${savedPath}. The image is 1x1 pixels.`,
      metadata: { out: savedPath, versioned: false },
    })
  })

  test("asks for the imagegen permission over the whole operation", async () => {
    stubFetch()
    const tool = await loadTool()
    const { asks, ask } = recordAsks()
    const args = { prompt: "a cat", out: "cat.png", size: "1672x941" } as const

    await tool.execute(args, v1ToolContext(dir, new AbortController().signal, ask))

    expect(asks).toEqual([
      {
        permission: "imagegen",
        patterns: ["*"],
        always: ["*"],
        metadata: { prompt: "a cat", out: "cat.png", size: "1672x941" },
      },
    ])
  })

  test("sends the account from OpenCode's auth data as the ChatGPT account header", async () => {
    const fetchMock = stubFetch()
    const tool = await loadTool()
    const { ask } = recordAsks()

    await tool.execute(
      { prompt: "a cat", out: "cat.png", size: "1254x1254" },
      v1ToolContext(dir, new AbortController().signal, ask),
    )

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer tok")
    expect(headers["ChatGPT-Account-Id"]).toBe("acct-1")
  })

  test("reports missing credentials after the permission was granted and before the backend call", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({})
    const fetchMock = stubFetch()
    const tool = await loadTool()
    const { asks, ask } = recordAsks()

    const act = tool.execute(
      { prompt: "a cat", out: "cat.png", size: "1254x1254" },
      v1ToolContext(dir, new AbortController().signal, ask),
    )

    await expect(act).rejects.toThrow("OpenAI ChatGPT OAuth credentials not configured.")
    expect(asks).toHaveLength(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("does not read credentials when the permission is denied", async () => {
    // Reaching the credential loader would report missing credentials instead of the denial.
    process.env.OPENCODE_AUTH_CONTENT = "{not json"
    const fetchMock = stubFetch()
    const tool = await loadTool()
    const ask: ToolContext["ask"] = async () => {
      throw new Error("denied by the host")
    }

    const act = tool.execute(
      { prompt: "a cat", out: "cat.png", size: "1254x1254" },
      v1ToolContext(dir, new AbortController().signal, ask),
    )

    await expect(act).rejects.toThrow("denied by the host")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
