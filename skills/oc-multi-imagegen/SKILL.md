---
name: "oc-multi-imagegen"
description: "Use before any image generation or image edit with the imagegen or imageedit tool: choosing raster or code, choosing between creating and editing, labelling reference images, writing the prompt, correcting a result, keeping related images consistent, transparent backgrounds, and checking what came back."
---

# Image generation and editing

The image tools follow reference pixels better than prose. Each call has three parts: references that carry look and geometry, a prompt that carries structure and facts, and a check of the file that came back. The tool descriptions list their arguments and limits.

Every backend has the same two image tools. Create a new image from text with `imagegen`. Change, restyle or combine existing images with `imageedit`, which takes them as reference images. Whenever an existing image should guide the result, including a correction, a sibling in a consistent set or a rendered layout, the call is an `imageedit` call. Where the backend offers `imagegen_models`, use it before choosing a model instead of guessing one; where it lists the account's models live, a listed model is available to the key, not proven to support a format or feature.

## Pick the medium

Icons, logos, charts, diagrams, and anything that must scale, be recoloured or be edited later belong in SVG or code, or in an existing icon set. Where the backend generates SVG, use it for a simple icon or logo that must scale, and ask for flat shapes and few colours; charts, diagrams and exact layouts still belong in code. Generate rasters for photos, illustrations, textures and visual concepts. For a short animated GIF, describe the subject, the motion and how the loop returns to its first frame. When a layout needs exact positions, spacing or small text, render it in code and pass the render to `imageedit` as a reference.

## Write the call

- Label each reference by role in the prompt: "Image 1: approved style; copy its colours and shadows. Image 2: layout at true size; match positions." Say what to borrow and what to leave out.
- Pass geometry as a picture (a rendered layout, a crop, a sketch). Dimensions written in words come out approximate.
- Order the prompt: medium and framing, the role of each reference, content in reading order with every visible string in quotes, then hard constraints. For an app screen, state "flat screen capture, no device frame".
- Assign colour by role and name where colour must not appear; otherwise labels and states get colour-coded on their own.
- Pick the size or aspect ratio that fits the use.

## Chain results

Each result reports the path it was actually saved to, which can differ from the requested one: the extension follows the returned format, and an existing file gets a `-vN` suffix. Read the file from that path, and when it is a PNG, JPEG or WebP, pass it as the next `imageedit` reference. A GIF or SVG result cannot be a reference; follow the GIF and SVG steps under "Correct" and "Keep related images consistent".

## Correct

For a PNG, JPEG or WebP result, pass it to `imageedit` as Image 1 and write: "Reproduce Image 1 faithfully: same layout, scale, colours and text. Apply only these corrections: 1. ... 2. ..." Name the region and the exact new values. Batch every fix for an image into one round, because each regeneration can change things you did not mention. Compare the result with the previous version, not only against the requested fix.

A GIF or SVG result cannot be a reference image. Correct it with a new `imagegen` call in the format the operator asked for: reuse the previous prompt, describe what to keep from the result, and list each correction. Convert a result to another format only when the operator asks for that.

A reference-guided edit regenerates the whole image. When a region must stay pixel-identical, or one region keeps failing, edit or composite locally and record that the image was patched.

## Keep related images consistent

Approve one anchor image first, then create each sibling with `imageedit`, passing the anchor as the style reference and labelling its role. When the anchor is a GIF or SVG, create each sibling with `imagegen` and repeat the anchor prompt's style description word for word instead. Separate generations drift in layout and detail, so frames that must match each other, such as a storyboard or a before-and-after pair, may be better generated as one numbered grid and cut afterwards.

## Exact text

Large headings usually render correctly; small text can pick up misspellings. When wording matters, leave it out of the generated image and draw it afterwards in code.

## Transparency

Where the tool has a `background` argument, set it to `transparent` for an isolated cut-out instead of asking for transparency in the prompt, and ask for one subject with clear margin on every side. The returned alpha can be soft at the edges and across the subject, so process it when a hard cut-out or fully opaque subject is needed. Recheck the alpha after every correction round; do not assume an edit kept it.

## Check and record

- Open every result at full size and crop dense regions. Read the pixel size the tool reports instead of assuming the requested size.
- Check each quoted string, the colour roles, everything the prompt forbade, and anything that changed without being asked.
- For transparency, check the image mode and alpha, and view the result on a light and a dark background.
- For an SVG, render it and check its shapes, colours and text; its viewBox is in vector units, not pixels. For a GIF, check that the frames change and the loop closes; the reported size is one frame's.
- Report what the final file is: which images were generated, from which references, and any post-processing such as upscaling, patching or matting. Say so when a result was not checked or differs from the request.
