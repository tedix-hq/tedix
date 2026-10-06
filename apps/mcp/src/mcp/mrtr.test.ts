import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	resolveRequestStateKey,
	signRequestState,
	verifyRequestState,
} from "./mrtr";

const SIGNING_KEY = "test-signing-key-at-least-32-bytes-long";

function mintInput(
	overrides?: Partial<Parameters<typeof signRequestState>[0]>,
) {
	return {
		toolId: "delete_app",
		organizationId: "org-1",
		signingKey: SIGNING_KEY,
		...overrides,
	};
}

describe("requestState codec (SDK-backed)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("round-trips a signed state for the same tool + org", async () => {
		const state = await signRequestState(mintInput());

		const result = await verifyRequestState({
			requestState: state,
			toolId: "delete_app",
			organizationId: "org-1",
			signingKey: SIGNING_KEY,
		});

		expect(result).toEqual({
			ok: true,
			payload: { toolId: "delete_app", org: "org-1" },
		});
	});

	it("rejects a missing or non-string requestState", async () => {
		for (const requestState of [undefined, null, "", 42]) {
			const result = await verifyRequestState({
				requestState,
				toolId: "delete_app",
				organizationId: "org-1",
				signingKey: SIGNING_KEY,
			});
			expect(result).toEqual({ ok: false, reason: "missing_request_state" });
		}
	});

	it("rejects a malformed token", async () => {
		const result = await verifyRequestState({
			requestState: "not.valid",
			toolId: "delete_app",
			organizationId: "org-1",
			signingKey: SIGNING_KEY,
		});

		expect(result).toEqual({ ok: false, reason: "malformed_request_state" });
	});

	it("rejects a token signed under a different key", async () => {
		const state = await signRequestState(
			mintInput({ signingKey: "other-signing-key-also-32-bytes-long!!" }),
		);

		const result = await verifyRequestState({
			requestState: state,
			toolId: "delete_app",
			organizationId: "org-1",
			signingKey: SIGNING_KEY,
		});

		expect(result).toEqual({ ok: false, reason: "signature_mismatch" });
	});

	it("rejects a token minted for a different tool", async () => {
		const state = await signRequestState(mintInput());

		const result = await verifyRequestState({
			requestState: state,
			toolId: "delete_workspace",
			organizationId: "org-1",
			signingKey: SIGNING_KEY,
		});

		expect(result).toEqual({ ok: false, reason: "tool_mismatch" });
	});

	it("rejects a token minted for a different org", async () => {
		const state = await signRequestState(mintInput());

		const result = await verifyRequestState({
			requestState: state,
			toolId: "delete_app",
			organizationId: "org-2",
			signingKey: SIGNING_KEY,
		});

		expect(result).toEqual({ ok: false, reason: "org_mismatch" });
	});

	it("rejects a user-bound state replayed by another user", async () => {
		const state = await signRequestState(
			mintInput({ subjectUserId: "user-a" }),
		);
		await expect(
			verifyRequestState({
				requestState: state,
				toolId: "delete_app",
				organizationId: "org-1",
				subjectUserId: "user-b",
				signingKey: SIGNING_KEY,
			}),
		).resolves.toEqual({ ok: false, reason: "user_mismatch" });
		await expect(
			verifyRequestState({
				requestState: state,
				toolId: "delete_app",
				organizationId: "org-1",
				subjectUserId: "user-a",
				signingKey: SIGNING_KEY,
			}),
		).resolves.toMatchObject({ ok: true });
	});

	it("rejects an expired token (>5 minutes old)", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const state = await signRequestState(mintInput());

		vi.setSystemTime(new Date("2026-01-01T00:05:01Z"));
		const result = await verifyRequestState({
			requestState: state,
			toolId: "delete_app",
			organizationId: "org-1",
			signingKey: SIGNING_KEY,
		});

		expect(result).toEqual({ ok: false, reason: "expired" });
	});

	it("still verifies within the 5-minute TTL", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const state = await signRequestState(mintInput());

		vi.setSystemTime(new Date("2026-01-01T00:04:58Z"));
		const result = await verifyRequestState({
			requestState: state,
			toolId: "delete_app",
			organizationId: "org-1",
			signingKey: SIGNING_KEY,
		});

		expect(result.ok).toBe(true);
	});

	it("pads a short signing key instead of throwing the codec's RangeError", async () => {
		const shortKey = "short-token";
		const state = await signRequestState(mintInput({ signingKey: shortKey }));

		const result = await verifyRequestState({
			requestState: state,
			toolId: "delete_app",
			organizationId: "org-1",
			signingKey: shortKey,
		});

		expect(result.ok).toBe(true);
	});
});

describe("resolveRequestStateKey", () => {
	it("prefers PLATFORM_SERVICE_TOKEN and falls back to a >=32-byte dev key", () => {
		expect(resolveRequestStateKey({ PLATFORM_SERVICE_TOKEN: "tok" })).toBe(
			"tok",
		);
		const fallback = resolveRequestStateKey(undefined);
		expect(resolveRequestStateKey({ PLATFORM_SERVICE_TOKEN: "" })).toBe(
			fallback,
		);
		expect(
			new TextEncoder().encode(fallback).byteLength,
		).toBeGreaterThanOrEqual(32);
	});

	it("fails closed in production instead of using the dev fallback", () => {
		expect(() => resolveRequestStateKey({ ENVIRONMENT: "production" })).toThrow(
			/PLATFORM_SERVICE_TOKEN is required in production/,
		);
		expect(() =>
			resolveRequestStateKey({
				PLATFORM_SERVICE_TOKEN: "",
				ENVIRONMENT: "production",
			}),
		).toThrow(/PLATFORM_SERVICE_TOKEN is required in production/);
		expect(
			resolveRequestStateKey({
				PLATFORM_SERVICE_TOKEN: "tok",
				ENVIRONMENT: "production",
			}),
		).toBe("tok");
	});
});
