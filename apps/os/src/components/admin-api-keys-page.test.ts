/**
 * API-key management invariants.
 *
 * Scope selection: the create dialog used to hardcode `scopes: ["*"]`. The API
 * refuses wildcard from any non-platform principal
 * (`assertDelegatableApiKeyScopes`), so tenant API-key creation returned
 * FORBIDDEN for every ordinary owner and admin. These pin the two properties
 * that keep it fixed: the dialog offers exactly the scopes the server will
 * accept, and it starts from least privilege.
 *
 * Safety and the mounted flows (confirmation, step-up on the direct client,
 * scope picker) are exercised in admin-api-keys-flows.test.tsx.
 */

import {
	API_KEY_SCOPE_METADATA,
	PLATFORM_ONLY_API_KEY_SCOPES,
	TENANT_DELEGABLE_API_KEY_SCOPES,
} from "@tedix/api-contract/schemas/organization";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@/lib/api", () => ({
	osApi: {},
	getAuthenticatedOsApi: () => ({}),
}));
vi.mock("@/lib/step-up-auth", () => ({
	useStepUpAuth: () => ({ requireStepUp: () => {}, StepUpDialog: () => null }),
	useStepUpResume: () => ({ intent: null, failure: null }),
}));

import {
	DEFAULT_KEY_SCOPES,
	apiKeyExpirationDateLabel,
	apiKeyExpirationDateToIso,
	apiKeyStatusVariant,
	expiringKeysSummary,
	parseRotateKeyIntent,
	keyActionDescription,
	keyActionLabel,
	keyActionTitle,
	keyTimestampLabel,
	scopesSummary,
} from "./admin-api-keys-page";

describe("API key scope selection", () => {
	it("defaults to read-only, tenant-delegable scopes", () => {
		expect(DEFAULT_KEY_SCOPES.length).toBeGreaterThan(0);
		for (const scope of DEFAULT_KEY_SCOPES) {
			expect(
				API_KEY_SCOPE_METADATA[scope].write,
				`${scope} is a write scope and must not be a default`,
			).toBe(false);
			expect(
				TENANT_DELEGABLE_API_KEY_SCOPES as readonly string[],
				`${scope} must be delegable by a tenant admin`,
			).toContain(scope);
		}
	});

	it("keeps every platform-only scope out of the dialog", () => {
		for (const scope of PLATFORM_ONLY_API_KEY_SCOPES) {
			expect(
				TENANT_DELEGABLE_API_KEY_SCOPES as readonly string[],
			).not.toContain(scope);
		}
	});
});

describe("step-up round trip", () => {
	it("restores a rotation target, and refuses one without a key", () => {
		expect(parseRotateKeyIntent({ keyId: "k1", name: "CI" })).toEqual({
			keyId: "k1",
			name: "CI",
		});
		expect(parseRotateKeyIntent({ name: "CI" })).toBeNull();
		expect(parseRotateKeyIntent("k1")).toBeNull();
	});
});

describe("pure helpers", () => {
	it("labels each pending action", () => {
		const rotate = { type: "rotate", id: "1", name: "CI" } as const;
		const revoke = { type: "revoke", id: "1", name: "CI" } as const;
		const del = { type: "delete", id: "1", name: "CI" } as const;
		expect(keyActionTitle(rotate)).toBe("Rotate CI?");
		expect(keyActionTitle(revoke)).toBe("Revoke CI?");
		expect(keyActionTitle(del)).toBe("Delete CI?");
		expect(keyActionTitle(null)).toBe("Delete API key?");
		expect(keyActionLabel(rotate)).toBe("Rotate key");
		expect(keyActionLabel(revoke)).toBe("Revoke key");
		expect(keyActionLabel(null)).toBe("Delete key");
		expect(keyActionDescription(rotate)).toContain("stop working immediately");
		expect(keyActionDescription(del)).toContain("cannot be undone");
	});

	it("summarizes scopes without pretending an empty key can call anything", () => {
		expect(scopesSummary(null)).toBe("--");
		expect(scopesSummary([])).toBe("--");
		expect(scopesSummary(["*"])).toBe("Full access");
		expect(scopesSummary(["apps:read"])).toBe("1 scope");
		expect(scopesSummary(["apps:read", "apps:write"])).toBe("2 scopes");
	});

	it("maps key states to the shared semantic badge tones", () => {
		expect(apiKeyStatusVariant("active")).toBe("success");
		expect(apiKeyStatusVariant("revoked")).toBe("destructive");
		expect(apiKeyStatusVariant("expired")).toBe("secondary");
		expect(apiKeyStatusVariant(null)).toBe("success");
	});

	it("normalizes D1 timestamps and reads null as Never", () => {
		expect(keyTimestampLabel(null)).toBe("Never");
		// A D1 CURRENT_TIMESTAMP (no Z) must parse as UTC, not local time —
		// any non-empty relative label proves it parsed.
		expect(keyTimestampLabel("2026-03-08 14:29:34")).not.toBe("");
	});

	it("builds the expiring-keys banner sentence", () => {
		expect(expiringKeysSummary([], 30)).toBeNull();
		expect(
			expiringKeysSummary([{ name: "CI", warningType: "expiring" }], 30),
		).toBe("CI expires within 30 days.");
		expect(
			expiringKeysSummary(
				[
					{ name: "CI", warningType: "expiring" },
					{ name: "Importer", warningType: "rotation_overdue" },
				],
				30,
			),
		).toBe("CI expires within 30 days; Importer is overdue for rotation.");
	});
});

describe("Cloudflare-style key creation", () => {
	it("turns an expiration day into a stable end-of-day UTC boundary", () => {
		const expiration = new Date(2026, 7, 31);
		expect(apiKeyExpirationDateToIso(expiration)).toBe(
			"2026-08-31T23:59:59.999Z",
		);
		expect(apiKeyExpirationDateToIso(undefined)).toBeUndefined();
		expect(apiKeyExpirationDateToIso(new Date("invalid"))).toBeUndefined();
		expect(apiKeyExpirationDateLabel(expiration, "en-US")).toBe("Aug 31, 2026");
	});
});
