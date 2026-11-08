import { SaxesParser, type SaxesTagNS } from "saxes"

// The OpenAI Images API documents its SVG output as static vector content without scripts, external resources or
// embedded raster images. inspectSvg refuses a document outside that contract before anything is saved: it parses the
// XML strictly and rejects the active and external forms listed below. It is a refusal check for those forms, not a
// sanitizer, and passing it does not make a document safe to inline into a web page.
// https://developers.openai.com/api/docs/guides/image-generation#generate-svg-output

const SVG_NAMESPACE = "http://www.w3.org/2000/svg"
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink"
const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml"
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace"

// SVG elements that run code, load or embed other documents or rasters, or animate the document.
const REFUSED_ELEMENTS = new Set([
  "script",
  "foreignObject",
  "image",
  "feImage",
  "iframe",
  "object",
  "embed",
  "audio",
  "video",
  "animate",
  "animateMotion",
  "animateTransform",
  "animateColor",
  "set",
  "discard",
  "handler",
  "listener",
])

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/
const LENGTH = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(px|pt|pc|mm|cm|in|em|ex)?$/
// Every url(...) reference, wherever it appears in CSS text; only same-document fragments are allowed. Only CSS
// whitespace is skipped: JavaScript's \s also matches characters such as U+00A0, which CSS reads as part of the URL.
const URL_REFERENCE = /url\([ \t\n\r\f]*(['"]?)[ \t\n\r\f]*([^'")]*)/gi
// A declaration of an animation or transition property, vendor-prefixed or not, where a declaration can start.
const ANIMATION_PROPERTY = /(?:^|[{;}])\s*(?:-[a-z]+-)?(?:animation|transition)(?:-[-\w]*)?\s*:/i
// A call to a CSS function that loads an image from a string or a custom property, not only from url(), vendor-prefixed
// or not. These are refused by name, so neither a quoted string nor var() can pass them a resource.
const IMAGE_FUNCTION = /(?:^|[^-\w])(?:-[a-z]+-)?(?:image-set|image|cross-fade|src)\s*\(/i

// Attributes a browser parses as CSS values besides style: the presentation attributes of SVG 2, section 6.6
// (https://www.w3.org/TR/SVG2/styling.html#PresentationAttributes), including its geometry and transform attributes,
// and those SVG 1.1 also listed. A name checked on an element where it is not a presentation attribute only refuses
// more. Other attributes, such as aria-label or data-* text, are not CSS.
const PRESENTATION_ATTRIBUTES = new Set([
  "alignment-baseline",
  "baseline-shift",
  "clip",
  "clip-path",
  "clip-rule",
  "color",
  "color-interpolation",
  "color-interpolation-filters",
  "color-profile",
  "color-rendering",
  "cursor",
  "cx",
  "cy",
  "d",
  "direction",
  "display",
  "dominant-baseline",
  "enable-background",
  "fill",
  "fill-opacity",
  "fill-rule",
  "filter",
  "flood-color",
  "flood-opacity",
  "font-family",
  "font-size",
  "font-size-adjust",
  "font-stretch",
  "font-style",
  "font-variant",
  "font-weight",
  "glyph-orientation-horizontal",
  "glyph-orientation-vertical",
  "gradientTransform",
  "height",
  "image-rendering",
  "kerning",
  "letter-spacing",
  "lighting-color",
  "marker-end",
  "marker-mid",
  "marker-start",
  "mask",
  "mask-type",
  "opacity",
  "overflow",
  "paint-order",
  "pathLength",
  "patternTransform",
  "pointer-events",
  "r",
  "rx",
  "ry",
  "shape-rendering",
  "stop-color",
  "stop-opacity",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "text-anchor",
  "text-decoration",
  "text-overflow",
  "text-rendering",
  "transform",
  "transform-origin",
  "unicode-bidi",
  "vector-effect",
  "visibility",
  "white-space",
  "width",
  "word-spacing",
  "writing-mode",
  "x",
  "y",
])

type SvgInspection = { ok: true; geometry: string } | { ok: false; reason: string }

class Refusal extends Error {}

const refuse = (reason: string): never => {
  throw new Refusal(reason)
}

// A URL parser strips leading C0 controls and space (U+0000 to U+0020); JavaScript's trim() strips more, such as U+00A0,
// which a URL keeps, so a reference starting with it resolves against another document.
const withoutLeadingUrlSpace = (value: string): string => {
  let start = 0
  while (start < value.length && value.charCodeAt(start) <= 0x20) start++
  return value.slice(start)
}

// CSS reaches the document through style sheets, style attributes and presentation attributes. Escapes are refused
// first: without them, every function name, property and at-rule is literal text. The walk separates comments and
// strings the way a CSS tokenizer does, so neither can hide code, and returns the code with comments removed and
// strings emptied for the image-function check and the callers' own checks.
function checkCss(text: string): string {
  if (text.includes("\\")) refuse("it uses a CSS escape, which can disguise a resource or an animation")
  for (const match of text.matchAll(URL_REFERENCE)) {
    // URL_REFERENCE already skipped the CSS whitespace before the target.
    if (!match[2].startsWith("#")) refuse("it references an external resource or embedded data through url()")
    // CSS reads an unquoted url() body as literal text up to ")", but the walk below would read a comment delimiter
    // there as a comment, or a quote as a string, and skip real code after it. Such references are refused instead.
    const quoteAfter = match[1] === "" && /['"]/.test(text[(match.index ?? 0) + match[0].length] ?? "")
    if (/\/\*|\*\//.test(match[2]) || quoteAfter) refuse("its url() reference holds a comment delimiter or a quote")
  }
  let code = ""
  for (let index = 0; index < text.length; ) {
    const char = text[index]
    if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2)
      index = end < 0 ? text.length : end + 2
      code += " "
    } else if (char === '"' || char === "'") {
      // A string ends at its closing quote, or unterminated at a newline.
      let end = index + 1
      while (end < text.length && !`${char}\n\r\f`.includes(text[end])) end++
      index = end + 1
      code += `${char}${char}`
    } else {
      code += char
      index++
    }
  }
  if (IMAGE_FUNCTION.test(code)) {
    refuse("it uses a CSS image function such as image-set() or src(), which can load a resource")
  }
  return code
}

// A style sheet or style attribute: CSS that also must not animate the document. A style sheet must not hold an
// at-rule, which covers @import, @font-face and @keyframes.
function checkStyle(text: string, sheet: boolean): void {
  const code = checkCss(text)
  if (sheet && code.includes("@")) refuse("its style sheet has an at-rule such as @import, @font-face or @keyframes")
  if (ANIMATION_PROPERTY.test(code)) refuse("its CSS animates the document with an animation or transition property")
}

// The root's viewBox, or its width and height, as numbers this module formats itself, so no provider text reaches a
// message. A present viewBox, width or height must be valid; percentages are allowed for width and height but do not
// give the document a size.
function geometryOf(root: SaxesTagNS): string {
  const attribute = (name: string) => {
    const found = root.attributes[name]
    return found && found.uri === "" ? found.value.trim() : undefined
  }
  const viewBox = attribute("viewBox")
  let box: number[] | undefined
  if (viewBox !== undefined) {
    const parts = viewBox.split(/[\s,]+/)
    box = parts.map(Number)
    if (parts.length !== 4 || !parts.every((part) => NUMBER.test(part)) || !box.every(Number.isFinite)) {
      refuse("its viewBox is not four numbers")
    }
    if (box[2] <= 0 || box[3] <= 0) refuse("its viewBox width or height is not positive")
  }
  const length = (name: "width" | "height") => {
    const value = attribute(name)
    if (value === undefined || /^[+-]?(?:\d+\.?\d*|\.\d+)%$/.test(value)) return undefined
    const match = LENGTH.exec(value)
    const amount = match ? Number(match[1]) : Number.NaN
    if (!match || !Number.isFinite(amount) || amount <= 0) refuse(`its ${name} is not a positive length`)
    return `${amount}${match?.[2] ?? ""}`
  }
  const width = length("width")
  const height = length("height")
  const size = width !== undefined && height !== undefined ? `width ${width} and height ${height}` : undefined
  if (box) return `viewBox ${box.join(" ")}${size ? `, ${size}` : ""}`
  if (size) return size
  return refuse("its root has neither a viewBox nor a positive width and height")
}

// Checks that `bytes` is one well-formed SVG document in the SVG namespace, with a usable size and none of the refused
// forms. Reasons name only this module's own vocabulary, never provider text.
export function inspectSvg(bytes: Uint8Array): SvgInspection {
  let text: string
  try {
    // A byte order mark is removed; any invalid UTF-8 fails.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return { ok: false, reason: "it is not UTF-8 text" }
  }
  const parser = new SaxesParser({ xmlns: true, position: false })
  let root: SaxesTagNS | undefined
  // Open elements, innermost last, so text can be attributed to a style sheet and metadata can hold other vocabularies.
  const open: SaxesTagNS[] = []
  const inside = (local: string) => open.some((tag) => tag.uri === SVG_NAMESPACE && tag.local === local)
  parser.on("doctype", () => refuse("it has a DOCTYPE declaration, which can define entities or load external content"))
  parser.on("processinginstruction", () => refuse("it has a processing instruction such as a style sheet link"))
  parser.on("opentag", (tag) => {
    if (!root) {
      if (tag.uri !== SVG_NAMESPACE || tag.local !== "svg") refuse("its root element is not svg in the SVG namespace")
      root = tag
    }
    if (tag.uri === SVG_NAMESPACE) {
      if (REFUSED_ELEMENTS.has(tag.local)) refuse(`it contains a <${tag.local}> element`)
    } else if (tag.uri === XHTML_NAMESPACE || !inside("metadata")) {
      refuse("it contains an element outside the SVG namespace")
    }
    for (const attribute of Object.values(tag.attributes)) {
      if (/^on/i.test(attribute.local)) refuse("it has an event handler attribute")
      if (attribute.local === "href" && (attribute.uri === "" || attribute.uri === XLINK_NAMESPACE)) {
        if (!withoutLeadingUrlSpace(attribute.value).startsWith("#"))
          refuse("it links to an external resource or embedded data")
      }
      if (attribute.uri === XML_NAMESPACE && attribute.local === "base") {
        refuse("it sets xml:base, which can point its references at another document")
      }
      if (attribute.uri === "" && attribute.local === "style") checkStyle(attribute.value, false)
      else if (attribute.uri === "" && PRESENTATION_ATTRIBUTES.has(attribute.local)) checkCss(attribute.value)
    }
    open.push(tag)
  })
  // A style sheet's text is checked whole when its element closes, however the parser splits it.
  let styleSheet = ""
  parser.on("closetag", (tag) => {
    open.pop()
    if (tag.uri !== SVG_NAMESPACE || tag.local !== "style") return
    checkStyle(styleSheet, true)
    styleSheet = ""
  })
  const collectStyle = (value: string) => {
    if (inside("style")) styleSheet += value
  }
  parser.on("text", collectStyle)
  parser.on("cdata", collectStyle)
  try {
    parser.write(text).close()
  } catch (error) {
    // Parser messages can quote provider text, so only the fact of the failure is reported.
    return { ok: false, reason: error instanceof Refusal ? error.message : "it is not well-formed XML" }
  }
  if (!root) return { ok: false, reason: "it has no root element" }
  try {
    return { ok: true, geometry: geometryOf(root) }
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.message }
    throw error
  }
}
