import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { verifyChain } from "@tedix/agent-governance/seal";
import { hashValue } from "@tedix/agent-governance/hash";
import type {
	CallDescription,
	ChangeRecordInput,
} from "@tedix/agent-governance/types";
import {
	SqlAccountabilityAdapter,
	SqlComplianceAdapter,
	type TurnHolds,
} from "./adapters";
import { STAGED_REASON } from "./approval-modes";
import type { WorkspaceStorage } from "./runtime";

function memoryStorage(): WorkspaceStorage {
	const db = new Database(":memory:");
	return {
		exec: <T>(sql: string, ...params: unknown[]) =>
			db.query(sql).all(...(params as never[])) as T[],
		run: (sql, ...params) => {
			if (params.length) db.query(sql).run(...(params as never[]));
			else db.exec(sql);
		},
		get: () => undefined,
		put: () => {},
		delete: () => {},
	};
}

const input: ChangeRecordInput = {
	resource: "output:o1",
	operation: "write",
	actor: { id: "member", kind: "user" },
	source: { surface: "workspace_object" },
	decision: {
		verdict: "allow",
		gate: "tool_scope",
		reason: "allowed",
		riskTier: "bounded_write",
		blastRadius: "single_resource",
	},
	outcome: "applied",
	argsHash: "hash",
};

test("a workspace ledger export verifies with the gateway's verifyChain, rows from before chaining included", async () => {
	const storage = memoryStorage();
	// A store created before chaining: no seal columns, one record in it.
	storage.run(
		"CREATE TABLE change_records (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, recorded_at TEXT NOT NULL, resource TEXT NOT NULL, operation TEXT NOT NULL, actor_id TEXT NOT NULL, outcome TEXT NOT NULL, record TEXT NOT NULL)",
	);
	const old = {
		...input,
		id: "old",
		sequence: 1,
		recordedAt: "2026-11-01T00:00:00.000Z",
	};
	storage.run(
		"INSERT INTO change_records (sequence, id, recorded_at, resource, operation, actor_id, outcome, record) VALUES (1, 'old', ?, 'output:o1', 'write', 'member', 'applied', ?)",
		old.recordedAt,
		JSON.stringify(old),
	);
	const ledger = new SqlAccountabilityAdapter(storage, {
		productSha: "abc123",
	});
	await Promise.all([ledger.append(input), ledger.append(input)]);

	const records = await ledger.list();
	expect(records.map((r) => r.sequence)).toEqual([1, 2, 3]);
	expect(records[2]).toMatchObject({
		schemaVersion: 2,
		environment: { productSha: "abc123" },
	});
	expect(
		await verifyChain({ records, checkpoints: [], publicKey: null }),
	).toMatchObject({ ok: true, recordsVerified: 3, unsealedRecords: 0 });

	const tampered = records.map((r, i) =>
		i === 1 ? { ...r, environment: { productSha: "other" } } : r,
	);
	expect(
		await verifyChain({ records: tampered, checkpoints: [], publicKey: null }),
	).toMatchObject({ ok: false, reason: "digest", sequence: 2 });
});

describe("the gate stages a person's file and Work writes in the asking modes", () => {
	const gate = (
		mode: TurnHolds["mode"],
		personSent = true,
		storage = memoryStorage(),
	) =>
		new SqlComplianceAdapter(storage, { writesNeedApproval: true }).under({
			mode,
			computerReadsHeld: false,
			personSent,
			approvedAll: () => false,
		});
	const call = (
		resource: string,
		operation: string,
		args: unknown[] = [{ outputId: "o1", expectedRevision: 1 }],
	): CallDescription => ({
		resource,
		operation,
		args,
		actor: { id: "u1", kind: "user", organizationId: "org1" },
		source: { surface: "workspace_object" },
		riskTier: "bounded_write",
		blastRadius: "single_resource",
	});

	test("account writes reach their canonical approval service except in Read only", async () => {
		for (const mode of ["auto", "ask_every_time", "ask_for_changes"] as const)
			expect(
				(await gate(mode).check(call("connected_account", "write"))).verdict,
			).toBe("allow");
		expect(
			(await gate("read_only").check(call("connected_account", "write")))
				.verdict,
		).toBe("deny");
	});

	test("a doc edit or a Work Item stages; nothing is allowed to run", async () => {
		for (const mode of ["ask_every_time", "ask_for_changes"] as const)
			for (const [resource, operation] of [
				["output", "edit"],
				["output", "create"],
				["work", "create"],
				["work", "comment"],
			] as const)
				expect(await gate(mode).check(call(resource, operation))).toMatchObject(
					{ verdict: "needs_approval", reason: STAGED_REASON },
				);
	});

	test("what always asks, outside services, other turns and other modes never stage", async () => {
		const reasons = async (
			mode: TurnHolds["mode"],
			description: CallDescription,
			personSent = true,
		) => (await gate(mode, personSent).check(description)).reason;
		const removal = call("output", "edit", [
			{ outputId: "o1", ops: [{ op: "delete", index: 0 }] },
		]);
		const message = call("tedi_tool", "call", [{ tool: "gmail_send_message" }]);
		const otherOrg = call("output", "edit", [
			{ outputId: "o1", organizationId: "org2" },
		]);
		for (const description of [removal, message, otherOrg])
			expect(await reasons("ask_for_changes", description)).not.toBe(
				STAGED_REASON,
			);
		expect(
			await reasons(
				"ask_for_changes",
				call("tedi_tool", "call", [{ tool: "linear_create_issue" }]),
			),
		).not.toBe(STAGED_REASON);
		// A turn from an app, a tedi or a schedule keeps asking.
		expect(
			await reasons("ask_for_changes", call("output", "edit"), false),
		).not.toBe(STAGED_REASON);
		// Auto runs it; Read only refuses it.
		expect((await gate("auto").check(call("output", "edit"))).verdict).toBe(
			"allow",
		);
		expect(
			(await gate("read_only").check(call("output", "edit"))).verdict,
		).toBe("deny");
	});

	test("accepting runs the staged call once with the person's receipt", async () => {
		const storage = memoryStorage();
		const compliance = new SqlComplianceAdapter(storage, {
			writesNeedApproval: true,
		});
		const accepted = call("output", "revise", [
			{
				outputId: "o1",
				content: { kind: "document", blocks: [] },
				expectedRevision: 1,
			},
		]);
		compliance.recordApproval("a1", "approved", "u1", {
			resource: "output",
			operation: "revise",
			argsHash: await hashValue(accepted.args),
		});
		expect(
			(await gate("ask_for_changes", true, storage).check(accepted)).verdict,
		).toBe("allow");
	});
});
