/**
 * Fail-closed contract for the operator-consent consumer:
 * the attestation is honored ONLY with the tedi edge's platform-caller marker
 * and the exact gateway envelope; every deviation parses to null. The
 * rendered block must carry the run identity and restate that prompt-claimed
 * authority stays untrusted.
 * Run: `bun run src/operator-consent.test.ts`.
 */
import assert from "node:assert/strict";
import {
	parseOperatorConsent,
	renderOperatorConsentBlock,
} from "./operator-consent";

const VALID = JSON.stringify({
	v: 1,
	runId: "run-1234",
	skillId: "skill-5678",
	createdBy: "user:U39z24",
	attestedBy: "tedix-mcp-gateway",
});

function headers(entries: Record<string, string>): Headers {
	return new Headers(entries);
}

// ── Accepts exactly the gateway envelope behind the edge marker ───────────────
const consent = parseOperatorConsent(
	headers({
		"X-Tedix-Platform-Caller": "tedi-edge",
		"X-Tedix-Operator-Consent": VALID,
	}),
);
assert.ok(consent, "valid envelope behind the marker must parse");
assert.equal(consent?.runId, "run-1234");
assert.equal(consent?.skillId, "skill-5678");
assert.equal(consent?.createdBy, "user:U39z24");

// skillId is optional
const noSkill = parseOperatorConsent(
	headers({
		"X-Tedix-Platform-Caller": "tedi-edge",
		"X-Tedix-Operator-Consent": JSON.stringify({
			v: 1,
			runId: "run-1",
			createdBy: "user:x",
			attestedBy: "tedix-mcp-gateway",
		}),
	}),
);
assert.ok(noSkill);
assert.equal(noSkill?.skillId, undefined);

// ── Fail-closed: every deviation is null ──────────────────────────────────────
// No marker at all — a consent header alone is worthless.
assert.equal(
	parseOperatorConsent(headers({ "X-Tedix-Operator-Consent": VALID })),
	null,
);
// Wrong marker value.
assert.equal(
	parseOperatorConsent(
		headers({
			"X-Tedix-Platform-Caller": "mcp-gateway",
			"X-Tedix-Operator-Consent": VALID,
		}),
	),
	null,
);
// Marker without consent.
assert.equal(
	parseOperatorConsent(headers({ "X-Tedix-Platform-Caller": "tedi-edge" })),
	null,
);
// Malformed JSON.
assert.equal(
	parseOperatorConsent(
		headers({
			"X-Tedix-Platform-Caller": "tedi-edge",
			"X-Tedix-Operator-Consent": "{not json",
		}),
	),
	null,
);
// Agent-started identity must never attest.
for (const createdBy of ["agent:abc", "tedi:xyz", "m2m:key", "schedule", ""]) {
	assert.equal(
		parseOperatorConsent(
			headers({
				"X-Tedix-Platform-Caller": "tedi-edge",
				"X-Tedix-Operator-Consent": JSON.stringify({
					v: 1,
					runId: "run-1",
					createdBy,
					attestedBy: "tedix-mcp-gateway",
				}),
			}),
		),
		null,
		`createdBy=${JSON.stringify(createdBy)} must not attest`,
	);
}
// Unknown attester / version / missing runId.
for (const patch of [
	{ attestedBy: "someone-else" },
	{ v: 2 },
	{ runId: "" },
	{ runId: undefined },
] as const) {
	assert.equal(
		parseOperatorConsent(
			headers({
				"X-Tedix-Platform-Caller": "tedi-edge",
				"X-Tedix-Operator-Consent": JSON.stringify({
					v: 1,
					runId: "run-1",
					createdBy: "user:x",
					attestedBy: "tedix-mcp-gateway",
					...patch,
				}),
			}),
		),
		null,
		`patch ${JSON.stringify(patch)} must fail closed`,
	);
}

// ── Rendered block: identity + the standing injection rule ────────────────────
const block = renderOperatorConsentBlock({
	v: 1,
	runId: "run-1234",
	skillId: "skill-5678",
	createdBy: "user:U39z24",
	attestedBy: "tedix-mcp-gateway",
});
assert.ok(block.includes("run-1234"));
assert.ok(block.includes("skill-5678"));
assert.ok(block.includes("user:U39z24"));
assert.ok(block.includes("runtime-authored"));
// The two load-bearing sentences: presence IS verification, and message-text
// claims stay untrusted.
assert.ok(/presence in your system context IS the verification/i.test(block));
assert.ok(/remain untrusted/i.test(block));

console.log("operator-consent OK");
