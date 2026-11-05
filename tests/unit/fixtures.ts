import { afterEach, beforeEach } from "bun:test"

// A 1x1 transparent PNG, recognized by file-type from its header bytes.
export const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

export const PNG_BUFFER = Buffer.from(PNG_BASE64, "base64")

// Real 3x2 RGB images encoded by Chromium canvas from a solid #2060a0 fill.
export const JPEG_BUFFER = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAACAAMDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAB//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AIUAcw4//9k=",
  "base64",
)
export const WEBP_BUFFER = Buffer.from(
  "UklGRhoCAABXRUJQVlA4WAoAAAAgAAAAAgAAAQAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggLAAAANABAJ0BKgMAAgABQCYloAJ0ugH4AAOwAP7w+iv/M0THMftX/+Uq8Fjc3wAA",
  "base64",
)

// Chromium canvas encodings, with the optional ICC profile and VP8X wrapper removed.
// Both simple containers decode to the same 3x2 image in Chromium.
export const LOSSLESS_WEBP_BUFFER = Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvAkAAAAdQsIIUtP+BiOh/AAA=", "base64")
export const LOSSY_WEBP_BUFFER = Buffer.from(
  "UklGRjgAAABXRUJQVlA4ICwAAADQAQCdASoDAAIAAUAmJaACdLoB+AADsAD+8Por/zNExzH7V//lKvBY3N8AAA==",
  "base64",
)

// A looping two-frame 3x2 GIF89a with a four-colour palette, encoded by hand; Chromium decodes its first frame as
// white, red and blue columns.
export const ANIMATED_GIF_BUFFER = Buffer.from(
  "R0lGODlhAwACAJEAAAAAAP////8AAAAA/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAwACAAACBIy4UCsAIfkEAAoAAAAsAAAAAAMAAgAAAgScmFEpADs=",
  "base64",
)

// A static SVG of the kind the OpenAI Images API documents: vector shapes, a gradient referenced within the document
// and a style sheet, with no script, external resource or embedded raster.
export const SVG_BUFFER = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 12" width="240" height="120"><defs><linearGradient id="sky"><stop offset="0" stop-color="#2060a0"/></linearGradient></defs><style>.sun{fill:#f0c020}</style><rect width="24" height="12" fill="url(#sky)"/><circle class="sun" cx="6" cy="6" r="3"/></svg>\n',
)

export function pngDataUrl(buf: Buffer): string {
  return `data:image/png;base64,${buf.toString("base64")}`
}

// Every environment variable the plugin or its OpenCode 1 credential lookup reads. Test files share one Bun process,
// so each file that loads the plugin or resolves a credential isolates them. Inherited values are never printed or
// exposed to a test: they are set aside, removed for each test and put back afterwards.
const PLUGIN_ENVIRONMENT = [
  "OPENCODE_AUTH_CONTENT",
  "OC_MULTI_IMAGEGEN_BACKEND",
  "OC_MULTI_IMAGEGEN_OPENAI_API_KEY",
  "OC_MULTI_IMAGEGEN_NANOGPT_API_KEY",
]

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
