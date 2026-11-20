import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { verifyChain } from "@tedix/agent-governance/seal";
import type { ChangeRecordInput } from "@tedix/agent-governance/types";
import { SqlAccountabilityAdapter } from "./adapters";
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
