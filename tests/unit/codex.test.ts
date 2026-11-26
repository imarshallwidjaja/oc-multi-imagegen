import { afterEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { z } from "zod"
import { type CodexArgs, codexBackend, codexImageedit, codexImagegen } from "../../src/codex"
import type { ImageCredential, OAuthCredential } from "../../src/credential"
import { PNG_BASE64, PNG_BUFFER } from "./fixtures"

function imagesResponse(data: Array<{ b64_json: string }>): Response {
  return new Response(JSON.stringify({ created: 0, data }))
}

function generateArgs(overrides: Partial<CodexArgs> = {}): CodexArgs {
  return { prompt: "a cat", out: "cat.png", size: "1254x1254", ...overrides }
}

const signal = new AbortController().signal
const auth: OAuthCredential = { type: "oauth", access: "tok" }

function callCodex(args: CodexArgs, credential: OAuthCredential = auth) {
  return codexImagegen.request(credential, args, signal)
}

// Runs a Codex tool through the shared flow with a host that allows everything.
function runTool(name: string, args: Record<string, unknown>, directory: string, credential: ImageCredential = auth) {
  const tool = codexBackend.tools.find((candidate) => candidate.name === name)
  if (tool?.kind !== "image") throw new Error(`${name} is not a Codex image tool`)
  return tool.run(args, {
    signal,
    authorize: async () => {},
    authorizeFetch: async () => {},
    resolveDirectory: async () => directory,
    resolveCredential: async () => credential,
  })
}

describe("Codex backend request", () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function stubImage(image = PNG_BASE64) {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => imagesResponse([{ b64_json: image }]))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    return fetchMock
  }

  test("imagegen posts the Codex request body to the generations endpoint and returns the decoded image", async () => {
    const fetchMock = stubImage()
    const prompt = "a mountain lake"

    const result = await callCodex(generateArgs({ prompt, size: "1254x1254" }), {
      type: "oauth",
      access: "tok",
      accountId: "acct",
    })

    expect(Buffer.from(result)).toEqual(PNG_BUFFER)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations")
    expect(init.method).toBe("POST")
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer tok",
      "ChatGPT-Account-Id": "acct",
      originator: "opencode",
    })
    expect(JSON.parse(init.body as string)).toEqual({
      prompt: `${prompt} Generate the image with a width of 1254 pixels and a height of 1254 pixels (1:1 aspect ratio).`,
      background: "opaque",
      model: "gpt-image-2",
      quality: "auto",
      size: "auto",
    })
  })

  test("imageedit posts the same body with the reference images to the edits endpoint", async () => {
    const fetchMock = stubImage()
    const prompt = "put both characters together"
    const dataUrls = ["data:image/png;base64,AAA", "data:image/jpeg;base64,BBB"]

    await codexImageedit.request(
      auth,
      { ...generateArgs({ prompt, size: "1672x941" }), images: ["ref.png"] },
      dataUrls,
      signal,
    )

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/edits")
    expect(JSON.parse(init.body as string)).toEqual({
      prompt: `${prompt} Generate the image with a width of 1672 pixels and a height of 941 pixels (16:9 aspect ratio).`,
      background: "opaque",
      model: "gpt-image-2",
      quality: "auto",
      size: "auto",
      images: [{ image_url: dataUrls[0] }, { image_url: dataUrls[1] }],
    })
  })

  test("sends the requested background, and opaque when it is null", async () => {
    const fetchMock = stubImage()

    await callCodex(generateArgs({ background: "transparent" }))
    await callCodex(generateArgs({ background: null }))

    const backgrounds = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body as string).background)
    expect(backgrounds).toEqual(["transparent", "opaque"])
  })

  test("sends an explicit model and quality in place of the defaults, unchanged", async () => {
    const fetchMock = stubImage()

    await callCodex(generateArgs({ model: "some-new-model", quality: "HIGH" }))

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body).toMatchObject({ model: "some-new-model", quality: "HIGH", size: "auto" })
  })

  test("sends the defaults when model and quality are null", async () => {
    const fetchMock = stubImage()

    await callCodex(generateArgs({ model: null, quality: null }))

    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({
      model: "gpt-image-2",
      quality: "auto",
    })
  })

  test("omits the account header when accountId is absent", async () => {
    const fetchMock = stubImage()

    await callCodex(generateArgs())

    expect(fetchMock.mock.calls[0][1].headers as Record<string, string>).not.toHaveProperty("ChatGPT-Account-Id")
  })

  test("refuses a credential of another kind before any request", async () => {
    const fetchMock = stubImage()
    const key: ImageCredential = { type: "key", key: "sk-test" }

    await expect(runTool("imagegen", generateArgs(), "/nonexistent", key)).rejects.toThrow(
      "The backend needs a oauth credential but received key.",
    )

    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("throws with the status and response body, without the access token", async () => {
    const fetchMock = mock(
      async (_url: string, _init: RequestInit) => new Response("upstream boom for tok", { status: 500 }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const act = callCodex(generateArgs())

    await expect(act).rejects.toThrow("codex images request failed: 500 upstream boom for [redacted]")
  })

  test.each([
    ["imagegen", {}],
    ["imageedit", { images: ["ref.png"] }],
  ])(
    "%s separates requested settings from verified ones in the result text only when they were given",
    async (name, extra) => {
      stubImage()
      const dir = await mkdtemp(path.join(os.tmpdir(), "codex-note-"))
      try {
        await Bun.write(path.join(dir, "ref.png"), PNG_BUFFER)
        const message = async (overrides: Partial<CodexArgs>, out: string) =>
          (await runTool(name, { ...generateArgs({ ...overrides, out }), ...extra }, dir)).message
        const plain = await message({}, "a.png")
        const saved = (out: string) => plain.replace(path.join(dir, "a.png"), path.join(dir, out))

        expect(plain).toStartWith(`Generated image saved to ${path.join(dir, "a.png")}. The image is PNG, 1x1 pixels`)
        expect(plain).not.toContain("Requested")
        expect(await message({ model: null, quality: null }, "b.png")).toBe(saved("b.png"))
        expect(await message({ model: "m1" }, "c.png")).toBe(
          `${saved("c.png")} Requested model m1; the Codex response does not report which settings it applied, so they are unverified.`,
        )
        expect(await message({ model: "m1", quality: "low" }, "d.png")).toContain("Requested model m1 and quality low;")
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  )
})

describe("Codex backend arguments", () => {
  const parse = (value: Record<string, unknown>) => codexImagegen.schema.safeParse(value)

  test("accepts the size presets and nothing else", () => {
    for (const size of ["1254x1254", "1536x1024", "1024x1536", "1448x1086", "1086x1448", "1672x941", "941x1672"]) {
      expect(parse({ prompt: "p", out: "o.png", size }).success).toBe(true)
    }
    expect(parse({ prompt: "p", out: "o.png", size: "1280x720" }).error?.issues[0].message).toBe(
      'Unsupported size "1280x720". Use one of: 1254x1254 (1:1), 1536x1024 (3:2), 1024x1536 (2:3), 1448x1086 (4:3), 1086x1448 (3:4), 1672x941 (16:9), 941x1672 (9:16).',
    )
  })

  test("imageedit takes one to five reference images", () => {
    const images = (count: number) =>
      codexImageedit.schema.safeParse({
        prompt: "p",
        out: "o.png",
        size: "1254x1254",
        images: Array(count).fill("a.png"),
      })
    expect(images(1).success).toBe(true)
    expect(images(5).success).toBe(true)
    expect(images(0).success).toBe(false)
    expect(images(6).success).toBe(false)
  })

  test.each([
    ["imagegen", codexImagegen],
    ["imageedit", codexImageedit],
  ])("%s describes model and quality as unverified requests, not as unsupported", (_name, tool) => {
    const schema = z.toJSONSchema(tool.schema, { io: "input" }) as {
      properties: Record<string, { description: string }>
    }

    for (const field of ["model", "quality"]) {
      expect(schema.properties[field].description).toContain("unverified")
      expect(schema.properties[field].description).not.toMatch(/ignored|not supported|forbidden/i)
    }
  })
})
