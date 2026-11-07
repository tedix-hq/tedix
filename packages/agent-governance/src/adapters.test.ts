import { describe, expect, it } from "vite-plus/test";
import { createInMemoryAdapters } from "./in-memory";
import { CallRefusedError, guardedCall, wrapBinding } from "./wrap-binding";
import type { Actor, CallDescription, Source } from "./types";

const actor: Actor = { id: "user-1", kind: "user", organizationId: "org-1" };
const source: Source = { surface: "workspace_object", traceId: "trace-1" };

class Crm {
	customers = new Map<string, string>([["c1", "Ada"]]);
	async getCustomer(id: string) {
		return this.customers.get(id) ?? null;
	}
	async renameCustomer(id: string, name: string) {
		this.customers.set(id, name);
		return { id, name };
	}
	async deleteCustomer(id: string) {
		this.customers.delete(id);
		return { deleted: id };
	}
}

function build(policies = {}) {
	const adapters = createInMemoryAdapters({
		policies: {
			"tool:crm.deleteCustomer": {
				riskTier: "high_impact_write",
				blastRadius: "single_resource",
				destructive: true,
			},
			"tool:crm.renameCustomer": {
				riskTier: "bounded_write",
				blastRadius: "single_resource",
			},
			...policies,
		},
	});
	const crm = new Crm();
	const wrapped = wrapBinding(crm, {
		...adapters,
		actor,
		source,
		resource: "tool:crm",
		methods: {
			getCustomer: { resource: "tool:crm.getCustomer", riskTier: "read" },
			renameCustomer: {
				resource: "tool:crm.renameCustomer",
				before: async ([id]) => ({
					revisionId: `c:${id}:before`,
					hash: crm.customers.get(id as string),
				}),
				after: async ([id], result) => ({
					revisionId: `c:${id}:after`,
					hash: (result as { name: string }).name,
				}),
				undo: ([id], _r, before) => ({
					kind: "compensating_call",
					call: {
						resource: "tool:crm.renameCustomer",
						operation: "renameCustomer",
						args: [id, before?.hash],
					},
				}),
			},
			deleteCustomer: {
				resource: "tool:crm.deleteCustomer",
				destructive: true,
			},
		},
	});
	return { adapters, crm, wrapped };
}

describe("wrapBinding", () => {
	it("checks, calls and records an allowed write with before/after and undo", async () => {
		const { adapters, wrapped } = build();
		expect(await wrapped.getCustomer("c1")).toBe("Ada");
		await wrapped.renameCustomer("c1", "Grace");
		const rows = await adapters.accountability.list();
		expect(
			rows.map((r) => [r.operation, r.outcome, r.decision.verdict]),
		).toEqual([
			["getCustomer", "applied", "allow"],
			["renameCustomer", "applied", "allow"],
		]);
		expect(rows[1]).toMatchObject({
			before: { hash: "Ada" },
			after: { hash: "Grace" },
			undo: { kind: "compensating_call", call: { args: ["c1", "Ada"] } },
			decision: { riskTier: "bounded_write", budget: { limit: 30 } },
		});
		expect(adapters.compliance.outcomes.map((o) => o.outcome.status)).toEqual([
			"applied",
			"applied",
		]);
	});

	it("refuses a destructive call without a receipt, never calls the binding, and still records", async () => {
		const { adapters, crm, wrapped } = build();
		await expect(wrapped.deleteCustomer("c1")).rejects.toBeInstanceOf(
			CallRefusedError,
		);
		expect(crm.customers.has("c1")).toBe(true);
		const [row] = await adapters.accountability.list({
			resource: "tool:crm.deleteCustomer",
		});
		expect(row).toMatchObject({
			outcome: "needs_approval",
			decision: { verdict: "needs_approval", gate: "destructive_approval" },
		});
	});

	it("rate-limits high-impact writes after the tier budget", async () => {
		const { adapters } = build({
			"tool:crm.archive": {
				riskTier: "high_impact_write",
				blastRadius: "single_resource",
			},
		});
		const call: CallDescription = {
			resource: "tool:crm.archive",
			operation: "archive",
			args: [],
			actor,
			source,
		};
		const run = () => guardedCall(call, async () => "ok", adapters);
		for (let i = 0; i < 5; i++) await run();
		const error = await run().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(CallRefusedError);
		expect((error as CallRefusedError).decision).toMatchObject({
			gate: "risk_rate_limit",
			rate: { limited: true, retryAfterSeconds: 60 },
		});
	});

	it("records an unknown outcome when the binding throws", async () => {
		const { adapters } = build();
		const call: CallDescription = {
			resource: "tool:crm.renameCustomer",
			operation: "renameCustomer",
			args: ["c1", "x"],
			actor,
			source,
		};
		await expect(
			guardedCall(
				call,
				async () => {
					throw new Error("upstream 502");
				},
				adapters,
			),
		).rejects.toThrow("upstream 502");
		const [row] = await adapters.accountability.list();
		expect(row?.outcome).toBe("unknown");
	});

	it("exports an append-only ledger with monotonic sequence", async () => {
		const { adapters, wrapped } = build();
		await wrapped.getCustomer("c1");
		await wrapped.getCustomer("c1");
		const exported = await adapters.accountability.export();
		expect(exported.records.map((r) => r.sequence)).toEqual([1, 2]);
		expect(Object.isFrozen(exported.records[0])).toBe(true);
	});
});

describe("InMemoryMemoryAdapter", () => {
	it("writes with provenance, reviews, and rolls back to a prior revision", async () => {
		const { adapters } = build();
		const provenance = { actor, source, changeRecordId: "chg_00000001" };
		const r1 = await adapters.memory.write({
			key: "prefs/tone",
			value: "formal",
			provenance,
		});
		const r2 = await adapters.memory.write({
			key: "prefs/tone",
			value: "casual",
			provenance,
		});
		expect(
			(await adapters.memory.read("prefs/tone"))?.approved,
		).toBeUndefined();
		await adapters.memory.review(r1.revisionId, "approve", {
			id: "owner",
			kind: "user",
		});
		await adapters.memory.review(
			r2.revisionId,
			"reject",
			{ id: "owner", kind: "user" },
			"too loose",
		);
		const entry = await adapters.memory.read("prefs/tone");
		expect(entry?.approved?.value).toBe("formal");
		expect(entry?.current.review).toBe("rejected");
		const r3 = await adapters.memory.rollback(
			"prefs/tone",
			r1.revisionId,
			provenance,
		);
		expect(r3).toMatchObject({
			revision: 3,
			value: "formal",
			rolledBackFrom: r1.revisionId,
			hash: r1.hash,
		});
		expect((await adapters.memory.history("prefs/tone")).length).toBe(3);
		expect((await adapters.memory.list("prefs/")).map((e) => e.key)).toEqual([
			"prefs/tone",
		]);
		await expect(
			adapters.memory.review(r1.revisionId, "reject", actor),
		).rejects.toThrow("already approved");
	});
});
