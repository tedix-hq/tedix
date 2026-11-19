import { describe, expect, it } from "vite-plus/test";
import { guardedCall, CallRefusedError } from "./wrap-binding";
import type {
	ApprovalEvidence,
	CallDescription,
	GovernanceAdapters,
} from "./types";

const actor = { id: "agent-1", kind: "agent", organizationId: "org-test" };
const provenance = {
	actor,
	source: { surface: "test" },
	changeRecordId: "change-1",
};
const readCall: CallDescription = {
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
			// A write: a ledger may leave out reads that applied.
			const call = {
				...readCall,
				operation: "update",
				riskTier: "bounded_write" as const,
				blastRadius: "single_resource" as const,
			};
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
		it("keeps the approval evidence of an allowed call and drops it from a refused one", async () => {
			const adapters = build();
			const call = {
				...readCall,
				operation: "update",
				riskTier: "bounded_write" as const,
				blastRadius: "single_resource" as const,
			};
			const shown: ApprovalEvidence = {
				approverId: "user-approver",
				approvedAt: "2026-11-19T10:00:00.000Z",
				presentedHash: "a".repeat(64),
				approvalRequestId: "request-1",
				kind: "owner_request",
				boundArgsHash: "b".repeat(64),
				singleUse: true,
				policy: { revisionId: "rev-1", ruleDigest: "c".repeat(64) },
			};
			// Nothing was shown to anyone: presentedHash is absent.
			const unseen: ApprovalEvidence = {
				approverId: "policy:tenant_policy",
				approvedAt: "2026-11-19T10:00:01.000Z",
				kind: "policy",
				singleUse: false,
				policy: { ruleId: "tenant_policy" },
			};
			const first = await guardedCall(call, async () => "ok", {
				...adapters,
				approval: () => shown,
			});
			const second = await guardedCall(call, async () => "ok", {
				...adapters,
				approval: () => unseen,
			});
			await expect(
				guardedCall({ ...call, destructive: true }, async () => "no", {
					...adapters,
					approval: () => shown,
				}),
			).rejects.toBeInstanceOf(CallRefusedError);
			expect(first.record.approval).toEqual(shown);
			expect(second.record.approval).toEqual(unseen);
			const rows = await adapters.accountability.list();
			expect(rows.map((row) => row.approval)).toEqual([
				shown,
				unseen,
				undefined,
			]);
		});
		it("enforces tier budgets and separates actors", async () => {
			const adapters = build();
			const write = { ...readCall, riskTier: "high_impact_write" as const };
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
