---
name: gemini-generate-media
description: Generate images with Google Gemini directly from a skill workflow, using the platform-global GEMINI_API_KEY injected at the Worker layer (no tedi runtime provider dependency).
capabilities:
  network: true
  rationale:
    mode: important
  expectedAnnotations:
    destructive: false
    readOnly: false
audience:
  - tedi
---

# gemini-generate-media

Executable skill that calls the Google Gemini API directly to generate an
image, independent of any tedi runtime provider configuration.

## How it works

This skill ships `./scripts/workflow.ts` and declares `capabilities.network:
true`. When invoked via `run_skill_workflow`, the skill-runtime loads the
workflow into a Dynamic Worker and routes its outbound `fetch()` through the
platform **OutboundProxy**, which injects the platform-global Agent Platform
API key as the `x-goog-api-key` header for the **Vertex AI** endpoint
(`aiplatform.googleapis.com`), billed to the GCP project's Cloud billing
account.

The workflow code never sees the key, and — per the Cloudflare
`dynamic-workflows` guidance that the dispatch envelope is persisted and
readable via `instance.status()` — the key is never placed in `params` or
metadata. This mirrors the tedi runtime's outbound credential injection for
Azure keys.

## Usage

`run_skill_workflow({ slug: "gemini-generate-media", params: { prompt, model? } })`

- `prompt` — image prompt (string).
- `model` — defaults to `gemini-3.1-flash-image-preview`; also accepts
  `gemini-3-pro-image-preview`.

## Output

- `credentialInjection` — `verified` when the `GET /models` probe returns 200,
  proving the platform key reached Gemini.
- `image` — `{ ok, status, bytes }`. On success, the base64 image is the
  return value of the `generate-image` step and is persisted as run artifact
  `outputs/generate-image.json` (spilled to R2 when larger than 16 KiB). Read
  it with `get_skill_run_artifact`.

> Paid models (image/video previews) require a funded Gemini billing balance.
> If the project's prepay credits are exhausted, the `generate-image` step
> returns `status: 429` (`RESOURCE_EXHAUSTED`) while `credentialInjection`
> still reports `verified` — the machinery works; only billing blocks output.

## Rendering in chat

To show the generated image inline in the Tedix OS chat, embed the **stable
session-authed** media URL as a markdown image in your reply (Tedix OS renders it as
a clickable thumbnail; the browser's session cookie authorizes it, so it
survives transcript scrollback — unlike a short-lived signed URL):

```
![image](/skill-runs/{runId}/media/outputs/generate-image.json?kind=image)
```

Use the `runId` returned by `run_skill_workflow`. Multiple `![image](...)` lines
render as a gallery grid. The `?kind=image` hint is the canonical signal Tedix OS
uses to pick `<img>` vs `<video>`.
