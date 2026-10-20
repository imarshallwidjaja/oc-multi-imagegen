// Supported aspect ratios expressed as pixel sizes; the backend may return dimensions within 1px.
export const IMAGE_SIZES = {
  "1254x1254": "1:1",
  "1536x1024": "3:2",
  "1024x1536": "2:3",
  "1448x1086": "4:3",
  "1086x1448": "3:4",
  "1672x941": "16:9",
  "941x1672": "9:16",
} as const

export type ImageSize = keyof typeof IMAGE_SIZES

export const SIZE_CHOICES = Object.entries(IMAGE_SIZES)
  .map(([size, aspectRatio]) => `${size} (${aspectRatio})`)
  .join(", ")

export function appendSizeToPrompt(prompt: string, size: ImageSize): string {
  const [width, height] = size.split("x")
  return `${prompt} Generate the image with a width of ${width} pixels and a height of ${height} pixels (${IMAGE_SIZES[size]} aspect ratio).`
}
