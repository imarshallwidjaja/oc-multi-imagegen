import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import type { FileHandle } from "node:fs/promises"
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { RASTER_FORMATS } from "../../src/image-format"
import { MAX_PREVIEW_BYTES, saveGeneratedImage } from "../../src/output-image"
import { inspectSvg } from "../../src/svg"
import { ANIMATED_GIF_BUFFER, JPEG_BUFFER, PNG_BUFFER, pngChunk, SVG_BUFFER, solidPng, WEBP_BUFFER } from "./fixtures"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "out-image-"))
})

afterEach(async () => {
  await chmod(dir, 0o700)
  await rm(dir, { recursive: true, force: true })
})

// Saving through both hosts, extension handling and refusals that create nothing are covered in imagegen.test.ts.
// These cases own how a file name is claimed and written.
const save = (out: string, bytes: Uint8Array = PNG_BUFFER) => saveGeneratedImage(out, dir, bytes, RASTER_FORMATS)
// Distinct PNG payloads: trailing bytes keep the header, so each is still a 1x1 PNG.
const pngWith = (marker: string) => Buffer.concat([PNG_BUFFER, Buffer.from(marker)])

describe("saveGeneratedImage", () => {
  test("keeps existing files and saves under the first free -vN suffix, before the extension", async () => {
    await writeFile(path.join(dir, "my.photo.png"), "first")
    await writeFile(path.join(dir, "my.photo-v2.png"), "second")

    const saved = await save("my.photo.png")

    expect(saved).toMatchObject({ savedPath: path.join(dir, "my.photo-v3.png"), versioned: true })
    expect(await readFile(saved.savedPath)).toEqual(PNG_BUFFER)
    expect(await readFile(path.join(dir, "my.photo.png"), "utf8")).toBe("first")
    expect(await readFile(path.join(dir, "my.photo-v2.png"), "utf8")).toBe("second")
  })

  test("gives each concurrent save of one target its own file with its own bytes", async () => {
    const payloads = Array.from({ length: 8 }, (_, index) => pngWith(`payload ${index}`))

    const saved = await Promise.all(payloads.map((bytes) => save("cat.png", bytes)))

    const names = saved.map((result) => path.basename(result.savedPath))
    expect([...names].sort()).toEqual(
      ["cat.png", ...Array.from({ length: 7 }, (_, index) => `cat-v${index + 2}.png`)].sort(),
    )
    expect(saved.filter((result) => !result.versioned)).toHaveLength(1)
    for (const [index, result] of saved.entries()) expect(await readFile(result.savedPath)).toEqual(payloads[index])
  })

  test("does not follow a dangling symbolic link at the target", async () => {
    await mkdir(path.join(dir, "elsewhere"))
    await symlink(path.join(dir, "elsewhere", "victim.png"), path.join(dir, "cat.png"))

    const saved = await save("cat.png")

    expect(saved).toMatchObject({ savedPath: path.join(dir, "cat-v2.png"), versioned: true })
    expect(await readdir(path.join(dir, "elsewhere"))).toEqual([])
    expect((await lstat(path.join(dir, "cat.png"))).isSymbolicLink()).toBe(true)
  })

  test("fails once every suffix up to -v999 is taken, creating nothing", async () => {
    await writeFile(path.join(dir, "cat.png"), "taken")
    for (let version = 2; version <= 999; version++) await writeFile(path.join(dir, `cat-v${version}.png`), "taken")

    await expect(save("cat.png")).rejects.toThrow(
      `could not find a non-conflicting filename under ${dir}/cat-vN.png (tried up to v999)`,
    )
    expect(await readdir(dir)).toHaveLength(999)
  })

  test("stops at a failure other than an existing name, leaving existing files alone", async () => {
    await writeFile(path.join(dir, "cat.png"), "first")
    await chmod(dir, 0o500)

    const error = (await save("cat.png").catch((caught: NodeJS.ErrnoException) => caught)) as NodeJS.ErrnoException

    expect(error.code).toBe("EACCES")
    await chmod(dir, 0o700)
    expect(await readdir(dir)).toEqual(["cat.png"])
    expect(await readFile(path.join(dir, "cat.png"), "utf8")).toBe("first")
  })

  // A real write or close failure needs a full disk or a failing device, so these cases fail the call's file handle
  // after the file was created, keeping the file system's own behavior for creation and removal.
  const handlePrototype = async () => {
    const probe = await open(os.devNull)
    await probe.close()
    return Object.getPrototypeOf(probe) as FileHandle
  }
  const failWrite = async (failure: Error, afterPartialWrite = async () => {}) =>
    spyOn(await handlePrototype(), "writeFile").mockImplementationOnce(async function (this: FileHandle, data) {
      await this.write((data as Uint8Array).subarray(0, 8))
      await afterPartialWrite()
      throw failure
    })

  test("removes the file it created when the write fails, and rejects with that failure", async () => {
    await writeFile(path.join(dir, "cat.png"), "first")
    const failure = new Error("disk full")
    const failing = await failWrite(failure)

    try {
      await expect(save("cat.png")).rejects.toBe(failure)
    } finally {
      failing.mockRestore()
    }

    expect(await readdir(dir)).toEqual(["cat.png"])
    expect(await readFile(path.join(dir, "cat.png"), "utf8")).toBe("first")
  })

  test("removes the file it created when closing it fails, and rejects with that failure", async () => {
    const failure = new Error("close failed")
    const prototype = await handlePrototype()
    const close = prototype.close
    const failing = spyOn(prototype, "close").mockImplementationOnce(async function (this: FileHandle) {
      await close.call(this)
      throw failure
    })

    try {
      await expect(save("cat.png")).rejects.toBe(failure)
    } finally {
      failing.mockRestore()
    }

    expect(await readdir(dir)).toEqual([])
  })

  test("reports a failed removal with the write failure and the path where a partial file may remain", async () => {
    const failure = new Error("disk full")
    // Removing the file then fails, because its directory no longer allows changes.
    const failing = await failWrite(failure, () => chmod(dir, 0o500))

    const error = (await save("cat.png")
      .catch((caught: AggregateError) => caught)
      .finally(() => failing.mockRestore())) as AggregateError

    const savedPath = path.join(dir, "cat.png")
    expect(error.message).toContain(`could not write ${savedPath}: disk full`)
    expect(error.message).toContain("a partial file may remain there")
    expect(error.errors[0]).toBe(failure)
    expect((error.errors.at(-1) as NodeJS.ErrnoException).code).toBe("EACCES")
    await chmod(dir, 0o700)
    expect(await readFile(savedPath)).toEqual(PNG_BUFFER.subarray(0, 8))
  })
})

// Whether a saved image can be attached inline. How each host returns it is covered in v1.test.ts and v2.test.ts.
// The warning for a requested transparent background that is missing is covered through both hosts in
// imagegen.test.ts. These cases own the PNGs whose alpha the plugin cannot measure, which must not be reported opaque.
describe("saveGeneratedImage transparency warning", () => {
  // The 8-byte signature and the 25-byte IHDR chunk come first in every PNG solidPng builds.
  const IHDR_END = 33
  const rgbWithTrns = (() => {
    const png = solidPng(2, 2)
    return Buffer.concat([png.subarray(0, IHDR_END), pngChunk("tRNS", new Uint8Array(6)), png.subarray(IHDR_END)])
  })()
  const interlacedRgba = (() => {
    const png = solidPng(2, 2, 255)
    const header = Buffer.from(png.subarray(16, 29))
    header[12] = 1
    return Buffer.concat([png.subarray(0, 8), pngChunk("IHDR", header), png.subarray(IHDR_END)])
  })()

  test.each([
    ["an RGB PNG with a tRNS chunk", rgbWithTrns, "tRNS transparency is not measured"],
    ["an interlaced RGBA PNG", interlacedRgba, "interlaced PNG"],
  ])("does not warn for %s, whose alpha is not measured", async (_name, bytes, reason) => {
    const saved = await saveGeneratedImage("out.png", dir, bytes, RASTER_FORMATS, { expectTransparent: true })

    expect(saved.message).toContain(`alpha not measured (${reason})`)
    expect(saved.message).not.toContain("Warning:")
  })
})

describe("saveGeneratedImage inline preview", () => {
  const ALL_FORMATS = [...RASTER_FORMATS, "gif", "svg"] as const
  const savePreview = (out: string, bytes: Uint8Array, preview = true) =>
    saveGeneratedImage(out, dir, bytes, ALL_FORMATS, { preview })

  test("attaches nothing and adds no note unless the call asks for a preview", async () => {
    const saved = await savePreview("cat.png", PNG_BUFFER, false)

    expect(saved.preview).toBeUndefined()
    expect(saved.message).not.toContain("preview")
  })

  test.each([
    ["PNG", PNG_BUFFER, "image/png"],
    ["JPEG", JPEG_BUFFER, "image/jpeg"],
    ["WebP", WEBP_BUFFER, "image/webp"],
  ] as const)("attaches the saved %s bytes with their MIME type", async (_name, bytes, mime) => {
    const saved = await savePreview("cat", bytes)

    expect(saved.preview).toEqual({ mime, bytes })
    expect(await readFile(saved.savedPath)).toEqual(bytes)
    expect(saved.message).not.toContain("preview")
  })

  test.each([
    ["GIF", ANIMATED_GIF_BUFFER, "cat.gif"],
    ["SVG", SVG_BUFFER, "cat.svg"],
  ] as const)("omits a %s with a note naming the saved file", async (name, bytes, file) => {
    const saved = await savePreview("cat", bytes)

    expect(saved.preview).toBeUndefined()
    expect(saved.message).toEndWith(
      ` Inline preview omitted: ${name} cannot be attached inline; inspect the saved file at ${path.join(dir, file)}.`,
    )
  })

  test("attaches an image of exactly 3.5 MiB and omits one byte more with a note", async () => {
    const padded = (length: number) => Buffer.concat([PNG_BUFFER, Buffer.alloc(length - PNG_BUFFER.length)])

    const atLimit = await savePreview("limit.png", padded(MAX_PREVIEW_BYTES))
    const over = await savePreview("over.png", padded(MAX_PREVIEW_BYTES + 1))

    expect(MAX_PREVIEW_BYTES).toBe(3.5 * 1024 * 1024)
    expect(atLimit.preview?.bytes.length).toBe(MAX_PREVIEW_BYTES)
    expect(over.preview).toBeUndefined()
    expect(over.message).toEndWith(
      ` Inline preview omitted: the image is 3670017 bytes (limit 3670016 bytes); use read on ${over.savedPath}.`,
    )
  })
})

// The SVG contract the OpenAI Images API documents: static vector content without scripts, external resources or
// embedded rasters. Saving through both hosts, and that a refusal writes nothing, are covered in imagegen.test.ts.
const NS = 'xmlns="http://www.w3.org/2000/svg"'
const svg = (body: string, root = `${NS} viewBox="0 0 10 5"`) => Buffer.from(`<svg ${root}>${body}</svg>`)

describe("inspectSvg", () => {
  test.each([
    ["the documented static form", SVG_BUFFER, "viewBox 0 0 24 12, width 240 and height 120"],
    [
      "a byte order mark and leading whitespace",
      Buffer.from(`\ufeff\n  <svg ${NS} viewBox="0,0,10,5"/>`),
      "viewBox 0 0 10 5",
    ],
    ["width and height without a viewBox", svg("", `${NS} width="64px" height="3.2e1"`), "width 64px and height 32"],
    [
      "percentages beside a viewBox",
      svg("", `${NS} width="100%" height="100%" viewBox="0 0 10 5"`),
      "viewBox 0 0 10 5",
    ],
    [
      "references within the document",
      svg('<use href="#a"/><path id="a" style="fill:url( #g )"/>'),
      "viewBox 0 0 10 5",
    ],
    // CSS skips space, tab and line breaks around a url() target; a URL parser strips leading C0 controls and space.
    [
      "references within the document after ASCII whitespace",
      svg(`<use href="&#9; #a"/><path id="a" fill="url(&#9;#g)" style="stroke:url( &#10;' #g' )"/>`),
      "viewBox 0 0 10 5",
    ],
    [
      "static styles, comments and quoted font names",
      svg(
        "<style>/* palette */ .a{fill:#f80;stroke:url('#g')}</style>" +
          `<text class="a" font-family="'Inter', sans-serif" transform="rotate(45 5 5)" style="fill:url(#g);font-family:'Inter'">Lantern</text>`,
      ),
      "viewBox 0 0 10 5",
    ],
    [
      "same-document filters",
      svg(
        '<filter id="f"><feGaussianBlur stdDeviation="1"/></filter>' +
          '<rect filter="url(#f)" style="filter:url(#f) drop-shadow(0 0 1px red)"/>',
      ),
      "viewBox 0 0 10 5",
    ],
    // Only style sheets, style attributes and presentation attributes are CSS; other attribute text is not checked as CSS.
    [
      "text attributes that hold quotes, parentheses, backslashes and function-like text",
      svg(
        `<g aria-label="Lantern (artist's impression)" data-caption='image-set("x.png" 1x) or src(m.svg)' ` +
          'data-path="C:\\files"><rect/></g>',
      ),
      "viewBox 0 0 10 5",
    ],
    [
      "metadata in another vocabulary",
      svg('<metadata><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></metadata>'),
      "viewBox 0 0 10 5",
    ],
  ])("accepts %s and reports its vector geometry", (_name, bytes, geometry) => {
    expect(inspectSvg(bytes)).toEqual({ ok: true, geometry })
  })

  const invalidUtf8 = Buffer.concat([
    Buffer.from(`<svg ${NS} viewBox="0 0 1 1">`),
    Buffer.from([0xff]),
    Buffer.from("</svg>"),
  ])
  test.each([
    ["invalid UTF-8", invalidUtf8, "it is not UTF-8 text"],
    ["unclosed markup", Buffer.from(`<svg ${NS} viewBox="0 0 1 1"><g>`), "it is not well-formed XML"],
    ["an undefined entity", svg("<text>&nbsp;</text>"), "it is not well-formed XML"],
    ["a DOCTYPE", Buffer.from(`<!DOCTYPE svg><svg ${NS} viewBox="0 0 1 1"/>`), "it has a DOCTYPE declaration"],
    [
      "a style sheet link",
      Buffer.from(`<?xml-stylesheet href="x.css"?><svg ${NS} viewBox="0 0 1 1"/>`),
      "processing instruction",
    ],
    ["a root outside the SVG namespace", Buffer.from('<svg viewBox="0 0 1 1"/>'), "its root element is not svg"],
    ["an HTML root", Buffer.from('<html xmlns="http://www.w3.org/1999/xhtml"/>'), "its root element is not svg"],
    ["a script", svg("<script>alert(1)</script>"), "it contains a <script> element"],
    ["foreign content", svg("<foreignObject/>"), "it contains a <foreignObject> element"],
    ["an embedded raster", svg('<image href="data:image/png;base64,AAAA"/>'), "it contains a <image> element"],
    ["a filter image", svg('<filter><feImage href="#a"/></filter>'), "it contains a <feImage> element"],
    ["animation", svg('<rect><animate attributeName="x"/></rect>'), "it contains a <animate> element"],
    ["an XHTML element", svg('<h:script xmlns:h="http://www.w3.org/1999/xhtml"/>'), "outside the SVG namespace"],
    [
      "an XHTML element inside metadata",
      svg('<metadata><h:p xmlns:h="http://www.w3.org/1999/xhtml"/></metadata>'),
      "outside the SVG namespace",
    ],
    ["an event handler", svg('<rect onclick="x()"/>'), "it has an event handler attribute"],
    ["an external link", svg('<a href="https://example.com"><rect/></a>'), "it links to an external resource"],
    ["a javascript link written with a character reference", svg('<a href="&#106;avascript:x()"/>'), "it links to"],
    [
      "an external xlink:href",
      svg('<use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="other.svg#a"/>'),
      "it links to an external resource",
    ],
    ["an external url() in an attribute", svg('<rect fill="url(https://example.com/p.svg#g)"/>'), "through url()"],
    ["an external url() in a style sheet", svg("<style>.a{background:url('x.png')}</style>"), "through url()"],
    [
      "a style sheet import in CDATA",
      svg("<style><![CDATA[@import 'x.css';]]></style>"),
      "its style sheet has an at-rule",
    ],
    // CSS escapes and image functions can load a resource that the literal url() and at-rule checks would miss.
    [
      "an escaped url() in a style sheet",
      svg("<style>rect{fill:u\\72l(https://evil.example/p.svg#g)}</style>"),
      "it uses a CSS escape",
    ],
    [
      "an escaped url() in a style attribute",
      svg("<rect style='mask-image:u\\rl(https://evil.example/m.png)'/>"),
      "it uses a CSS escape",
    ],
    [
      "an escaped url() in a presentation attribute",
      svg('<rect fill="u\\72l(https://evil.example/p.svg#g)"/>'),
      "it uses a CSS escape",
    ],
    [
      "an escape written as a character reference",
      svg('<rect style="fill:u&#92;72l(https://evil.example/p.svg#g)"/>'),
      "it uses a CSS escape",
    ],
    ["an escaped @import", svg('<style>@\\69mport "https://evil.example/x.css";</style>'), "it uses a CSS escape"],
    ["an escaped presentation attribute", svg('<path pathLength="1\\0"/>'), "it uses a CSS escape"],
    // CSS reads an unquoted url() body literally, so a comment delimiter or quote there must not hide the code after it.
    [
      "an image function between comment delimiters in unquoted url()",
      svg(`<rect style='fill:url(#a/*);mask-image:image-set("https://evil.example/m.png" 1x);stroke:url(#b*/)'/>`),
      "holds a comment delimiter or a quote",
    ],
    [
      "keyframes and an animation between comment delimiters in unquoted url()",
      svg("<style>rect{fill:url(#a/*)}@keyframes s{to{opacity:0}}rect{animation:s 1s;stroke:url(#b*/)}</style>"),
      "holds a comment delimiter or a quote",
    ],
    [
      "an image function after a quote in unquoted url()",
      svg(`<rect style='fill:url(#a"x);mask-image:image-set("https://evil.example/m.png" 1x)'/>`),
      "holds a comment delimiter or a quote",
    ],
    // U+00A0 is not CSS whitespace: CSS reads it as the start of an unquoted url(), which then ends at the first ")".
    [
      "an image function after a quote that follows a no-break space in url()",
      svg(`<rect style="fill:url(&#160;&quot;#a);mask-image:image-set('https://e.invalid/m.png' 1x);x:&quot;)"/>`),
      "through url()",
    ],
    ["a url() target that starts with a no-break space", svg('<rect fill="url(&#160;#a)"/>'), "through url()"],
    ["a quoted url() target that starts with a no-break space", svg(`<rect fill="url('&#160;#a')"/>`), "through url()"],
    // A URL parser does not strip U+00A0, so the reference resolves against another document.
    ["a link that starts with a no-break space", svg('<use href="&#160;#a"/>'), "it links to an external resource"],
    [
      "an xlink:href that starts with a no-break space",
      svg('<use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="&#160;#a"/>'),
      "it links to an external resource",
    ],
    ["escaped embedded data", svg("<rect style='fill:url(d\\61ta:image/png;base64,AAAA)'/>"), "it uses a CSS escape"],
    [
      "a resource string in image-set()",
      svg(`<rect style='mask-image:image-set("https://evil.example/m.png" 1x)'/>`),
      "it uses a CSS image function",
    ],
    ["a resource string in src()", svg("<style>rect{mask-image:src('m.svg')}</style>"), "it uses a CSS image function"],
    [
      "a custom property passed to image-set()",
      svg(`<rect style='--u:"https://evil.example/m.png";mask-image:image-set(var(--u) 1x)'/>`),
      "it uses a CSS image function",
    ],
    [
      "a custom property passed to src()",
      svg(`<style>rect{--u:"m.svg";mask-image:src(var(--u))}</style>`),
      "it uses a CSS image function",
    ],
    [
      "a prefixed image-set() in a presentation attribute",
      svg(`<rect style='--u:"https://evil.example/m.png"' mask="-webkit-image-set(var(--u) 1x)"/>`),
      "it uses a CSS image function",
    ],
    ["image()", svg('<rect style="mask-image:image(var(--u))"/>'), "it uses a CSS image function"],
    [
      "a prefixed cross-fade()",
      svg("<style>rect{mask-image:-webkit-cross-fade(var(--a), var(--b), 50%)}</style>"),
      "it uses a CSS image function",
    ],
    ["a string @import", svg('<style>@import "https://evil.example/x.css";</style>'), "has an at-rule"],
    ["keyframes", svg("<style>@keyframes spin{to{opacity:0}}</style>"), "has an at-rule"],
    ["an animation property", svg("<style>rect{animation:spin 1s infinite}</style>"), "animation or transition"],
    ["a prefixed transition", svg('<rect style="-webkit-transition-duration:1s"/>'), "animation or transition"],
    [
      "an animation between comments that hold quotes",
      svg('<style>/* " */ rect{animation:spin 1s} /* " */</style>'),
      "animation or transition",
    ],
    [
      "an animation after an unterminated string",
      svg('<style>rect{font-family:"a\n}rect{animation:spin 1s}</style>'),
      "animation or transition",
    ],
    [
      "an xml:base that redirects a fragment",
      svg('<g xml:base="https://evil.example/"><use href="#a"/></g>'),
      "it sets xml:base",
    ],
    ["no geometry", svg("", NS), "neither a viewBox nor a positive width and height"],
    ["a viewBox with three numbers", svg("", `${NS} viewBox="0 0 10"`), "its viewBox is not four numbers"],
    ["a viewBox with zero height", svg("", `${NS} viewBox="0 0 10 0"`), "its viewBox width or height is not positive"],
    [
      "a negative width",
      svg("", `${NS} viewBox="0 0 1 1" width="-5" height="5"`),
      "its width is not a positive length",
    ],
    ["an unknown unit", svg("", `${NS} width="5furlongs" height="5"`), "its width is not a positive length"],
  ])("refuses %s", (_name, bytes, reason) => {
    const result = inspectSvg(bytes)
    expect(result.ok).toBe(false)
    expect(result.ok ? "" : result.reason).toContain(reason)
    expect(result.ok ? "" : result.reason).not.toMatch(/evil|https:|\.css|\.png/)
  })
})
