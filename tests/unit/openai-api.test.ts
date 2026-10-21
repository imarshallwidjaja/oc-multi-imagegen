import { afterEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { z } from "zod"
import { readReferenceImages } from "../../src/input-image"
import { openaiApiBackend } from "../../src/openai-api"
import type { GenerateArgs } from "../../src/schema"
import type { ImageCredential } from "../../src/types"
import { PNG_BUFFER } from "./fixtures"

function imagesResponse(data: Array<{ b64_json: string }>): Response {
  return new Response(JSON.stringify({ created: 0, data }))
}

function generateArgs(overrides: Partial<GenerateArgs> = {}): GenerateArgs {
  return { prompt: "a cat", out: "cat.png", size: "1536x864", ...overrides }
}

const signal = new AbortController().signal
const key: ImageCredential = { type: "key", key: "sk-images" }

function callApi(args: GenerateArgs, dataUrls: string[] = [], credential: ImageCredential = key) {
  return openaiApiBackend.generate(credential, args, dataUrls, signal)
}

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubImage(image = "BASE64IMAGE") {
  const fetchMock = mock(async (_url: string, _init: RequestInit) => imagesResponse([{ b64_json: image }]))
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

describe("OpenAI Images API backend request", () => {
  test("posts the documented generation body with the key as a bearer token", async () => {
    const fetchMock = stubImage()

    const result = await callApi(generateArgs({ prompt: "a mountain lake" }))

    expect(result).toBe("BASE64IMAGE")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://api.openai.com/v1/images/generations")
    expect(init.method).toBe("POST")
    expect(init.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer sk-images" })
    expect(JSON.parse(init.body as string)).toEqual({
      model: "gpt-image-2.5-sunburst",
      prompt: "a mountain lake",
      size: "1536x864",
      quality: "auto",
      background: "opaque",
      n: 1,
      output_format: "png",
      stream: false,
    })
  })

  test("posts the same body with the references as data URLs to the edits endpoint", async () => {
    const fetchMock = stubImage()
    const dataUrls = ["data:image/png;base64,AAA", "data:image/webp;base64,BBB"]

    await callApi(generateArgs({ background: "transparent" }), dataUrls)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://api.openai.com/v1/images/edits")
    expect(JSON.parse(init.body as string)).toEqual({
      model: "gpt-image-2.5-sunburst",
      prompt: "a cat",
      size: "1536x864",
      quality: "auto",
      background: "transparent",
      n: 1,
      output_format: "png",
      stream: false,
      images: [{ image_url: dataUrls[0] }, { image_url: dataUrls[1] }],
    })
  })

  test("sends an explicit model and quality unchanged, and the defaults when they are null", async () => {
    const fetchMock = stubImage()

    await callApi(generateArgs({ model: "gpt-image-3-preview", quality: "xhigh" }))
    await callApi(generateArgs({ model: null, quality: null }))

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body as string))
    expect(bodies.map(({ model, quality }) => ({ model, quality }))).toEqual([
      { model: "gpt-image-3-preview", quality: "xhigh" },
      { model: "gpt-image-2.5-sunburst", quality: "auto" },
    ])
  })

  test("never sends the legacy response_format or an organization header", async () => {
    const fetchMock = stubImage()

    await callApi(generateArgs())

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body as string)).not.toHaveProperty("response_format")
    expect(Object.keys(init.headers as Record<string, string>)).toEqual(["Content-Type", "Authorization"])
  })

  test("refuses a credential of another kind before any request", async () => {
    const fetchMock = stubImage()

    await expect(callApi(generateArgs(), [], { type: "oauth", access: "tok" })).rejects.toThrow(
      "The backend needs a key credential but received oauth.",
    )

    expect(fetchMock).not.toHaveBeenCalled()
  })

  test.each(["sk bad", "sk-bad\n", "sk-é"])(
    "refuses a key that cannot be an HTTP header value without quoting it",
    async (bad) => {
      const fetchMock = stubImage()

      const error = await callApi(generateArgs(), [], { type: "key", key: bad }).catch((caught: Error) => caught)

      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe(
        "The stored OpenAI Images API key contains characters that cannot be sent in an HTTP header.",
      )
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  test("reports the status and response body with the key removed", async () => {
    globalThis.fetch = mock(
      async (_url: string, _init: RequestInit) =>
        new Response('{"error":{"message":"Incorrect API key provided: sk-images."}}', { status: 401 }),
    ) as unknown as typeof fetch

    const act = callApi(generateArgs())

    await expect(act).rejects.toThrow(
      'openai-api images request failed: 401 {"error":{"message":"Incorrect API key provided: [redacted]."}}',
    )
  })
})

describe("OpenAI Images API backend arguments", () => {
  const parse = (value: Record<string, unknown>) =>
    openaiApiBackend.argsSchema.safeParse({ prompt: "p", out: "o.png", ...value })

  test.each(["1536x864", "1024x1024", "16x48", "48x16", "3840x2160", "1280x720"])(
    "accepts the native size %s",
    (size) => {
      expect(parse({ size }).success).toBe(true)
    },
  )

  test.each([
    ["1000x1000", "multiple of 16"],
    ["1536x", "WIDTHxHEIGHT"],
    ["1536X864", "WIDTHxHEIGHT"],
    [" 1536x864", "WIDTHxHEIGHT"],
    ["auto", "WIDTHxHEIGHT"],
    ["0x1024", "WIDTHxHEIGHT"],
    ["-16x16", "WIDTHxHEIGHT"],
    ["1536x864x2", "WIDTHxHEIGHT"],
    ["16x64", "between 1:3 and 3:1"],
    ["4096x1024", "between 1:3 and 3:1"],
  ])("rejects the size %s before any request", (size, reason) => {
    const message = parse({ size }).error?.issues[0].message
    expect(message).toContain(`Unsupported size "${size}"`)
    expect(message).toContain(reason)
  })

  test("reports a missing or non-string size", () => {
    expect(parse({}).error?.issues[0].message).toContain("Missing size")
    expect(parse({ size: 1024 }).error?.issues[0].message).toContain("Unsupported size 1024")
  })

  test("leaves model-specific size limits to the API", () => {
    // Above the documented experimental range and a very small image: only the API knows the model's limits.
    expect(parse({ size: "4096x2304" }).success).toBe(true)
    expect(parse({ size: "16x16" }).success).toBe(true)
  })

  test("takes up to sixteen reference images", () => {
    const images = (count: number) => parse({ size: "1536x864", images: Array(count).fill("a.png") })
    expect(images(16).success).toBe(true)
    expect(images(17).success).toBe(false)
  })

  test("documents its defaults and limits without Codex caveats", () => {
    const schema = z.toJSONSchema(openaiApiBackend.argsSchema, { io: "input" }) as {
      properties: Record<string, { description: string }>
    }
    const text = JSON.stringify(schema) + Object.values(openaiApiBackend.description).join(" ")

    expect(schema.properties.model.description).toContain("gpt-image-2.5-sunburst")
    expect(schema.properties.quality.description).toContain("auto")
    expect(schema.properties.images.description).toContain("up to 16")
    expect(schema.properties.images.description).toContain("PNG, JPEG or WebP")
    expect(text).not.toMatch(/Codex|unverified|1254x1254|in the prompt sentence/)
  })

  test("adds no note to the result text", () => {
    expect(openaiApiBackend).not.toHaveProperty("resultNote")
  })
})

describe("OpenAI Images API reference images", () => {
  let dir: string | undefined
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  async function reference(name: string, bytes: Buffer) {
    dir ??= await mkdtemp(path.join(os.tmpdir(), "api-ref-"))
    await writeFile(path.join(dir, name), bytes)
    return dir
  }

  test.each([
    ["PNG", "image/png", PNG_BUFFER],
    ["JPEG", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
    ["WebP", "image/webp", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])],
  ])("accepts %s", async (_name, mime, bytes) => {
    const where = await reference("ref", bytes)

    expect(await readReferenceImages(["ref"], where, openaiApiBackend.references)).toEqual([
      `data:${mime};base64,${bytes.toString("base64")}`,
    ])
  })

  test("rejects a GIF, which the API does not take", async () => {
    const where = await reference("ref.gif", Buffer.from("GIF89a"))

    await expect(readReferenceImages(["ref.gif"], where, openaiApiBackend.references)).rejects.toThrow(
      `unsupported reference image type image/gif: ${path.join(where, "ref.gif")}. Use image/png, image/jpeg, image/webp.`,
    )
  })

  test("rejects a reference whose data URL exceeds the documented length", async () => {
    // 15,728,640 bytes encode to 20,971,520 base64 characters; the data URL prefix pushes it over the limit.
    const where = await reference("big.png", Buffer.concat([PNG_BUFFER, Buffer.alloc(15_728_640 - PNG_BUFFER.length)]))

    await expect(readReferenceImages(["big.png"], where, openaiApiBackend.references)).rejects.toThrow(
      "reference image is too large",
    )
  })

  test("accepts a reference whose data URL is just under the documented length", async () => {
    const where = await reference("max.png", Buffer.concat([PNG_BUFFER, Buffer.alloc(15_728_610 - PNG_BUFFER.length)]))

    const [dataUrl] = await readReferenceImages(["max.png"], where, openaiApiBackend.references)

    expect(dataUrl.length).toBeLessThanOrEqual(20_971_520)
    expect(dataUrl.length).toBeGreaterThan(20_971_480)
  })
})
