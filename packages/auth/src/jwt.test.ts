import { describe, expect, it } from "vite-plus/test";

import {
	computeAudienceAudit,
	isM2MToken,
	isUserToken,
	normalizeDescopeBaseUrl,
} from "./jwt";
import type { AudienceAuditEvent, JWTPayload } from "./types";

const basePayload = {
	iat: 1,
	exp: 2,
	iss: "https://auth.tedix.dev",
	aud: "project",
} satisfies Pick<JWTPayload, "iat" | "exp" | "iss" | "aud">;

describe("JWT token type detection", () => {
	it("normalizes Descope base URLs before SDK validation", () => {
		expect(normalizeDescopeBaseUrl("https://auth.tedix.dev/v1/apps")).toBe(
			"https://auth.tedix.dev",
		);
		expect(normalizeDescopeBaseUrl("https://api.descope.com/")).toBe(
			"https://api.descope.com",
		);
		expect(normalizeDescopeBaseUrl(" ")).toBeUndefined();
	});

	it("treats Descope AIH OAuth user tokens as user tokens", () => {
		const payload: JWTPayload = {
			...basePayload,
			sub: "U123",
			email: "owner@example.com",
			client_id: "https://chatgpt.com/.well-known/oauth-client",
		};

		expect(isUserToken(payload)).toBe(true);
		expect(isM2MToken(payload)).toBe(false);
	});

	it("treats client-credentials tokens without a subject as M2M", () => {
		const payload: JWTPayload = {
			...basePayload,
			client_id: "CI123",
		};

		expect(isM2MToken(payload)).toBe(true);
		expect(isUserToken(payload)).toBe(false);
	});

	it("does not classify tedi access-key tokens as user tokens", () => {
		const payload: JWTPayload = {
			...basePayload,
			sub: "access-key-subject",
			client_id: "CI_TEDI",
			entityType: "tedi",
			tediId: "7cc9147f-60c7-4464-bbdd-6fc8e66029c1",
		};

		expect(isUserToken(payload)).toBe(false);
		expect(isM2MToken(payload)).toBe(false);
	});

	// decisions/agent-capability-mutation-gate.md: an adversarial review of
	// the capability-mutation-gate fix flagged that `isUserToken` proved only
	// "not overtly a tedi token," not "affirmatively a human" — the same
	// failure shape the gate fix itself closed elsewhere. `isM2MToken` assumes
	// a machine client-credentials token never carries `sub`, but Descope's own
	// AIH M2M payload shape is not guaranteed to honor that (see
	// `shouldAttemptAihM2mScopeHydration` in apps/mcp/src/auth-helpers.ts, which
	// keys off `client_id` + no `email` instead of `sub`). A token shaped like
	// that — `client_id` set, `sub` unexpectedly present, no human `email` —
	// must not be classified as a user token even though it is not tagged as a
	// tedi either.
	it("does not classify a client-credentials-shaped token as a user token even if it unexpectedly carries a sub", () => {
		const payload: JWTPayload = {
			...basePayload,
			sub: "aih-m2m-client-record-id",
			client_id: "CI_AIH_M2M",
		};

		expect(isUserToken(payload)).toBe(false);
	});
});

describe("audience audit (measurement for the enforcement rollout)", () => {
	const audit = {
		surface: "api:rpc",
		expected: ["https://api.tedix.dev"],
		report: () => {},
	};
	const PROJECT = "P2example000000000000000000";

	it("accepts a token whose aud matches the surface", () => {
		const event = computeAudienceAudit(audit, "https://api.tedix.dev", PROJECT);
		expect(event.wouldReject).toBe(false);
		expect(event.passedOnlyViaProjectId).toBe(false);
	});

	it("handles aud as an array, per RFC 7519", () => {
		const event = computeAudienceAudit(
			audit,
			["https://other.tedix.dev", "https://api.tedix.dev"],
			PROJECT,
		);
		expect(event.wouldReject).toBe(false);
		expect(event.actual).toHaveLength(2);
	});

	// The headline finding: a token minted for the MCP edge is accepted
	// everywhere else today, because no other surface checks aud at all.
	it("flags a token minted for a different surface", () => {
		const event = computeAudienceAudit(
			audit,
			"https://tedix-unified.mcp.tedix.dev/mcp",
			PROJECT,
		);
		expect(event.wouldReject).toBe(true);
		expect(event.passedOnlyViaProjectId).toBe(false);
	});

	// The subtle one this audit exists to measure: validateToken prepends the
	// bare project ID whenever a caller passes allowedAudiences without an
	// explicit audience, so `aud: <projectId>` satisfies the CURRENT check while
	// failing a strict one. Flipping enforcement on breaks exactly these.
	it("separates tokens that pass only via the bare project ID", () => {
		const event = computeAudienceAudit(audit, PROJECT, PROJECT);
		expect(event.wouldReject).toBe(true);
		expect(event.passedOnlyViaProjectId).toBe(true);
	});

	// Tedix session JWTs are not guaranteed to carry aud at all, so absence must
	// not read as a rejection or it drowns the signal.
	it("reports a missing aud claim without counting it as a rejection", () => {
		const event = computeAudienceAudit(audit, undefined, PROJECT);
		expect(event.missingAudienceClaim).toBe(true);
		expect(event.wouldReject).toBe(false);
	});

	// computeAudienceAudit is pure and must never throw on malformed input — a
	// crash here would surface as a token rejection at the call site.
	it("tolerates a malformed aud claim without throwing", () => {
		for (const bad of [null, 42, {}, [1, 2], [null], true]) {
			const event = computeAudienceAudit(audit, bad, PROJECT);
			expect(event.actual).toEqual([]);
			expect(event.wouldReject).toBe(false);
			expect(event.missingAudienceClaim).toBe(true);
		}
	});

	// The report callback is per call, so auditing cannot leak across surfaces
	// and cannot fire when a caller did not ask for it.
	it("routes the observation to the caller's own report callback", () => {
		const seen: AudienceAuditEvent[] = [];
		const event = computeAudienceAudit(
			{ ...audit, report: (e) => seen.push(e) },
			"https://api.tedix.dev",
			PROJECT,
		);
		expect(event.surface).toBe("api:rpc");
		expect(seen).toEqual([]);
	});
});
