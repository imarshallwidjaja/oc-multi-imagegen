import { describe, expect, test } from "bun:test"
import { appendSizeToPrompt } from "../../src/size"

describe("appendSizeToPrompt", () => {
  test("appends the width, height, and aspect ratio of the size", () => {
    const prompt = "a mountain lake"

    const result = appendSizeToPrompt(prompt, "1672x941")

    expect(result).toBe(
      `${prompt} Generate the image with a width of 1672 pixels and a height of 941 pixels (16:9 aspect ratio).`,
    )
  })
})
