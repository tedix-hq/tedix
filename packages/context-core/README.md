# @tedix/context-core

Runtime-neutral primitives for tedi context assembly: observation extraction, reflection, compiled memory, and trace safety.

## Overview

`context-core` holds the pure, body-neutral logic behind a tedi's
Observer/Reflector/Crystallizer/Compiler cycle. Every module here is
platform-independent: **no HTTP, no runtime SDK, no `@tedix/db`, no zod at
runtime**. The workspace renderer's sole runtime dependency is Mustache. The
actual LLM calls, persistence, and platform I/O live in the
Agent runtime (`apps/tedi-runtime`) and its `src/brain/` adapters.
API, tedi edge, DB role templates, and `@tedix/tedi-session` also consume
shared context, workspace, and compaction primitives.

Because it has no platform or I/O dependencies, this package runs anywhere:
Cloudflare Workers, Durable Objects, or plain Node/Bun — whatever body a tedi
runs on.

Import from the per-file entry points (`@tedix/context-core/types`, `/observer`, etc.). The package has no root entry point.

## Features

- **Types** (`/types`) — shared shapes: `Observation`, `ObservationBlock`, `TaskIntent`, `ReflectionResult`
- **Observer** (`/observer`) — pure parse/validate helpers (`parseObserverResult`) for turning raw Observer-LLM JSON into validated `Observation`/`TaskIntent` arrays, including the self-owner guard that strips spurious first-person `ownerHint: "self"` labels from procedural self-talk
- **Prompts** (`/prompts`) — `OBSERVER_SYSTEM_PROMPT` and related system prompt text used to drive the Observer LLM call
- **Reflector** (`/reflector`) — token-budget-aware merge helpers (`finalizeReflection`, `noopReflection`) that condense observations, keeping the original set if the condensed version doesn't actually save tokens
- **Compiler** (`/compiler`) — Atlas-style compiled memory: clusters `RationaleRecordInput`s into `CompiledDirective`s (`ALWAYS`/`NEVER`/`PREFER`) with the promotion gates defined in `src/compiler.ts`
- **Crystallizer** (`/crystallizer`) — detects recurring procedural-observation patterns (`CRYSTALLIZATION_THRESHOLD = 3`) that a runtime may promote into muscle memory / a draft skill
- **Trace safety** (`/trace-safety`) — redact-at-write enforcement for raw
  prompts, tool payloads, and model output: sensitive-key allowlisting,
  dual-path (structured + embedded-secret) scrubbing, and a fail-closed
  `assertNoSentinel` guard
- **Tokens** (`/tokens`) — `countTokens`, a dependency-free chars/4 approximation
- **Harness version** (`/harness-version`) — `shortHash`, the pure
  component-hash/id derivation shared by the API and Agent runtime for
  `HarnessVersion` bumps
- **Mission text** (`/mission-text`) — deterministic objective-title and
  overlap helpers shared by persistence deduplication and API orchestration
- **Workspace renderer** (`/tedi-workspace`) — deterministic Mustache rendering
  over caller-supplied identity, policy, and template data; it performs no D1
  reads itself

## Usage

```typescript
import { parseObserverResult } from "@tedix/context-core/observer";
import { finalizeReflection } from "@tedix/context-core/reflector";
import { countTokens } from "@tedix/context-core/tokens";

const result = parseObserverResult(rawLlmJson);
const reflected = finalizeReflection({
	original: result.observations,
	condensed: mergedObservations,
	tokensBefore: countTokens(serializedBefore),
	tokensAfter: countTokens(serializedAfter),
});
```

## Related

- `apps/tedi-runtime/src/brain/` — supplies the LLM calls, HTTP, and persistence this package deliberately omits
- [Workers and governance](../../docs/public/workers-and-governance.md) — public context for
  the durable worker model these primitives support.
- `src/harness-version.ts` — canonical implementation of the harness-version
  hashing scheme.
