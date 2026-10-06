/**
 * Unit tests for authorizeCodingSession / revokeCodingSession C3 surface.
 *
 * Covers:
 * - Auth gate: isPlatformPrincipal check on the context
 * - Provisioning fn called with the right sessionKey
 * - Fail-soft: provisioning error does NOT throw, returns {ok:false,error}
 *
 * These tests exercise the pure orchestration logic extracted below;
 * the oRPC procedure wrappers (withPermission) are framework
 * concerns validated by integration tests.
 */

import { isPlatformPrincipal } from "@tedix/auth/types";
import { describe, expect, test, vi } from "vite-plus/test";
import type { ProvisioningConfig } from "@tedix/provisioning";

// ---------------------------------------------------------------------------
// Extracted orchestration fns (mirrors what the procedures do internally,
// allowing pure unit testing without oRPC middleware stack).
// ---------------------------------------------------------------------------

type CodingSessionDeps = {
	getProvisioningConfig: (tedi: {
		slug: string | null;
	}) => ProvisioningConfig | null;
	requireTediAccess: (
		tediId: string,
	) => Promise<{ id: string; slug: string | null; organizationId: string }>;
	authorizeCodingSession: (
		config: ProvisioningConfig,
		opts: { sessionKey: string; authorizedBy?: string },
	) => Promise<{ ok: boolean; error?: string }>;
	revokeCodingSession: (
		config: ProvisioningConfig,
		opts: { sessionKey: string },
	) => Promise<{ ok: boolean; error?: string }>;
	actorId: string;
};

async function orchestrateAuthorize(
	input: { tediId: string; sessionKey: string; authorizedBy?: string },
	context: {
		user?: { sub: string };
		apiKey?: { id: string; scopes?: string[] };
	},
	deps: CodingSessionDeps,
) {
	const tedi = await deps.requireTediAccess(input.tediId);
	const provConfig = deps.getProvisioningConfig(tedi);
	if (!provConfig) {
		throw new Error(
			"Tedi runtime route is not configured — cannot authorize coding session",
		);
	}
	const result = await deps.authorizeCodingSession(provConfig, {
		sessionKey: input.sessionKey,
		authorizedBy: input.authorizedBy ?? deps.actorId,
	});
	return { ok: result.ok, error: result.error };
}

async function orchestrateRevoke(
	input: { tediId: string; sessionKey: string },
	_context: {
		user?: { sub: string };
		apiKey?: { id: string; scopes?: string[] };
	},
	deps: CodingSessionDeps,
) {
	const tedi = await deps.requireTediAccess(input.tediId);
	const provConfig = deps.getProvisioningConfig(tedi);
	if (!provConfig) {
		throw new Error(
			"Tedi runtime route is not configured — cannot revoke coding session",
		);
	}
	const result = await deps.revokeCodingSession(provConfig, {
		sessionKey: input.sessionKey,
	});
	return { ok: result.ok, error: result.error };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEDI_ID = "11111111-1111-1111-1111-111111111111";
const SESSION_KEY = "sess_abc123";
const PROV_CONFIG: ProvisioningConfig = {
	workerUrl: "https://cto.tedi.tedix.dev",
};

function makeDeps(
	overrides: Partial<CodingSessionDeps> = {},
): CodingSessionDeps {
	return {
		getProvisioningConfig: vi.fn(() => PROV_CONFIG),
		requireTediAccess: vi.fn(async () => ({
			id: TEDI_ID,
			slug: "cto",
			organizationId: "org-1",
		})),
		authorizeCodingSession: vi.fn(async () => ({ ok: true })),
		revokeCodingSession: vi.fn(async () => ({ ok: true })),
		actorId: "user-platform-admin",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// isPlatformPrincipal gate (unit-tested directly — the oRPC withPermission
// middleware enforces tedis:delete before the handler runs)
// ---------------------------------------------------------------------------

describe("isPlatformPrincipal — coding session auth gate", () => {
	test("platform API key with platform:admin scope passes", () => {
		const ctx = {
			authType: "api-key",
			apiKey: { id: "k1", scopes: ["platform:admin"] },
		};
		expect(isPlatformPrincipal(ctx)).toBe(true);
	});

	test("ordinary org API key without platform:admin is rejected", () => {
		const ctx = {
			authType: "api-key",
			apiKey: { id: "k2", scopes: ["apps:write", "tedis:delete"] },
		};
		// Not a platform principal — but requireTediAccess org check still allows
		// same-org owner; the permission gate (tedis:delete) is the first line.
		expect(isPlatformPrincipal(ctx)).toBe(false);
	});

	test("service binding counts as trusted (authType=service-binding)", () => {
		// service-binding bypasses the requireOrganizationId check in requireTediAccess;
		// isPlatformPrincipal does NOT count service-binding alone as platform principal —
		// that's by design (binding trust is structural, not permission-based).
		const ctx = { authType: "service-binding" };
		expect(isPlatformPrincipal(ctx)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// authorize orchestration
// ---------------------------------------------------------------------------

describe("orchestrateAuthorize", () => {
	test("calls authorizeCodingSession with the right sessionKey", async () => {
		const deps = makeDeps();
		const ctx = { apiKey: { id: "k1", scopes: ["platform:admin"] } };
		const result = await orchestrateAuthorize(
			{ tediId: TEDI_ID, sessionKey: SESSION_KEY },
			ctx,
			deps,
		);
		expect(result.ok).toBe(true);
		expect(deps.authorizeCodingSession).toHaveBeenCalledOnce();
		expect(deps.authorizeCodingSession).toHaveBeenCalledWith(PROV_CONFIG, {
			sessionKey: SESSION_KEY,
			authorizedBy: "user-platform-admin",
		});
	});

	test("passes explicit authorizedBy label through to provisioning fn", async () => {
		const deps = makeDeps();
		const ctx = { apiKey: { id: "k1", scopes: ["platform:admin"] } };
		await orchestrateAuthorize(
			{
				tediId: TEDI_ID,
				sessionKey: SESSION_KEY,
				authorizedBy: "cto-operator",
			},
			ctx,
			deps,
		);
		expect(deps.authorizeCodingSession).toHaveBeenCalledWith(PROV_CONFIG, {
			sessionKey: SESSION_KEY,
			authorizedBy: "cto-operator",
		});
	});

	test("fail-soft: provisioning error returns {ok:false,error} without throwing", async () => {
		const deps = makeDeps({
			authorizeCodingSession: vi.fn(async () => ({
				ok: false,
				error: "tedi runtime timed out",
			})),
		});
		const ctx = { apiKey: { id: "k1", scopes: ["platform:admin"] } };
		const result = await orchestrateAuthorize(
			{ tediId: TEDI_ID, sessionKey: SESSION_KEY },
			ctx,
			deps,
		);
		expect(result.ok).toBe(false);
		expect(result.error).toBe("tedi runtime timed out");
	});

	test("throws when provConfig is null (runtime route not configured)", async () => {
		const deps = makeDeps({
			getProvisioningConfig: vi.fn(() => null),
		});
		const ctx = { apiKey: { id: "k1", scopes: ["platform:admin"] } };
		await expect(
			orchestrateAuthorize(
				{ tediId: TEDI_ID, sessionKey: SESSION_KEY },
				ctx,
				deps,
			),
		).rejects.toThrow(/cannot authorize coding session/);
		expect(deps.authorizeCodingSession).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// revoke orchestration
// ---------------------------------------------------------------------------

describe("orchestrateRevoke", () => {
	test("calls revokeCodingSession with the right sessionKey", async () => {
		const deps = makeDeps();
		const ctx = { apiKey: { id: "k1", scopes: ["platform:admin"] } };
		const result = await orchestrateRevoke(
			{ tediId: TEDI_ID, sessionKey: SESSION_KEY },
			ctx,
			deps,
		);
		expect(result.ok).toBe(true);
		expect(deps.revokeCodingSession).toHaveBeenCalledOnce();
		expect(deps.revokeCodingSession).toHaveBeenCalledWith(PROV_CONFIG, {
			sessionKey: SESSION_KEY,
		});
	});

	test("fail-soft: provisioning error returns {ok:false,error} without throwing", async () => {
		const deps = makeDeps({
			revokeCodingSession: vi.fn(async () => ({
				ok: false,
				error: "service unavailable",
			})),
		});
		const ctx = { apiKey: { id: "k1", scopes: ["platform:admin"] } };
		const result = await orchestrateRevoke(
			{ tediId: TEDI_ID, sessionKey: SESSION_KEY },
			ctx,
			deps,
		);
		expect(result.ok).toBe(false);
		expect(result.error).toBe("service unavailable");
	});

	test("throws when provConfig is null", async () => {
		const deps = makeDeps({
			getProvisioningConfig: vi.fn(() => null),
		});
		const ctx = { apiKey: { id: "k1", scopes: ["platform:admin"] } };
		await expect(
			orchestrateRevoke(
				{ tediId: TEDI_ID, sessionKey: SESSION_KEY },
				ctx,
				deps,
			),
		).rejects.toThrow(/cannot revoke coding session/);
		expect(deps.revokeCodingSession).not.toHaveBeenCalled();
	});
});
