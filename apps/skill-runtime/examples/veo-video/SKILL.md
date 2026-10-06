---
name: veo-generate-video
description: Generate a short video with Google Veo directly from a skill workflow (async submit + durable poll), using the platform-global Agent Platform key on the project-scoped Vertex endpoint.
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

# veo-generate-video

Executable skill that generates a short video with Google **Veo** on Vertex AI,
independent of any tedi runtime provider configuration.

## How it works

Veo is asynchronous, which is the ideal shape for a durable Cloudflare Workflow:

1. `submit` — `POST {model}:predictLongRunning` returns an operation name.
2. Durable poll loop — `step.sleep` hibernates between checks (near-zero cost);
   each `{model}:fetchPredictOperation` is its own durable `step.do`.
3. On `done`, the platform media bridge fetches the operation, streams its
   inline base64 MP4 directly to organization-owned R2, and returns a receipt.

`predictLongRunning` requires the **project-scoped** Vertex path
(`projects/{proj}/locations/{loc}/publishers/google/models/...`) — the express
`publishers/google` path returns `RESOURCE_PROJECT_INVALID`. The skill-runtime
OutboundProxy mints a short-lived OAuth token from the platform Google service
account for the regional `*-aiplatform.googleapis.com` host; usage bills to the
project's Cloud billing account. Project-scoped Veo rejects API-key-only auth.

## Usage

`run_skill_workflow({ slug: "veo-generate-video", params: { vertexEndpoint, prompt, model?, durationSeconds?, aspectRatio? } })`

- `vertexEndpoint` — required project-scoped endpoint, for example `https://us-central1-aiplatform.googleapis.com/v1/projects/example-project/locations/us-central1/publishers/google/models`. It must match the operator's configured video endpoint and service account; the example supplies no managed project by default.
- `video-assets.tedix.internal` is a virtual origin intercepted by the runtime's outbound proxy for organization-owned media. It is not a DNS host or a private installation coordinate.

- `model` — defaults to `veo-3.0-generate-001`.
- `durationSeconds` — 4 (default), Veo supports a small set of values.
- `aspectRatio` — `16:9` (default) or `9:16`.

## Output

Returns `{ ok, polls, video: { r2Key, bytes } }`. Poll steps return only
`{done}`; the final step returns an R2 asset receipt, keeping the MP4 outside
of persisted Workflow state.
