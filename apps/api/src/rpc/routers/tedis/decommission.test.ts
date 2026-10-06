import { describe, expect, test, vi } from "vite-plus/test";
import {
	assertPlatformAdminOrServiceBinding,
	orchestrateTediDecommission as orchestrateTediDecommissionRaw,
} from "./crud";
import type { BaseContext } from "./helpers";

type DecommissionArgs = Parameters<typeof orchestrateTediDecommissionRaw>[0];
const orchestrateTediDecommission = (
	args: Omit<DecommissionArgs, "orgId"> & { orgId?: string },
) => orchestrateTediDecommissionRaw({ ...args, orgId: args.orgId ?? "org-1" });

/**
 * Build a set of decommission deps with vitest spies. Defaults model a healthy
 * isolate tedi where every sub-cleanup succeeds; individual tests override.
 */
function makeDeps(
	overrides: Partial<
		Parameters<typeof orchestrateTediDecommission>[0]["deps"]
	> = {},
) {
	return {
		decommission: vi.fn(async () => true),
		isIsolateBody: true,
		stopSchedules: vi.fn(async () => ({
			attempted: true,
			ok: true,
			canceledScheduleIds: ["sched-1", "sched-2"],
		})),
		purgeExternalIdentity: vi.fn(async () => [
			{
				step: "descope_fga_revoke",
				ok: true,
				detail: "revoked 3 app relations",
			},
			{ step: "descope_identity_delete", ok: true, detail: "deleted user u1" },
		]),
		purgeAgentMemoryProfile: vi.fn(async () => ({
			step: "agent_memory_profile_delete",
			ok: true,
			detail: "org:org-1:tedi:tedi-1",
		})),
		deleteRow: vi.fn(async () => {}),
		emitAudit: vi.fn(() => {}),
		...overrides,
	};
}

describe("assertPlatformAdminOrServiceBinding (scope gating)", () => {
	test("rejects an ordinary org user (no platform authority)", () => {
		const ctx = {
			authType: "user",
			user: { sub: "user-123", email: "member@acme.com" },
		} as unknown as BaseContext;
		expect(() => assertPlatformAdminOrServiceBinding(ctx)).toThrow(
			/Platform admin authority required/,
		);
	});

	test("rejects an API key without platform:admin scope", () => {
		const ctx = {
			authType: "api-key",
			apiKey: { id: "k1", scopes: ["apps:read"] },
		} as unknown as BaseContext;
		expect(() => assertPlatformAdminOrServiceBinding(ctx)).toThrow(
			/Platform admin authority required/,
		);
	});

	test("accepts an API key with platform:admin scope", () => {
		const ctx = {
			authType: "api-key",
			apiKey: { id: "k1", scopes: ["platform:admin"] },
		} as unknown as BaseContext;
		expect(() => assertPlatformAdminOrServiceBinding(ctx)).not.toThrow();
	});

	test("accepts a trusted service binding", () => {
		const ctx = { authType: "service-binding" } as unknown as BaseContext;
		expect(() => assertPlatformAdminOrServiceBinding(ctx)).not.toThrow();
	});
});

describe("orchestrateTediDecommission — confirmSlug gating", () => {
	test("rejects a hard purge when confirmSlug does not match the slug", async () => {
		const deps = makeDeps();
		await expect(
			orchestrateTediDecommission({
				tediId: "tedi-1",
				slug: "echo",
				input: { hardPurge: true, confirmSlug: "wrong" },
				deps,
			}),
		).rejects.toThrow(/confirmSlug to exactly match the tedi slug "echo"/);

		// Fail-closed BEFORE any mutation — and before any audit, since nothing
		// destructive happened.
		expect(deps.decommission).not.toHaveBeenCalled();
		expect(deps.purgeExternalIdentity).not.toHaveBeenCalled();
		expect(deps.deleteRow).not.toHaveBeenCalled();
		expect(deps.emitAudit).not.toHaveBeenCalled();
	});

	test("rejects a hard purge when confirmSlug is omitted", async () => {
		const deps = makeDeps();
		await expect(
			orchestrateTediDecommission({
				tediId: "tedi-1",
				slug: "echo",
				input: { hardPurge: true },
				deps,
			}),
		).rejects.toThrow(/confirmSlug/);
		expect(deps.deleteRow).not.toHaveBeenCalled();
	});
});

describe("orchestrateTediDecommission — decommission path (no purge)", () => {
	test("decommissions + stops schedules, never deletes, no residual steps", async () => {
		const deps = makeDeps();
		const result = await orchestrateTediDecommission({
			tediId: "tedi-1",
			slug: "echo",
			input: {},
			deps,
		});

		expect(deps.decommission).toHaveBeenCalledOnce();
		expect(deps.stopSchedules).toHaveBeenCalledOnce();
		expect(deps.purgeExternalIdentity).not.toHaveBeenCalled();
		expect(deps.deleteRow).not.toHaveBeenCalled();

		expect(result.decommissioned).toBe(true);
		expect(result.purged).toBe(false);
		expect(result.schedulesStopped).toMatchObject({
			attempted: true,
			ok: true,
		});
		expect(result.schedulesStopped.canceledScheduleIds).toEqual([
			"sched-1",
			"sched-2",
		]);
		expect(result.programmaticCleanups).toEqual([]);
		expect(result.residualManualSteps).toEqual([]);
	});

	test("throws fail-closed when the Stage-1 decommission write returns no row", async () => {
		const deps = makeDeps({ decommission: vi.fn(async () => false) });
		await expect(
			orchestrateTediDecommission({
				tediId: "tedi-1",
				slug: "echo",
				input: {},
				deps,
			}),
		).rejects.toThrow(/Failed to decommission tedi/);
	});

	test("skips (does not fail) schedule stop for a container/legacy body", async () => {
		const deps = makeDeps({ isIsolateBody: false });
		const result = await orchestrateTediDecommission({
			tediId: "tedi-1",
			slug: "echo",
			input: { stopSchedules: true },
			deps,
		});
		expect(deps.stopSchedules).not.toHaveBeenCalled();
		expect(result.schedulesStopped).toMatchObject({
			attempted: false,
			ok: true,
		});
		expect(result.schedulesStopped.detail).toMatch(/container\/legacy/);
	});

	test("honors stopSchedules=false (not requested)", async () => {
		const deps = makeDeps();
		const result = await orchestrateTediDecommission({
			tediId: "tedi-1",
			slug: "echo",
			input: { stopSchedules: false },
			deps,
		});
		expect(deps.stopSchedules).not.toHaveBeenCalled();
		expect(result.schedulesStopped).toMatchObject({
			attempted: false,
			ok: true,
			detail: "not requested",
		});
	});

	test("reports a failed schedule stop without aborting the run", async () => {
		const deps = makeDeps({
			stopSchedules: vi.fn(async () => ({
				attempted: true,
				ok: false,
				detail: "timeout_after_10000ms",
			})),
		});
		const result = await orchestrateTediDecommission({
			tediId: "tedi-1",
			slug: "echo",
			input: {},
			deps,
		});
		expect(result.decommissioned).toBe(true);
		expect(result.schedulesStopped).toMatchObject({
			attempted: true,
			ok: false,
			detail: "timeout_after_10000ms",
		});
	});
});

describe("orchestrateTediDecommission — hard-purge orchestration", () => {
	test("runs external-identity teardown + D1 delete and reports residual steps", async () => {
		const deps = makeDeps();
		const result = await orchestrateTediDecommission({
			tediId: "tedi-361b",
			slug: "echo",
			input: { hardPurge: true, confirmSlug: "echo" },
			deps,
		});

		expect(deps.decommission).toHaveBeenCalledOnce();
		expect(deps.purgeExternalIdentity).toHaveBeenCalledOnce();
		expect(deps.deleteRow).toHaveBeenCalledOnce();

		expect(result.purged).toBe(true);

		// Programmatic cleanups carry the mocked sub-cleanup outcomes plus the
		// D1 cascade marker appended after deleteRow.
		const steps = result.programmaticCleanups.map((c) => c.step);
		expect(steps).toContain("descope_fga_revoke");
		expect(steps).toContain("descope_identity_delete");
		expect(steps).toContain("d1_cascade_delete");
		const cascade = result.programmaticCleanups.find(
			(c) => c.step === "d1_cascade_delete",
		);
		expect(cascade?.ok).toBe(true);
		expect(cascade?.detail).toMatch(/tedi_secrets/);

		// Agent Memory is programmatic; only R2 and Artifacts remain manual.
		expect(result.residualManualSteps).toHaveLength(2);
		const residual = result.residualManualSteps;
		expect(residual.some((s) => /R2 objects/.test(s.step))).toBe(true);
		expect(residual.some((s) => /artifacts repository/.test(s.step))).toBe(
			true,
		);
		expect(residual.some((s) => /Agent Memory/.test(s.step))).toBe(false);
		// The purged tediId is interpolated into the residual instructions.
		expect(residual.some((s) => s.step.includes("tedi-361b"))).toBe(true);
		// Each residual step names the scope required to complete it.
		for (const step of residual) {
			expect(step.scope.length).toBeGreaterThan(0);
			expect(step.reason.length).toBeGreaterThan(0);
		}
	});

	test("residual R2 step enumerates the real runtime key prefixes while Agent Memory is programmatic", async () => {
		const tediId = "11111111-2222-3333-4444-555555555555";
		const result = await orchestrateTediDecommission({
			tediId,
			slug: "echo",
			input: { hardPurge: true, confirmSlug: "echo" },
			deps: makeDeps(),
		});

		const r2 = result.residualManualSteps.find((s) =>
			/R2 objects/.test(s.step),
		);
		expect(r2).toBeDefined();
		// Runtime writes under the bare `${tediId}/` prefix — every real write path
		// must be enumerated so an operator does not leave data behind.
		expect(r2?.step).toContain(`${tediId}/objects/`);
		expect(r2?.step).toContain(`${tediId}/tedi_shell_workspace/`);
		expect(r2?.step).toContain(`${tediId}/harness/runs/`);
		expect(r2?.step).toContain(`${tediId}/artifacts/turn_summary/`);
		expect(r2?.step).toContain(`${tediId}/SOUL.md`);
		expect(r2?.step).toContain(`${tediId}/memory/`);
		// Browser captures are the documented exception (still `tedis/`/`orgs/`).
		expect(r2?.step).toContain(`tedis/${tediId}/browser-`);
		expect(r2?.step).toContain(`orgs/<orgId>/tedis/${tediId}/browser-`);
		// The installation binding identifies the correct bucket.
		expect(r2?.step).toContain("TEDI_STORAGE binding");
		// It must NOT instruct deleting the wrong, data-leaving `tedis/${tediId}/*`
		// blanket prefix for the per-tedi namespace.
		expect(r2?.step).not.toMatch(/under the tedis\//);

		expect(
			result.programmaticCleanups.find(
				(step) => step.step === "agent_memory_profile_delete",
			)?.ok,
		).toBe(true);
	});

	test("retains an exact-profile manual residual when managed-memory deletion fails", async () => {
		const result = await orchestrateTediDecommission({
			tediId: "tedi-1",
			orgId: "org-1",
			slug: "echo",
			input: { hardPurge: true, confirmSlug: "echo" },
			deps: makeDeps({
				purgeAgentMemoryProfile: vi.fn(async () => ({
					step: "agent_memory_profile_delete",
					ok: false,
					detail: "runtime unavailable",
				})),
			}),
		});

		const residual = result.residualManualSteps.find((step) =>
			/Agent Memory/.test(step.step),
		);
		expect(residual?.step).toContain("org:org-1:tedi:tedi-1");
	});

	test("surfaces a failed sub-cleanup without aborting the D1 delete", async () => {
		const deps = makeDeps({
			purgeExternalIdentity: vi.fn(async () => [
				{
					step: "descope_identity_delete",
					ok: false,
					detail: "descope 500",
				},
			]),
		});
		const result = await orchestrateTediDecommission({
			tediId: "tedi-1",
			slug: "echo",
			input: { hardPurge: true, confirmSlug: "echo" },
			deps,
		});
		// Delete still runs even though identity cleanup failed.
		expect(deps.deleteRow).toHaveBeenCalledOnce();
		expect(result.purged).toBe(true);
		const identity = result.programmaticCleanups.find(
			(c) => c.step === "descope_identity_delete",
		);
		expect(identity?.ok).toBe(false);
	});
});

describe("orchestrateTediDecommission — always-on audit", () => {
	test("emits a 'completed' audit once with the full stage outcomes on success", async () => {
		const deps = makeDeps();
		await orchestrateTediDecommission({
			tediId: "tedi-1",
			slug: "echo",
			input: { hardPurge: true, confirmSlug: "echo" },
			deps,
		});

		expect(deps.emitAudit).toHaveBeenCalledOnce();
		const audit = deps.emitAudit.mock.calls[0][0];
		expect(audit.status).toBe("completed");
		expect(audit.failedStage).toBeUndefined();
		expect(audit.result.purged).toBe(true);
		expect(audit.result.decommissioned).toBe(true);
		expect(audit.result.programmaticCleanups.map((c) => c.step)).toContain(
			"d1_cascade_delete",
		);
		expect(audit.result.residualManualSteps.length).toBeGreaterThan(0);
	});

	test("emits a 'failed' audit with the partial stage outcomes when a sub-step throws mid-orchestration, then re-throws", async () => {
		// The D1 delete throws AFTER external-identity teardown already succeeded:
		// the destructive footprint is partially gone and MUST still be audited.
		const deps = makeDeps({
			deleteRow: vi.fn(async () => {
				throw new Error("d1 delete failed: connection lost");
			}),
		});

		await expect(
			orchestrateTediDecommission({
				tediId: "tedi-1",
				slug: "echo",
				input: { hardPurge: true, confirmSlug: "echo" },
				deps,
			}),
		).rejects.toThrow(/d1 delete failed/);

		// Identity teardown ran; the delete then threw.
		expect(deps.purgeExternalIdentity).toHaveBeenCalledOnce();
		expect(deps.deleteRow).toHaveBeenCalledOnce();

		// Audit was still emitted exactly once, marking the failure + partial state.
		expect(deps.emitAudit).toHaveBeenCalledOnce();
		const audit = deps.emitAudit.mock.calls[0][0];
		expect(audit.status).toBe("failed");
		expect(audit.failedStage).toBe("d1_delete");
		expect(audit.error).toMatch(/d1 delete failed/);
		// Completed-vs-failed stage outcomes: decommission + identity teardown
		// landed, but the cascade delete did not, so purged stays false.
		expect(audit.result.decommissioned).toBe(true);
		expect(audit.result.purged).toBe(false);
		const steps = audit.result.programmaticCleanups.map((c) => c.step);
		expect(steps).toContain("descope_identity_delete");
		expect(steps).not.toContain("d1_cascade_delete");
	});

	test("emits a 'failed' audit when the Stage-1 decommission write fails", async () => {
		const deps = makeDeps({ decommission: vi.fn(async () => false) });
		await expect(
			orchestrateTediDecommission({
				tediId: "tedi-1",
				slug: "echo",
				input: {},
				deps,
			}),
		).rejects.toThrow(/Failed to decommission tedi/);

		expect(deps.emitAudit).toHaveBeenCalledOnce();
		const audit = deps.emitAudit.mock.calls[0][0];
		expect(audit.status).toBe("failed");
		expect(audit.failedStage).toBe("decommission");
		expect(audit.result.purged).toBe(false);
	});
});
