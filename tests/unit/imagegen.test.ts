import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PNG_BASE64, PNG_BUFFER } from "./fixtures"
import { type ToolHarness, v1Harness, v2Harness } from "./hosts"

// The imagegen contract is shared by both host adapters, so each test runs against OpenCode 1 and OpenCode 2.
// Capture so this file's env edits don't leak into other test files sharing the bun test process.
const ORIGINAL_AUTH_CONTENT = process.env.OPENCODE_AUTH_CONTENT
const originalFetch = globalThis.fetch
let dir: string

beforeEach(async () => {
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "oauth", access: "tok" } })
  dir = await mkdtemp(path.join(os.tmpdir(), "imagegen-"))
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

function stubFetch(
  respond: (url: string, init: RequestInit) => Response | Promise<Response> = () => imagesResponse(PNG_BASE64),
) {
  const fetchMock = mock(async (url: string, init: RequestInit) => respond(url, init))
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

const supportedSizes =
  "1254x1254 (1:1), 1536x1024 (3:2), 1024x1536 (2:3), 1448x1086 (4:3), 1086x1448 (3:4), 1672x941 (16:9), 941x1672 (9:16)"

const harnesses: Array<[string, (directory: string) => Promise<ToolHarness>]> = [
  ["OpenCode 1", v1Harness],
  ["OpenCode 2", v2Harness],
]

describe.each(harnesses)("imagegen through %s", (_host, createHarness) => {
  test("saves the generated image under the host directory and reports it", async () => {
    const fetchMock = stubFetch()
    const harness = await createHarness(dir)

    const result = await harness.execute({ prompt: "a cat", out: "cat.png", size: "1672x941" })

    const savedPath = path.join(dir, "cat.png")
    expect(await readFile(savedPath)).toEqual(PNG_BUFFER)
    // PNG_BASE64 is a 1x1 image. The message reports the size of the saved image, not the requested size.
    expect(result).toEqual({
      message: `Generated image saved to ${savedPath}. The image is 1x1 pixels.`,
      out: savedPath,
      versioned: false,
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok")
    expect(JSON.parse(init.body as string).prompt).toBe(
      "a cat Generate the image with a width of 1672 pixels and a height of 941 pixels (16:9 aspect ratio).",
    )
  })

  test("versions the output path when it already exists", async () => {
    stubFetch()
    const harness = await createHarness(dir)
    const args = { prompt: "a cat", out: "cat.png", size: "1254x1254" }
    await harness.execute(args)

    const second = await harness.execute(args)

    expect(second.out).toBe(path.join(dir, "cat-v2.png"))
    expect(second.versioned).toBe(true)
    expect(second.message).toContain("the requested path")
  })

  test("ignores an extra quality argument", async () => {
    const fetchMock = stubFetch()
    const harness = await createHarness(dir)

    await harness.execute({ prompt: "a cat", out: "cat.png", size: "1672x941", quality: "low" })

    expect(await readFile(path.join(dir, "cat.png"))).toEqual(PNG_BUFFER)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).quality).toBe("auto")
  })

  test("generates without reference images when images is null", async () => {
    const fetchMock = stubFetch()
    const harness = await createHarness(dir)
    // Some models fill unused optional arguments with null.
    await harness.execute({ prompt: "a cat", out: "cat.png", size: "1254x1254", images: null, background: null })

    expect(fetchMock.mock.calls[0][0]).toBe("https://chatgpt.com/backend-api/codex/images/generations")
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).background).toBe("opaque")
  })

  const invalidArguments: Array<[string, Record<string, unknown>, string]> = [
    [
      "an unsupported size",
      { prompt: "a cat", out: "cat.png", size: "1280x720" },
      `Unsupported size "1280x720". Use one of: ${supportedSizes}.`,
    ],
    ["a missing size", { prompt: "a cat", out: "cat.png" }, `Missing size. Use one of: ${supportedSizes}.`],
    ["a null size", { prompt: "a cat", out: "cat.png", size: null }, `Missing size. Use one of: ${supportedSizes}.`],
    [
      "more than five reference images",
      { prompt: "a cat", out: "cat.png", size: "1254x1254", images: ["1", "2", "3", "4", "5", "6"] },
      "at images",
    ],
    [
      "an unsupported background",
      { prompt: "a cat", out: "cat.png", size: "1254x1254", background: "auto" },
      "at background",
    ],
    ["a missing prompt", { out: "cat.png", size: "1254x1254" }, "at prompt"],
  ]
  test.each(invalidArguments)(
    "rejects %s before asking permission or calling the backend",
    async (_name, args, message) => {
      const fetchMock = stubFetch()
      const harness = await createHarness(dir)

      await expect(harness.execute(args)).rejects.toThrow(message)

      expect(harness.permissionRequests).toHaveLength(0)
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  test("asks permission once for the whole operation before calling the backend", async () => {
    const harness = await createHarness(dir)
    const fetchMock = stubFetch(() => {
      expect(harness.permissionRequests).toHaveLength(1)
      return imagesResponse(PNG_BASE64)
    })

    await harness.execute({ prompt: "a cat", out: "cat.png", size: "1254x1254" })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(harness.permissionRequests).toHaveLength(1)
  })

  test("a denied permission stops before reference images are read or the backend is called", async () => {
    const fetchMock = stubFetch()
    const harness = await createHarness(dir)
    harness.denyPermission(new Error("denied by the host"))

    // The reference image does not exist: reading it first would fail with a different error.
    const act = harness.execute({ prompt: "a cat", out: "cat.png", size: "1254x1254", images: ["missing.png"] })

    await expect(act).rejects.toThrow("denied by the host")
    expect(fetchMock).not.toHaveBeenCalled()
    expect(existsSync(path.join(dir, "cat.png"))).toBe(false)
  })

  test("forwards the cancellation signal to the provider request", async () => {
    const fetchMock = stubFetch()
    const harness = await createHarness(dir)
    const controller = new AbortController()

    await harness.execute({ prompt: "a cat", out: "cat.png", size: "1254x1254" }, controller.signal)

    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal)
  })

  test("does nothing when the call is cancelled before it starts", async () => {
    const fetchMock = stubFetch()
    const harness = await createHarness(dir)
    const controller = new AbortController()
    controller.abort(new Error("stopped before start"))

    const act = harness.execute({ prompt: "a cat", out: "cat.png", size: "1254x1254" }, controller.signal)

    await expect(act).rejects.toThrow("stopped before start")
    expect(harness.permissionRequests).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("cancelling during the provider request rejects without retrying or saving", async () => {
    const controller = new AbortController()
    const fetchMock = stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
          controller.abort(new Error("stopped during request"))
        }),
    )
    const harness = await createHarness(dir)

    const act = harness.execute({ prompt: "a cat", out: "cat.png", size: "1254x1254" }, controller.signal)

    await expect(act).rejects.toThrow("stopped during request")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await readdir(dir)).toEqual([])
  })

  test("does not save an image whose request finished after cancellation", async () => {
    const controller = new AbortController()
    const fetchMock = stubFetch(() => {
      controller.abort(new Error("stopped after response"))
      return imagesResponse(PNG_BASE64)
    })
    const harness = await createHarness(dir)

    const act = harness.execute({ prompt: "a cat", out: "cat.png", size: "1254x1254" }, controller.signal)

    await expect(act).rejects.toThrow("stopped after response")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await readdir(dir)).toEqual([])
  })

  test("propagates a provider failure without saving", async () => {
    stubFetch(() => new Response("upstream boom", { status: 500 }))
    const harness = await createHarness(dir)

    const act = harness.execute({ prompt: "a cat", out: "cat.png", size: "1254x1254" })

    await expect(act).rejects.toThrow("codex images request failed: 500 upstream boom")
    expect(await readdir(dir)).toEqual([])
  })
})
