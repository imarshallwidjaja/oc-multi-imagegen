import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pickNonOverwritePath } from "../../src/output-image"
import { PNG_BUFFER } from "./fixtures"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "out-image-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// Place a real PNG at the path so it is occupied; pickNonOverwritePath only checks existence.
function occupy(p: string): Promise<void> {
  return writeFile(p, PNG_BUFFER)
}

describe("pickNonOverwritePath", () => {
  test("returns the requested path when nothing exists", async () => {
    const requested = path.join(dir, "image.png")
    expect(await pickNonOverwritePath(requested)).toBe(requested)
  })

  test("appends -v2 when the requested path exists", async () => {
    const requested = path.join(dir, "image.png")
    await occupy(requested)
    expect(await pickNonOverwritePath(requested)).toBe(path.join(dir, "image-v2.png"))
  })

  test("skips to the first free suffix when earlier versions exist", async () => {
    const requested = path.join(dir, "image.png")
    await occupy(requested)
    await occupy(path.join(dir, "image-v2.png"))
    expect(await pickNonOverwritePath(requested)).toBe(path.join(dir, "image-v3.png"))
  })

  test("preserves the extension and stem in the versioned name", async () => {
    const requested = path.join(dir, "my.photo.jpeg")
    await occupy(requested)
    expect(await pickNonOverwritePath(requested)).toBe(path.join(dir, "my.photo-v2.jpeg"))
  })

  test("throws once every version up to the limit is taken", async () => {
    // maxVersion is lowered to 2 so we can fill the suffix space without writing 999 files.
    const requested = path.join(dir, "image.png")
    await occupy(requested)
    await occupy(path.join(dir, "image-v2.png"))
    expect(pickNonOverwritePath(requested, 2)).rejects.toThrow(
      `could not find a non-conflicting filename under ${dir}/image-vN.png (tried up to v2)`,
    )
  })
})
