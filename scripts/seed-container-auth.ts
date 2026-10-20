// Writes a disposable credential seed for a containerized OpenCode test from the host's own auth file.
// The seed carries the OpenAI ChatGPT access token, its expiry and account id, with a placeholder refresh
// token so the container can never rotate the host's session. Nothing but validity facts reaches stdout
// or stderr: errors name paths and reasons, never file contents.
//
//   --host v1  an OpenCode 1 auth.json, placed in the container's XDG data directory
//   --host v2  a file for `opencode auth import`
//
// The output path must be new. The seed is written to a fresh private file next to it and linked into
// place only after the host file is confirmed unchanged, so an existing file, symlink or hard link at the
// output path (including the host auth file itself) is refused and left as it was. The output directory
// must already exist, be owned by you and be private (mode 700); this script never creates or changes one.
import {
  closeSync,
  constants,
  fchmodSync,
  linkSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"

const REFRESH_PLACEHOLDER = "container-seed-has-no-refresh-token"
const USAGE = "Usage: bun scripts/seed-container-auth.ts --host v1|v2 --out <new file> [--min-hours 24]"

class SeedError extends Error {}

function seedFor(host: "v1" | "v2", openai: { access: string; expires: number; accountId?: string }) {
  if (host === "v1") {
    return {
      openai: {
        type: "oauth",
        access: openai.access,
        refresh: REFRESH_PLACEHOLDER,
        expires: openai.expires,
        ...(openai.accountId ? { accountId: openai.accountId } : {}),
      },
    }
  }
  return [
    {
      id: "crd_containerseed",
      integrationID: "openai",
      label: "OAuth",
      active: true,
      value: {
        type: "oauth",
        methodID: "chatgpt-browser",
        refresh: REFRESH_PLACEHOLDER,
        access: openai.access,
        expires: openai.expires,
        ...(openai.accountId ? { metadata: { accountID: openai.accountId } } : {}),
      },
    },
  ]
}

function main() {
  const { values } = parseArgs({
    options: {
      host: { type: "string" },
      out: { type: "string" },
      "min-hours": { type: "string", default: "24" },
    },
    strict: true,
  })
  if (!values.out || (values.host !== "v1" && values.host !== "v2")) throw new SeedError(USAGE)
  const minHours = Number(values["min-hours"])
  if (!Number.isFinite(minHours) || minHours <= 0) throw new SeedError("--min-hours must be a positive number")

  const out = path.resolve(values.out)
  const outDir = statSync(path.dirname(out), { throwIfNoEntry: false })
  if (!outDir?.isDirectory() || outDir.uid !== process.getuid?.() || (outDir.mode & 0o077) !== 0) {
    throw new SeedError(`${path.dirname(out)} must be an existing directory you own with mode 700.`)
  }

  // OpenCode resolves its data directory with xdg-basedir, which treats an empty XDG_DATA_HOME as unset.
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  const source = path.join(dataHome, "opencode", "auth.json")
  const before = statSync(source, { throwIfNoEntry: false })
  if (!before) throw new SeedError(`No OpenCode auth file at ${source}.`)
  let host: Record<string, Record<string, unknown> | undefined>
  try {
    host = JSON.parse(readFileSync(source, "utf-8"))
  } catch {
    throw new SeedError(`${source} is not valid JSON.`)
  }

  const openai = host.openai
  if (openai?.type !== "oauth" || typeof openai.access !== "string" || typeof openai.expires !== "number") {
    throw new SeedError("The host auth file has no OpenAI ChatGPT OAuth entry.")
  }
  const hoursLeft = (openai.expires - Date.now()) / 3_600_000
  if (hoursLeft < minHours) {
    throw new SeedError(
      `The host OpenAI access token has ${hoursLeft.toFixed(1)} h left; ${minHours} h required. Sign in again on the host.`,
    )
  }
  const seed = seedFor(values.host, {
    access: openai.access,
    expires: openai.expires,
    accountId: typeof openai.accountId === "string" ? openai.accountId : undefined,
  })

  const temporary = `${out}.${process.pid}.tmp`
  let created = false
  try {
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    created = true
    try {
      fchmodSync(fd, 0o600)
      writeSync(fd, JSON.stringify(seed))
    } finally {
      closeSync(fd)
    }
    const after = statSync(source)
    if (after.mtimeMs !== before.mtimeMs || after.size !== before.size || after.ino !== before.ino) {
      throw new SeedError("The host auth file changed while it was read; no seed was written.")
    }
    try {
      // link() fails on any existing path, including a symlink or a hard link to another file.
      linkSync(temporary, out)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new SeedError(`${out} already exists; the seed is only written to a new path.`)
      }
      throw error
    }
  } finally {
    // Only the file this run created; an earlier file at that name is not ours to remove.
    if (created) unlinkSync(temporary)
  }
  console.log(`Wrote ${out} (OpenAI access token valid for ${hoursLeft.toFixed(1)} h, placeholder refresh token).`)
}

try {
  main()
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code
  console.error(error instanceof SeedError ? error.message : `Seed failed${code ? ` (${code})` : ""}.`)
  process.exitCode = 1
}
