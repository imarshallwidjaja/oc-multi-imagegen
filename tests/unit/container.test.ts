import { afterEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"

// The container runbook's two scripts, run as subprocesses against synthetic credentials and a fake `docker`.
// Nothing here needs Docker, OpenCode, a real credential or the network.

const repoRoot = path.resolve(import.meta.dir, "../..")
const helper = path.join(repoRoot, "scripts/opencode-container.sh")
const seeder = path.join(repoRoot, "scripts/seed-container-auth.ts")

const ACCESS = "SYNTHETIC-HOST-ACCESS-TOKEN"
const REFRESH = "SYNTHETIC-HOST-REFRESH-TOKEN"
const PLACEHOLDER = "container-seed-has-no-refresh-token"

const temporaryDirectories: string[] = []
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function temporaryDirectory() {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "oc-container-test-")))
  temporaryDirectories.push(directory)
  return directory
}

async function exec(command: string[], env: Record<string, string>) {
  const proc = Bun.spawn(command, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code, output: stdout + stderr }
}

// A host auth file with a synthetic ChatGPT entry. The data directory is private so it can also be an output directory.
function hostDataHome(root: string, expires = Date.now() + 100 * 3_600_000) {
  const dataHome = path.join(root, "host-data")
  const directory = path.join(dataHome, "opencode")
  mkdirSync(directory, { recursive: true })
  chmodSync(directory, 0o700)
  const source = path.join(directory, "auth.json")
  writeFileSync(
    source,
    JSON.stringify({
      openai: { type: "oauth", access: ACCESS, refresh: REFRESH, expires, accountId: "acct-synthetic" },
    }),
    { mode: 0o600 },
  )
  return { dataHome, source }
}

function privateDirectory(parent: string, name: string) {
  const directory = path.join(parent, name)
  mkdirSync(directory)
  chmodSync(directory, 0o700)
  return directory
}

function snapshot(file: string) {
  const stat = statSync(file)
  return { content: readFileSync(file, "utf-8"), mode: stat.mode, mtimeMs: stat.mtimeMs, ino: stat.ino }
}

describe("seed-container-auth", () => {
  const seed = (host: string, out: string, dataHome: string) =>
    exec([process.execPath, seeder, "--host", host, "--out", out], { XDG_DATA_HOME: dataHome })

  test.each(["v1", "v2"])(
    "writes a private %s seed with a placeholder refresh token and prints no secret",
    async (host) => {
      const root = temporaryDirectory()
      const { dataHome } = hostDataHome(root)
      const outDir = privateDirectory(root, "out")
      const out = path.join(outDir, "seed.json")

      const result = await seed(host, out, dataHome)

      expect(result.code).toBe(0)
      expect(result.output).not.toContain(ACCESS)
      expect(result.output).not.toContain(REFRESH)
      expect(statSync(out).mode & 0o777).toBe(0o600)
      const written = readFileSync(out, "utf-8")
      expect(written).toContain(PLACEHOLDER)
      expect(written).toContain(ACCESS)
      expect(written).not.toContain(REFRESH)
      expect(readdirSync(outDir)).toEqual(["seed.json"])
    },
  )

  test("refuses every existing destination, including aliases of the host file, and leaves it unchanged", async () => {
    const root = temporaryDirectory()
    const { dataHome, source } = hostDataHome(root)
    const outDir = privateDirectory(root, "out")
    const existing = path.join(outDir, "existing.json")
    writeFileSync(existing, "keep me", { mode: 0o644 })
    const symlinkToSource = path.join(outDir, "symlink.json")
    symlinkSync(source, symlinkToSource)
    const hardLinkToSource = path.join(outDir, "hardlink.json")
    linkSync(source, hardLinkToSource)
    const danglingSymlink = path.join(outDir, "dangling.json")
    symlinkSync(path.join(outDir, "not-created.json"), danglingSymlink)

    for (const out of [source, existing, symlinkToSource, hardLinkToSource]) {
      const before = { out: snapshot(out), source: snapshot(source) }
      const result = await seed("v1", out, dataHome)
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain("already exists")
      expect(result.output).not.toContain(ACCESS)
      expect({ out: snapshot(out), source: snapshot(source) }).toEqual(before)
    }
    expect((await seed("v1", danglingSymlink, dataHome)).code).not.toBe(0)
    expect(existsSync(path.join(outDir, "not-created.json"))).toBe(false)
    expect(readdirSync(outDir).sort()).toEqual(["dangling.json", "existing.json", "hardlink.json", "symlink.json"])
  })

  test("refuses an output directory that is missing or readable by others, without creating or changing it", async () => {
    const root = temporaryDirectory()
    const { dataHome } = hostDataHome(root)
    const open = path.join(root, "open")
    mkdirSync(open)
    chmodSync(open, 0o755)

    expect((await seed("v1", path.join(open, "seed.json"), dataHome)).code).not.toBe(0)
    expect(readdirSync(open)).toEqual([])
    expect(statSync(open).mode & 0o777).toBe(0o755)

    const missing = path.join(root, "missing", "seed.json")
    expect((await seed("v1", missing, dataHome)).code).not.toBe(0)
    expect(existsSync(path.dirname(missing))).toBe(false)
  })

  test("reports a host file that is not JSON without echoing its contents", async () => {
    const root = temporaryDirectory()
    const { dataHome, source } = hostDataHome(root)
    writeFileSync(source, `{"openai": "${ACCESS}`)
    const out = path.join(privateDirectory(root, "out"), "seed.json")

    const result = await seed("v1", out, dataHome)

    expect(result.code).not.toBe(0)
    expect(result.output).not.toContain(ACCESS)
    expect(existsSync(out)).toBe(false)
  })
})

// Stands in for docker: records each call, behaves like `docker run` for --name and --cidfile, and acts per
// FAKE_DOCKER_MODE: ok, fail (exit FAKE_DOCKER_EXIT, default 1), collide (name in use, no container), hang (a
// container that ignores SIGTERM and exits only when `docker stop` names its id). A container is gone once its
// listing is empty. FAKE_DOCKER_STUCK keeps it listed and makes stop and kill fail; FAKE_DOCKER_DAEMON_DOWN makes
// stop, kill and every listing fail, as when the daemon dies after the container was created.
const FAKE_DOCKER = `#!/usr/bin/env bash
cmd=$1; shift
case $cmd in
  run)
    args=("$@"); name=; cid=; seeddir=
    for ((i = 0; i < \${#args[@]}; i++)); do
      case \${args[i]} in
        --name) name=\${args[i+1]} ;;
        --cidfile) cid=\${args[i+1]} ;;
        -v) case \${args[i+1]} in *:/seed:ro) seeddir=\${args[i+1]%%:*} ;; esac ;;
      esac
    done
    seedmode=; [ -z "$seeddir" ] || seedmode=$(stat -c %a "$seeddir/import.json" 2>/dev/null)
    echo "run $name seedmode=$seedmode :: $*" >>"$FAKE_DOCKER_LOG"
    case \${FAKE_DOCKER_MODE:-ok} in
      collide) echo "name already in use" >&2; exit 125 ;;
    esac
    echo "id-$name" >"$cid"
    case \${FAKE_DOCKER_MODE:-ok} in
      fail) exit "\${FAKE_DOCKER_EXIT:-1}" ;;
      hang) trap '' TERM; while [ ! -e "$FAKE_DOCKER_LOG.stopped-id-$name" ]; do sleep 0.1; done ;;
    esac
    ;;
  stop | kill)
    id=\${@: -1}
    echo "$cmd $id" >>"$FAKE_DOCKER_LOG"
    [ -z "\${FAKE_DOCKER_STUCK:-}\${FAKE_DOCKER_DAEMON_DOWN:-}" ] || exit 1
    touch "$FAKE_DOCKER_LOG.stopped-$id"
    ;;
  ps)
    echo "ps $*" >>"$FAKE_DOCKER_LOG"
    [ -z "\${FAKE_DOCKER_DAEMON_DOWN:-}" ] || { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
    case $* in
      *id=*) [ -z "\${FAKE_DOCKER_STUCK:-}" ] || echo "\${*##*id=}" ;;
      *) printf '%s' "\${FAKE_DOCKER_PS:-}" ;;
    esac
    ;;
esac
`

// The two ways a stopped container can stay unproven: still listed after stop and kill failed, or no answer at all.
const UNREACHABLE: Array<Record<string, string>> = [{ FAKE_DOCKER_STUCK: "1" }, { FAKE_DOCKER_DAEMON_DOWN: "1" }]

function container() {
  const root = temporaryDirectory()
  const bin = path.join(root, "bin")
  mkdirSync(bin)
  writeFileSync(path.join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 })
  // The helper waits half a second between checks that a container is gone; the shim keeps unsettled cases fast.
  writeFileSync(path.join(bin, "sleep"), "#!/bin/sh\nexec /bin/sleep 0.01\n", { mode: 0o755 })
  const log = path.join(root, "docker.log")
  const { dataHome } = hostDataHome(root)
  const env = {
    PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`,
    FAKE_DOCKER_LOG: log,
    XDG_DATA_HOME: dataHome,
    TMPDIR: root,
  }
  const run = (args: string[], extra: Record<string, string> = {}) =>
    exec(["bash", helper, ...args], { ...env, ...extra })
  return {
    root,
    run,
    start: (args: string[], extra: Record<string, string> = {}) =>
      Bun.spawn(["bash", helper, ...args], {
        env: { ...process.env, ...env, ...extra },
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      }),
    calls: () => (existsSync(log) ? readFileSync(log, "utf-8").split("\n").filter(Boolean) : []),
    async sandbox() {
      const result = await run(["init"])
      expect(result.code).toBe(0)
      return result.stdout.trim()
    },
    // A sandbox as `pack` and `prepare` leave it, without packing anything.
    async ready(...hosts: string[]) {
      const sandbox = await this.sandbox()
      mkdirSync(path.join(sandbox, "pkg/package"), { recursive: true })
      for (const host of hosts) expect((await run(["prepare", host], { OC_SANDBOX: sandbox })).code).toBe(0)
      return sandbox
    },
  }
}

async function until(condition: () => boolean) {
  for (let i = 0; i < 100 && !condition(); i++) await Bun.sleep(50)
  expect(condition()).toBe(true)
}

describe("opencode-container.sh sandbox", () => {
  test("init makes a private marked sandbox outside the repository, and refuses a TMPDIR inside it", async () => {
    const c = container()
    const sandbox = await c.sandbox()

    expect(sandbox.startsWith(c.root)).toBe(true)
    expect(statSync(sandbox).mode & 0o777).toBe(0o700)
    expect(
      readdirSync(sandbox, { withFileTypes: true })
        .map((entry) => entry.name)
        .sort(),
    ).toEqual([".oc-multi-imagegen-sandbox", "cid", "logs", "pack"])

    const before = readdirSync(repoRoot).sort()
    const inside = await c.run(["init"], { TMPDIR: repoRoot })
    expect(inside.code).not.toBe(0)
    expect(readdirSync(repoRoot).sort()).toEqual(before)
  })

  test("rejects an unsafe OC_SANDBOX before creating or changing anything", async () => {
    const c = container()
    const real = await c.sandbox()
    const alias = path.join(c.root, "alias")
    symlinkSync(real, alias)
    const homeLike = privateDirectory(c.root, "home-like")
    const insideRepo = path.join(repoRoot, "tests")
    const unsafe: Array<[string, string]> = [
      ["relative path", "relative-sandbox"],
      ["symlink to a real sandbox", alias],
      ["directory that init did not make", homeLike],
      ["directory inside the repository", insideRepo],
      ["missing path inside the repository", path.join(repoRoot, "not-a-sandbox")],
      ["parent of the repository", path.dirname(repoRoot)],
      ["filesystem root", "/"],
    ]
    const watched = [real, homeLike, insideRepo, path.dirname(repoRoot)]
    const listing = () => watched.map((dir) => readdirSync(dir).sort())
    const before = listing()

    for (const [label, sandbox] of unsafe) {
      const result = await c.run(["prepare", "v1"], { OC_SANDBOX: sandbox })
      expect({ label, code: result.code }).toEqual({ label, code: 2 })
    }

    expect(listing()).toEqual(before)
    expect(existsSync(path.join(repoRoot, "not-a-sandbox"))).toBe(false)
    expect(c.calls()).toEqual([])
  })

  test("run refuses a host that was not prepared, so docker never creates root-owned mount sources", async () => {
    const c = container()
    const sandbox = await c.sandbox()

    const result = await c.run(["run", "v1", "early", "--", "--version"], { OC_SANDBOX: sandbox })

    expect(result.code).toBe(2)
    expect(result.stderr).toContain("is missing")
    expect(c.calls()).toEqual([])
  })

  test("rejects a timeout that is not a positive whole number before docker is called", async () => {
    const c = container()
    const sandbox = await c.sandbox()

    for (const timeout of ["0", "00", "abc", "1.5", "-1"]) {
      const result = await c.run(["run", "v1", "t", "--", "serve"], { OC_SANDBOX: sandbox, OC_TIMEOUT: timeout })
      expect({ timeout, code: result.code }).toEqual({ timeout, code: 2 })
      expect(result.stderr).toContain("OC_TIMEOUT")
    }
    expect(c.calls()).toEqual([])
  })

  test("pack refuses a sandbox that already holds a package", async () => {
    const c = container()
    const sandbox = await c.sandbox()
    mkdirSync(path.join(sandbox, "pkg"))

    const result = await c.run(["pack"], { OC_SANDBOX: sandbox })

    expect(result.code).toBe(2)
    expect(result.stderr).toContain("already holds a package")
    expect(readdirSync(path.join(sandbox, "pack"))).toEqual([])
  })

  test("clean removes credentials, state and kept seeds, keeps work and logs, and refuses while a sandbox container runs or cannot be listed", async () => {
    const c = container()
    const sandbox = await c.sandbox()
    expect((await c.run(["prepare", "v1"], { OC_SANDBOX: sandbox })).code).toBe(0)
    expect((await c.run(["seed", "v1"], { OC_SANDBOX: sandbox })).code).toBe(0)
    const auth = path.join(sandbox, "v1/data/opencode/auth.json")
    expect(existsSync(auth)).toBe(true)
    writeFileSync(path.join(sandbox, "v1/work/character.png"), "image")
    writeFileSync(path.join(sandbox, "logs/v1-case-A.out"), "log")
    mkdirSync(path.join(sandbox, "seed.KEPT00"))
    writeFileSync(path.join(sandbox, "seed.KEPT00/import.json"), "kept seed")
    mkdirSync(path.join(sandbox, "seed"))
    writeFileSync(path.join(sandbox, "seed/import.json"), "earlier seed")

    const refused = await c.run(["clean"], { OC_SANDBOX: sandbox, FAKE_DOCKER_PS: "abc123" })
    expect(refused.code).toBe(2)
    expect(existsSync(auth)).toBe(true)

    const unlisted = await c.run(["clean"], { OC_SANDBOX: sandbox, FAKE_DOCKER_DAEMON_DOWN: "1" })
    expect(unlisted.code).toBe(2)
    expect(existsSync(auth)).toBe(true)
    expect(existsSync(path.join(sandbox, "seed.KEPT00"))).toBe(true)
    expect(existsSync(path.join(sandbox, "seed/import.json"))).toBe(true)

    expect((await c.run(["clean"], { OC_SANDBOX: sandbox })).code).toBe(0)
    expect(existsSync(path.join(sandbox, "v1/data"))).toBe(false)
    expect(existsSync(path.join(sandbox, "seed.KEPT00"))).toBe(false)
    expect(existsSync(path.join(sandbox, "seed"))).toBe(false)
    expect(readFileSync(path.join(sandbox, "v1/work/character.png"), "utf-8")).toBe("image")
    expect(readFileSync(path.join(sandbox, "logs/v1-case-A.out"), "utf-8")).toBe("log")
  })
})

// Seed material that is not a run's own: a fixed-name file from an earlier version of the helper, and a
// directory kept by an earlier run whose container could not be confirmed gone.
function earlierSeeds(sandbox: string) {
  const files = [path.join(sandbox, "seed/import.json"), path.join(sandbox, "seed.KEPT00/import.json")]
  for (const file of files) {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, "an earlier seed", { mode: 0o600 })
  }
  return {
    untouched: () => files.every((file) => readFileSync(file, "utf-8") === "an earlier seed"),
    seedEntries: () =>
      readdirSync(sandbox)
        .filter((name) => name.startsWith("seed"))
        .sort(),
  }
}

describe("opencode-container.sh container lifecycle", () => {
  test("a v2 seed exists only during the import and is gone after success, leaving earlier seeds alone", async () => {
    const c = container()
    const sandbox = await c.ready("v2")
    const earlier = earlierSeeds(sandbox)

    const result = await c.run(["seed", "v2"], { OC_SANDBOX: sandbox })

    expect(result.code).toBe(0)
    expect(result.output).not.toContain(ACCESS)
    expect(c.calls()[0]).toMatch(
      /^run ocimg-v2-seed-import-\S+ seedmode=600 :: .*-v \S+\/seed\.\w+:\/seed:ro .*auth import --standalone \/seed\/import\.json$/,
    )
    expect(earlier.untouched()).toBe(true)
    expect(earlier.seedEntries()).toEqual(["seed", "seed.KEPT00"])
  })

  test("a failed import exits with docker's status and leaves no seed of its own", async () => {
    const c = container()
    const sandbox = await c.ready("v2")
    const earlier = earlierSeeds(sandbox)

    const result = await c.run(["seed", "v2"], { OC_SANDBOX: sandbox, FAKE_DOCKER_MODE: "fail", FAKE_DOCKER_EXIT: "7" })

    expect(result.code).toBe(7)
    expect(result.output).not.toContain(ACCESS)
    expect(c.calls().filter((line) => line.startsWith("run "))).toHaveLength(1)
    expect(earlier.untouched()).toBe(true)
    expect(earlier.seedEntries()).toEqual(["seed", "seed.KEPT00"])
  })

  test("a signal during the import stops that container and removes only its own seed", async () => {
    const c = container()
    const sandbox = await c.ready("v2")
    const earlier = earlierSeeds(sandbox)
    const proc = c.start(["seed", "v2"], { OC_SANDBOX: sandbox, FAKE_DOCKER_MODE: "hang" })

    await until(() => c.calls().some((line) => line.startsWith("run ")))
    proc.kill("SIGTERM")
    const code = await proc.exited

    const name = c.calls()[0].split(" ")[1]
    expect(code).toBe(143)
    expect(c.calls().filter((line) => line.startsWith("stop "))).toEqual([`stop id-${name}`])
    expect(earlier.untouched()).toBe(true)
    expect(earlier.seedEntries()).toEqual(["seed", "seed.KEPT00"])
  }, 15_000)

  test("a timed-out import exits 124 and removes its seed", async () => {
    const c = container()
    const sandbox = await c.ready("v2")

    const result = await c.run(["seed", "v2"], { OC_SANDBOX: sandbox, OC_TIMEOUT: "1", FAKE_DOCKER_MODE: "hang" })

    expect(result.code).toBe(124)
    expect(readdirSync(sandbox).filter((name) => name.startsWith("seed"))).toEqual([])
  }, 30_000)

  test("a container that cannot be confirmed gone fails the import, names the container and keeps its seed", async () => {
    for (const unreachable of UNREACHABLE) {
      const c = container()
      const sandbox = await c.ready("v2")
      const earlier = earlierSeeds(sandbox)

      // Docker itself exits 0, so only the unconfirmed container can fail the import.
      const result = await c.run(["seed", "v2"], { OC_SANDBOX: sandbox, ...unreachable })

      const name = c.calls()[0].split(" ")[1]
      expect({ unreachable, code: result.code }).toEqual({ unreachable, code: 1 })
      expect(result.stderr).toContain(`Could not confirm that container id-${name} is gone`)
      const kept = readdirSync(sandbox).filter((entry) => entry.startsWith("seed.") && entry !== "seed.KEPT00")
      expect(kept).toHaveLength(1)
      expect(result.stderr).toContain(`Kept ${path.join(sandbox, kept[0])}`)
      expect(readFileSync(path.join(sandbox, kept[0], "import.json"), "utf-8")).toContain(ACCESS)
      expect(earlier.untouched()).toBe(true)
    }
  })

  test("an unconfirmed container does not hide docker's own failure status", async () => {
    const c = container()
    const sandbox = await c.ready("v1")

    const result = await c.run(["run", "v1", "stuck", "--", "serve"], {
      OC_SANDBOX: sandbox,
      FAKE_DOCKER_MODE: "fail",
      FAKE_DOCKER_EXIT: "7",
      FAKE_DOCKER_DAEMON_DOWN: "1",
    })

    expect(result.code).toBe(7)
    expect(result.stderr).toContain("Could not confirm that container")
  })

  test("a timeout stops the container the helper started, waits for it, and returns 124", async () => {
    const c = container()
    const sandbox = await c.ready("v1")

    const result = await c.run(["run", "v1", "slow", "--", "serve"], {
      OC_SANDBOX: sandbox,
      OC_TIMEOUT: "1",
      FAKE_DOCKER_MODE: "hang",
    })

    const name = c.calls()[0].split(" ")[1]
    expect(result.code).toBe(124)
    expect(result.stderr).toContain("OC_TIMEOUT")
    expect(c.calls().filter((line) => line.startsWith("run "))).toHaveLength(1)
    expect(c.calls().filter((line) => line.startsWith("stop "))).toEqual([`stop id-${name}`])
  }, 30_000)

  test("a container name collision stops nothing", async () => {
    const c = container()
    const sandbox = await c.ready("v1")

    const result = await c.run(["run", "v1", "taken", "--", "serve"], {
      OC_SANDBOX: sandbox,
      FAKE_DOCKER_MODE: "collide",
    })

    expect(result.code).toBe(125)
    expect(c.calls().filter((line) => /^(stop|kill) /.test(line))).toEqual([])
  })
})

describe("opencode-container.sh cases", () => {
  const prepared = async () => {
    const c = container()
    const sandbox = await c.ready("v1")
    return { c, sandbox, env: { OC_SANDBOX: sandbox, OC_MODEL: "provider/model-under-test" } }
  }

  test("runs the four cases in order and logs each", async () => {
    const { c, sandbox, env } = await prepared()

    const result = await c.run(["cases", "v1"], env)

    expect(result.code).toBe(0)
    const runs = c.calls().filter((line) => line.startsWith("run "))
    expect(runs.map((line) => line.split(" ")[1].replace(/-\d+-\d+$/, ""))).toEqual([
      "ocimg-v1-case-A",
      "ocimg-v1-case-B",
      "ocimg-v1-case-C",
      "ocimg-v1-case-D",
    ])
    for (const line of runs) expect(line).toContain("--model provider/model-under-test")
    expect(readdirSync(path.join(sandbox, "logs")).sort()).toEqual([
      "v1-case-A.err",
      "v1-case-A.out",
      "v1-case-B.err",
      "v1-case-B.out",
      "v1-case-C.err",
      "v1-case-C.out",
      "v1-case-D.err",
      "v1-case-D.out",
    ])
  })

  test("stops at the first failed case", async () => {
    const { c, env } = await prepared()

    const result = await c.run(["cases", "v1"], { ...env, FAKE_DOCKER_MODE: "fail", FAKE_DOCKER_EXIT: "7" })

    expect(result.code).toBe(7)
    expect(result.stderr).toContain("Case A failed")
    expect(c.calls().filter((line) => line.startsWith("run "))).toHaveLength(1)
  })

  test("does not start case B when case A's container cannot be confirmed gone", async () => {
    for (const unreachable of UNREACHABLE) {
      const { c, env } = await prepared()

      // Case A's docker exits 0, so only the unconfirmed container can fail the command.
      const result = await c.run(["cases", "v1"], { ...env, ...unreachable })

      const name = c.calls()[0].split(" ")[1]
      expect({ unreachable, code: result.code }).toEqual({ unreachable, code: 1 })
      expect(c.calls().filter((line) => line.startsWith("run "))).toHaveLength(1)
      // The warning reaches the terminal although each case's stderr goes to a log file.
      expect(result.stderr).toContain(`Could not confirm that container id-${name} is gone`)
      expect(result.stderr).toContain("Case A failed")
    }
  })

  test("refuses to start over earlier work or logs before any container runs", async () => {
    const { c, sandbox, env } = await prepared()
    writeFileSync(path.join(sandbox, "v1/work/character.png"), "earlier attempt")
    const staleWork = await c.run(["cases", "v1"], env)
    expect(staleWork.code).toBe(2)
    expect(staleWork.stderr).toContain("not empty")

    rmSync(path.join(sandbox, "v1/work/character.png"))
    writeFileSync(path.join(sandbox, "logs/v1-case-A.out"), "earlier attempt")
    const staleLog = await c.run(["cases", "v1"], env)
    expect(staleLog.code).toBe(2)
    expect(staleLog.stderr).toContain("earlier attempt")

    expect(c.calls()).toEqual([])
    expect(readdirSync(path.join(sandbox, "v1/work"))).toEqual([])
  })

  test("needs an explicit model", async () => {
    const { c, sandbox } = await prepared()

    const result = await c.run(["cases", "v1"], { OC_SANDBOX: sandbox, OC_MODEL: "" })

    expect(result.code).not.toBe(0)
    expect(c.calls()).toEqual([])
  })
})
