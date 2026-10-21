import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PNG_BASE64, PNG_BUFFER } from "./fixtures"
import {
  FLAVOURS,
  type Flavour,
  SHARED_SIZE,
  STORED_CREDENTIALS,
  type ToolHarness,
  v1Harness,
  v2Harness,
} from "./hosts"

// The imagegen flow is shared by both host adapters and both backends, so each test runs against OpenCode 1 and
// OpenCode 2 with each backend selected. Wire-level request details live in codex.test.ts and openai-api.test.ts.
// Capture so this file's env edits don't leak into other test files sharing the bun test process.
const ORIGINAL_AUTH_CONTENT = process.env.OPENCODE_AUTH_CONTENT
const originalFetch = globalThis.fetch
let dir: string

beforeEach(async () => {
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(STORED_CREDENTIALS)
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

const hosts: Array<[string, (directory: string, flavour: Flavour) => Promise<ToolHarness>]> = [
  ["OpenCode 1", v1Harness],
  ["OpenCode 2", v2Harness],
]
const matrix = hosts.flatMap(([host, create]) =>
  FLAVOURS.map((flavour) => [host, flavour.backend, create, flavour] as const),
)

const args = { prompt: "a cat", out: "cat.png", size: SHARED_SIZE }

describe.each(matrix)("imagegen through %s with the %s backend", (_host, _backend, create, flavour) => {
  const createHarness = (directory: string) => create(directory, flavour)

  test("saves the generated image under the host directory and reports it", async () => {
    const fetchMock = stubFetch()
    const harness = await createHarness(dir)

    const result = await harness.execute(args)

    const savedPath = path.join(dir, "cat.png")
    expect(await readFile(savedPath)).toEqual(PNG_BUFFER)
    // PNG_BASE64 is a 1x1 image. The message reports the size of the saved image, not the requested size.
    expect(result).toEqual({
      message: `Generated image saved to ${savedPath}. The image is 1x1 pixels.`,
      out: savedPath,
      versioned: false,
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(flavour.generationsUrl)
    expect((init.headers as Record<string, string>).Authorization).toBe(flavour.authorization)
  })

  test("versions the output path when it already exists", async () => {
    stubFetch()
    const harness = await createHarness(dir)
    await harness.execute(args)

    const second = await harness.execute(args)

    expect(second.out).toBe(path.join(dir, "cat-v2.png"))
    expect(second.versioned).toBe(true)
    expect(second.message).toContain("the requested path")
  })

  test("drops arguments it does not define", async () => {
    const fetchMock = stubFetch()
    const harness = await createHarness(dir)

    await harness.execute({ ...args, output_format: "jpeg", n: 4 })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.n).not.toBe(4)
    expect(body.output_format).not.toBe("jpeg")
  })

  test("generates without reference images when optional arguments are null", async () => {
    const fetchMock = stubFetch()
    const harness = await createHarness(dir)
    // Some models fill unused optional arguments with null.
    await harness.execute({ ...args, images: null, background: null, model: null, quality: null })

    expect(fetchMock.mock.calls[0][0]).toBe(flavour.generationsUrl)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).background).toBe("opaque")
  })

  test("sends reference images to the edits endpoint in the order given", async () => {
    const fetchMock = stubFetch()
    await Bun.write(path.join(dir, "first.png"), PNG_BUFFER)
    await Bun.write(path.join(dir, "second.png"), Buffer.concat([PNG_BUFFER, Buffer.from("trailer")]))
    const harness = await createHarness(dir)

    await harness.execute({ ...args, images: ["first.png", "second.png"] })

    expect(fetchMock.mock.calls[0][0]).toBe(flavour.editsUrl)
    const { images } = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(images).toHaveLength(2)
    expect(images[0].image_url).toBe(`data:image/png;base64,${PNG_BASE64}`)
    expect(images[1].image_url).toBe(
      `data:image/png;base64,${Buffer.concat([PNG_BUFFER, Buffer.from("trailer")]).toString("base64")}`,
    )
  })

  const invalidArguments: Array<[string, Record<string, unknown>, string]> = [
    ["an unsupported background", { ...args, background: "auto" }, "at background"],
    ["a missing prompt", { out: "cat.png", size: SHARED_SIZE }, "at prompt"],
    ["an empty model", { ...args, model: "" }, "at model"],
    ["a non-string quality", { ...args, quality: 3 }, "at quality"],
    ["a missing size", { prompt: "a cat", out: "cat.png" }, "Missing size"],
  ]
  test.each(invalidArguments)(
    "rejects %s before asking permission or calling the backend",
    async (_name, invalid, message) => {
      const fetchMock = stubFetch()
      const harness = await createHarness(dir)

      await expect(harness.execute(invalid)).rejects.toThrow(message)

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

    await harness.execute(args)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(harness.permissionRequests).toHaveLength(1)
  })

  test("a denied permission stops before credentials, reference images or the backend are touched", async () => {
    // Reaching the credential store would fail with a different error than the denial.
    process.env.OPENCODE_AUTH_CONTENT = "{}"
    const fetchMock = stubFetch()
    const harness = await createHarness(dir)
    harness.denyPermission(new Error("denied by the host"))

    // The reference image does not exist: reading it first would fail with a different error.
    const act = harness.execute({ ...args, images: ["missing.png"] })

    await expect(act).rejects.toThrow("denied by the host")
    expect(fetchMock).not.toHaveBeenCalled()
    expect(existsSync(path.join(dir, "cat.png"))).toBe(false)
  })

  test("forwards the cancellation signal to the provider request", async () => {
    const fetchMock = stubFetch()
    const harness = await createHarness(dir)
    const controller = new AbortController()

    await harness.execute(args, controller.signal)

    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal)
  })

  test("does nothing when the call is cancelled before it starts", async () => {
    const fetchMock = stubFetch()
    const harness = await createHarness(dir)
    const controller = new AbortController()
    controller.abort(new Error("stopped before start"))

    const act = harness.execute(args, controller.signal)

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

    const act = harness.execute(args, controller.signal)

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

    const act = harness.execute(args, controller.signal)

    await expect(act).rejects.toThrow("stopped after response")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await readdir(dir)).toEqual([])
  })

  test("propagates a provider failure once, without saving or trying another backend", async () => {
    const fetchMock = stubFetch(() => new Response("upstream boom", { status: 500 }))
    const harness = await createHarness(dir)

    const act = harness.execute(args)

    await expect(act).rejects.toThrow(`${flavour.backend} images request failed: 500 upstream boom`)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await readdir(dir)).toEqual([])
  })

  test("saves nothing, not even the output directory, when the backend returns data that is not a PNG", async () => {
    stubFetch(() => imagesResponse(Buffer.from("not an image").toString("base64")))
    const harness = await createHarness(dir)

    const act = harness.execute({ ...args, out: "nested/cat.png" })

    await expect(act).rejects.toThrow("not a PNG")
    expect(await readdir(dir)).toEqual([])
  })

  // Buffer.from decodes an array or a serialized Buffer, so the PNG bytes below would pass the PNG check if the
  // response boundary accepted them. An empty image would otherwise write a 0-byte file.
  const malformedResponses: Array<[string, unknown]> = [
    ["no image", { data: [] }],
    ["an empty image", { data: [{ b64_json: "" }] }],
    ["a null body", null],
    ["a numeric array of PNG bytes", { data: [{ b64_json: [...PNG_BUFFER] }] }],
    ["a serialized Buffer of PNG bytes", { data: [{ b64_json: { type: "Buffer", data: [...PNG_BUFFER] } }] }],
  ]
  test.each(malformedResponses)(
    "rejects %s from the backend after one request, saving nothing, not even the output directory",
    async (_name, body) => {
      const fetchMock = stubFetch(() => new Response(JSON.stringify(body)))
      const harness = await createHarness(dir)

      const act = harness.execute({ ...args, out: "nested/cat.png" })

      await expect(act).rejects.toThrow(`no image returned by ${flavour.backend} images endpoint`)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(await readdir(dir)).toEqual([])
    },
  )
})
