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

// The container runbook's scripts, run as subprocesses against synthetic credentials, a fake `docker` and, for the
// in-container skill probe, a fake `opencode` and `wget`. Nothing here needs Docker, OpenCode, a real credential or
// the network.

const repoRoot = path.resolve(import.meta.dir, "../..")
const helper = path.join(repoRoot, "scripts/opencode-container.sh")
const probe = path.join(repoRoot, "scripts/container-skill-probe.sh")
const backendProbe = path.join(repoRoot, "scripts/container-backend-probe.sh")
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

describe("seed-container-auth image key", () => {
  const KEY = "sk-SYNTHETIC-IMAGE-KEY"
  const seedWithKey = (host: string, out: string, dataHome: string, envFile: string) =>
    exec([process.execPath, seeder, "--host", host, "--out", out, "--image-key-env-file", envFile], {
      XDG_DATA_HOME: dataHome,
    })

  function dotenv(root: string, text: string) {
    const file = path.join(root, ".env")
    writeFileSync(file, text, { mode: 0o600 })
    return file
  }

  test.each(["v1", "v2"])(
    "adds the last OPENAI_API_KEY of a dotenv file to the %s seed and prints no secret",
    async (host) => {
      const root = temporaryDirectory()
      const { dataHome } = hostDataHome(root)
      const env = dotenv(root, `OTHER=1\nOPENAI_API_KEY=sk-OLD\n# comment\nexport OPENAI_API_KEY="${KEY}" # trailing\n`)
      const out = path.join(privateDirectory(root, "out"), "seed.json")

      const result = await seedWithKey(host, out, dataHome, env)

      expect(result.code).toBe(0)
      expect(result.output).not.toContain(KEY)
      expect(result.output).not.toContain(ACCESS)
      expect(result.stdout).toContain("OpenAI Images API key")
      const written = JSON.parse(readFileSync(out, "utf-8"))
      if (host === "v1") {
        expect(written["openai-images"]).toEqual({ type: "api", key: KEY })
        expect(written.openai.access).toBe(ACCESS)
      } else {
        expect(written.map((entry: { integrationID: string }) => entry.integrationID)).toEqual([
          "openai",
          "openai-images",
        ])
        expect(written[1]).toMatchObject({
          integrationID: "openai-images",
          active: true,
          value: { type: "key", key: KEY },
        })
      }
    },
  )

  test.each([
    ["has no OPENAI_API_KEY value", "OTHER=1\n", "has no OPENAI_API_KEY value"],
    ["has an empty value", "OPENAI_API_KEY=\n", "has no OPENAI_API_KEY value"],
    ["has a value that cannot be a header", 'OPENAI_API_KEY="sk bad value"\n', "is not usable as an API key"],
  ])("refuses a dotenv file that %s, without echoing it or writing a seed", async (_name, text, reason) => {
    const root = temporaryDirectory()
    const { dataHome } = hostDataHome(root)
    const out = path.join(privateDirectory(root, "out"), "seed.json")

    const result = await seedWithKey("v1", out, dataHome, dotenv(root, text))

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain(reason)
    expect(result.output).not.toContain("sk bad value")
    expect(existsSync(out)).toBe(false)
  })

  test("refuses a dotenv path that is not a file", async () => {
    const root = temporaryDirectory()
    const { dataHome } = hostDataHome(root)
    const out = path.join(privateDirectory(root, "out"), "seed.json")

    const result = await seedWithKey("v1", out, dataHome, path.join(root, "missing.env"))

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("is not a file")
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

  test("smoke runs one low-quality generation and one edit of its output, and rejects other modes", async () => {
    const { c, sandbox, env } = await prepared()

    const result = await c.run(["cases", "v1", "smoke"], env)

    expect(result.code).toBe(0)
    const runs = c.calls().filter((line) => line.startsWith("run "))
    expect(runs.map((line) => line.split(" ")[1].replace(/-\d+-\d+$/, ""))).toEqual([
      "ocimg-v1-case-G",
      "ocimg-v1-case-E",
    ])
    expect(runs[0]).toContain("quality low")
    expect(runs[0]).toContain("size 1536x1024")
    expect(runs[1]).toContain("size 1536x1024")
    expect(runs[1]).toContain("smoke-generate.png")
    expect(readdirSync(path.join(sandbox, "logs")).sort()).toEqual([
      "v1-case-E.err",
      "v1-case-E.out",
      "v1-case-G.err",
      "v1-case-G.out",
    ])
    expect((await c.run(["cases", "v1", "everything"], env)).code).toBe(2)
  })

  test("asks for the images in plain terms that name neither the tool nor the skill", async () => {
    const { c, env } = await prepared()

    await c.run(["cases", "v1"], env)

    const prompts = c
      .calls()
      .filter((line) => line.startsWith("run "))
      .map((line) => line.split("--model provider/model-under-test ")[1])
    expect(prompts).toHaveLength(4)
    for (const prompt of prompts) expect(prompt).not.toMatch(/imagegen|skill|image generation/i)
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

describe("opencode-container.sh host configuration", () => {
  const configOf = (sandbox: string, host: string) =>
    JSON.parse(readFileSync(path.join(sandbox, host, "config/opencode/opencode.json"), "utf-8"))

  test("the default permits imagegen, the plugin's skill and PNG reads on both hosts, and nothing else", async () => {
    const c = container()
    const sandbox = await c.ready("v1", "v2")

    expect(configOf(sandbox, "v1").permission).toEqual({
      "*": "deny",
      imagegen: "allow",
      skill: { "*": "deny", "oc-multi-imagegen": "allow" },
      read: { "*": "deny", "*.png": "allow" },
    })
    expect(configOf(sandbox, "v2").permissions).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      { action: "imagegen", resource: "*", effect: "allow" },
      { action: "skill", resource: "oc-multi-imagegen", effect: "allow" },
      { action: "read", resource: "*.png", effect: "allow" },
    ])
  })

  test("tool-only permits imagegen and leaves the skill denied, and ask permits nothing without a prompt", async () => {
    const c = container()
    const sandbox = await c.ready()

    for (const [mode, effect] of [
      ["tool-only", "allow"],
      ["ask", "ask"],
    ]) {
      for (const host of ["v1", "v2"]) {
        expect((await c.run(["prepare", host, mode], { OC_SANDBOX: sandbox })).code).toBe(0)
      }
      expect(configOf(sandbox, "v1").permission).toEqual({ "*": "deny", imagegen: effect })
      expect(configOf(sandbox, "v2").permissions).toEqual([
        { action: "*", resource: "*", effect: "deny" },
        { action: "imagegen", resource: "*", effect: effect },
      ])
    }
    expect((await c.run(["prepare", "v1", "everything"], { OC_SANDBOX: sandbox })).code).toBe(2)
  })

  test("skills lists what a host registered, and lifecycle needs a host that reloads plugins", async () => {
    const c = container()
    const sandbox = await c.ready("v1", "v2")

    expect((await c.run(["skills", "v1"], { OC_SANDBOX: sandbox })).code).toBe(0)
    expect((await c.run(["skills", "v2"], { OC_SANDBOX: sandbox })).code).toBe(0)
    expect((await c.run(["lifecycle", "v1"], { OC_SANDBOX: sandbox })).code).toBe(2)
    expect((await c.run(["lifecycle", "v2"], { OC_SANDBOX: sandbox })).code).toBe(0)

    const runs = c.calls().filter((line) => line.startsWith("run "))
    expect(runs).toHaveLength(3)
    expect(runs[0]).toContain("debug skill")
    // The v2 check runs the probe, which starts a private server inside the container; the lifecycle check edits
    // the package it mounts. The probe's behavior is tested below.
    for (const [run, mode] of [
      [runs[1], "skills"],
      [runs[2], "lifecycle"],
    ]) {
      expect(run).toContain("OPENCODE_SERVER_PASSWORD=probe")
      expect(run).toContain(`${probe}:/probe.sh:ro`)
      expect(run).toEndWith(` /probe.sh ${mode}`)
    }
    expect(runs[1]).toContain(":/pluginpkg:ro")
    expect(runs[2]).toContain(":/pluginpkg ")
    expect(runs[2]).not.toContain(":/pluginpkg:ro")
  })

  test("prepare writes the plugin's backend option for the selected backend and leaves the default without one", async () => {
    const c = container()
    const sandbox = await c.sandbox()
    mkdirSync(path.join(sandbox, "pkg/package"), { recursive: true })

    for (const host of ["v1", "v1-floor", "v2"]) {
      expect((await c.run(["prepare", host, "allow", "openai-api"], { OC_SANDBOX: sandbox })).code).toBe(0)
    }

    expect(configOf(sandbox, "v1").plugin).toEqual([["file:///pluginpkg", { backend: "openai-api" }]])
    expect(configOf(sandbox, "v1-floor").plugin).toEqual([["file:///pluginpkg", { backend: "openai-api" }]])
    expect(configOf(sandbox, "v2").plugins).toEqual([{ package: "/pluginpkg", options: { backend: "openai-api" } }])
    // The permission rules are the same whichever backend is selected: the wildcard covers both resources.
    expect(configOf(sandbox, "v1").permission.imagegen).toBe("allow")

    expect((await c.run(["prepare", "v1", "allow", "codex"], { OC_SANDBOX: sandbox })).code).toBe(0)
    expect(configOf(sandbox, "v1").plugin).toEqual(["file:///pluginpkg"])
    expect((await c.run(["prepare", "v1", "allow", "dall-e"], { OC_SANDBOX: sandbox })).code).toBe(2)
  })

  test("seed hands the image key file to the seed script by path and writes the key into the host's own store", async () => {
    const c = container()
    const sandbox = await c.ready("v1")
    const env = path.join(c.root, "image.env")
    writeFileSync(env, "OPENAI_API_KEY=sk-SYNTHETIC-IMAGE-KEY\n", { mode: 0o600 })

    const result = await c.run(["seed", "v1"], { OC_SANDBOX: sandbox, OC_IMAGE_KEY_ENV_FILE: env })

    expect(result.code).toBe(0)
    expect(result.output).not.toContain("sk-SYNTHETIC-IMAGE-KEY")
    const store = JSON.parse(readFileSync(path.join(sandbox, "v1/data/opencode/auth.json"), "utf-8"))
    expect(store["openai-images"]).toEqual({ type: "api", key: "sk-SYNTHETIC-IMAGE-KEY" })
  })

  test("backend runs the probe for the host and backend, and rejects a backend it does not know", async () => {
    const c = container()
    const sandbox = await c.ready("v1", "v2")

    expect((await c.run(["backend", "v1", "openai-api"], { OC_SANDBOX: sandbox })).code).toBe(0)
    expect((await c.run(["backend", "v2", "codex"], { OC_SANDBOX: sandbox })).code).toBe(0)
    expect((await c.run(["backend", "v1", "dall-e"], { OC_SANDBOX: sandbox })).code).toBe(2)

    const runs = c.calls().filter((line) => line.startsWith("run "))
    expect(runs).toHaveLength(2)
    expect(runs[0]).toContain(`${backendProbe}:/probe.sh:ro`)
    expect(runs[0]).toEndWith(" /probe.sh v1 openai-api")
    expect(runs[0]).not.toContain("OPENCODE_SERVER_PASSWORD")
    expect(runs[1]).toContain("OPENCODE_SERVER_PASSWORD=probe")
    expect(runs[1]).toEndWith(" /probe.sh v2 codex")
  })

  test("skills and lifecycle fail when the probe in the container fails", async () => {
    const c = container()
    const sandbox = await c.ready("v2")

    for (const mode of ["skills", "lifecycle"]) {
      const result = await c.run([mode, "v2"], { OC_SANDBOX: sandbox, FAKE_DOCKER_MODE: "fail", FAKE_DOCKER_EXIT: "1" })
      expect({ mode, code: result.code }).toEqual({ mode, code: 1 })
    }
  })
})

// scripts/container-skill-probe.sh runs `opencode serve` and `wget` inside the OpenCode 2 container. Here both are
// fakes: `opencode` only stays alive and logs, and `wget` answers /api/skill from the state the probe edits (the
// package's SKILL.md and the config's plugin list) unless FAKE_SKILLS picks a failure.
const FAKE_OPENCODE = `#!/bin/sh
echo "fake opencode serve started"
echo $$ >"$PROBE_TMP/server.pid"
exec /bin/sleep 600
`

const FAKE_WGET = `#!/bin/sh
for last; do :; done
own() {
  printf '{"id":"oc-multi-imagegen","name":"oc-multi-imagegen","path":"/pluginpkg/skills/oc-multi-imagegen/SKILL.md","content":"%s"}' "$1"
}
builtin() { printf '{"id":"opencode","name":"OpenCode","path":"/builtin/opencode.md","content":"%s"}' "$1"; }
case $last in
  */api/location) echo '{"directory":"/work"}'; exit 0 ;;
esac
content=$(tr '\\n' ' ' <"$PROBE_PKG/skills/oc-multi-imagegen/SKILL.md")
case \${FAKE_SKILLS:-live} in
  down) echo "wget: server returned error: HTTP/1.1 500 Internal Server Error" >&2; exit 1 ;;
  truncated) printf '{"location":{"directory":"/work"},"data":[{"id":"oc-multi-imag'; exit 0 ;;
  # An exit-0 reply cut off after a complete entry, once the plugin has left the config.
  cut-after-entry)
    if grep -q '"/pluginpkg"' "$PROBE_CONFIG"; then
      printf '{"location":{"directory":"/work"},"data":[%s,%s]}' "$(builtin 'guide')" "$(own "$content")"
    else
      printf '{"location":{"directory":"/work"},"data":[%s' "$(builtin 'guide')"
    fi
    exit 0 ;;
  html) echo '<html>502 Bad Gateway for oc-multi-imagegen LIFECYCLE-MARKER</html>'; exit 0 ;;
  duplicate) printf '{"location":{},"data":[%s,%s]}' "$(own "$content")" "$(own "$content")"; exit 0 ;;
  # Another skill carries the marker while this skill's entry never changes.
  foreign-marker) printf '{"location":{},"data":[%s,%s]}' "$(builtin 'LIFECYCLE-MARKER')" "$(own 'unchanged')"; exit 0 ;;
  # The plugin entry stays registered after the plugin leaves the config.
  stale) printf '{"location":{},"data":[%s,%s]}' "$(builtin 'guide')" "$(own "$content")"; exit 0 ;;
esac
if grep -q '"/pluginpkg"' "$PROBE_CONFIG"; then
  printf '{"location":{"directory":"/work"},"data":[%s,%s]}' "$(builtin 'guide')" "$(own "$content")"
else
  printf '{"location":{"directory":"/work"},"data":[%s]}' "$(builtin 'guide')"
fi
`

function skillProbe() {
  const root = temporaryDirectory()
  const bin = path.join(root, "bin")
  mkdirSync(bin)
  writeFileSync(path.join(bin, "opencode"), FAKE_OPENCODE, { mode: 0o755 })
  writeFileSync(path.join(bin, "wget"), FAKE_WGET, { mode: 0o755 })
  writeFileSync(path.join(bin, "sleep"), "#!/bin/sh\nexec /bin/sleep 0.01\n", { mode: 0o755 })
  const pkg = path.join(root, "pkg")
  mkdirSync(path.join(pkg, "skills/oc-multi-imagegen"), { recursive: true })
  writeFileSync(path.join(pkg, "skills/oc-multi-imagegen/SKILL.md"), "# Image generation\nGuidance.\n")
  writeFileSync(path.join(pkg, "server.js"), "export default {}\n")
  const config = path.join(root, "opencode.json")
  const tmp = privateDirectory(root, "tmp")
  const configText = `{\n  "plugins": ["/pluginpkg"],\n  "update": "disable"\n}\n`
  writeFileSync(config, configText)
  const env = { PATH: `${bin}:${process.env.PATH}`, PROBE_PKG: pkg, PROBE_CONFIG: config, PROBE_TMP: tmp }
  return {
    pkg,
    config,
    configText,
    run: (mode: string, extra: Record<string, string> = {}) => exec(["sh", probe, mode], { ...env, ...extra }),
    skillText: () => readFileSync(path.join(pkg, "skills/oc-multi-imagegen/SKILL.md"), "utf-8"),
    serverStopped: () => {
      const pid = Number(readFileSync(path.join(tmp, "server.pid"), "utf-8"))
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    },
  }
}

describe("container-skill-probe.sh", () => {
  test("lifecycle reports each state it read from a successful reply, then stops its server", async () => {
    const p = skillProbe()

    const result = await p.run("lifecycle")

    expect(result.stdout).toBe("loaded: entries=1 marker=0\nupdated: entries=1 marker=1\nremoved: entries=0\n")
    expect(result.code).toBe(0)
    expect(p.skillText()).toContain("LIFECYCLE-MARKER")
    expect(readFileSync(p.config, "utf-8")).toBe(p.configText.replace('["/pluginpkg"]', "[]"))
    await until(p.serverStopped)
  })

  test("skills prints the list once the plugin's skill is in it", async () => {
    const p = skillProbe()

    const result = await p.run("skills")

    expect(result.code).toBe(0)
    expect(result.stdout).toStartWith('{"location":')
    expect(result.stdout.match(/\{"id":"oc-multi-imagegen"/g)).toHaveLength(1)
  })

  test("an unknown mode is a usage error", async () => {
    const result = await skillProbe().run("everything")

    expect(result.code).toBe(2)
    expect(result.stderr).toContain("usage")
  })

  // A failed request is not an empty list, and a state that never arrives is not a result: the probe exits 1,
  // reports only the states it did reach, and prints the last reply and the server's log.
  const failures: Array<{
    label: string
    mode: string
    skills: string
    noPlugin?: true
    reported: string
    seen: string
  }> = [
    {
      label: "a listing request that fails",
      mode: "skills",
      skills: "down",
      reported: "",
      seen: "request failed: wget: server returned error",
    },
    {
      label: "a truncated listing",
      mode: "skills",
      skills: "truncated",
      reported: "",
      seen: "reply is not a skill list",
    },
    {
      label: "a listing cut off after a complete entry, once the plugin has left the config",
      mode: "lifecycle",
      skills: "cut-after-entry",
      reported: "loaded: entries=1 marker=0\nupdated: entries=1 marker=1\n",
      seen: "reply is not a skill list",
    },
    {
      label: "an error page that names the skill",
      mode: "skills",
      skills: "html",
      reported: "",
      seen: "reply is not a skill list",
    },
    {
      label: "only built-in skills",
      mode: "skills",
      skills: "live",
      noPlugin: true,
      reported: "",
      seen: "saw entries=0 marker=0, wanted entries=1",
    },
    { label: "the skill listed twice", mode: "skills", skills: "duplicate", reported: "", seen: "saw entries=2" },
    {
      label: "a listing request that fails before the plugin loads",
      mode: "lifecycle",
      skills: "down",
      reported: "",
      seen: "request failed",
    },
    {
      label: "only built-in skills at the start",
      mode: "lifecycle",
      skills: "live",
      noPlugin: true,
      reported: "",
      seen: "saw entries=0 marker=0, wanted entries=1",
    },
    {
      label: "a marker that only another skill carries",
      mode: "lifecycle",
      skills: "foreign-marker",
      reported: "loaded: entries=1 marker=0\n",
      seen: "saw entries=1 marker=0, wanted entries=1 marker=1",
    },
    {
      label: "an entry that stays registered after the plugin leaves the config",
      mode: "lifecycle",
      skills: "stale",
      reported: "loaded: entries=1 marker=0\nupdated: entries=1 marker=1\n",
      seen: "saw entries=1 marker=1, wanted entries=0 marker=0",
    },
  ]
  test.each(failures)("fails on $label, with the last reply and the server log", async (failure) => {
    const p = skillProbe()
    if (failure.noPlugin) writeFileSync(p.config, p.configText.replace('["/pluginpkg"]', "[]"))

    const result = await p.run(failure.mode, { FAKE_SKILLS: failure.skills })

    expect(result.code).toBe(1)
    expect(result.stdout).toBe(failure.reported)
    expect(result.stderr).toContain("Probe failed: timed out waiting for")
    expect(result.stderr).toContain(failure.seen)
    expect(result.stderr).toContain("Last reply")
    expect(result.stderr).toContain("fake opencode serve started")
    await until(p.serverStopped)
  })
})

// scripts/container-backend-probe.sh runs `opencode serve` and `wget` inside a container. Here `wget` answers from
// what FAKE_REGISTERED and FAKE_PROVIDER_ENTRY say the host registered, with the openai-images methods in FAKE_METHODS.
const FAKE_BACKEND_WGET = `#!/bin/sh
for last; do :; done
registered() { [ -n "$FAKE_REGISTERED" ]; }
case $last in
  */api/location | */path) echo '{"directory":"/work"}' ;;
  */provider/auth*)
    if registered; then echo '{"openai":[{"type":"api","label":"Manually enter API Key"}],"openai-images":'"$FAKE_METHODS"'}'
    else echo '{"openai":[{"type":"api","label":"Manually enter API Key"}]}'; fi ;;
  */config*)
    if [ -n "$FAKE_PROVIDER_ENTRY" ]; then echo '{"provider":{"openai-images":{}}}'; else echo '{"model":"openai/example"}'; fi ;;
  */experimental/tool*)
    if [ -n "$FAKE_TOOLS" ]; then echo "$FAKE_TOOLS"
    else echo '[{"id":"invalid","description":"Do not use"},{"id":"imagegen","description":"Generate or edit one raster image through the OpenAI Images API. Load the skill.","parameters":{}}]'; fi ;;
  */api/integration)
    if registered; then echo '{"data":[{"id":"openai","name":"OpenAI","methods":[{"type":"key"}],"connections":[]},{"id":"openai-images","name":"OpenAI Images API","methods":'"$FAKE_METHODS"',"connections":[]}]}'
    else echo '{"data":[{"id":"openai","name":"OpenAI","methods":[{"type":"key"}],"connections":[]}]}'; fi ;;
  *) echo "wget: unexpected $last" >&2; exit 1 ;;
esac
`

// The methods each host reports for the plugin's key sign-in, as seen on the pinned hosts.
const REAL_METHODS = {
  v1: '[{"type":"api","label":"OpenAI Images API"}]',
  v2: '[{"type":"key"}]',
}

describe("container-backend-probe.sh", () => {
  function backendProbeRunner() {
    const root = temporaryDirectory()
    const bin = path.join(root, "bin")
    mkdirSync(bin)
    writeFileSync(path.join(bin, "opencode"), FAKE_OPENCODE, { mode: 0o755 })
    writeFileSync(path.join(bin, "wget"), FAKE_BACKEND_WGET, { mode: 0o755 })
    writeFileSync(path.join(bin, "sleep"), "#!/bin/sh\nexec /bin/sleep 0.01\n", { mode: 0o755 })
    const tmp = privateDirectory(root, "tmp")
    const env = { PATH: `${bin}:${process.env.PATH}`, PROBE_TMP: tmp }
    return (args: string[], extra: Record<string, string> = {}) =>
      exec(["sh", backendProbe, ...args], {
        FAKE_REGISTERED: "",
        FAKE_PROVIDER_ENTRY: "",
        FAKE_METHODS: REAL_METHODS[args[0] as "v1" | "v2"] ?? "[]",
        ...env,
        ...extra,
      })
  }

  test("OpenCode 1 with openai-api shows the key sign-in and the tool, and no provider entry", async () => {
    const result = await backendProbeRunner()(["v1", "openai-api"], { FAKE_REGISTERED: "1" })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('sign-in method: "openai-images":[{"type":"api","label":"OpenAI Images API"}]')
    expect(result.stdout).toContain("provider entry: none")
    expect(result.stdout).toContain("tool: Generate or edit one raster image through the OpenAI Images API.")
  })

  test("OpenCode 2 with openai-api shows the key-only integration", async () => {
    const result = await backendProbeRunner()(["v2", "openai-api"], { FAKE_REGISTERED: "1" })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain(
      'integration: {"id":"openai-images","name":"OpenAI Images API","methods":[{"type":"key"}]',
    )
  })

  test.each(["v1", "v2"])("codex registers nothing on %s", async (host) => {
    const result = await backendProbeRunner()([host, "codex"])

    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/(sign-in method|integration): none/)
  })

  test.each([
    ["v1", "openai-api", {}, "sign-in method is missing"],
    ["v2", "openai-api", {}, "integration is missing"],
    ["v1", "codex", { FAKE_REGISTERED: "1" }, "sign-in method is registered but should not be"],
    ["v2", "codex", { FAKE_REGISTERED: "1" }, "integration is registered but should not be"],
    [
      "v1",
      "openai-api",
      { FAKE_REGISTERED: "1", FAKE_PROVIDER_ENTRY: "1" },
      "provider entry is registered but should not be",
    ],
  ])("fails for %s with %s when %j", async (host, backend, extra, message) => {
    const result = await backendProbeRunner()([host, backend], extra)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(message)
    expect(result.stderr).toContain("Server log (last 30 lines):")
  })

  // The key is registered under openai-images, but not as the one key-only method the backend promises.
  test.each([
    ["v1", "an empty list", "[]"],
    ["v1", "another type", '[{"type":"oauth","label":"OpenAI Images API"}]'],
    ["v1", "an extra method", '[{"type":"api","label":"OpenAI Images API"},{"type":"oauth","label":"Other"}]'],
    ["v2", "an empty list", "[]"],
    ["v2", "another type", '[{"type":"oauth"}]'],
    ["v2", "an extra method", '[{"type":"key"},{"type":"oauth"}]'],
  ])("fails for %s when openai-images has %s as its methods", async (host, _name, methods) => {
    const result = await backendProbeRunner()([host, "openai-api"], { FAKE_REGISTERED: "1", FAKE_METHODS: methods })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain("has the wrong shape")
    expect(result.stderr).toContain("Server log (last 30 lines):")
  })

  test.each(["v1", "v2"])("codex still fails on %s when openai-images is registered with no methods", async (host) => {
    const result = await backendProbeRunner()([host, "codex"], { FAKE_REGISTERED: "1", FAKE_METHODS: "[]" })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain("is registered but should not be")
  })

  test("the OpenCode 1 tool check fails on a reply that has no imagegen entry", async () => {
    const result = await backendProbeRunner()(["v1", "openai-api"], {
      FAKE_REGISTERED: "1",
      FAKE_TOOLS: '{"error":"x"}',
    })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain("tool is missing")
  })

  test("an unknown host or backend is a usage error", async () => {
    expect((await backendProbeRunner()(["v3", "codex"])).code).toBe(2)
    expect((await backendProbeRunner()(["v1", "dall-e"])).code).toBe(2)
  })
})
