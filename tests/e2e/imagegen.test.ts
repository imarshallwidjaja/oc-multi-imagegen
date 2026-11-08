import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { installPackage } from "../../scripts/stage-package"
import { findReferenceEdit, readToolCalls } from "./tool-events"

// A live journey that spends account quota. `bun run test:e2e` sets OC_E2E_LIVE=1; without it, as when a bare
// `bun test` discovers this file, nothing below is registered beyond one skipped entry: no staging, build,
// temporary directory or OpenCode run.
const LIVE = process.env.OC_E2E_LIVE === "1"

const RUN_TIMEOUT_MS = 600_000
// A run that ignores SIGTERM after the timeout gets this long before SIGKILL.
const KILL_GRACE_MS = 10_000
const TEST_TIMEOUT_MS = RUN_TIMEOUT_MS + KILL_GRACE_MS + 10_000
const STYLE = "hand-drawn 90s Japanese animation style"

// Set by beforeAll: one temporary root that holds the work directory, the OpenCode config, the event evidence and
// the staged package. It is kept after the run for review.
let WORKDIR = ""
let XDG_CONFIG_HOME = ""
let EVIDENCE_DIR = ""

// The OpenCode run in progress, so afterAll can stop one that outlived its test.
let running: ChildProcess | undefined

async function writeOpencodeConfig(packageDir: string): Promise<void> {
  const cfgDir = path.join(XDG_CONFIG_HOME, "opencode")
  mkdirSync(cfgDir, { recursive: true })
  const config = {
    $schema: "https://opencode.ai/config.json",
    plugin: [pathToFileURL(packageDir).href],
    permission: { "*": "deny", imagegen: "allow", imageedit: "allow" },
    autoupdate: false,
  }
  await writeFile(path.join(cfgDir, "opencode.jsonc"), JSON.stringify(config, null, 2))
}

// The caller's environment passes through, including PATH and the host's own sign-in (HOME, XDG_DATA_HOME,
// OPENCODE_AUTH_CONTENT), except variables named OPENCODE or OPENCODE_* (OPENCODE_AUTH_CONTENT is kept),
// OC_MULTI_IMAGEGEN_* and OC_E2E_*. XDG_CONFIG_HOME is replaced, so the run reads only the config written above, and
// the backend is set to codex, so the sizes below are the Codex presets whatever the caller's environment selects.
function opencodeEnvironment(): NodeJS.ProcessEnv {
  const kept = Object.entries(process.env).filter(
    ([name]) => name === "OPENCODE_AUTH_CONTENT" || !/^(OPENCODE(_|$)|OC_MULTI_IMAGEGEN_|OC_E2E_)/.test(name),
  )
  return { ...Object.fromEntries(kept), XDG_CONFIG_HOME, OC_MULTI_IMAGEGEN_BACKEND: "codex" }
}

// Runs one prompt and returns its JSON event output, which is also kept at EVIDENCE_DIR/<name>.jsonl. A run that
// passes RUN_TIMEOUT_MS gets SIGTERM, then SIGKILL after KILL_GRACE_MS; only that is reported as a timeout.
async function runOpencode(name: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["run", prompt, "--format", "json", "--dir", WORKDIR]
    if (process.env.OPENCODE_MODEL) args.push("--model", process.env.OPENCODE_MODEL)
    const chunks: Buffer[] = []
    const proc = spawn("opencode", args, { stdio: ["ignore", "pipe", "inherit"], env: opencodeEnvironment() })
    running = proc
    let timedOut = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill("SIGTERM")
      killTimer = setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS)
    }, RUN_TIMEOUT_MS)
    const settle = () => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      running = undefined
    }
    proc.on("error", (err) => {
      settle()
      reject(err)
    })
    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
    proc.on("close", (code, signal) => {
      settle()
      const output = Buffer.concat(chunks).toString("utf8")
      const evidence = path.join(EVIDENCE_DIR, `${name}.jsonl`)
      try {
        writeFileSync(evidence, output)
      } catch (err) {
        reject(err)
        return
      }
      console.log(`${name} events: ${evidence}`)
      if (timedOut) {
        reject(new Error(`opencode run timed out after ${RUN_TIMEOUT_MS}ms and was stopped with ${signal ?? "exit"}`))
        return
      }
      if (code !== 0) {
        reject(new Error(`opencode run failed (exit=${code} signal=${signal ?? "null"})`))
        return
      }
      resolve(output)
    })
  })
}

async function assertPng(filePath: string): Promise<Buffer> {
  expect(existsSync(filePath)).toBe(true)
  const buf = await readFile(filePath)
  expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
  return buf
}

function readPngDimensions(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

// The color type sits in the IHDR chunk right after the bit depth. 6 means RGBA.
function readPngColorType(buf: Buffer): number {
  return buf[25]
}

// The stages that passed every check. A stage that builds on others checks them first and fails without an OpenCode
// call when one did not pass, so a broken prerequisite never spends quota on the stages after it.
const passed = new Set<string>()
function stage(id: string, title: string, prerequisites: string[], body: () => Promise<void>) {
  test(
    `${id}. ${title}`,
    async () => {
      const missing = prerequisites.filter((prerequisite) => !passed.has(prerequisite))
      if (missing.length > 0) {
        throw new Error(`Stage ${id} not run: it builds on stage ${missing.join(" and ")}, which did not pass`)
      }
      await body()
      passed.add(id)
    },
    TEST_TIMEOUT_MS,
  )
}

if (!LIVE) {
  test.skip("image tools journey (live: run the whole file with `bun run test:e2e`)", () => {})
} else {
  // One journey: A saves character.png, B asks for the same path and must get the versioned character-v2.png, and
  // C composes both with an edit. D stands alone. Run the whole file: B and C need the earlier outputs.
  describe("image tools journey", () => {
    beforeAll(async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "oc-imagegen-e2e-"))
      WORKDIR = path.join(root, "work")
      XDG_CONFIG_HOME = path.join(root, "config")
      EVIDENCE_DIR = path.join(root, "events")
      for (const directory of [WORKDIR, XDG_CONFIG_HOME, EVIDENCE_DIR]) mkdirSync(directory)
      console.log(`WORKDIR: ${WORKDIR}`)
      console.log(`XDG_CONFIG_HOME: ${XDG_CONFIG_HOME}`)
      console.log(`EVIDENCE_DIR: ${EVIDENCE_DIR}`)
      // Builds and packs a staged copy of the checkout (the checkout's own dist/ is not rebuilt) and installs the
      // tarball with its runtime dependencies, as a consumer would.
      const staging = path.join(root, "staging")
      mkdirSync(staging)
      const packageDir = path.join(root, "plugin")
      await installPackage(staging, packageDir)
      await writeOpencodeConfig(packageDir)
    }, 120_000)

    afterAll(() => {
      running?.kill("SIGKILL")
    })

    stage("A", "man portrait 1024x1536", [], async () => {
      await runOpencode(
        "A",
        `Use the imagegen tool to generate an image at character.png. ` +
          `Content: a man wearing a navy-blue samue and a red hachimaki headband, standing in a garden of cherry blossoms in full bloom. ` +
          `Style: ${STYLE}. Size: 1024x1536 (portrait).`,
      )
      const out = path.join(WORKDIR, "character.png")
      const buf = await assertPng(out)
      const { width, height } = readPngDimensions(buf)
      expect(width).toBe(1024)
      expect(height).toBe(1536)
      // Without a background request, the plugin sends opaque and the backend returns RGB (color type 2).
      expect(readPngColorType(buf)).toBe(2)
      console.log(`A: ${out}`)
    })

    stage("B", "woman landscape 1536x1024 (auto-versioned)", ["A"], async () => {
      await runOpencode(
        "B",
        `Use the imagegen tool to generate an image at character.png. ` +
          `Content: a woman wearing a yellow yukata and holding a red wagasa parasol, standing in a garden at night with fireflies dancing around her. ` +
          `Style: ${STYLE}. Size: 1536x1024 (landscape).`,
      )
      const out = path.join(WORKDIR, "character-v2.png")
      const buf = await assertPng(out)
      const { width, height } = readPngDimensions(buf)
      expect(width).toBe(1536)
      expect(height).toBe(1024)
      console.log(`B: ${out}`)
    })

    stage("C", "compose two characters from A and B references", ["A", "B"], async () => {
      const output = await runOpencode(
        "C",
        // A plain-language edit request: the agent chooses the edit tool for the two reference images itself.
        `Combine ./character.png and ./character-v2.png into one new image saved at together.png. ` +
          `Content: the man from Image 1 (navy samue + red hachimaki) and the woman from Image 2 (yellow yukata + red wagasa) standing side by side ` +
          `on the engawa veranda of an old Japanese house, smiling at the viewer. ` +
          `Preserve each character's outfit, hairstyle, and props exactly. ` +
          `Style: ${STYLE}. Size: 1672x941.`,
      )
      // Require an edit that passed both references and saved together.png, so a separate imagegen call cannot supply it.
      const { out } = findReferenceEdit(
        readToolCalls(output),
        ["character.png", "character-v2.png"],
        "together.png",
        WORKDIR,
      )
      const buf = await assertPng(out)
      const { width, height } = readPngDimensions(buf)
      // The backend sometimes returns this size with an edge 1px off (e.g. 1672x940).
      expect(Math.abs(width - 1672)).toBeLessThanOrEqual(1)
      expect(Math.abs(height - 941)).toBeLessThanOrEqual(1)
      console.log(`C: ${out}`)
    })

    stage("D", "sticker with a transparent background", [], async () => {
      await runOpencode(
        "D",
        `Use the imagegen tool to generate an image at sticker.png. ` +
          `Content: a sticker of a red paper lantern with a transparent background. ` +
          `Style: ${STYLE}. Size: 1254x1254.`,
      )
      const out = path.join(WORKDIR, "sticker.png")
      const buf = await assertPng(out)
      expect(readPngColorType(buf)).toBe(6)
      console.log(`D: ${out}`)
    })
  })
}
