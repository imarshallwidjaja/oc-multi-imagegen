import { afterEach, describe, expect, mock, test } from "bun:test"
import { z } from "zod"
import { codexImagegen } from "../../src/codex"
import type { GenerateArgs } from "../../src/schema"
import type { ImageCredential } from "../../src/types"

function imagesResponse(data: Array<{ b64_json: string }>): Response {
  return new Response(JSON.stringify({ created: 0, data }))
}

function generateArgs(overrides: Partial<GenerateArgs> = {}): GenerateArgs {
  return { prompt: "a cat", out: "cat.png", size: "1254x1254", ...overrides }
}

const signal = new AbortController().signal
const auth: ImageCredential = { type: "oauth", access: "tok" }

function callCodex(args: GenerateArgs, dataUrls: string[] = [], credential: ImageCredential = auth) {
  return codexImagegen.generate(credential, args, dataUrls, signal)
}

describe("Codex backend request", () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function stubImage(image = "BASE64IMAGE") {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => imagesResponse([{ b64_json: image }]))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    return fetchMock
  }

  test("posts the Codex request body to the generations endpoint and returns the image when no reference image is given", async () => {
    const fetchMock = stubImage()
    const prompt = "a mountain lake"

    const result = await callCodex(generateArgs({ prompt, size: "1254x1254" }), [], {
      type: "oauth",
      access: "tok",
      accountId: "acct",
    })

    expect(result).toBe("BASE64IMAGE")
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

  test("posts the Codex request body with the reference images to the edits endpoint when they are given", async () => {
    const fetchMock = stubImage()
    const prompt = "put both characters together"
    const dataUrls = ["data:image/png;base64,AAA", "data:image/jpeg;base64,BBB"]

    await callCodex(generateArgs({ prompt, size: "1672x941" }), dataUrls)

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

    await expect(callCodex(generateArgs(), [], { type: "key", key: "sk-test" })).rejects.toThrow(
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
})

describe("Codex backend arguments", () => {
  const parse = (value: Record<string, unknown>) => codexImagegen.schema.safeParse(value)

  test("accepts the size presets and nothing else", () => {
    expect(parse({ prompt: "p", out: "o.png", size: "1672x941" }).success).toBe(true)
    expect(parse({ prompt: "p", out: "o.png", size: "1280x720" }).error?.issues[0].message).toContain(
      'Unsupported size "1280x720". Use one of: 1254x1254 (1:1)',
    )
  })

  test("takes at most five reference images", () => {
    const images = (count: number) =>
      parse({ prompt: "p", out: "o.png", size: "1254x1254", images: Array(count).fill("a.png") })
    expect(images(5).success).toBe(true)
    expect(images(6).success).toBe(false)
  })

  test("describes model and quality as unverified requests, not as unsupported", () => {
    const schema = z.toJSONSchema(codexImagegen.schema, { io: "input" }) as {
      properties: Record<string, { description: string }>
    }

    for (const field of ["model", "quality"]) {
      expect(schema.properties[field].description).toContain("unverified")
      expect(schema.properties[field].description).not.toMatch(/ignored|not supported|forbidden/i)
    }
  })

  test("separates requested settings from verified ones in the result text only when they were given", () => {
    expect(codexImagegen.resultNote(generateArgs())).toBeUndefined()
    expect(codexImagegen.resultNote(generateArgs({ model: null, quality: null }))).toBeUndefined()
    expect(codexImagegen.resultNote(generateArgs({ model: "m1" }))).toBe(
      "Requested model m1; the Codex response does not report which settings it applied, so they are unverified.",
    )
    expect(codexImagegen.resultNote(generateArgs({ model: "m1", quality: "low" }))).toContain(
      "model m1 and quality low",
    )
  })
})
