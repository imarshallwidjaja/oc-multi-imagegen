import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"
import plugin from "../../src/index"
import type { ImageSize } from "../../src/size"
import type { GenerateArgs } from "../../src/types"
import { PNG_BASE64, PNG_BUFFER } from "./fixtures"

// Capture so this file's env edits don't leak into other test files sharing the bun test process.
const ORIGINAL_AUTH_CONTENT = process.env.OPENCODE_AUTH_CONTENT
const originalFetch = globalThis.fetch
let dir: string

beforeEach(async () => {
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "oauth", access: "tok" } })
  dir = await mkdtemp(path.join(os.tmpdir(), "index-"))
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

function imagesResponse(b64Json: string): Response {
  return new Response(JSON.stringify({ created: 0, data: [{ b64_json: b64Json }] }))
}

describe("imagegen execute", () => {
  const supportedSizes =
    "1254x1254 (1:1), 1536x1024 (3:2), 1024x1536 (2:3), 1448x1086 (4:3), 1086x1448 (3:4), 1672x941 (16:9), 941x1672 (9:16)"

  test("exports the package identity and one imagegen tool", async () => {
    expect(plugin.id).toBe("oc-multi-imagegen")
    const hooks = await plugin.server({} as PluginInput)
    expect(Object.keys(hooks.tool ?? {})).toEqual(["imagegen"])
  })

  test("saves the generated image under the context directory and reports it", async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => imagesResponse(PNG_BASE64))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const hooks = await plugin.server({} as PluginInput)
    const ctx = { directory: dir } as ToolContext
    const out = "cat.png"
    const size = "1672x941"

    const result = await hooks.tool?.imagegen?.execute({ prompt: "a cat", out, size }, ctx)

    const savedPath = path.join(dir, out)
    expect(await readFile(savedPath)).toEqual(PNG_BUFFER)
    // PNG_BASE64 is a 1x1 image. The message reports the size of the saved image, not the requested size.
    expect(result).toEqual({
      output: `Generated image saved to ${savedPath}. The image is 1x1 pixels.`,
      metadata: { out: savedPath, versioned: false },
    })
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body as string).prompt).toBe(
      "a cat Generate the image with a width of 1672 pixels and a height of 941 pixels (16:9 aspect ratio).",
    )
  })

  test("ignores an extra quality argument", async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => imagesResponse(PNG_BASE64))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const hooks = await plugin.server({} as PluginInput)
    const ctx = { directory: dir } as ToolContext
    const out = "cat.png"
    const args = { prompt: "a cat", out, size: "1672x941", quality: "low" } as const

    await hooks.tool?.imagegen?.execute(args, ctx)

    expect(await readFile(path.join(dir, out))).toEqual(PNG_BUFFER)
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body as string).quality).toBe("auto")
  })

  test("rejects an unsupported size with the supported sizes without calling the backend", async () => {
    const fetchMock = mock(async () => new Response(""))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const hooks = await plugin.server({} as PluginInput)
    const ctx = { directory: dir } as ToolContext
    // Some OpenCode versions pass arguments to execute without validating them against the schema.
    const size = "1280x720" as ImageSize

    const act = hooks.tool?.imagegen?.execute({ prompt: "a cat", out: "cat.png", size }, ctx)

    await expect(act).rejects.toThrow(`Unsupported size "${size}". Use one of: ${supportedSizes}.`)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("rejects a missing size with the supported sizes without calling the backend", async () => {
    const fetchMock = mock(async () => new Response(""))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const hooks = await plugin.server({} as PluginInput)
    const ctx = { directory: dir } as ToolContext
    const args = { prompt: "a cat", out: "cat.png" } as unknown as GenerateArgs

    const act = hooks.tool?.imagegen?.execute(args, ctx)

    await expect(act).rejects.toThrow(`Missing size. Use one of: ${supportedSizes}.`)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("generates without reference images when images is null", async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => imagesResponse(PNG_BASE64))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const hooks = await plugin.server({} as PluginInput)
    const ctx = { directory: dir } as ToolContext
    const out = "cat.png"
    // Some models fill unused optional arguments with null.
    const args = { prompt: "a cat", out, size: "1254x1254", images: null } as unknown as GenerateArgs

    await hooks.tool?.imagegen?.execute(args, ctx)

    expect(await readFile(path.join(dir, out))).toEqual(PNG_BUFFER)
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations")
  })

  test("rejects more than five reference images without calling the backend", async () => {
    const fetchMock = mock(async () => new Response(""))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const hooks = await plugin.server({} as PluginInput)
    const ctx = { directory: dir } as ToolContext
    const images = ["1.png", "2.png", "3.png", "4.png", "5.png", "6.png"]

    const act = hooks.tool?.imagegen?.execute({ prompt: "a cat", out: "cat.png", size: "1254x1254", images }, ctx)

    await expect(act).rejects.toThrow("at images")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("reports a null size as missing", async () => {
    const fetchMock = mock(async () => new Response(""))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const hooks = await plugin.server({} as PluginInput)
    const ctx = { directory: dir } as ToolContext
    const args = { prompt: "a cat", out: "cat.png", size: null } as unknown as GenerateArgs

    const act = hooks.tool?.imagegen?.execute(args, ctx)

    await expect(act).rejects.toThrow(`Missing size. Use one of: ${supportedSizes}.`)
  })

  test("rejects an unsupported background without calling the backend", async () => {
    const fetchMock = mock(async () => new Response(""))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const hooks = await plugin.server({} as PluginInput)
    const ctx = { directory: dir } as ToolContext
    const args = { prompt: "a cat", out: "cat.png", size: "1254x1254", background: "auto" } as unknown as GenerateArgs

    const act = hooks.tool?.imagegen?.execute(args, ctx)

    await expect(act).rejects.toThrow("at background")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("rejects a missing prompt without calling the backend", async () => {
    const fetchMock = mock(async () => new Response(""))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const hooks = await plugin.server({} as PluginInput)
    const ctx = { directory: dir } as ToolContext
    const args = { out: "cat.png", size: "1254x1254" } as unknown as GenerateArgs

    const act = hooks.tool?.imagegen?.execute(args, ctx)

    await expect(act).rejects.toThrow("at prompt")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
