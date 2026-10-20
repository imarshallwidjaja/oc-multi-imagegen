import { afterEach, describe, expect, mock, test } from "bun:test"
import { callViaCodexImages } from "../../src/codex"
import type { GenerateArgs } from "../../src/types"

function imagesResponse(data: Array<{ b64_json: string }>): Response {
  return new Response(JSON.stringify({ created: 0, data }))
}

function generateArgs(overrides: Partial<GenerateArgs> = {}): GenerateArgs {
  return { prompt: "a cat", out: "cat.png", size: "1254x1254", ...overrides }
}

describe("callViaCodexImages", () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("posts the Codex request body to the generations endpoint and returns the image when no reference image is given", async () => {
    const image = "BASE64IMAGE"
    const fetchMock = mock(async (_url: string, _init: RequestInit) => imagesResponse([{ b64_json: image }]))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const auth = { type: "oauth", access: "tok", accountId: "acct" } as const
    const prompt = "a mountain lake"

    const result = await callViaCodexImages(auth, generateArgs({ prompt, size: "1254x1254" }), [])

    expect(result).toBe(image)
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
    const fetchMock = mock(async (_url: string, _init: RequestInit) => imagesResponse([{ b64_json: "BASE64IMAGE" }]))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const auth = { type: "oauth", access: "tok" } as const
    const prompt = "put both characters together"
    const dataUrls = ["data:image/png;base64,AAA", "data:image/jpeg;base64,BBB"]

    await callViaCodexImages(auth, generateArgs({ prompt, size: "1672x941" }), dataUrls)

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

  test("sends the requested background", async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => imagesResponse([{ b64_json: "BASE64IMAGE" }]))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const auth = { type: "oauth", access: "tok" } as const

    await callViaCodexImages(auth, generateArgs({ background: "transparent" }), [])

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body as string).background).toBe("transparent")
  })

  test("sends an opaque background when background is null", async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => imagesResponse([{ b64_json: "BASE64IMAGE" }]))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const auth = { type: "oauth", access: "tok" } as const

    await callViaCodexImages(auth, generateArgs({ background: null }), [])

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body as string).background).toBe("opaque")
  })

  test("omits the account header when accountId is absent", async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => imagesResponse([{ b64_json: "BASE64IMAGE" }]))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const auth = { type: "oauth", access: "tok" } as const

    await callViaCodexImages(auth, generateArgs(), [])

    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers as Record<string, string>).not.toHaveProperty("ChatGPT-Account-Id")
  })

  test("throws with the status and response body when the request fails", async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => new Response("upstream boom", { status: 500 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const auth = { type: "oauth", access: "tok" } as const

    const act = callViaCodexImages(auth, generateArgs(), [])

    await expect(act).rejects.toThrow("codex images request failed: 500 upstream boom")
  })

  test("throws when the response contains no image", async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => imagesResponse([]))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const auth = { type: "oauth", access: "tok" } as const

    const act = callViaCodexImages(auth, generateArgs(), [])

    await expect(act).rejects.toThrow("no image returned by codex images endpoint")
  })

  test("throws when the returned image is empty", async () => {
    // An empty image would decode to a 0-byte file and be reported as success.
    const fetchMock = mock(async (_url: string, _init: RequestInit) => imagesResponse([{ b64_json: "" }]))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const auth = { type: "oauth", access: "tok" } as const

    const act = callViaCodexImages(auth, generateArgs(), [])

    await expect(act).rejects.toThrow("no image returned by codex images endpoint")
  })
})
