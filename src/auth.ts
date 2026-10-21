import * as fs from "node:fs/promises"
import * as path from "node:path"
import { xdgData } from "xdg-basedir"
import type { CredentialSpec, ImageCredential } from "./types"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Mirrors OpenCode 1's auth resolution: OPENCODE_AUTH_CONTENT overrides $XDG_DATA_HOME/opencode/auth.json, content
// that does not parse falls through to the file, and a missing or unreadable file means no credentials. The Auth
// service is not exposed to external plugins, so this reproduces the rules directly. Errors are dropped on purpose:
// a parse error can quote the text it failed on, and that text is credential material.
async function loadAuthData(): Promise<Record<string, unknown>> {
  if (process.env.OPENCODE_AUTH_CONTENT) {
    try {
      const parsed: unknown = JSON.parse(process.env.OPENCODE_AUTH_CONTENT)
      return isRecord(parsed) ? parsed : {}
    } catch {
      // Falls through to the file, as OpenCode does.
    }
  }
  if (!xdgData) return {}
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(xdgData, "opencode", "auth.json"), "utf-8"))
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

// Reads the one stored entry the backend consumes, on every call so a changed credential applies to the next call.
// Entries of other providers are never returned. OpenCode 1 stores a key credential as `{ type: "api", key }`.
export async function loadStoredCredential(spec: CredentialSpec): Promise<ImageCredential | undefined> {
  const entry = (await loadAuthData())[spec.provider]
  if (!isRecord(entry)) return undefined
  if (spec.type === "oauth" && entry.type === "oauth" && typeof entry.access === "string") {
    return {
      type: "oauth",
      access: entry.access,
      ...(typeof entry.accountId === "string" ? { accountId: entry.accountId } : {}),
    }
  }
  if (spec.type === "key" && entry.type === "api" && typeof entry.key === "string" && entry.key) {
    return { type: "key", key: entry.key }
  }
  return undefined
}
