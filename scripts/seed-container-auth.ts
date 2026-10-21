// Writes a disposable credential seed for a containerized OpenCode test from the host's own auth file.
// The seed carries the OpenAI ChatGPT access token, its expiry and account id, with a placeholder refresh
// token so the container can never rotate the host's session. Nothing but validity facts reaches stdout
// or stderr: errors name paths and reasons, never file contents.
//
//   --host v1  an OpenCode 1 auth.json, placed in the container's XDG data directory
//   --host v2  a file for `opencode auth import`
//
// --image-key-env-file <dotenv file> --image-key-env-out <new file> hands the OpenAI Images API key to the container
// the way a deployment does: the second file is a Docker env file holding OC_MULTI_IMAGEGEN_OPENAI_API_KEY. The key
// comes from the OPENAI_API_KEY line of the dotenv file, which is read here and nowhere else; it is never printed and
// never passed on a command line. The seed then also holds a synthetic saved `openai-images` credential, so a run
// that succeeds with the real key shows that the variable took precedence over a saved key.
//
// Each output path must be new. Files are written to fresh private files next to their paths and linked into
// place only after the host file is confirmed unchanged, so an existing file, symlink or hard link at an
// output path (including the host auth file itself) is refused and left as it was. Each output directory
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
import { parseArgs, parseEnv } from "node:util"

const REFRESH_PLACEHOLDER = "container-seed-has-no-refresh-token"
const USAGE =
  "Usage: bun scripts/seed-container-auth.ts --host v1|v2 --out <new file> [--min-hours 24] [--image-key-env-file <dotenv file> --image-key-env-out <new file>]"
// The dotenv file's name for the key, and the variable the plugin reads.
const IMAGE_KEY_VARIABLE = "OPENAI_API_KEY"
const PLUGIN_KEY_VARIABLE = "OC_MULTI_IMAGEGEN_OPENAI_API_KEY"
// Saved under `openai-images` in the seed. OpenAI would not accept it.
const SAVED_IMAGE_KEY_DECOY = "sk-synthetic-decoy-not-a-real-key"

class SeedError extends Error {}

// Reads the last OPENAI_API_KEY assignment of a dotenv file. Errors name the file and the reason, never its contents.
function readImageKey(file: string): string {
  const stat = statSync(file, { throwIfNoEntry: false })
  if (!stat?.isFile()) throw new SeedError(`${file} is not a file.`)
  const key = parseEnv(readFileSync(file, "utf-8"))[IMAGE_KEY_VARIABLE]
  if (!key) throw new SeedError(`${file} has no ${IMAGE_KEY_VARIABLE} value.`)
  if (!/^[\x21-\x7e]+$/.test(key)) {
    throw new SeedError(`The ${IMAGE_KEY_VARIABLE} value in ${file} is not usable as an API key.`)
  }
  return key
}

function seedFor(
  host: "v1" | "v2",
  openai: { access: string; expires: number; accountId?: string },
  savedImageKey?: string,
) {
  if (host === "v1") {
    return {
      openai: {
        type: "oauth",
        access: openai.access,
        refresh: REFRESH_PLACEHOLDER,
        expires: openai.expires,
        ...(openai.accountId ? { accountId: openai.accountId } : {}),
      },
      ...(savedImageKey ? { "openai-images": { type: "api", key: savedImageKey } } : {}),
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
    ...(savedImageKey
      ? [
          {
            id: "crd_containerimages",
            integrationID: "openai-images",
            label: "API key",
            active: true,
            value: { type: "key", key: savedImageKey },
          },
        ]
      : []),
  ]
}

function main() {
  const { values } = parseArgs({
    options: {
      host: { type: "string" },
      out: { type: "string" },
      "min-hours": { type: "string", default: "24" },
      "image-key-env-file": { type: "string" },
      "image-key-env-out": { type: "string" },
    },
    strict: true,
  })
  if (!values.out || (values.host !== "v1" && values.host !== "v2")) throw new SeedError(USAGE)
  if (!values["image-key-env-file"] !== !values["image-key-env-out"]) throw new SeedError(USAGE)
  const minHours = Number(values["min-hours"])
  if (!Number.isFinite(minHours) || minHours <= 0) throw new SeedError("--min-hours must be a positive number")

  const out = path.resolve(values.out)
  const envOut = values["image-key-env-out"] ? path.resolve(values["image-key-env-out"]) : undefined
  if (out === envOut) throw new SeedError("--out and --image-key-env-out must be different paths.")
  for (const target of envOut ? [out, envOut] : [out]) {
    const outDir = statSync(path.dirname(target), { throwIfNoEntry: false })
    if (!outDir?.isDirectory() || outDir.uid !== process.getuid?.() || (outDir.mode & 0o077) !== 0) {
      throw new SeedError(`${path.dirname(target)} must be an existing directory you own with mode 700.`)
    }
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
  const imageKeyFile = values["image-key-env-file"]
  const imageKey = imageKeyFile ? readImageKey(path.resolve(imageKeyFile)) : undefined
  const seed = seedFor(
    values.host,
    {
      access: openai.access,
      expires: openai.expires,
      accountId: typeof openai.accountId === "string" ? openai.accountId : undefined,
    },
    imageKey ? SAVED_IMAGE_KEY_DECOY : undefined,
  )

  // Every file is staged privately first; none is linked into place until the host file is confirmed unchanged.
  const staged: Array<{ out: string; temporary: string }> = []
  const linked: string[] = []
  try {
    staged.push(stageFile(out, JSON.stringify(seed)))
    if (envOut) staged.push(stageFile(envOut, `${PLUGIN_KEY_VARIABLE}=${imageKey}\n`))
    const after = statSync(source)
    if (after.mtimeMs !== before.mtimeMs || after.size !== before.size || after.ino !== before.ino) {
      throw new SeedError("The host auth file changed while it was read; no seed was written.")
    }
    for (const file of staged) {
      try {
        // link() fails on any existing path, including a symlink or a hard link to another file.
        linkSync(file.temporary, file.out)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new SeedError(`${file.out} already exists; the seed is only written to a new path.`)
        }
        throw error
      }
      linked.push(file.out)
    }
  } catch (error) {
    // The seed is all or nothing: remove the paths this run linked before reporting the failure.
    for (const file of linked) unlinkSync(file)
    throw error
  } finally {
    // Only the files this run created; an earlier file at that name is not ours to remove.
    for (const file of staged) unlinkSync(file.temporary)
  }
  console.log(
    `Wrote ${out} (OpenAI access token valid for ${hoursLeft.toFixed(1)} h, placeholder refresh token${imageKey ? ", synthetic saved image key" : ""}).`,
  )
  if (envOut) console.log(`Wrote ${envOut} (OpenAI Images API key as ${PLUGIN_KEY_VARIABLE}).`)
}

// Creates a private temporary file next to `out` exclusively and writes the content. If the name is already taken,
// the existing file is not ours to remove and stays as it was.
function stageFile(out: string, content: string): { out: string; temporary: string } {
  const temporary = `${out}.${process.pid}.tmp`
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    try {
      fchmodSync(fd, 0o600)
      writeSync(fd, content)
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    // The caller records the file only when this returns, so any failure after creating it removes it here.
    unlinkSync(temporary)
    throw error
  }
  return { out, temporary }
}

try {
  main()
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code
  console.error(error instanceof SeedError ? error.message : `Seed failed${code ? ` (${code})` : ""}.`)
  process.exitCode = 1
}
