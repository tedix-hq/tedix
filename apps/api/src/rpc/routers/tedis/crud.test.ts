/**
 * updateTediProcedure capability-mutation gate — unit tests for the pure
 * predicate. Capability-tier fields are writable only by `user` and `apikey`
 * callers; every other `authType`, including an unresolved one, is refused.
 */

import { describe, expect, it } from "vite-plus/test";
import {
	agentUnreachableCapabilityFieldsTouched,
	resolveNewTediCapabilityProfile,
	resolveNewTediBudgets,
	resolveNewTediDefaultPolicyPack,
	resolveTediCreateOrg,
	resolveTediDeleteAccess,
} from "./crud";
import crudSource from "./crud.ts?raw";

describe("agentUnreachableCapabilityFieldsTouched", () => {
	it("blocks a tedi-authenticated caller changing mcpCapabilityProfile", () => {
		expect(
			agentUnreachableCapabilityFieldsTouched("tedi", {
				mcpCapabilityProfile: "platform_admin",
			}),
		).toEqual(["mcpCapabilityProfile"]);
	});

	it("blocks a tedi-authenticated caller changing toolPolicy", () => {
		expect(
			agentUnreachableCapabilityFieldsTouched("tedi", {
				toolPolicy: { deploy: "always-approve" },
			}),
		).toEqual(["toolPolicy"]);
	});

	it("blocks both fields at once and reports both", () => {
		expect(
			agentUnreachableCapabilityFieldsTouched("tedi", {
				mcpCapabilityProfile: "platform_admin",
				toolPolicy: { deploy: "always-approve" },
			}),
		).toEqual(["mcpCapabilityProfile", "toolPolicy"]);
	});

	it("does NOT block a tedi-authenticated caller updating unrelated fields (name, avatar, timezone)", () => {
		expect(
			agentUnreachableCapabilityFieldsTouched("tedi", {
				name: "New Name",
				avatar: "https://example.com/a.png",
				timezone: "Europe/Berlin",
			}),
		).toEqual([]);
	});

	it("never blocks a human (authType=user), even for capability fields", () => {
		expect(
			agentUnreachableCapabilityFieldsTouched("user", {
				mcpCapabilityProfile: "platform_admin",
				toolPolicy: { deploy: "always-approve" },
			}),
		).toEqual([]);
	});

	it("never blocks an operator-issued API key (authType=apikey), even for capability fields", () => {
		expect(
			agentUnreachableCapabilityFieldsTouched("apikey", {
				mcpCapabilityProfile: "platform_admin",
			}),
		).toEqual([]);
	});

	it("treats an explicit null the same as a real value — nulling out a capability field is still a mutation", () => {
		expect(
			agentUnreachableCapabilityFieldsTouched("tedi", {
				mcpCapabilityProfile: null,
			}),
		).toEqual(["mcpCapabilityProfile"]);
	});

	it("does not flag a field that is simply absent from the update payload", () => {
		expect(agentUnreachableCapabilityFieldsTouched("tedi", {})).toEqual([]);
	});

	// --- The confirmed-live gap this fix closes ------------------------------
	// The first shipped fix trusted `Boolean(context.tediId)` as the sole
	// "is this an agent?" signal. A conversational delegation turn's tool call
	// reaches apps/api via apps/mcp's identity-forwarding chain, which has a
	// demonstrated branch (the generic "human OAuth token" fallback in
	// apps/mcp/src/index.ts, hit when the target app lacks
	// `mcpConfig.descopeResourceId`) that never sets `x-tedix-auth-type` and so
	// never populates `context.tediId` downstream — even though the call
	// genuinely originated from a tedi's own LLM tool selection. Any authType
	// OTHER than the affirmative human/apikey allowlist must now be blocked,
	// regardless of whether `tediId` happens to be present or absent.
	it("blocks an M2M-authenticated caller (the exact live-confirmed bypass shape)", () => {
		expect(
			agentUnreachableCapabilityFieldsTouched("m2m", {
				mcpCapabilityProfile: "platform_admin",
			}),
		).toEqual(["mcpCapabilityProfile"]);
	});

	it("blocks the apps/mcp -> apps/api service-binding auth type (authType=service-binding)", () => {
		expect(
			agentUnreachableCapabilityFieldsTouched("service-binding", {
				toolPolicy: { deploy: "always-approve" },
			}),
		).toEqual(["toolPolicy"]);
	});

	it("blocks an unresolved/unknown authType (undefined) — fail CLOSED, not open", () => {
		expect(
			agentUnreachableCapabilityFieldsTouched(undefined, {
				mcpCapabilityProfile: "platform_admin",
			}),
		).toEqual(["mcpCapabilityProfile"]);
	});
});

/**
 * `repoConfig` is a capability grant (a bare `repoUrl` marks a tedi
 * `embodied`), and `cronJobs` is durable self-scheduling.
 */
describe("agentUnreachableCapabilityFieldsTouched — repoConfig / cronJobs", () => {
	it("blocks an agent granting itself repo/workstation capability via repoConfig", () => {
		expect(
			agentUnreachableCapabilityFieldsTouched("tedi", {
				repoConfig: {
					repoUrl: "https://github.com/tedix-hq/tedix",
					branch: "main",
				},
			}),
		).toEqual(["repoConfig"]);
	});

	it("blocks repoConfig on the live-confirmed conversational bypass shape (service-binding)", () => {
		expect(
			agentUnreachableCapabilityFieldsTouched("service-binding", {
				repoConfig: { repoUrl: "https://github.com/attacker/repo" },
			}),
		).toEqual(["repoConfig"]);
	});

	it("blocks an agent installing durable cron self-scheduling", () => {
		expect(
			agentUnreachableCapabilityFieldsTouched("tedi", {
				cronJobs: [{ schedule: "*/5 * * * *", prompt: "escalate" }],
			}),
		).toEqual(["cronJobs"]);
	});

	it("reports every touched capability field at once", () => {
		expect(
			agentUnreachableCapabilityFieldsTouched("tedi", {
				mcpCapabilityProfile: "platform_admin",
				toolPolicy: { bash: "always-allow" },
				repoConfig: { repoUrl: "https://github.com/x/y" },
				cronJobs: [],
			}),
		).toEqual(["mcpCapabilityProfile", "toolPolicy", "repoConfig", "cronJobs"]);
	});

	it("treats nulling repoConfig (revoking capability) as a mutation too", () => {
		expect(
			agentUnreachableCapabilityFieldsTouched("tedi", { repoConfig: null }),
		).toEqual(["repoConfig"]);
	});

	it("still lets a human set repoConfig and cronJobs", () => {
		expect(
			agentUnreachableCapabilityFieldsTouched("user", {
				repoConfig: { repoUrl: "https://github.com/tedix-hq/tedix" },
				cronJobs: [{ schedule: "0 9 * * 1", prompt: "weekly review" }],
			}),
		).toEqual([]);
	});

	it("keeps personality and channels writable but prevents self-raised budgets", () => {
		expect(
			agentUnreachableCapabilityFieldsTouched("tedi", {
				personality: "# SOUL.md",
				budgets: { monthlyUsd: 100 },
				channels: { telegram: { enabled: true } },
			}),
		).toEqual(["budgets"]);
	});
});

describe("resolveTediCreateOrg", () => {
	const CALLER = "11111111-1111-4111-8111-111111111111";
	const OTHER = "22222222-2222-4222-8222-222222222222";

	it("defaults to the caller's org", () => {
		expect(
			resolveTediCreateOrg({
				callerOrgId: CALLER,
				isPlatformPrincipal: false,
			}),
		).toEqual({ orgId: CALLER, forbidden: false });
	});

	// This is what makes tenant onboarding automatable: a platform admin can give a
	// freshly provisioned customer org its first tedi without logging into that
	// customer's workspace.
	it("lets a platform principal create in another org", () => {
		expect(
			resolveTediCreateOrg({
				callerOrgId: CALLER,
				requestedOrgId: OTHER,
				isPlatformPrincipal: true,
			}),
		).toEqual({ orgId: OTHER, forbidden: false });
	});

	it("refuses a non-platform caller naming another org", () => {
		expect(
			resolveTediCreateOrg({
				callerOrgId: CALLER,
				requestedOrgId: OTHER,
				isPlatformPrincipal: false,
			}),
		).toEqual({ orgId: OTHER, forbidden: true });
	});

	it("allows a non-platform caller to name their OWN org explicitly", () => {
		expect(
			resolveTediCreateOrg({
				callerOrgId: CALLER,
				requestedOrgId: CALLER,
				isPlatformPrincipal: false,
			}),
		).toEqual({ orgId: CALLER, forbidden: false });
	});
});

describe("resolveTediDeleteAccess", () => {
	const CALLER = "11111111-1111-4111-8111-111111111111";
	const OTHER = "22222222-2222-4222-8222-222222222222";

	it("allows an ordinary caller to delete a tedi in their OWN org", () => {
		expect(
			resolveTediDeleteAccess({
				callerOrgId: CALLER,
				tediOrgId: CALLER,
				isPlatformPrincipal: false,
			}),
		).toEqual({ allowed: true, crossOrg: false });
	});

	// The offboarding counterpart of resolveTediCreateOrg's cross-org create: a
	// platform admin can tear down a departing customer's tedis without
	// interactively logging into that customer's workspace.
	it("lets a platform principal delete a tedi in ANOTHER org", () => {
		expect(
			resolveTediDeleteAccess({
				callerOrgId: CALLER,
				tediOrgId: OTHER,
				isPlatformPrincipal: true,
			}),
		).toEqual({ allowed: true, crossOrg: true });
	});

	// Fail-closed: this is the whole reason the guard exists.
	it("refuses a non-platform caller deleting a tedi in another org", () => {
		expect(
			resolveTediDeleteAccess({
				callerOrgId: CALLER,
				tediOrgId: OTHER,
				isPlatformPrincipal: false,
			}),
		).toEqual({ allowed: false, crossOrg: true });
	});

	// REGRESSION — privilege escalation. EVERY tenant tedi's tool call reaches
	// apps/api as authType "service-binding" (that is how the MCP->API hop works),
	// carrying its own tenant's org id. If the transport alone conferred authority,
	// any `standard` tedi in any tenant could delete any tedi in any org. Authority
	// must come from the PRINCIPAL, never the binding. Only the internal `system`
	// caller gets the narrow bypass (mirrors requireTediAccess).
	it("refuses a non-system service binding deleting cross-org", () => {
		expect(
			resolveTediDeleteAccess({
				callerOrgId: CALLER,
				tediOrgId: OTHER,
				isPlatformPrincipal: false,
				isSystemServiceBinding: false,
			}),
		).toEqual({ allowed: false, crossOrg: true });
	});

	it("allows the internal system service binding to delete cross-org", () => {
		expect(
			resolveTediDeleteAccess({
				callerOrgId: "system",
				tediOrgId: OTHER,
				isPlatformPrincipal: false,
				isSystemServiceBinding: true,
			}),
		).toEqual({ allowed: true, crossOrg: true });
	});

	// A service binding scoped to the caller's own org gains nothing extra, and
	// platform authority never *downgrades* a same-org delete.
	it("reports crossOrg=false for a same-org platform principal", () => {
		expect(
			resolveTediDeleteAccess({
				callerOrgId: CALLER,
				tediOrgId: CALLER,
				isPlatformPrincipal: true,
			}),
		).toEqual({ allowed: true, crossOrg: false });
	});
});

describe("resolveNewTediCapabilityProfile", () => {
	// The first tedi in an org is its operator — it must be able to run the org
	// (install MCP apps, manage connections) so the human never opens the
	// dashboard. org_admin still has no platform:admin, so it stays own-org only.
	it("gives the first tedi in an org the org_admin profile", () => {
		expect(resolveNewTediCapabilityProfile({ existingTediCount: 0 })).toBe(
			"org_admin",
		);
	});

	it("gives every subsequent tedi the standard profile", () => {
		expect(resolveNewTediCapabilityProfile({ existingTediCount: 1 })).toBe(
			"standard",
		);
		expect(resolveNewTediCapabilityProfile({ existingTediCount: 7 })).toBe(
			"standard",
		);
	});

	it("honors an explicit requested profile over the first-tedi default", () => {
		expect(
			resolveNewTediCapabilityProfile({
				existingTediCount: 0,
				requestedProfile: "standard",
			}),
		).toBe("standard");
	});
});

/**
 * Wiring guard for the non-destructive delete path.
 *
 * `DELETE /tedis/{tediId}` used to call `deleteTedi`, whose D1 cascade destroys
 * this worker's memory_facts, tedi_rationale_records, tedi_artifacts,
 * tedi_runtime_events, skill_entries/skill_runs, tedi_expertise,
 * tedi_growth_snapshots and tedi_entrustment_grants. The retention behavior is
 * proven against real SQLite in
 * `packages/db/src/queries/tedi-retirement.test.ts`; what that suite cannot see
 * is which primitive this handler reaches for. Without this guard, reinstating
 * `deleteTedi` here would silently restore the cascade with every retention
 * test still green.
 *
 * Scoped to the single export, matching the convention in
 * `apps/api/src/rpc/step-up.test.ts` — a whole-file assertion would pass on
 * `decommissionTediProcedure`'s legitimate hard-purge call.
 */
function procedureSource(source: string, exportName: string): string {
	const start = source.indexOf(`export const ${exportName}`);
	if (start === -1) {
		throw new Error(`export ${exportName} not found — the guard is stale`);
	}
	const next = source.indexOf("\nexport ", start + 1);
	return source.slice(start, next === -1 ? source.length : next);
}

/**
 * Wiring guard for the fail-closed capability-DOWNGRADE re-sync (audit CC-2).
 *
 * The AIH M2M re-sync after a capability-profile change is DIRECTIONAL: an
 * upgrade/no-op stays best-effort (`waitUntil`), but a DOWNGRADE must propagate
 * the reduced scopes or surface the failure — a best-effort waitUntil that
 * swallows the error would silently leave the managed Descope client holding the
 * OLD, broader scopes. This guard asserts the handler still branches on
 * `isTediCapabilityDowngrade`, awaits the re-sync synchronously on the downgrade
 * path, and throws on failure rather than swallowing it. A regression that
 * reverts the whole block back to a single `waitUntil` would otherwise pass
 * every other test in this file.
 */
describe("updateTediProcedure fails closed on a capability downgrade", () => {
	const handler = procedureSource(crudSource, "updateTediProcedure");

	it("branches the AIH re-sync on isTediCapabilityDowngrade", () => {
		expect(handler).toContain("isTediCapabilityDowngrade(");
	});

	it("awaits the re-sync synchronously on the downgrade path", () => {
		expect(handler).toContain(
			"await materializeManagedAppAssignments(context, tedi)",
		);
	});

	it("surfaces (throws) a downgrade re-sync failure instead of swallowing it", () => {
		// The downgrade branch must createError on failure; the catch must not be a
		// bare best-effort swallow.
		expect(handler).toContain("DOWNGRADE failed");
		expect(handler).toContain("ErrorCodes.INTERNAL_SERVER_ERROR");
	});

	it("keeps the non-downgrade (upgrade/no-op) path best-effort + non-blocking", () => {
		expect(handler).toContain("context.waitUntil(resync)");
	});
});

describe("updateTediProcedure keeps inference admission authoritative", () => {
	const handler = procedureSource(crudSource, "updateTediProcedure");

	it("synchronizes an explicit AI Gateway policy after the tedi row update", () => {
		expect(
			handler.indexOf("await updateTedi(context.db, tediId, updateData)"),
		).toBeLessThan(
			handler.indexOf("await upsertTediInferencePolicy(context.db"),
		);
		expect(handler).toContain("data.budgets?.aiGatewayPolicy !== undefined");
		expect(handler).toContain("organizationId: existingTedi.organizationId");
	});
});

describe("deleteTediProcedure does not destroy the tedi's memory", () => {
	const handler = procedureSource(crudSource, "deleteTediProcedure");

	it("retires the tedi instead of deleting the row", () => {
		expect(handler).toContain("retireTedi(context.db,");
	});

	it("never calls the cascade-triggering deleteTedi primitive", () => {
		expect(handler).not.toContain("deleteTedi(");
	});

	it("still purges the external identity so the worker stops authenticating", () => {
		// Descope user, FGA relations and the AIH MCP server are re-creatable;
		// the memory is not. Retirement keeps the memory and drops the identity.
		expect(handler).toContain("purgeTediExternalIdentity(context, tedi)");
	});

	it("keeps the irreversible cascade reachable only through decommission", () => {
		// The purge primitive must still exist for the platform-admin
		// confirmSlug-gated hard purge — retirement replaces the default path,
		// it does not remove the ability to truly erase a worker.
		expect(procedureSource(crudSource, "decommissionTediProcedure")).toContain(
			"deleteTedi(context.db, tedi.id)",
		);
	});
});

describe("new tedi entitlement budgets", () => {
	const limits = {
		includedMonthlyTokens: 100_000,
		maxTedis: 1,
		maxCronJobsPerTedi: 2,
		maxIterationsPerTask: 8,
		defaultDailyTokenLimit: 50_000,
		defaultDailyMessageLimit: 50,
	};
	it("uses shared inference capacity while preserving the plan cron limit", () => {
		expect(resolveNewTediBudgets(limits)).toEqual({
			dailyTokenLimit: -1,
			dailyMessageLimit: -1,
			maxCronJobs: 2,
			maxIterationsPerTask: -1,
		});
		expect(
			resolveNewTediBudgets({ ...limits, maxCronJobsPerTedi: 4 }),
		).toMatchObject({ maxCronJobs: 4, maxIterationsPerTask: -1 });
	});
});

describe("new tedi default policy", () => {
	const current = {
		id: "current",
		scope: "system",
		slug: "system-default",
		version: 27,
		status: "active",
		publishedAt: "2026-08-29",
		target: "shared",
		definition: {
			cronPolicy: { disableCognitiveDefaults: true, cronTemplates: [] },
		},
	};
	const heads = (values: unknown[]) =>
		values as Parameters<typeof resolveNewTediDefaultPolicyPack>[0];
	it("selects newest active publication, ignoring later drafts and preserving disablement", () => {
		expect(
			resolveNewTediDefaultPolicyPack(
				heads([
					{ ...current, id: "old", version: 26 },
					{ ...current, id: "draft", version: 28, status: "draft" },
					current,
				]),
			),
		).toEqual(current);
	});
	it.each(
		[
			[],
			[{ ...current, status: "draft" }],
			[{ ...current, publishedAt: null }],
			[{ ...current, target: "app" }],
			[{ ...current, scope: "organization" }],
			[current, current],
		].map((values) => ({ values })),
	)(
		"fails closed for an unavailable or ambiguous default: %j",
		({ values }) => {
			expect(() => resolveNewTediDefaultPolicyPack(heads(values))).toThrow();
		},
	);
});
