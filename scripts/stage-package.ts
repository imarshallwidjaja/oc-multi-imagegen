// Builds and packs this checkout in a staging directory, so a check of the package never rebuilds, deletes or packs
// the checkout's own dist/, which a running OpenCode may have loaded.
//
//   bun scripts/stage-package.ts <empty directory>
//
// The staging directory receives `source/`, a copy of the checkout's build and package inputs as Git sees them
// (tracked files, and untracked files that are not ignored, with uncommitted changes): package.json, tsconfig.json,
// src/, which the build script compiles, and the entries of the manifest's `files` list other than dist/. Nothing else
// in the checkout is read or copied. Only regular files in real directories are staged: a symbolic link, as an input or
// as a directory above one, could point at an ignored file or outside the checkout, and stops the staging before
// anything is copied. The package's own `build` script then runs in `source/`, and `npm pack` writes the tarball to the
// staging directory. The command prints the tarball and the staged build, one `name: path` line each. `installPackage`
// also extracts the tarball and installs it with its runtime dependencies, as a consumer would.
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs"
import path from "node:path"

const REPO_DIR = path.resolve(import.meta.dir, "..")

// Child processes get PATH and a HOME of their own (npm keeps its cache and logs there), and nothing else of the
// caller's environment, so npm_config_*, GIT_* and similar settings cannot change what is built or packed.
async function run(command: string[], cwd: string, home: string): Promise<string> {
  const proc = Bun.spawn(command, {
    cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`${command.join(" ")} failed in ${cwd} (exit ${code}): ${stderr.trim()}`)
  return stdout
}

// Whether `file`, relative to `checkout`, is a regular file in real directories there. Returns false for a file that is
// missing from the working tree, which Git still lists until the deletion is staged, and throws for a link or another
// kind of file, as the file or a directory above it.
// `directories` records the directories already checked.
function isStagedInput(checkout: string, file: string, directories: Set<string>): boolean {
  // lstat follows links in the parent path, so every directory above the file is checked first: Git still lists a
  // tracked file whose parent was replaced by a link, which may be ignored, dangle or point outside the checkout.
  const parts = file.split("/")
  for (let depth = 1; depth < parts.length; depth++) {
    const directory = parts.slice(0, depth).join("/")
    if (directories.has(directory)) continue
    const stat = lstatSync(path.join(checkout, directory), { throwIfNoEntry: false })
    if (!stat) return false
    if (stat.isSymbolicLink())
      throw new Error(`${directory} is a symbolic link; the package is staged from regular files only`)
    if (!stat.isDirectory())
      throw new Error(`${directory} is not a directory; the package is staged from regular files only`)
    directories.add(directory)
  }
  const stat = lstatSync(path.join(checkout, file), { throwIfNoEntry: false })
  if (!stat) return false
  if (stat.isSymbolicLink())
    throw new Error(`${file} is a symbolic link; the package is staged from regular files only`)
  // Git lists a nested repository as a directory.
  if (!stat.isFile()) throw new Error(`${file} is not a regular file; the package is staged from regular files only`)
  return true
}

export interface StagedPackage {
  // The tarball `npm pack` wrote in the staging directory.
  tarball: string
  // The staged build, source/dist/index.js; the same bytes are in the tarball.
  build: string
}

// Stages `checkout` (this repository unless a test names another) into the empty directory `destination`.
export async function stagePackage(destination: string, checkout = REPO_DIR): Promise<StagedPackage> {
  if (!statSync(destination).isDirectory() || readdirSync(destination).length > 0) {
    throw new Error(`${destination} must be an existing empty directory`)
  }
  const home = path.join(destination, "home")
  const source = path.join(destination, "source")
  mkdirSync(home)
  const directories = new Set<string>()
  // The manifest is checked like every other input before it is read, so a link is refused before its target is opened.
  if (!isStagedInput(checkout, "package.json", directories)) throw new Error(`${checkout} has no package.json`)
  const { files = [] } = JSON.parse(readFileSync(path.join(checkout, "package.json"), "utf-8"))
  // npm applies the manifest's negated entries itself when it packs, and dist/ is what the build writes.
  const packaged = (files as string[]).filter((entry) => !entry.startsWith("!") && entry !== "dist")
  const inputPaths = ["package.json", "tsconfig.json", "src", ...packaged]
  // Git reads the checkout with the caller's HOME, which may hold the safe.directory setting for it.
  const listed = await run(
    ["git", "-C", checkout, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...inputPaths],
    checkout,
    process.env.HOME ?? home,
  )
  const inputs = listed.split("\0").filter((file) => file !== "" && isStagedInput(checkout, file, directories))
  for (const file of inputs) {
    mkdirSync(path.dirname(path.join(source, file)), { recursive: true })
    copyFileSync(path.join(checkout, file), path.join(source, file))
  }
  await run(["bun", "run", "build"], source, home)
  // npm 11 returns an array; npm 12 keys the same entries by package name.
  const [{ filename }] = Object.values<{ filename: string }>(
    JSON.parse(await run(["npm", "pack", "--json", "--pack-destination", destination], source, home)),
  )
  return { tarball: path.join(destination, filename), build: path.join(source, "dist", "index.js") }
}

// Stages this checkout into the empty directory `staging`, extracts the tarball there and moves the package to
// `packageDir`, whose parent must exist, then copies in its runtime dependencies (installProductionDependencies).
// The result is the package a consumer would install, with no network access.
export async function installPackage(staging: string, packageDir: string): Promise<StagedPackage> {
  const staged = await stagePackage(staging)
  const extracted = path.join(staging, "extracted")
  mkdirSync(extracted)
  await run(["tar", "-xzf", staged.tarball, "-C", extracted], staging, path.join(staging, "home"))
  renameSync(path.join(extracted, "package"), packageDir)
  installProductionDependencies(packageDir)
  return staged
}

// Copies the runtime dependency closure of the package at `packageDir` (its `dependencies`, and theirs) from the
// checkout's node_modules into `packageDir/node_modules`, resolving each name the way Node does from the package
// that needs it. Development dependencies, including both OpenCode SDKs, are not copied, so the copy fails to load
// if the package needs one at runtime.
function installProductionDependencies(packageDir: string): void {
  const copied = new Set<string>()
  const manifest = (dir: string) => JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8"))
  const locate = (name: string, from: string) => {
    for (let dir = from; ; dir = path.dirname(dir)) {
      const candidate = path.join(dir, "node_modules", name)
      if (existsSync(path.join(candidate, "package.json"))) return candidate
      if (dir === REPO_DIR) return undefined
    }
  }
  const pending = Object.keys(manifest(packageDir).dependencies ?? {}).map((name) => ({ name, from: REPO_DIR }))
  for (let next = pending.pop(); next; next = pending.pop()) {
    const found = locate(next.name, next.from)
    if (!found) throw new Error(`${next.name} is not installed under ${REPO_DIR}; run bun install --frozen-lockfile`)
    if (copied.has(found)) continue
    const target = path.join(packageDir, path.relative(REPO_DIR, found))
    mkdirSync(path.dirname(target), { recursive: true })
    // Nested node_modules are copied only for the dependencies that resolve to them.
    cpSync(found, target, {
      recursive: true,
      dereference: true,
      filter: (file) => file === found || path.basename(file) !== "node_modules",
    })
    copied.add(found)
    const { dependencies = {}, optionalDependencies = {} } = manifest(found)
    for (const name of Object.keys(dependencies)) pending.push({ name, from: found })
    for (const name of Object.keys(optionalDependencies)) if (locate(name, found)) pending.push({ name, from: found })
  }
}

if (import.meta.main) {
  const [destination] = process.argv.slice(2)
  if (!destination || process.argv.length !== 3) {
    console.error("Usage: bun scripts/stage-package.ts <empty directory>")
    process.exit(2)
  }
  const staged = await stagePackage(path.resolve(destination))
  console.log(`tarball: ${staged.tarball}`)
  console.log(`build: ${staged.build}`)
}
