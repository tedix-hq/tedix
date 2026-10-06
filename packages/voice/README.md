# @tedix/voice

Worker-side voice for the kernel (`apps/api`) and the Agent runtime
(`apps/tedi-runtime`).

| Entry point            | Source           | Owns                                                                                                    |
| ---------------------- | ---------------- | ------------------------------------------------------------------------------------------------------- |
| `@tedix/voice/runtime` | `src/runtime.ts` | Live-call helpers: the instrumented, self-healing transcriber, WebSocket wire guard, transcript filters |
| `@tedix/voice/stt`     | `src/stt.ts`     | Voice-note and turn-attachment speech-to-text (Azure through the AI Gateway, Workers AI fallback)       |
| `@tedix/voice/tts`     | `src/tts.ts`     | Spoken replies (Azure through the AI Gateway, Workers AI Aura fallback)                                 |

`bun run test:run` runs every `src/*.test.ts` as a plain Bun script.
