import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { selectBackend } from "../../src/backend"
import { describeImagegen } from "../../src/imagegen"
import { loadPackagedSkill, SKILL_FILE, SKILL_NAME, SKILLS_DIRECTORY } from "../../src/skill"
import { isolateEnvironment } from "./fixtures"
import { selectBackendVariable } from "./hosts"

isolateEnvironment()
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "skill-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function skillFile(text: string) {
  const file = path.join(dir, "SKILL.md")
  await writeFile(file, text)
  return file
}

const frontmatter = (name = '"oc-multi-imagegen"', description = '"Use before image work."') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n`

describe("packaged skill", () => {
  test("is an existing SKILL.md in an absolute skills directory that loads", async () => {
    expect(path.isAbsolute(SKILLS_DIRECTORY)).toBe(true)
    expect(existsSync(SKILL_FILE)).toBe(true)

    await expect(loadPackagedSkill()).resolves.toMatchObject({ name: SKILL_NAME })
  })

  test("frontmatter reads the same through a YAML parser and the loader", async () => {
    const text = readFileSync(SKILL_FILE, "utf-8")
    const yaml = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? ""
    const skill = await loadPackagedSkill()

    expect(Bun.YAML.parse(yaml)).toEqual({ name: skill.name, description: skill.description })
  })

  test.each(["codex", "openai-api"] as const)("the tool description points to the skill by name for %p", (backend) => {
    selectBackendVariable(backend)

    expect(describeImagegen(selectBackend(undefined))).toContain(SKILL_NAME)
  })

  test.each([
    ["has no frontmatter", "# Body\n", "no frontmatter"],
    [
      "has an unsupported key",
      `${frontmatter().slice(0, -4)}license: "MIT"\n---\nBody`,
      "unsupported frontmatter line",
    ],
    ["sets a key twice", `${frontmatter().slice(0, -4)}name: "oc-multi-imagegen"\n---\nBody`, "name is set twice"],
    [
      "has an unquoted value",
      `${frontmatter('"oc-multi-imagegen"', "plain text")}Body`,
      "unsupported frontmatter line",
    ],
    [
      "has a value that is not JSON",
      `${frontmatter('"oc-multi-imagegen"', '"bad \\q escape"')}Body`,
      "not a JSON string",
    ],
    ["has another name", `${frontmatter('"other"')}Body`, 'name must be "oc-multi-imagegen"'],
    ["has a blank description", `${frontmatter('"oc-multi-imagegen"', '"  "')}Body`, "description is missing"],
    ["has no body", frontmatter(), "the body is empty"],
  ])("rejects a file that %s", async (_label, text, reason) => {
    const file = await skillFile(text)

    await expect(loadPackagedSkill(file)).rejects.toThrow(reason)
    await expect(loadPackagedSkill(file)).rejects.toThrow(file)
  })

  test("reports a missing file instead of loading an empty skill", async () => {
    const file = path.join(dir, "missing", "SKILL.md")

    const error = await loadPackagedSkill(file).then(
      () => new Error("the skill loaded"),
      (caught: Error) => caught,
    )

    expect(error.message).toContain(`${file} could not be read`)
    expect((error.cause as NodeJS.ErrnoException).code).toBe("ENOENT")
  })

  test("accepts CRLF line endings", async () => {
    const file = await skillFile(`${frontmatter()}# Body\n`.replace(/\n/g, "\r\n"))

    expect(await loadPackagedSkill(file)).toMatchObject({ name: SKILL_NAME, content: "# Body" })
  })
})
