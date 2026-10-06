/**
 * Opt Zod out of its JIT object compiler, because this app ships a
 * Content-Security-Policy without `'unsafe-eval'`.
 *
 * Zod 4 compiles object schemas into optimized validators with `new Function`.
 * It already degrades safely under CSP — `util.allowsEval` probes with a
 * `new Function("")` inside a try/catch and `$ZodObject` gates on
 * `jit && allowsEval.value`, so a blocked probe falls back to the interpreted
 * path and nothing breaks. The cost is that the *attempt* still reaches the
 * browser as a `securitypolicyviolation` even though the throw is swallowed:
 * one `script-src ← eval` report per route
 * that parses an object schema (including `/apps/store`).
 *
 * `jitless` is Zod's own escape hatch for exactly this — its source comments
 * call out that strict CSPs report the caught `new Function`. Setting it here
 * short-circuits the probe, so the reports disappear and the fallback we were
 * silently getting anyway becomes explicit rather than incidental.
 *
 * Imported for side effect before any schema parses; see `router.tsx`.
 */

import { config } from "zod";

config({ jitless: true });
