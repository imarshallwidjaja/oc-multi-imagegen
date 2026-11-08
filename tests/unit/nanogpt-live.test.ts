import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { imageSize } from "image-size"

const REPO_DIR = path.resolve(import.meta.dir, "../..")
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

// The runner as an operator starts it, with a throwaway HOME and data directory and nothing else of the caller's
// environment, so no saved or environment credential can be found.
function runner(mode: string, directory: string, home: string, extra: Record<string, string> = {}) {
  return Bun.spawnSync(["bun", "run", "scripts/nanogpt-live.ts", mode, directory], {
    cwd: REPO_DIR,
    env: { PATH: process.env.PATH, HOME: home, XDG_DATA_HOME: home, ...extra },
  })
}

test("the preflight runs every collector, stops at the controlled edit failure and keeps its evidence", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "nano-live-"))
  try {
    const directory = path.join(parent, "preflight")
    const result = runner("--preflight", directory, parent)

    // The process has exited, so the restored fetch and the final write are behind it: what remains is the evidence.
    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toBe(`1-generate: saved ${path.join(directory, "1-generate.png")}\n`)
    expect(result.stderr.toString()).toContain(
      `1-edit: failed after request-recorded (controlled-transport-failure); evidence: ${path.join(directory, "report.json")}`,
    )
    expect((await readdir(directory)).sort()).toEqual(["1-generate.png", "pattern.png", "report.json", "subject.png"])
    const text = await readFile(path.join(directory, "report.json"), "utf8")
    const report = JSON.parse(text)
    expect(report.mode).toBe("controlled-failure")
    expect(report.candidate).toMatch(/^[a-f0-9]{40}$/)

    // The fixtures on disk are the ones the report describes, in the order the edit sends them.
    const references = await Promise.all(
      [path.join(directory, "subject.png"), path.join(directory, "pattern.png")].map(async (file) => {
        const bytes = await readFile(file)
        expect(imageSize(bytes)).toMatchObject({ width: 512, height: 512 })
        return { mime: "image/png", bytes: bytes.length, sha256: sha256(bytes) }
      }),
    )
    expect(references[0].sha256).not.toBe(references[1].sha256)
    expect(
      report.references.map(({ mime, bytes, sha256 }: Record<string, unknown>) => ({ mime, bytes, sha256 })),
    ).toEqual(references)

    // Only the two preflight cases ran, and each records the last boundary it completed.
    expect(report.cases.map((entry: { name: string }) => entry.name)).toEqual(["1-generate", "1-edit"])
    const [generate, edit] = report.cases
    expect(generate).toMatchObject({
      tool: "imagegen",
      status: "saved; visual review required",
      lastCompleted: "output-saved",
      permission: "authorized explicit runner",
      httpStatus: 200,
      request: { model: "qwen-image-3-pro", n: 1, resolution: "1k", aspect_ratio: "auto", references: [] },
      // The synthetic answer is the subject fixture, so the response and output hashes are its hash.
      response: { count: 1, images: [{ inline: { sha256: references[0].sha256 }, url: false }] },
      output: { mime: "image/png", width: 512, height: 512, sha256: references[0].sha256 },
    })
    expect(generate.failure).toBeUndefined()
    expect(edit).toMatchObject({
      tool: "imageedit",
      status: "failed",
      lastCompleted: "request-recorded",
      failure: "controlled-transport-failure",
      request: { model: "qwen-image-3-pro", n: 1, resolution: "1k", references },
    })
    expect(edit.response).toBeUndefined()
    expect(edit.output).toBeUndefined()

    // Hashes and sizes only: no key, header, data URL or base64 payload is serialized.
    const subject = (await readFile(path.join(directory, "subject.png"))).toString("base64")
    expect(text).not.toContain("synthetic-preflight-key")
    expect(text).not.toContain("Authorization")
    expect(text).not.toContain("base64")
    expect(text).not.toContain(subject.slice(0, 64))
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test("explicit live invocation fails when the selected credential is unavailable", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "nano-missing-"))
  try {
    const directory = path.join(parent, "missing")
    const result = runner("--live", directory, parent, { OPENCODE_AUTH_CONTENT: "{}" })
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain("1-generate: failed after permission-granted (missing-credential)")
    const report = JSON.parse(await readFile(path.join(directory, "report.json"), "utf8"))
    expect(report.cases).toHaveLength(1)
    expect(report.cases[0]).toMatchObject({
      status: "failed",
      lastCompleted: "permission-granted",
      failure: "missing-credential",
    })
    expect(report.cases[0].request).toBeUndefined()
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})
