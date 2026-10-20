import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import plugin from "../../src/index"

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
