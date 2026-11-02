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
  let active: Record<string, unknown> = {}
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init?.method === "POST") {
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
      active.phase = "request"
      await persist()
      if (preflight) throw new Error("Controlled transport failure")
    }
    const response = await realFetch(input, init)
    if (init?.method === "POST") {
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
      active.phase = "response"
      await persist()
    }
    return response
  }) as typeof fetch
  try {
    for (const spec of preflight ? liveCases.slice(0, 1) : liveCases) {
      const { name, tool: toolName, ...controls } = spec
      active = { name, tool: toolName, controls, phase: "permission", status: "running" }
      report.cases.push(active)
      await persist()
      let authorized = false
      const host: ImageToolHost = {
        signal: AbortSignal.timeout(600000),
        authorize: async () => {
          authorized = true
          active.permission = "authorized explicit runner"
        },
        resolveDirectory: async () => directory,
        resolveCredential: async () => {
          if (!authorized) throw new Error("Permission must precede credential resolution")
          const credential = preflight
            ? { type: "key" as const, key: "synthetic-preflight-key" }
            : await loadCredential(nanoGptBackend.credential)
          if (!credential) {
            active.phase = "missing-credential"
            throw new Error("Missing NanoGPT credential")
          }
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
        active.phase = "saved"
        await persist()
        console.log(`${name}: saved ${result.savedPath}`)
      } catch {
        // Runtime/provider errors can include signed URLs or payloads. Retain only our phase and observed HTTP status.
        active.status = "failed"
        await persist()
        console.error(`${name}: failed at ${active.phase}; evidence: ${reportPath}`)
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
    const passed = await runLive(directory, mode === "--preflight")
    process.exitCode = passed ? 0 : 1
  }
}
