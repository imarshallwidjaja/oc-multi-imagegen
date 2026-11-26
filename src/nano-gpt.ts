import type { z } from "zod"
import type { CredentialSpec, KeyCredential } from "./credential"
import { type BodyRefusal, readBoundedResponseBody, validateHttpsUrl } from "./http-download"
import { defineImageTool, type EditToolSpec, type GenerationToolSpec } from "./imagegen"
import {
  controlFields,
  describeNanoImageTool,
  editSchema,
  findModel,
  generateSchema,
  NANO_OUTPUT_FORMATS,
  type NanoModel,
  nanoModelsTool,
  referenceRules,
} from "./nano-gpt-models"
import { IMAGEEDIT_TOOL, IMAGEGEN_TOOL, type Operation } from "./schema"
import type { Backend } from "./types"

// NanoGPT's normalized Image API. One endpoint serves generation and editing; the tool selects the operation, and
// reference images go in `input_references` as data URLs. Legacy image aliases are not sent.
// https://docs.nano-gpt.com/api-reference/endpoint/image-api-generate
const IMAGES_ENDPOINT = "https://api.nano-gpt.com/api/v1/images"

// A response that carries a URL instead of inline base64 (NanoGPT does this for very large images) is downloaded
// from a time-limited signed URL. The download is bounded; 4K PNGs stay far below it.
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024

const nanoGptCredential = {
  type: "key",
  provider: "nano-gpt-images",
  label: "NanoGPT API",
  environmentVariable: "OC_MULTI_IMAGEGEN_NANOGPT_API_KEY",
} as const satisfies CredentialSpec

// Appended to failures once the request has gone out, when the account may already have been billed.
const CHARGE_NOTE = "NanoGPT may already have charged for this generation."
const NOTHING_SAVED = `Nothing was saved. ${CHARGE_NOTE}`

// Provider text that appears in an error is shown without the key and cut to a length.
const MAX_CODE_LENGTH = 64
const MAX_DETAIL_LENGTH = 500
const shown = (text: string, key: string, limit: number) => text.replaceAll(key, "[redacted]").slice(0, limit)

type Call = { operation: Operation; model: NanoModel }

const label = ({ operation, model }: Call) =>
  `NanoGPT ${operation === "edit" ? IMAGEEDIT_TOOL : IMAGEGEN_TOOL} (${model.id})`

// Runs one step that talks to the network. A step that fails because the call was cancelled rethrows the cancellation
// reason. Any other failure is reported by stage alone: the runtime's message can contain the request URL, which for
// a download is a credential, and its code or name is runtime text that can spell the key. Neither the error's cause
// nor the provider's download host is reported, for the same reason.
async function networkStep<T>(call: Call, signal: AbortSignal, stage: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step()
  } catch {
    signal.throwIfAborted()
    throw new Error(`${label(call)} failed while ${stage}. ${NOTHING_SAVED} Do not repeat the call unchanged.`)
  }
}

function requireModel(operation: Operation, id: string): NanoModel {
  const model = findModel(operation, id)
  // The schema accepts only registry IDs, so a miss means a tool and its schema disagree.
  if (!model) throw new Error(`The ${operation} model ${id} is not in the NanoGPT registry.`)
  return model
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// The provider reports errors as { error: { message, type, code, parameter }, code }. Anything else is shown as
// bounded text. The key is removed from the code and the message, and both are cut to a length.
function describeFailure(call: Call, status: number, text: string, key: string): string {
  let code: string | undefined
  let detail = text
  try {
    const body: unknown = JSON.parse(text)
    if (isRecord(body)) {
      const error = isRecord(body.error) ? body.error : undefined
      const found = error?.code ?? body.code
      if (typeof found === "string") code = shown(found, key, MAX_CODE_LENGTH)
      if (typeof error?.message === "string") detail = error.message
      else if (typeof body.error === "string") detail = body.error
    }
  } catch {
    // Not JSON: the text is shown as it is.
  }
  const message = shown(detail, key, MAX_DETAIL_LENGTH)
  const hint =
    status === 401 || status === 403
      ? " Do not retry; the operator needs to check the NanoGPT key."
      : status === 402 || status === 429
        ? " Do not retry; the account balance or rate limit needs the operator."
        : status >= 500
          ? ` ${NOTHING_SAVED}`
          : ""
  return `${label(call)} request failed: HTTP ${status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}.${hint}`
}

type ImagePayload = { inline: Uint8Array } | { url: string }

// Fields that name a pending job rather than an image.
const JOB_FIELDS = [
  "runId",
  "run_id",
  "job_id",
  "jobId",
  "request_id",
  "requestId",
  "task_id",
  "taskId",
  "status_url",
  "statusUrl",
]

// The body is untrusted JSON. Exactly one image is expected, inline as `b64_json` or as a `url`.
function readImagePayload(call: Call, body: unknown, key: string): ImagePayload {
  const fail = (reason: string) =>
    new Error(`${label(call)} returned a response this plugin cannot use: ${reason} ${NOTHING_SAVED}`)
  if (!isRecord(body)) throw fail("the body is not a JSON object.")
  const data = body.data
  if (!Array.isArray(data) || data.length === 0) {
    const status = typeof body.status === "string" ? shown(body.status, key, 40) : undefined
    if (status !== undefined || JOB_FIELDS.some((field) => field in body)) {
      throw fail(
        `it describes a pending job${status ? ` (status ${JSON.stringify(status)})` : ""} instead of an image. This plugin does not poll for results; do not repeat the call unchanged.`,
      )
    }
    throw fail("data holds no image.")
  }
  if (data.length > 1) {
    throw fail(`data holds ${data.length} images but one was requested, and the plugin saves exactly one file.`)
  }
  const entry: unknown = data[0]
  if (!isRecord(entry)) throw fail("data[0] is not an object.")
  const inline = entry.b64_json
  const url = entry.url
  const hasInline = inline !== undefined && inline !== null
  const hasUrl = url !== undefined && url !== null
  if (hasInline && hasUrl) throw fail("data[0] has both b64_json and url.")
  // Only a non-empty string is base64 text: Buffer.from also accepts arrays and serialized Buffer objects.
  if (hasInline) {
    if (typeof inline !== "string" || inline === "") throw fail("data[0].b64_json is not a non-empty string.")
    return { inline: Buffer.from(inline, "base64") }
  }
  if (hasUrl) {
    if (typeof url !== "string" || url === "") throw fail("data[0].url is not a non-empty string.")
    return { url }
  }
  throw fail("data[0] has neither b64_json nor url.")
}

function describeRefusal(refusal: BodyRefusal): string {
  switch (refusal.kind) {
    case "declared-too-large":
      return `the image is ${refusal.declared} bytes and the limit is ${MAX_DOWNLOAD_BYTES}.`
    case "too-large":
      return `the image is larger than the limit of ${MAX_DOWNLOAD_BYTES} bytes.`
    case "empty":
      return "the response was empty."
    case "length-mismatch":
      return `${refusal.received} bytes arrived but the response declared ${refusal.declared}.`
  }
}

// Downloads the image without credentials and without following redirects, up to MAX_DOWNLOAD_BYTES. The provider
// hands out HTTPS URLs to its storage, and anything else is refused before a request is made. Neither the URL nor its
// host is ever reported: a signed URL is a credential, and the provider chooses the host name.
async function downloadImage(call: Call, raw: string, signal: AbortSignal): Promise<Uint8Array> {
  const checked = validateHttpsUrl(raw)
  if (!checked.ok) {
    throw new Error(
      `${label(call)} returned an image URL that the plugin will not download: ${checked.reason} ${NOTHING_SAVED}`,
    )
  }
  const fail = (reason: string) => new Error(`${label(call)} image download failed: ${reason} ${NOTHING_SAVED}`)
  const res = await networkStep(call, signal, "downloading the image", () =>
    fetch(checked.url, { method: "GET", redirect: "manual", signal }),
  )
  if (res.status >= 300 && res.status < 400)
    throw fail(`it answered with a redirect (HTTP ${res.status}), which is refused.`)
  if (!res.ok) throw fail(`HTTP ${res.status}.`)
  const body = await networkStep(call, signal, "reading the image download", () =>
    readBoundedResponseBody(res, MAX_DOWNLOAD_BYTES),
  )
  if (!body.ok) throw fail(describeRefusal(body.refusal))
  return body.bytes
}

// The arguments a request needs, as the generation schema validates them. Editing validates the same fields against
// its own model IDs and adds its references, which arrive separately.
type NanoArgs = Omit<z.output<typeof generateSchema>, "model" | "out"> & { model: string }

// Sends one request and returns the image bytes. Nothing is retried and no other model is tried.
async function requestImage(
  operation: Operation,
  { key }: KeyCredential,
  args: NanoArgs,
  referenceDataUrls: string[],
  signal: AbortSignal,
): Promise<Uint8Array> {
  const model = requireModel(operation, args.model)
  const call = { operation, model }
  const body = JSON.stringify({
    model: model.id,
    prompt: args.prompt,
    n: 1,
    ...controlFields(model, args),
    ...(operation === "edit" ? { input_references: referenceDataUrls } : {}),
  })
  const res = await networkStep(call, signal, "sending the request", () =>
    fetch(IMAGES_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body,
      signal,
    }),
  )
  const text = await networkStep(call, signal, "reading the response", () => res.text())
  if (!res.ok) throw new Error(describeFailure(call, res.status, text, key))
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${label(call)} returned a response that is not JSON. ${NOTHING_SAVED}`)
  }
  const payload = readImagePayload(call, parsed, key)
  return "inline" in payload ? payload.inline : downloadImage(call, payload.url, signal)
}

const requires = (sent: string) => `Needs a NanoGPT API key; ${sent} sent to NanoGPT, which bills the account.`
const KEY_DETAIL = `The key is ${nanoGptCredential.environmentVariable} in the OpenCode process environment, else the saved ${nanoGptCredential.provider} credential.`

const SAVE_FAILURE_NOTE = `The image was not saved. ${CHARGE_NOTE}`

export const nanoGptImagegen = {
  operation: "generate",
  description: describeNanoImageTool("generate", requires("the prompt is"), KEY_DETAIL),
  schema: generateSchema,
  credential: nanoGptCredential,
  outputFormats: NANO_OUTPUT_FORMATS,
  request: (credential, args, signal) => requestImage("generate", credential, args, [], signal),
  saveFailureNote: SAVE_FAILURE_NOTE,
} satisfies GenerationToolSpec<typeof generateSchema, typeof nanoGptCredential>

export const nanoGptImageedit = {
  operation: "edit",
  description: describeNanoImageTool("edit", requires("the prompt and reference images are"), KEY_DETAIL),
  schema: editSchema,
  credential: nanoGptCredential,
  outputFormats: NANO_OUTPUT_FORMATS,
  referenceRules: (args) => referenceRules(requireModel("edit", args.model)),
  request: (credential, args, references, signal) => requestImage("edit", credential, args, references, signal),
  saveFailureNote: SAVE_FAILURE_NOTE,
} satisfies EditToolSpec<typeof editSchema, typeof nanoGptCredential>

export const nanoGptBackend = {
  id: "nano-gpt",
  summary: "NanoGPT (curated models, resolution and aspect_ratio)",
  credential: nanoGptCredential,
  tools: [defineImageTool(nanoGptImagegen), defineImageTool(nanoGptImageedit), nanoModelsTool],
} satisfies Backend
