import { afterEach, beforeEach } from "bun:test"

// A 1x1 transparent PNG, recognized by file-type from its header bytes.
export const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

export const PNG_BUFFER = Buffer.from(PNG_BASE64, "base64")

export function pngDataUrl(buf: Buffer): string {
  return `data:image/png;base64,${buf.toString("base64")}`
}

// Every environment variable the plugin or its OpenCode 1 credential lookup reads. Test files share one Bun process,
// so each file that loads the plugin or resolves a credential isolates them. Inherited values are never printed or
// exposed to a test: they are set aside, removed for each test and put back afterwards.
const PLUGIN_ENVIRONMENT = ["OPENCODE_AUTH_CONTENT", "OC_MULTI_IMAGEGEN_BACKEND", "OC_MULTI_IMAGEGEN_OPENAI_API_KEY"]

export function isolateEnvironment(): void {
  const inherited = new Map<string, string | undefined>()
  beforeEach(() => {
    for (const name of PLUGIN_ENVIRONMENT) {
      inherited.set(name, process.env[name])
      delete process.env[name]
    }
  })
  afterEach(() => {
    for (const name of PLUGIN_ENVIRONMENT) {
      const value = inherited.get(name)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
}
