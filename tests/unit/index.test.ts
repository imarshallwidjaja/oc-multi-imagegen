import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { installPackage, stagePackage } from "../../scripts/stage-package"
import { SKILL_NAME } from "../../src/skill"
import { isolateEnvironment } from "./fixtures"

isolateEnvironment()

const REPO_DIR = path.resolve(import.meta.dir, "../..")

describe("package entry points", () => {
  test("source modules import neither host SDK at runtime", () => {
    const transpiler = new Bun.Transpiler({ loader: "ts" })
    const glob = new Bun.Glob("src/*.ts")
    for (const file of glob.scanSync({ cwd: REPO_DIR })) {
      // scanImports omits type-only imports, which TypeScript erases from the build.
      const runtimeImports = transpiler.scanImports(readFileSync(path.join(REPO_DIR, file), "utf-8")).map((i) => i.path)
      expect(runtimeImports.filter((specifier) => specifier.startsWith("@opencode"))).toEqual([])
    }
  })
})

const sha256 = (file: string) => new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex")

// What a consumer loads, run in a separate Node process from a project that has only the package and its runtime
// dependencies installed: the package name, ./server and the `main` file must be one module, both host entry points
// must be there, and OpenCode 1's config hook must point at the installed skills directory. `sdks` lists the file each
// OpenCode SDK resolves to for an import from the installed package's main module, where the package's imports
// resolve: a copy in the package's node_modules or in any directory above it counts. SDK_PROBE runs
// import.meta.resolve from a module beside the main file, since import.meta.resolve resolves from its own module.
const SDK_PROBE = `
export const sdks = ["@opencode-ai/plugin", "@opencode/plugin"].flatMap((name) => {
  try {
    return [import.meta.resolve(name)]
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND") return []
    throw error
  }
})
`
const CONSUMER = `
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
const root = (await import("oc-multi-imagegen")).default
const server = (await import("oc-multi-imagegen/server")).default
const packageDir = path.resolve("node_modules/oc-multi-imagegen")
const manifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf-8"))
const mainPath = path.join(packageDir, manifest.main)
const main = (await import(pathToFileURL(mainPath).href)).default
const hooks = await root.server({})
const config = { skills: { paths: ["/existing"] } }
await hooks.config(config)
const probe = path.join(path.dirname(mainPath), "sdk-probe.mjs")
await writeFile(probe, ${JSON.stringify(SDK_PROBE)})
const { sdks } = await import(pathToFileURL(probe).href)
console.log(JSON.stringify({
  packageDir,
  id: root.id,
  sameModule: root === server && root === main,
  hosts: [typeof root.server, typeof root.setup],
  tools: Object.keys(hooks.tool),
  skillPaths: config.skills.paths,
  sdks: sdks.map((url) => path.relative(packageDir, fileURLToPath(url))),
}))
`

describe("published package", () => {
  // Builds and packs a staged copy of the checkout with the package's own build script (scripts/stage-package.ts),
  // so the checkout's dist/ is neither needed nor touched, and installs the tarball into a consumer project.
  test("an installed tarball loads through every entry point with only its runtime dependencies", async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), "package-"))
    const checkoutBuild = () => statSync(path.join(REPO_DIR, "dist"), { throwIfNoEntry: false })?.mtimeMs ?? "absent"
    const buildBefore = checkoutBuild()
    try {
      const staging = path.join(work, "staging")
      mkdirSync(staging)
      const consumer = path.join(work, "consumer")
      mkdirSync(path.join(consumer, "node_modules"), { recursive: true })
      const packageDir = path.join(consumer, "node_modules", "oc-multi-imagegen")
      const { build } = await installPackage(staging, packageDir)
      expect(existsSync(path.join(packageDir, "skills", SKILL_NAME, "SKILL.md"))).toBe(true)
      // The installed entry points are the staged bytes: the build both host entry points load, and ./server.
      expect(sha256(path.join(packageDir, "dist", "index.js"))).toBe(sha256(build))
      expect(sha256(path.join(packageDir, "server.js"))).toBe(sha256(path.join(staging, "source", "server.js")))

      const load = () => {
        const loaded = Bun.spawnSync(["node", "--input-type=module", "-e", CONSUMER], {
          cwd: consumer,
          env: { PATH: process.env.PATH, HOME: work },
        })
        expect(loaded.stderr.toString()).toBe("")
        expect(loaded.exitCode).toBe(0)
        return JSON.parse(loaded.stdout.toString())
      }
      expect(load()).toEqual({
        packageDir,
        id: "oc-multi-imagegen",
        sameModule: true,
        hosts: ["function", "function"],
        tools: ["imagegen", "imageedit"],
        skillPaths: ["/existing", path.join(packageDir, "skills")],
        sdks: [],
      })

      // Follow the published README's local links, including images and topical guides, in the installed package.
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

      // An SDK nested in the installed package, here one whose exports serve only imports, would resolve for the
      // package's imports, and the check reports it.
      const nested = path.join(packageDir, "node_modules", "@opencode", "plugin")
      mkdirSync(nested, { recursive: true })
      writeFileSync(
        path.join(nested, "package.json"),
        '{"name":"@opencode/plugin","exports":{".":{"import":"./x.js"}}}',
      )
      writeFileSync(path.join(nested, "x.js"), "export default {}\n")
      expect(load().sdks).toEqual([path.join("node_modules", "@opencode", "plugin", "x.js")])
      expect(checkoutBuild()).toBe(buildBefore)
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }, 60_000)
})

// scripts/stage-package.ts run on a synthetic checkout in a temporary directory. Its ignored .env and its root
// openai.env hold sentinels that are neither build nor package inputs and must never reach the staging directory.
describe("package staging", () => {
  async function checkout() {
    const root = await mkdtemp(path.join(os.tmpdir(), "stage-checkout-"))
    const repo = path.join(root, "repo")
    for (const directory of ["src", "docs", "scripts"]) mkdirSync(path.join(repo, directory), { recursive: true })
    const files: Record<string, string> = {
      "package.json": JSON.stringify({
        name: "staged-fixture",
        version: "0.0.0",
        type: "module",
        files: ["dist", "docs", "README.md", "!docs/internal.md"],
        scripts: { build: "bun build ./src/index.ts --outdir ./dist --target node --format esm --packages external" },
      }),
      "src/index.ts": "export default 1\n",
      "README.md": "# Fixture\n",
      "docs/guide.md": "guide\n",
      "docs/internal.md": "internal\n",
      "scripts/tool.ts": "export {}\n",
      ".gitignore": ".env\n",
      ".env": "SENTINEL=ignored-env\n",
      "openai.env": "SENTINEL=root-env\n",
    }
    for (const [file, content] of Object.entries(files)) writeFileSync(path.join(repo, file), content)
    const init = Bun.spawnSync(["git", "init", "-q", repo], { env: { PATH: process.env.PATH, HOME: root } })
    expect(init.exitCode).toBe(0)
    const destination = path.join(root, "staging")
    mkdirSync(destination)
    const staged = () => {
      const listing = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory()
            ? listing(path.join(dir, entry.name)).map((file) => path.join(entry.name, file))
            : [entry.name],
        )
      return existsSync(path.join(destination, "source")) ? listing(path.join(destination, "source")).sort() : []
    }
    const sentinels = () => {
      const tarballs = readdirSync(destination).filter((name) => name.endsWith(".tgz"))
      const unpacked = tarballs.map(
        (name) =>
          Bun.spawnSync(["tar", "-xzOf", path.join(destination, name)], { env: { PATH: process.env.PATH, HOME: root } })
            .stdout,
      )
      const sources = staged().map((file) => readFileSync(path.join(destination, "source", file)))
      return [...sources, ...unpacked].filter((content) => content.toString().includes("SENTINEL")).length
    }
    return { root, repo, destination, staged, sentinels }
  }

  test("copies only the build and package inputs Git sees, then builds and packs them", async () => {
    const c = await checkout()
    try {
      await stagePackage(c.destination, c.repo)

      expect(c.staged()).toEqual([
        "README.md",
        path.join("dist", "index.js"),
        path.join("docs", "guide.md"),
        path.join("docs", "internal.md"),
        "package.json",
        path.join("src", "index.ts"),
      ])
      expect(c.sentinels()).toBe(0)
      // npm applies the negated files entry: the staged docs/internal.md stays out of the tarball.
      const [tarball] = readdirSync(c.destination).filter((name) => name.endsWith(".tgz"))
      const packed = Bun.spawnSync(["tar", "-tzf", path.join(c.destination, tarball)], {
        env: { PATH: process.env.PATH, HOME: c.root },
      })
      expect(packed.stdout.toString().trim().split("\n").sort()).toEqual([
        "package/README.md",
        "package/dist/index.js",
        "package/docs/guide.md",
        "package/package.json",
      ])
    } finally {
      await rm(c.root, { recursive: true, force: true })
    }
  })

  // docs/guide.md is in Git's index, and docs is replaced by a link that /docs in .gitignore hides, pointing at a
  // directory outside the checkout or at nothing. Git still lists docs/guide.md; the linked parent stops the staging
  // before any file is copied or built.
  test.each([
    ["outside the checkout", "../outside"],
    ["that dangles", "../missing"],
  ])("refuses a tracked file under a linked parent directory %s", async (_name, target) => {
    const c = await checkout()
    try {
      const add = Bun.spawnSync(["git", "-C", c.repo, "add", "docs/guide.md"], {
        env: { PATH: process.env.PATH, HOME: c.root },
      })
      expect(add.exitCode).toBe(0)
      mkdirSync(path.join(c.root, "outside"))
      writeFileSync(path.join(c.root, "outside", "guide.md"), "SENTINEL=outside\n")
      await rm(path.join(c.repo, "docs"), { recursive: true })
      symlinkSync(target, path.join(c.repo, "docs"))
      writeFileSync(path.join(c.repo, ".gitignore"), ".env\n/docs\n")

      await expect(stagePackage(c.destination, c.repo)).rejects.toThrow("docs is a symbolic link")

      expect(readdirSync(c.destination)).toEqual(["home"])
    } finally {
      await rm(c.root, { recursive: true, force: true })
    }
  })

  // A link under a packaged directory points at the ignored .env, at a directory, or at nothing. Each one stops the
  // staging before any file is copied or built.
  test.each([
    ["to an ignored file", "../.env"],
    ["to a directory", "../src"],
    ["that dangles", "../missing"],
  ])("refuses a symbolic link %s before copying anything", async (_name, target) => {
    const c = await checkout()
    try {
      symlinkSync(target, path.join(c.repo, "docs", "link"))

      await expect(stagePackage(c.destination, c.repo)).rejects.toThrow("docs/link is a symbolic link")

      expect(readdirSync(c.destination)).toEqual(["home"])
    } finally {
      await rm(c.root, { recursive: true, force: true })
    }
  })

  // package.json is replaced by a link to the ignored, non-JSON .env or to nothing. The link is refused before the
  // manifest is read: reading it first would fail with a parse error quoting the .env, or with a missing file.
  test.each([
    ["to an ignored file", ".env"],
    ["that dangles", "missing.json"],
  ])("refuses a manifest that is a symbolic link %s before reading it", async (_name, target) => {
    const c = await checkout()
    try {
      await rm(path.join(c.repo, "package.json"))
      symlinkSync(target, path.join(c.repo, "package.json"))

      await expect(stagePackage(c.destination, c.repo)).rejects.toThrow("package.json is a symbolic link")

      expect(readdirSync(c.destination)).toEqual(["home"])
    } finally {
      await rm(c.root, { recursive: true, force: true })
    }
  })
})
