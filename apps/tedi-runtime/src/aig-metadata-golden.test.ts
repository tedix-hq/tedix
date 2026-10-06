/**
 * GOLDEN OUTPUT pins for the tedi-runtime AI Gateway attribution encoder
 * (`aigMetadataRecord` / `aigMetadataHeader` in `llm.ts`).
 *
 * This output is the `cf-aig-metadata` header and the `env.AI.run` binding
 * `gateway.metadata`, i.e. what makes Workers AI spend filterable in gateway
 * logs. A silent change fails NOTHING at runtime — spend just becomes
 * un-attributable — so the contract is pinned byte-for-byte.
 *
 * Unlike the kernel encoder (`kernelGatewayMetadata` in apps/api, which always
 * emits `surface`/`sessionKeyHash`/`source`/`attribution` and synthesizes
 * `system:kernel:<source>` correlation), this one emits ONLY the fields
 * actually present and returns `null` when nothing is. That difference is
 * deliberate and must survive the `@tedix/workers-ai` extraction: the shared
 * transport serializes a pre-normalized record, the surface tag stays here.
 *
 * Run as a standalone bun script (apps/tedi-runtime's `test:run` loops
 * `src/*.test.ts` through `bun run`), matching the app's existing test style.
 */

import assert from "node:assert/strict";
import { type AigMetadata, aigMetadataHeader, aigMetadataRecord } from "./llm";

// Absent metadata → null (no header emitted at all).
assert.equal(aigMetadataRecord(undefined), null);
assert.equal(aigMetadataHeader(undefined), null);

// EMPTY CASE: an object with no usable entries is null, NOT `{}`. This is what
// keeps the transport from emitting an empty `cf-aig-metadata` header.
assert.equal(aigMetadataRecord({}), null);
assert.equal(aigMetadataHeader({}), null);

// Only present fields are emitted — no surface tag, no synthesized correlation.
assert.deepEqual(aigMetadataRecord({ tediId: "tedi-1" }), { tediId: "tedi-1" });
assert.equal(aigMetadataHeader({ tediId: "tedi-1" }), '{"tediId":"tedi-1"}');

// Empty-string fields are dropped (never a blank tag).
assert.deepEqual(aigMetadataRecord({ tediId: "", orgId: "org-1" }), {
	orgId: "org-1",
});
assert.equal(
	aigMetadataHeader({ tediId: "", orgId: "org-1" }),
	'{"orgId":"org-1"}',
);

// A fully populated record: exactly the five-entry Cloudflare ceiling, with the
// serialized header pinned byte-for-byte (including the nested JSON escape).
const full: AigMetadata = {
	tediId: "tedi-1",
	orgId: "org-1",
	sessionKeyHash: "abcd1234",
	source: "cron:daily",
	attribution: '{"v":1}',
};
assert.deepEqual(aigMetadataRecord(full), {
	tediId: "tedi-1",
	orgId: "org-1",
	sessionKeyHash: "abcd1234",
	source: "cron:daily",
	attribution: '{"v":1}',
});
assert.equal(
	aigMetadataHeader(full),
	'{"tediId":"tedi-1","orgId":"org-1","sessionKeyHash":"abcd1234","source":"cron:daily","attribution":"{\\"v\\":1}"}',
);

// SIX string entries THROW rather than silently truncating — truncation would
// destroy the exact attribution the header exists to preserve.
assert.throws(
	() =>
		aigMetadataRecord({
			tediId: "a",
			orgId: "b",
			sessionKeyHash: "c",
			source: "d",
			attribution: "e",
			extra: "f",
		} as unknown as AigMetadata),
	/AI Gateway metadata exceeds the 5-entry limit \(6\)/,
);

// Non-string values are filtered BEFORE the cap is counted, so six non-string
// entries collapse to null instead of throwing. Pinned because it is the
// asymmetry a rewrite is most likely to "tidy" away.
assert.equal(
	aigMetadataRecord({
		a: 1,
		b: 2,
		c: 3,
		d: 4,
		e: 5,
		f: 6,
	} as unknown as AigMetadata),
	null,
);

console.log("aig-metadata-golden.test.ts OK");
