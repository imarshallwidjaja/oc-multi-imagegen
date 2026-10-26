---
name: "oc-multi-imagegen"
description: "Use before any image generation or image edit with the imagegen or imageedit tool: choosing raster or code, labelling reference images, writing the prompt, correcting a result, keeping related images consistent, transparent backgrounds, and checking what came back."
---

# Image generation with imagegen

The image tools follow reference pixels better than prose. Each call has three parts: references that carry look and geometry, a prompt that carries structure and facts, and a check of the file that came back. The tool descriptions list their arguments and limits. Where a backend registers separate tools for creating from text and for editing existing images, create with `imagegen` and edit with `imageedit`, and use the model information tool it offers (`imagegen_models`) to choose a model instead of guessing one.

## Pick the medium

Icons, logos, charts, diagrams, and anything that must scale, be recoloured or be edited later belong in SVG or code, or in an existing icon set. Generate rasters for photos, illustrations, textures and visual concepts. When a layout needs exact positions, spacing or small text, render it in code and pass the render as a reference.

## Write the call

- Label each reference by role in the prompt: "Image 1: approved style; copy its colours and shadows. Image 2: layout at true size; match positions." Say what to borrow and what to leave out.
- Pass geometry as a picture (a rendered layout, a crop, a sketch). Dimensions written in words come out approximate.
- Order the prompt: medium and framing, the role of each reference, content in reading order with every visible string in quotes, then hard constraints. For an app screen, state "flat screen capture, no device frame".
- Assign colour by role and name where colour must not appear; otherwise labels and states get colour-coded on their own.
- Pick the size or aspect ratio that fits the use.

## Correct

Pass the result back as a reference and write: "Reproduce Image 1 faithfully: same layout, scale, colours and text. Apply only these corrections: 1. ... 2. ..." Name the region and the exact new values. Batch every fix for an image into one round, because each regeneration can change things you did not mention. Compare the result with the previous version, not only against the requested fix.

A reference-guided edit regenerates the whole image. When a region must stay pixel-identical, or one region keeps failing, edit or composite locally and record that the image was patched.

## Keep related images consistent

Approve one anchor image first, then pass it as the style reference for each sibling and label its role. Separate generations drift in layout and detail, so frames that must match each other, such as a storyboard or a before-and-after pair, may be better generated as one numbered grid and cut afterwards.

## Exact text

Large headings usually render correctly; small text can pick up misspellings. When wording matters, leave it out of the generated image and draw it afterwards in code.

## Transparency

Set `background` to `transparent` for an isolated cut-out and ask for one subject with clear margin on every side. The returned alpha can be soft at the edges and across the subject, so process it when a hard cut-out or fully opaque subject is needed. Recheck the alpha after every correction round; do not assume an edit kept it.

## Check and record

- Open every result at full size and crop dense regions. Read the pixel size the tool reports instead of assuming the requested size.
- Check each quoted string, the colour roles, everything the prompt forbade, and anything that changed without being asked.
- For transparency, check the image mode and alpha, and view the result on a light and a dark background.
- Report what the final file is: which images were generated, from which references, and any post-processing such as upscaling, patching or matting. Say so when a result was not checked or differs from the request.
