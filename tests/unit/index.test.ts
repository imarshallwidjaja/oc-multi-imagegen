import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import plugin from "../../src/index"
import { SKILL_NAME } from "../../src/skill"
import { isolateEnvironment } from "./fixtures"

isolateEnvironment()

const REPO_DIR = path.resolve(import.meta.dir, "../..")

describe("package entry points", () => {
  test("the default export serves OpenCode 1 and OpenCode 2", () => {
    expect(plugin.id).toBe("oc-multi-imagegen")
    expect(typeof plugin.server).toBe("function")
    expect(typeof plugin.setup).toBe("function")
  })

  test("source modules import neither host SDK at runtime", () => {
    const transpiler = new Bun.Transpiler({ loader: "ts" })
    const glob = new Bun.Glob("src/*.ts")
    for (const file of glob.scanSync({ cwd: REPO_DIR })) {
      // scanImports omits type-only imports, which TypeScript erases from the build.
      const runtimeImports = transpiler.scanImports(readFileSync(path.join(REPO_DIR, file), "utf-8")).map((i) => i.path)
      expect(runtimeImports.filter((specifier) => specifier.startsWith("@opencode"))).toEqual([])
    }
  })

  test("the root entry and ./server both resolve to the build, and ./server ships in the package", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_DIR, "package.json"), "utf-8"))

    expect(pkg.main).toBe("./dist/index.js")
    expect(pkg.exports["."].import).toBe("./dist/index.js")
    expect(pkg.exports["./server"].import).toBe("./server.js")
    expect(pkg.files).toContain("server.js")
    expect(readFileSync(path.join(REPO_DIR, "server.js"), "utf-8")).toBe('export { default } from "./dist/index.js"\n')
  })
})

describe("published package", () => {
  // Packs the real skill asset, then bundles the entry point into the extracted copy: it shows that the skill ships
  // in the tarball and that the module resolves it relative to itself. It does not test the exact published
  // dist/index.js or its dependencies; the container runbook loads that build from a packed copy that has only the
  // runtime dependencies installed.
  test("an extracted package finds its skill and linked documentation from a relocated entry point", async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), "package-"))
    try {
      const run = async (cmd: string[], cwd: string) => {
        const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}): ${stderr}`)
        return stdout
      }
      // The tarball is what a consumer gets. npm runs no lifecycle script here, so a missing dist/ is not rebuilt.
      const [{ filename }] = JSON.parse(await run(["npm", "pack", "--json", "--pack-destination", work], REPO_DIR))
      await run(["tar", "-xzf", path.join(work, filename), "-C", work], work)
      const packageDir = path.join(work, "package")
      expect(existsSync(path.join(packageDir, "skills", SKILL_NAME, "SKILL.md"))).toBe(true)

      // Follow the published README's local links, including images and topical guides, in the extracted package.
      const pending = [path.join(packageDir, "README.md")]
      const visited = new Set<string>()
      while (pending.length > 0) {
        const file = pending.pop()
        if (!file || visited.has(file)) continue
        visited.add(file)
        const content = readFileSync(file, "utf-8")
        for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)|<img\b[^>]*\bsrc="([^"]+)"/g)) {
          const href = match[1] ?? match[2]
          if (!href || /^[a-z]+:/i.test(href)) continue
          const [relative, anchor] = href.split("#")
          const target = relative ? path.resolve(path.dirname(file), relative) : file
          expect(existsSync(target), `${path.relative(packageDir, file)} links to ${href}`).toBe(true)
          if (!target.endsWith(".md")) continue
          pending.push(target)
          if (anchor) {
            const headings = [...readFileSync(target, "utf-8").matchAll(/^#{1,6} (.+)$/gm)].map((heading) =>
              heading[1]
                .toLowerCase()
                .replace(/[^\w -]/g, "")
                .replace(/ /g, "-"),
            )
            expect(headings, `${path.relative(packageDir, file)} links to ${href}`).toContain(anchor)
          }
        }
      }

      // Build the entry point into the extracted package so the test does not depend on an earlier `bun run build`.
      const built = await Bun.build({
        entrypoints: [path.join(REPO_DIR, "src/index.ts")],
        outdir: path.join(packageDir, "dist"),
        target: "node",
        format: "esm",
        packages: "external",
      })
      expect(built.success).toBe(true)
      await symlink(path.join(REPO_DIR, "node_modules"), path.join(packageDir, "node_modules"))

      const extracted = (await import(pathToFileURL(path.join(packageDir, "dist/index.js")).href)).default
      const config: { skills?: { paths?: string[] } } = {}
      const hooks = await extracted.server({})
      await hooks.config(config)

      expect(config.skills?.paths).toEqual([path.join(packageDir, "skills")])
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }, 60_000)
})
