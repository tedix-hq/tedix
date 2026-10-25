import { describe, expect, it } from "vite-plus/test";

import {
	isM2MToken,
	isOAuthClientToken,
	isUserToken,
	normalizeDescopeBaseUrl,
} from "./jwt";
import type { JWTPayload } from "./types";

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

describe("OAuth client token detection", () => {
	it("flags an MCP OAuth token even though its audience includes the project", () => {
		expect(
			isOAuthClientToken({
				...basePayload,
				iss: "https://api.descope.com/v1/apps/agentic/Pproject/RSconnect",
				aud: [
					"https://client.example/oauth-client.json",
					"Pproject",
					"https://connect.example/mcp",
				],
				azp: "https://client.example/oauth-client.json",
				sub: "U123",
				email: "owner@example.com",
			}),
		).toBe(true);
	});

	it("flags a relying-party claim under any issuer", () => {
		expect(
			isOAuthClientToken({ ...basePayload, sub: "U123", client_id: "C1" }),
		).toBe(true);
		expect(isOAuthClientToken({ ...basePayload, sub: "U123", azp: "C1" })).toBe(
			true,
		);
		expect(
			isOAuthClientToken({
				...basePayload,
				iss: "https://api.descope.com/v1/apps/Pproject",
				sub: "U123",
			}),
		).toBe(true);
	});

	it("does not flag a Descope session JWT", () => {
		for (const iss of [
			"https://api.descope.com/Pproject",
			"https://auth.tedix.dev/Pproject",
			"Pproject",
		]) {
			expect(
				isOAuthClientToken({
					...basePayload,
					iss,
					sub: "U123",
					drn: "DS",
				}),
			).toBe(false);
		}
	});
});
