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
| `@tedix/workers-ai/model-select`      | `selectWorkersAiModel`, `DEFAULT_WORKERS_AI_MODEL` (ref → model id)                     |
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

Agents 0.26's experimental `agents/models/ai-sdk` factory offers native V4
streaming and multimodal support, but its `AISettings` requires an `Ai` binding
and exposes no per-dispatch authorization seam. This package also supports
HTTPS gateways without that binding and requires billable admission with the
exact serialized request before every dispatch. Replacing the adapter directly
would remove those supported contracts. Model selection stays with callers;
no new provider path or global default is installed.

Upstream contracts: [factory settings](https://github.com/cloudflare/agents/blob/agents%400.26.0/packages/agents/src/models/core/settings.ts)
and [Agents 0.26 release](https://github.com/cloudflare/agents/releases/tag/agents%400.26.0).

Breaker state is per-isolate by design. Two Workers cannot share module scope,
so a cross-Worker breaker would need a Durable Object round-trip on the hot path
of every inference — more expensive than the doomed probe it would save.
