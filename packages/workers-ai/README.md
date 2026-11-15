# @tedix/workers-ai

The one way a Tedix Worker calls Cloudflare Workers AI: AI Gateway transport
resolution, the gateway-or-binding chat transport, the `LanguageModelV2` adapter
the AI SDK drives (including separate reasoning and usage detail), model-id
resolution, and a provider circuit breaker.

Runtime-neutral: nothing here branches on which app is calling.

## Entry points

| Import                                | Owns                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| `@tedix/workers-ai/gateway-transport` | Binding-vs-HTTPS AI Gateway resolution for one provider on one gateway                  |
| `@tedix/workers-ai/transport`         | `callWorkersAi` — OpenAI-shaped chat over the gateway, falling back to `env.AI`         |
| `@tedix/workers-ai/model`             | `workersAiModel` — a `LanguageModelV2` for `generateText`/`generateObject`/`streamText` |
| `@tedix/workers-ai/model-select`      | `selectWorkersAiModel` (configured ref → model id)                                      |
| `@tedix/workers-ai/breaker`           | `createProviderBreaker` — per-isolate primary-provider cooldown                         |

No barrel; import the exact leaf.

## The two seams the caller owns

**Attribution.** `WorkersAiTransportRequest.attribution` is a PRE-NORMALIZED
`Record<string, string>`. Each app keeps its own encoder — `kernelGatewayMetadata`
in `apps/api`, `aigMetadataRecord` in `apps/tedi-runtime` — including the AI
Gateway five-entry cap, because the surface tag and its defaults are app policy.
This package only serializes what it is handed, and emits no `cf-aig-metadata`
at all when handed nothing or an empty record.

**Authorization.** `WorkersAiClient.authorize` is REQUIRED, not optional. An
optional hook is one a caller forgets, and a forgotten one means unmetered
inference. It runs before any request leaves the Worker and returns the
attribution actually sent, so an app that mints a billing reservation folds its
id in there. A caller with no billing plane passes an explicit no-op.

## Provider choice does not live here

Model selection stays in each app's policy: Auto Router is the default, while
explicit Azure and Workers AI selections remain fixed. The explicit Workers AI
adapter does not choose a fallback provider. `createProviderBreaker` is the shared
mechanism; the policy that trips and reads it is the app's.

Explicit Workers AI results preserve `reasoning_content`/`reasoning` separately
from assistant text, including reasoning and cached-input token counts. Reasoning
tokens are part of completion tokens; they are not added a second time.
`doStream` replays a buffered response as separate reasoning/text/tool frames;
it does not provide incremental network streaming.

Cancellation is checked before admission and again before dispatch. The binding
cannot stop inference already sent, but cancellation rejects the caller's wait
and removes its listener when the wait ends.

## Native provider assessment

Reassessed for Agents 0.33.0, the version this repo pins. Its
`agents/models/ai-sdk` factory (`createAI`) offers `LanguageModelV4` streaming,
multimodal models and gateway metadata. It no longer requires the `Ai`
binding: `AISettings` also accepts `{ accountId, apiToken }`. That HTTP path
does not match ours. A model id goes to the Cloudflare REST API
(`api.cloudflare.com/.../ai/run`) with an account API token holding
**Workers AI Read**, while this package sends HTTPS calls to
`gateway.ai.cloudflare.com` with the gateway-scoped `CF_AI_GATEWAY_TOKEN`.
Adopting it would need a broader credential and a different endpoint.

The factory still has no per-dispatch authorization seam. `createAI` takes
only settings: no `fetch` or transport injection and no hook that sees the
serialized request. Per-call `headers` and `metadata` cannot reject a call
before it is sent. This package requires billable admission with the exact
serialized request before every dispatch, so replacing the adapter would
remove that contract. Decision unchanged: keep this adapter. Model selection
stays with callers; no new provider path or global default is installed.

Upstream contracts: [factory settings](https://github.com/cloudflare/agents/blob/agents%400.33.0/packages/agents/src/models/core/settings.ts),
[AI SDK provider guide](https://developers.cloudflare.com/agents/models/ai-sdk/),
[AI Gateway REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)
and [Agents 0.33 release](https://github.com/cloudflare/agents/releases/tag/agents%400.33.0).

Breaker state is per-isolate by design. Two Workers cannot share module scope,
so a cross-Worker breaker would need a Durable Object round-trip on the hot path
of every inference — more expensive than the doomed probe it would save.
