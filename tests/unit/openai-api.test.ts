import { afterEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { z } from "zod"
import type { ImageCredential, KeyCredential } from "../../src/credential"
import { readReferenceImages } from "../../src/input-image"
import { openaiApiBackend, openaiApiImageedit, openaiApiImagegen, openaiApiModels } from "../../src/openai-api"
import { lookUpOpenAiModels } from "../../src/openai-models"
import { PNG_BASE64, PNG_BUFFER } from "./fixtures"

type GenerateArgs = z.output<typeof openaiApiImagegen.schema>
type EditArgs = z.output<typeof openaiApiImageedit.schema>

function imagesResponse(data: Array<{ b64_json: string }>): Response {
  return new Response(JSON.stringify({ created: 0, data }))
}

function generateArgs(overrides: Partial<GenerateArgs> = {}): GenerateArgs {
  return { prompt: "a cat", out: "cat.png", size: "1536x864", ...overrides }
}

function editArgs(overrides: Partial<EditArgs> = {}): EditArgs {
  return { prompt: "a cat", out: "cat.png", size: "1536x864", images: ["ref.png"], ...overrides }
}

const signal = new AbortController().signal
const key: KeyCredential = { type: "key", key: "sk-images" }

function callApi(args: GenerateArgs) {
  return openaiApiImagegen.request(key, args, signal)
}

function callEdit(args: EditArgs, dataUrls: string[]) {
  return openaiApiImageedit.request(key, args, dataUrls, signal)
}

// Runs imagegen through the shared flow, which checks the credential, with a host that allows everything.
function runImagegen(credential: ImageCredential, args = generateArgs(), directory = "/nonexistent") {
  const tool = openaiApiBackend.tools.find((candidate) => candidate.name === "imagegen")
  if (tool?.kind !== "image") throw new Error("imagegen is not an image tool")
  return tool.run(args, {
    signal,
    authorize: async () => {},
    resolveDirectory: async () => directory,
    resolveCredential: async () => credential,
  })
}

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubImage(image = PNG_BASE64) {
  const fetchMock = mock(async (_url: string, _init: RequestInit) => imagesResponse([{ b64_json: image }]))
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

describe("OpenAI Images API backend request", () => {
  test("imagegen posts the documented generation body with the key as a bearer token and decodes the image", async () => {
    const fetchMock = stubImage()

    const result = await callApi(generateArgs({ prompt: "a mountain lake" }))

    expect(Buffer.from(result)).toEqual(PNG_BUFFER)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://api.openai.com/v1/images/generations")
    expect(init.method).toBe("POST")
    expect(init.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer sk-images" })
    expect(JSON.parse(init.body as string)).toEqual({
      model: "gpt-image-2.6-sunburst",
      prompt: "a mountain lake",
      size: "1536x864",
      quality: "auto",
      background: "opaque",
      n: 1,
      output_format: "png",
      stream: false,
    })
  })

  test("imageedit posts the same body with the references as data URLs to the edits endpoint", async () => {
    const fetchMock = stubImage()
    const dataUrls = ["data:image/png;base64,AAA", "data:image/webp;base64,BBB"]

    await callEdit(editArgs({ background: "transparent" }), dataUrls)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://api.openai.com/v1/images/edits")
    expect(JSON.parse(init.body as string)).toEqual({
      model: "gpt-image-2.6-sunburst",
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
      { model: "gpt-image-2.6-sunburst", quality: "auto" },
    ])
  })

  test.each([
    ["jpeg", {}, { output_format: "jpeg", background: "opaque" }],
    ["webp", { background: "transparent" }, { output_format: "webp", background: "transparent" }],
    [
      "gif",
      { frame_count: 4, frame_duration_ms: 120 },
      { output_format: "gif", frame_count: 4, frame_duration_ms: 120 },
    ],
    ["gif", { background: "opaque" }, { output_format: "gif", background: "opaque" }],
    ["svg", { svg_model: "author-model" }, { output_format: "svg", svg: { model: "author-model" } }],
    ["svg", {}, { output_format: "svg" }],
  ] as const)("sends output_format %s with only the fields that belong to it", async (format, extra, expected) => {
    const fetchMock = stubImage()

    await callApi(generateArgs({ output_format: format, ...extra }))

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://api.openai.com/v1/images/generations")
    expect(JSON.parse(init.body as string)).toEqual({
      model: "gpt-image-2.6-sunburst",
      prompt: "a cat",
      size: "1536x864",
      quality: "auto",
      n: 1,
      stream: false,
      ...expected,
    })
  })

  test.each([
    ["jpeg", {}, { output_format: "jpeg", background: "opaque" }],
    ["webp", { background: "transparent" }, { output_format: "webp", background: "transparent" }],
  ] as const)("imageedit sends output_format %s to the edits endpoint", async (format, extra, expected) => {
    const fetchMock = stubImage()

    await callEdit(editArgs({ output_format: format, ...extra }), ["data:image/png;base64,AAA"])

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://api.openai.com/v1/images/edits")
    expect(JSON.parse(init.body as string)).toMatchObject(expected)
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

    await expect(runImagegen({ type: "oauth", access: "tok" })).rejects.toThrow(
      "The backend needs a key credential but received oauth.",
    )

    expect(fetchMock).not.toHaveBeenCalled()
  })

  test.each(["sk bad", "sk-bad\n", "sk-é"])(
    "refuses a key that cannot be an HTTP header value without quoting it",
    async (bad) => {
      const fetchMock = stubImage()

      const error = await runImagegen({ type: "key", key: bad }).catch((caught: Error) => caught)

      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe(
        "The OpenAI Images API key contains characters that cannot be sent in an HTTP header.",
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
    openaiApiImagegen.schema.safeParse({ prompt: "p", out: "o.png", ...value })

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

  test("imageedit takes one to sixteen reference images", () => {
    const images = (count: number) =>
      openaiApiImageedit.schema.safeParse({
        prompt: "p",
        out: "o.png",
        size: "1536x864",
        images: Array(count).fill("a.png"),
      })
    expect(images(1).success).toBe(true)
    expect(images(16).success).toBe(true)
    expect(images(0).success).toBe(false)
    expect(images(17).success).toBe(false)
  })

  test("documents its defaults and limits without Codex caveats", () => {
    const generate = z.toJSONSchema(openaiApiImagegen.schema, { io: "input" }) as {
      properties: Record<string, { description: string }>
    }
    const edit = z.toJSONSchema(openaiApiImageedit.schema, { io: "input" }) as typeof generate
    const text = JSON.stringify([generate, edit]) + openaiApiImagegen.description + openaiApiImageedit.description

    for (const schema of [generate, edit]) {
      expect(schema.properties.model.description).toContain("gpt-image-2.6-sunburst")
      expect(schema.properties.quality.description).toContain("auto")
    }
    expect(edit.properties.images.description).toContain("1 to 16")
    expect(edit.properties.images.description).toContain("PNG, JPEG or WebP")
    expect(text).not.toMatch(/Codex|unverified|1254x1254|in the prompt sentence/)
  })

  test("imageedit schema describes raster output only", () => {
    const edit = z.toJSONSchema(openaiApiImageedit.schema, { io: "input" }) as {
      properties: Record<string, { anyOf?: Array<{ enum?: string[] }>; description: string }>
    }

    expect(Object.keys(edit.properties)).not.toContain("frame_count")
    expect(Object.keys(edit.properties)).not.toContain("svg_model")
    expect(edit.properties.output_format.anyOf?.[0].enum).toEqual(["png", "jpeg", "webp"])
    expect(edit.properties.out.description).toContain("PNG, JPEG or WebP bytes")
  })

  test("accepts every documented output format and the GIF limits at both ends", () => {
    for (const output_format of ["png", "jpeg", "webp", "gif", "svg"]) {
      expect(parse({ size: "1024x1024", output_format }).success).toBe(true)
    }
    for (const [frame_count, frame_duration_ms] of [
      [2, 20],
      [16, 2000],
    ]) {
      expect(parse({ size: "1024x1024", output_format: "gif", frame_count, frame_duration_ms }).success).toBe(true)
    }
    expect(parse({ size: "1024x1024", output_format: "webp", background: "transparent" }).success).toBe(true)
  })

  test("documents the output controls and the GIF limits as tool limits", () => {
    const schema = z.toJSONSchema(openaiApiImagegen.schema, { io: "input" }) as {
      properties: Record<string, { description: string }>
    }

    expect(schema.properties.size.description).toContain("Check the returned dimensions when they matter.")
    expect(schema.properties.out.description).toContain("PNG, JPEG, WebP, GIF or SVG")
    expect(schema.properties.frame_count.description).toContain("not a proven provider maximum")
    expect(schema.properties.frame_duration_ms.description).toContain("not a proven provider maximum")
    expect(schema.properties.svg_model.description).toContain("never guess one")
    expect(schema.properties.background.description).toContain("transparent needs output_format png or webp")
  })

  test("reports only the saved image in the result text, even with an explicit model and quality", async () => {
    stubImage()
    const dir = await mkdtemp(path.join(os.tmpdir(), "api-result-"))
    try {
      const saved = await runImagegen(key, generateArgs({ model: "gpt-image-3-preview", quality: "high" }), dir)

      expect(saved.message).toBe(`Generated image saved to ${path.join(dir, "cat.png")}. The image is PNG, 1x1 pixels.`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("OpenAI model lookup", () => {
  const listed = [
    { id: "gpt-4.1", object: "model", created: 1_700_000_000, owned_by: "system" },
    { id: "chatgpt-image-latest", object: "model", created: 1_790_000_000, owned_by: "system" },
    { id: "gpt-image-2.6-sunburst", object: "model", created: 1_800_000_000, owned_by: "system" },
    {
      id: "gpt-image-1",
      object: "model",
      created: 1_740_000_000,
      owned_by: "system",
      shutdown_date: "2026-10-23",
    },
    { id: "gpt-image-2.6-flare", object: "model", created: 1_800_000_000, owned_by: "system", shutdown_date: null },
  ]

  function stubModels(body: unknown = { object: "list", data: listed }, status = 200) {
    const fetchMock = mock(async (_url: string, _init: RequestInit) =>
      typeof body === "string" ? new Response(body, { status }) : new Response(JSON.stringify(body), { status }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    return fetchMock
  }

  const ask = (args: { model?: string; query?: string } = {}) =>
    lookUpOpenAiModels("sk-images", args, signal, "gpt-image-2.6-sunburst")

  test("sends one GET to the documented endpoint with only the key as a bearer token", async () => {
    const fetchMock = stubModels()

    await ask()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://api.openai.com/v1/models")
    expect(init).toEqual({ method: "GET", headers: { Authorization: "Bearer sk-images" }, signal })
  })

  test("lists every image-family ID, newest first, marking the default, and says what the list does not prove", async () => {
    stubModels()

    const text = await ask()

    const lines = text.split("\n").filter((line) => line.startsWith("- "))
    expect(lines).toEqual([
      "- gpt-image-2.6-flare: created 2027-01-15, owned by system",
      "- gpt-image-2.6-sunburst (default): created 2027-01-15, owned by system",
      "- chatgpt-image-latest: created 2026-09-21, owned by system",
      "- gpt-image-1: created 2025-02-19, owned by system, shutdown date 2026-10-23",
    ])
    expect(text).toContain("(gpt-image-* and chatgpt-image-* IDs): 4 of 5 model IDs.")
    expect(text).toContain("not proof that it supports SVG, GIF, a size or any other feature")
    expect(text).toContain("imagegen and imageedit send any model ID unchanged, listed or not")
    expect(text).not.toContain("gpt-4.1")
    expect(text).not.toContain("is not in this list")
  })

  test("says when the default is not listed, and that both image tools still send it", async () => {
    stubModels({ data: listed.filter((model) => model.id !== "gpt-image-2.6-sunburst") })

    expect(await ask()).toContain(
      "The default gpt-image-2.6-sunburst is not in this list; imagegen and imageedit still send it when model is omitted.",
    )
  })

  test("searches every listed ID with query words, image models or not", async () => {
    stubModels()

    const text = await ask({ query: "GPT 4" })

    expect(text).toContain('that contain "gpt" and "4": 1 of 5 model IDs.')
    expect(text).toContain("- gpt-4.1: created 2023-11-14, owned by system")
    expect(await ask({ query: "no-such-model" })).toContain("0 of 5 model IDs")
  })

  test("checks one exact ID, listed or not", async () => {
    stubModels()

    const found = await ask({ model: "gpt-image-2.6-flare" })
    const missing = await ask({ model: "gpt-image-9" })

    expect(found).toContain("gpt-image-2.6-flare is listed by GET /v1/models for this key.")
    expect(found).toContain("not proof that it supports SVG")
    expect(missing).toContain("gpt-image-9 is not listed by GET /v1/models for this key (5 model IDs listed).")
    expect(missing).toContain("- gpt-image-2.6-sunburst (default)")
  })

  test("names how many entries a long list leaves out instead of dropping them silently", async () => {
    const many = Array.from({ length: 205 }, (_, index) => ({ id: `gpt-image-x${index}`, created: index }))
    stubModels({ data: many })

    const text = await ask()

    expect(text.split("\n").filter((line) => line.startsWith("- gpt-image-x"))).toHaveLength(200)
    expect(text).toContain("- ... and 5 more not shown; narrow the list with query.")
    expect(text).toContain("205 of 205 model IDs")
  })

  test.each([
    ["a body that is not JSON", "<html>oops sk-images</html>", "the body is not JSON"],
    ["no data list", { object: "list" }, "data is not a list"],
    ["an entry without an id", { data: [{ object: "model" }] }, "data[0] has no usable id"],
    ["an id with spaces", { data: [{ id: "gpt image" }] }, "data[0] has no usable id"],
    [
      "a non-numeric created",
      { data: [{ id: "gpt-image-2", created: "today" }] },
      "data[0].created is not a representable Unix timestamp",
    ],
    // JSON.parse accepts 1e300, but a Date cannot hold it, so showing it would throw a RangeError.
    [
      "a created time no date can hold",
      { data: [{ id: "gpt-image-2", created: 1e300 }] },
      "data[0].created is not a representable Unix timestamp",
    ],
    ["a non-string owner", { data: [{ id: "gpt-image-2", owned_by: 7 }] }, "data[0].owned_by is not a string"],
    [
      "a non-string shutdown date",
      { data: [{ id: "gpt-image-2", shutdown_date: 7 }] },
      "data[0].shutdown_date is not a string or null",
    ],
  ])("refuses a response with %s without quoting it", async (_name, body, reason) => {
    stubModels(body)

    const error = (await ask().catch((caught: Error) => caught)) as Error

    expect(error.message).toBe(`openai-api models response is malformed: ${reason}. The model list could not be read.`)
  })

  test("reports a rejected request with the status and a bounded body without the key", async () => {
    stubModels(`{"error":{"message":"Incorrect API key provided: sk-images."}}${"x".repeat(1000)}`, 401)

    const error = (await ask().catch((caught: Error) => caught)) as Error

    expect(error.message).toStartWith(
      'openai-api models request failed: 401 {"error":{"message":"Incorrect API key provided: [redacted]."}}',
    )
    expect(error.message.length).toBeLessThan(600)
  })

  test("refuses a key that cannot be an HTTP header value before any request", async () => {
    const fetchMock = stubModels()
    const host = {
      signal,
      authorize: async () => {},
      resolveCredential: async () => ({ type: "key" as const, key: "sk bad" }),
    }

    await expect(openaiApiModels.run({}, host)).rejects.toThrow(
      "The OpenAI Images API key contains characters that cannot be sent in an HTTP header.",
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("describes a listed model as no proof of capability", () => {
    expect(openaiApiModels.description).toContain("not proof that it supports SVG, GIF")
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

    expect(await readReferenceImages(["ref"], where, openaiApiImageedit.referenceRules())).toEqual([
      `data:${mime};base64,${bytes.toString("base64")}`,
    ])
  })

  test("rejects a GIF, which the API does not take", async () => {
    const where = await reference("ref.gif", Buffer.from("GIF89a"))

    await expect(readReferenceImages(["ref.gif"], where, openaiApiImageedit.referenceRules())).rejects.toThrow(
      `unsupported reference image type image/gif: ${path.join(where, "ref.gif")}. Use image/png, image/jpeg, image/webp.`,
    )
  })

  test("rejects a reference whose data URL exceeds the documented length", async () => {
    // 15,728,640 bytes encode to 20,971,520 base64 characters; the data URL prefix pushes it over the limit.
    const where = await reference("big.png", Buffer.concat([PNG_BUFFER, Buffer.alloc(15_728_640 - PNG_BUFFER.length)]))

    await expect(readReferenceImages(["big.png"], where, openaiApiImageedit.referenceRules())).rejects.toThrow(
      "reference image is too large",
    )
  })

  test("accepts a reference whose data URL is just under the documented length", async () => {
    const where = await reference("max.png", Buffer.concat([PNG_BUFFER, Buffer.alloc(15_728_610 - PNG_BUFFER.length)]))

    const [dataUrl] = await readReferenceImages(["max.png"], where, openaiApiImageedit.referenceRules())

    expect(dataUrl.length).toBeLessThanOrEqual(20_971_520)
    expect(dataUrl.length).toBeGreaterThan(20_971_480)
  })
})
