import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { deflateSync } from "node:zlib"
import { fileTypeFromBuffer } from "file-type"
import { imageSize } from "image-size"
import { loadCredential } from "../src/auth"
import { nanoGptBackend } from "../src/nano-gpt"
import type { ImageToolHost } from "../src/types"

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const describeBytes = (bytes: Uint8Array) => ({ bytes: bytes.length, sha256: hash(bytes) })

// Self-contained deterministic PNG fixtures: one subject and one independent pattern reference.
function fixture(pattern: boolean): Buffer {
  const raw = Buffer.alloc(512 * (512 * 3 + 1))
  for (let y = 0; y < 512; y++) {
    for (let x = 0; x < 512; x++) {
      let color = [245, 235, 210]
      if (pattern) color = (Math.floor(x / 48) + Math.floor(y / 48)) % 2 ? [30, 60, 150] : [245, 180, 30]
      else if ((x - 256) ** 2 + (y - 240) ** 2 < 150 ** 2) color = [20, 160, 125]
      if (!pattern && ((x - 205) ** 2 + (y - 200) ** 2 < 19 ** 2 || (x - 307) ** 2 + (y - 200) ** 2 < 19 ** 2))
        color = [255, 255, 255]
      if (!pattern && y > 277 && y < 300 && x > 205 && x < 308) color = [100, 30, 110]
      if (!pattern && y > 350 && y < 430 && x > 130 && x < 380) color = [190, 45, 45]
      const offset = y * 1537 + 1 + x * 3
      for (let channel = 0; channel < 3; channel++) raw[offset + channel] = color[channel]
    }
  }
  const chunk = (name: string, data: Buffer) => {
    const content = Buffer.concat([Buffer.from(name), data])
    let crc = 0xffffffff
    for (const byte of content) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    const size = Buffer.alloc(4)
    size.writeUInt32BE(data.length)
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([size, content, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(512, 0)
  header.writeUInt32BE(512, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

const profiles = [
  {
    model: "qwen-image-3-pro",
    generate: { resolution: "1k", aspect_ratio: "auto" },
    edit: { resolution: "1k" },
  },
  {
    model: "bytedance/seedream-v5.0-pro",
    generate: { resolution: "1k" },
    edit: { resolution: "1k" },
  },
  {
    model: "wan2.7-image-pro",
    generate: { resolution: "4k" },
    edit: { resolution: "2k" },
  },
  {
    model: "meta/muse-image/text-to-image",
    generate: { resolution: "1:1" },
    edit: { resolution: "1:1" },
  },
]
const generationPrompt =
  "A hand-painted storybook illustration of a small copper robot tending a rooftop garden at sunrise. Show a watering can and three sunflowers. No text."
const editPrompt =
  "Storybook illustration. Image 1: subject identity; keep its distinctive colors, face, and clothing. Image 2: pattern reference only; use this pattern on a new umbrella held above the subject. Keep the subject from Image 1, not Image 2. Change the background to a rainy garden. No text."
const liveCases = [
  ...profiles.flatMap(({ model, generate, edit }, index) => [
    {
      name: `${index + 1}-generate`,
      tool: "imagegen",
      model,
      prompt: generationPrompt,
      ...generate,
    },
    {
      name: `${index + 1}-edit`,
      tool: "imageedit",
      model,
      prompt: editPrompt,
      ...edit,
    },
  ]),
  {
    name: "seedream-explicit-edit",
    tool: "imageedit",
    model: "bytedance/seedream-v5.0-pro/edit",
    prompt: editPrompt,
    resolution: "1k",
  },
  {
    name: "wan-auto-generate",
    tool: "imagegen",
    model: "wan2.7-image-pro",
    prompt: generationPrompt,
    resolution: "auto",
  },
]

// The preflight spends nothing and reads no credential. It answers the first generation with a synthetic image, so
// the request, response and output collectors all run, then fails the first edit's transport once its request and
// ordered references are recorded, so the run stops the way a live failure stops it. No request leaves the process.
const preflightCases = liveCases.slice(0, 2)

// The boundaries a case passes, in order. A case records the last one it completed, so a failure is reported as
// "failed after <boundary>" and never names a step the runner did not observe.
type Boundary =
  | "started"
  | "permission-granted"
  | "credential-resolved"
  | "request-recorded"
  | "response-recorded"
  | "output-saved"
// Why a case failed, as far as the runner itself observed: provider and runtime error text can carry signed URLs or
// payloads, so it is never recorded.
type Failure = "missing-credential" | "controlled-transport-failure" | "unexpected-request" | "error"

async function runLive(directory: string, preflight: boolean) {
  // An existing report is never overwritten: each invocation has its own evidence directory.
  await mkdir(directory, { recursive: false })
  const reportPath = path.join(directory, "report.json")
  const refs = [path.join(directory, "subject.png"), path.join(directory, "pattern.png")]
  await writeFile(refs[0], fixture(false))
  await writeFile(refs[1], fixture(true))
  const candidate = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: import.meta.dir })
    .stdout.toString()
    .trim()
  const dirty = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: import.meta.dir })
    .stdout.toString()
    .trim()
  const report = {
    mode: preflight ? "controlled-failure" : "live",
    candidate,
    dirty,
    started: new Date().toISOString(),
    references: await Promise.all(
      refs.map(async (file) => ({
        path: file,
        mime: "image/png",
        width: 512,
        height: 512,
        ...describeBytes(await readFile(file)),
      })),
    ),
    cases: [] as Record<string, unknown>[],
  }
  const persist = () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  await persist()
  const realFetch = globalThis.fetch
  let active: Record<string, unknown> & { lastCompleted?: Boundary; failure?: Failure } = {}
  const reached = async (boundary: Boundary) => {
    active.lastCompleted = boundary
    await persist()
  }
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init?.method !== "POST") {
      // A download of a URL the provider returned. The preflight's synthetic answer never names one.
      if (!preflight) return realFetch(input, init)
      active.failure = "unexpected-request"
      throw new Error("The preflight sends no request beyond the image request")
    }
    const request = JSON.parse(String(init.body))
    active.request = {
      model: request.model,
      prompt: request.prompt,
      n: request.n,
      resolution: request.resolution,
      aspect_ratio: request.aspect_ratio,
      references: (request.input_references ?? []).map((value: string) => {
        const [prefix, data] = value.split(",")
        return { mime: prefix.slice(5).split(";")[0], ...describeBytes(Buffer.from(data, "base64")) }
      }),
    }
    await reached("request-recorded")
    let response: Response
    if (!preflight) response = await realFetch(input, init)
    else if (active.tool === "imageedit") {
      active.failure = "controlled-transport-failure"
      throw new Error("Controlled transport failure")
    } else response = Response.json({ data: [{ b64_json: fixture(false).toString("base64") }] })
    active.httpStatus = response.status
    const body: unknown = await response
      .clone()
      .json()
      .catch(() => undefined)
    if (body && typeof body === "object" && "data" in body && Array.isArray(body.data)) {
      active.response = {
        count: body.data.length,
        images: body.data.map((entry) => ({
          inline:
            typeof entry?.b64_json === "string" ? describeBytes(Buffer.from(entry.b64_json, "base64")) : undefined,
          url: typeof entry?.url === "string",
        })),
      }
    }
    await reached("response-recorded")
    return response
  }) as typeof fetch
  try {
    for (const spec of preflight ? preflightCases : liveCases) {
      const { name, tool: toolName, ...controls } = spec
      active = { name, tool: toolName, controls, status: "running" }
      report.cases.push(active)
      await reached("started")
      let authorized = false
      const host: ImageToolHost = {
        signal: AbortSignal.timeout(600000),
        authorize: async () => {
          authorized = true
          active.permission = "authorized explicit runner"
          await reached("permission-granted")
        },
        resolveDirectory: async () => directory,
        resolveCredential: async () => {
          if (!authorized) throw new Error("Permission must precede credential resolution")
          const credential = preflight
            ? { type: "key" as const, key: "synthetic-preflight-key" }
            : await loadCredential(nanoGptBackend.credential)
          if (!credential) {
            active.failure = "missing-credential"
            throw new Error("Missing NanoGPT credential")
          }
          await reached("credential-resolved")
          return credential
        },
      }
      const tool = nanoGptBackend.tools.find((tool) => tool.name === toolName)
      if (tool?.kind !== "image") throw new Error("Missing image tool")
      try {
        const result = await tool.run(
          {
            ...controls,
            out: path.join(directory, `${name}.png`),
            ...(toolName === "imageedit" ? { images: refs } : {}),
          },
          host,
        )
        const bytes = await readFile(result.savedPath)
        const format = await fileTypeFromBuffer(bytes)
        const dimensions = imageSize(bytes)
        active.output = {
          path: result.savedPath,
          mime: format?.mime,
          width: dimensions.width,
          height: dimensions.height,
          ...describeBytes(bytes),
        }
        active.status = "saved; visual review required"
        await reached("output-saved")
        console.log(`${name}: saved ${result.savedPath}`)
      } catch {
        active.status = "failed"
        active.failure ??= "error"
        await persist()
        console.error(`${name}: failed after ${active.lastCompleted} (${active.failure}); evidence: ${reportPath}`)
        return false
      }
    }
    return true
  } finally {
    globalThis.fetch = realFetch
    await persist()
  }
}

if (import.meta.main) {
  const [mode, directory] = process.argv.slice(2)
  if (!["--live", "--preflight"].includes(mode) || !directory || !path.isAbsolute(directory)) {
    console.error("Usage: bun run scripts/nanogpt-live.ts --live|--preflight /absolute/new-evidence-directory")
    process.exitCode = 2
  } else {
    // The preflight's designed stop is a failure, so it exits 1 like any stopped run; its last line names the case,
    // the boundary it completed and the failure, and report.json holds the same.
    const passed = await runLive(directory, mode === "--preflight")
    process.exitCode = passed ? 0 : 1
  }
}
