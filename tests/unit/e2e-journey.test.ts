import { afterEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"

// The tools the journey runs from PATH: Bun for `bun run` and the build, npm and Node for `npm pack`, Git to list the
// checkout, tar and gzip to extract the tarball, and sh and rm for the package scripts.
const JOURNEY_TOOLS = ["bun", "node", "npm", "git", "tar", "gzip", "sh", "rm"]

// The live journey in tests/e2e/imagegen.test.ts, run as a subprocess whose PATH is one directory: a fake `opencode`
// that records each call and the sign-in it was given and fails it, and links to JOURNEY_TOOLS found on `searchPath`.
// A real `opencode`, even one beside those tools, is not reachable, so nothing here can reach a model or spend quota.
// Bun loads a `.env` from the working directory of each Bun process, so the journey starts in a private project
// instead of the checkout: the checkout's `tests/` linked in, the checkout's own `test:e2e` script, and a `.env` that
// holds only a synthetic sign-in, which reaches OpenCode if the Bun process running the journey read it.
describe("live e2e journey", () => {
  const repoRoot = path.resolve(import.meta.dir, "../..")
  const temporaryDirectories: string[] = []
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  async function journey(command: string[], searchPath = process.env.PATH ?? "") {
    const root = mkdtempSync(path.join(os.tmpdir(), "oc-e2e-gate-"))
    temporaryDirectories.push(root)
    const bin = path.join(root, "bin")
    const tmp = path.join(root, "tmp")
    const project = path.join(root, "project")
    mkdirSync(bin)
    mkdirSync(tmp)
    mkdirSync(project)
    symlinkSync(path.join(repoRoot, "tests"), path.join(project, "tests"))
    const { scripts } = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf-8"))
    writeFileSync(path.join(project, "package.json"), JSON.stringify({ scripts: { "test:e2e": scripts["test:e2e"] } }))
    writeFileSync(path.join(project, ".env"), "OPENCODE_AUTH_CONTENT=synthetic-dotenv-sign-in\n")
    const calls = path.join(root, "opencode-calls")
    const signIns = path.join(root, "opencode-sign-ins")
    writeFileSync(
      path.join(bin, "opencode"),
      `#!/bin/sh\nprintf '%s\\n' "$2" >>"${calls}"\nprintf '%s\\n' "\${OPENCODE_AUTH_CONTENT-unset}" >>"${signIns}"\nexit 1\n`,
      { mode: 0o755 },
    )
    for (const tool of JOURNEY_TOOLS) {
      const found = Bun.which(tool, { PATH: searchPath })
      if (!found) throw new Error(`${tool} is not on PATH`)
      symlinkSync(found, path.join(bin, tool))
    }
    const proc = Bun.spawn(command, {
      cwd: project,
      env: { PATH: bin, HOME: root, TMPDIR: tmp },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return {
      code,
      output: stdout + stderr,
      prompts: existsSync(calls) ? readFileSync(calls, "utf-8").split("\n").filter(Boolean) : [],
      signIns: existsSync(signIns) ? readFileSync(signIns, "utf-8").split("\n").filter(Boolean) : [],
      temporaryEntries: readdirSync(tmp),
    }
  }

  const checkoutBuild = () => statSync(path.join(repoRoot, "dist"), { throwIfNoEntry: false })?.mtimeMs ?? "absent"

  test("bare discovery skips the journey before any setup, build or OpenCode call", async () => {
    const buildBefore = checkoutBuild()

    const result = await journey([process.execPath, "test", "tests/e2e"])

    expect(result.code).toBe(0)
    expect(result.output).toContain("1 skip")
    expect(result.prompts).toEqual([])
    expect(result.temporaryEntries).toEqual([])
    expect(checkoutBuild()).toBe(buildBefore)
  }, 30_000)

  test("bun run test:e2e opts in, and a failed stage A stops B and C before they call OpenCode while D still runs", async () => {
    const buildBefore = checkoutBuild()
    // The tools are found in one directory with another `opencode`, which records any call it gets.
    const shared = mkdtempSync(path.join(os.tmpdir(), "oc-e2e-shared-bin-"))
    temporaryDirectories.push(shared)
    const sharedCalls = path.join(shared, "calls")
    writeFileSync(path.join(shared, "opencode"), `#!/bin/sh\necho "$@" >>"${sharedCalls}"\nexit 1\n`, { mode: 0o755 })
    for (const tool of JOURNEY_TOOLS) symlinkSync(Bun.which(tool) ?? tool, path.join(shared, tool))

    const result = await journey([process.execPath, "run", "test:e2e"], shared)

    expect(existsSync(sharedCalls)).toBe(false)
    expect(result.code).not.toBe(0)
    expect(result.prompts).toHaveLength(2)
    expect(result.signIns).toEqual(["unset", "unset"])
    expect(result.prompts[0]).toContain("generate an image at character.png")
    expect(result.prompts[1]).toContain("generate an image at sticker.png")
    expect(result.output).toContain("Stage B not run: it builds on stage A, which did not pass")
    expect(result.output).toContain("Stage C not run: it builds on stage A and B, which did not pass")
    // The plugin was staged, built and installed under the run's own temporary root, not in the checkout.
    expect(result.temporaryEntries).toEqual([expect.stringMatching(/^oc-imagegen-e2e-/)])
    expect(checkoutBuild()).toBe(buildBefore)
  }, 60_000)
})
