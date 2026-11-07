import { describe, expect, it } from "vite-plus/test";
import { guardedCall, CallRefusedError } from "./wrap-binding";
import type { CallDescription, GovernanceAdapters } from "./types";

const actor = { id: "agent-1", kind: "agent", organizationId: "org-test" };
const provenance = {
	actor,
	source: { surface: "test" },
	changeRecordId: "change-1",
};
const call: CallDescription = {
	actor,
	source: provenance.source,
	resource: "tool:test",
	operation: "read",
	args: { token: "secret" },
	riskTier: "read",
	blastRadius: "none",
};

/** Supply fresh isolated storage for each contract test. */
export function describeGovernanceConformance(
	name: string,
	build: () => GovernanceAdapters,
) {
	describe(name, () => {
		it("writes provenance, reviews once, preserves approved values, and rolls back by append", async () => {
			const { memory } = build();
			expect(await memory.read("missing")).toBeNull();
			expect(await memory.history("missing")).toEqual([]);
			const r1 = await memory.write({
				key: "prefs/tone",
				value: { tone: "formal" },
				provenance,
			});
			const r2 = await memory.write({
				key: "prefs/tone",
				value: null,
				provenance,
			});
			expect(r1).toMatchObject({ revision: 1, review: "pending", provenance });
			expect((await memory.read(r1.key))?.approved).toBeUndefined();
			await memory.review(r1.revisionId, "approve", actor, "reviewed");
			await memory.review(r2.revisionId, "reject", actor);
			expect(await memory.read(r1.key)).toMatchObject({
				current: { revisionId: r2.revisionId, review: "rejected" },
				approved: {
					revisionId: r1.revisionId,
					reviewedBy: actor.id,
					reviewNote: "reviewed",
				},
			});
			await expect(
				memory.review(r1.revisionId, "reject", actor),
			).rejects.toThrow("already approved");
			await expect(memory.review("absent", "approve", actor)).rejects.toThrow(
				"Unknown memory revision",
			);
			const r3 = await memory.rollback(r1.key, r1.revisionId, provenance);
			expect(r3).toMatchObject({
				revision: 3,
				value: r1.value,
				hash: r1.hash,
				review: "approved",
				rolledBackFrom: r1.revisionId,
			});
			expect((await memory.history(r1.key)).map((r) => r.revision)).toEqual([
				1, 2, 3,
			]);
			await expect(
				memory.rollback("other", r1.revisionId, provenance),
			).rejects.toThrow("not a revision");
			expect((await memory.list("prefs/")).map((e) => e.key)).toEqual([r1.key]);
			await memory.write({ key: "literal%_\\", value: false, provenance });
			expect((await memory.list("literal%_\\")).map((e) => e.key)).toEqual([
				"literal%_\\",
			]);
		});
		it("records allowed, refused and uncertain calls in an immutable ordered ledger", async () => {
			const adapters = build();
			await guardedCall(call, async () => "ok", adapters);
			await expect(
				guardedCall(
					{ ...call, destructive: true },
					async () => {
						throw new Error("must not run");
					},
					adapters,
				),
			).rejects.toBeInstanceOf(CallRefusedError);
			await expect(
				guardedCall(
					call,
					async () => {
						throw new Error("upstream");
					},
					adapters,
				),
			).rejects.toThrow("upstream");
			const rows = await adapters.accountability.list();
			expect(rows.map((r) => r.outcome)).toEqual([
				"applied",
				"needs_approval",
				"unknown",
			]);
			expect(
				rows.every((r, i) => i === 0 || r.sequence > rows[i - 1]!.sequence),
			).toBe(true);
			expect(Object.isFrozen(rows[0])).toBe(true);
			expect(await adapters.accountability.get(rows[0]!.id)).toEqual(rows[0]);
			expect(await adapters.accountability.get("missing")).toBeNull();
			expect(
				await adapters.accountability.list({
					resource: call.resource,
					actorId: actor.id,
					afterSequence: rows[0]!.sequence,
					limit: 1,
				}),
			).toEqual([rows[1]]);
			expect(await adapters.accountability.list({ actorId: "other" })).toEqual(
				[],
			);
			expect(await adapters.accountability.list({ limit: 0 })).toEqual([]);
			expect((await adapters.accountability.export()).records).toEqual(rows);
		});
		it("enforces tier budgets and separates actors", async () => {
			const adapters = build();
			const write = { ...call, riskTier: "high_impact_write" as const };
			for (let i = 0; i < 5; i++)
				expect((await adapters.compliance.check(write)).verdict).toBe("allow");
			expect(await adapters.compliance.check(write)).toMatchObject({
				verdict: "deny",
				gate: "risk_rate_limit",
				rate: { limited: true },
			});
			expect(
				(
					await adapters.compliance.check({
						...write,
						actor: { ...actor, id: "other" },
					})
				).verdict,
			).toBe("allow");
		});
	});
}
