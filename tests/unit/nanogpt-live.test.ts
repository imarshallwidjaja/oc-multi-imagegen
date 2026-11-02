import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { imageSize } from "image-size"

test("live runner retains controlled-failure request, report and real fixture files without credentials", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "nano-live-"))
  try {
    const directory = path.join(parent, "preflight")
    const result = Bun.spawnSync(["bun", "run", "scripts/nanogpt-live.ts", "--preflight", directory], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { PATH: process.env.PATH, HOME: parent },
    })
    expect(result.exitCode).toBe(1)
    const text = await readFile(path.join(directory, "report.json"), "utf8")
    const report = JSON.parse(text)
    expect(report.mode).toBe("controlled-failure")
    expect(report.cases[0].status).toBe("failed")
    expect(report.cases[0].phase).toBe("request")
    expect(report.cases[0].request).toMatchObject({
      model: "qwen-image-3-pro",
      n: 1,
      resolution: "1k",
      aspect_ratio: "auto",
      references: [],
    })
    expect(report.cases[0].permission).toContain("authorized")
    expect(report.candidate).toMatch(/^[a-f0-9]{40}$/)
    for (const reference of report.references) {
      expect(imageSize(await readFile(reference.path))).toMatchObject({ width: 512, height: 512 })
      expect(reference.sha256).toMatch(/^[a-f0-9]{64}$/)
    }
    expect(text).not.toContain("synthetic-preflight-key")
    expect(text).not.toContain("base64")
    expect(text).not.toContain("Authorization")
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test("explicit live invocation fails when the selected credential is unavailable", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "nano-missing-"))
  try {
    const directory = path.join(parent, "missing")
    const result = Bun.spawnSync(["bun", "run", "scripts/nanogpt-live.ts", "--live", directory], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { PATH: process.env.PATH, HOME: parent, XDG_DATA_HOME: parent, OPENCODE_AUTH_CONTENT: "{}" },
    })
    expect(result.exitCode).toBe(1)
    const report = JSON.parse(await readFile(path.join(directory, "report.json"), "utf8"))
    expect(report.cases).toHaveLength(1)
    expect(report.cases[0]).toMatchObject({ status: "failed", phase: "missing-credential" })
    expect(report.cases[0].request).toBeUndefined()
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})
