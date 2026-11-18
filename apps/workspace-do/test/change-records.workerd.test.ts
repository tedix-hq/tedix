import { env, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vite-plus/test";
import { tenantStoreStub } from "@tedix/db/tenant-store/router";
import type { WorkspaceRpc } from "../src/do";
import type { WorkspaceEnv } from "../src/env";

const scope = {
	organizationId: "org_ledger_test",
	workspaceId: "a1111111-1111-4111-8111-111111111111",
};
const range = {
	from: "2026-10-01T00:00:00.000Z",
	until: "2026-10-02T00:00:00.000Z",
	limit: 2,
};

test("change record export counts the full time range, pages the records and isolates scope", async () => {
	const bindings = env as unknown as WorkspaceEnv;
	const stub = tenantStoreStub(
		bindings.WORKSPACE,
		bindings,
		scope,
	) as unknown as DurableObjectStub & WorkspaceRpc;
	await stub.readChangeRecords(scope);
	await runInDurableObject(stub, (_instance, state) => {
		const insert = (sequence: number, at: string) => {
			const record = {
				id: `record-${sequence}`,
				sequence,
				recordedAt: at,
				resource: "output",
				operation: "read",
				actor: { id: "member", kind: "user" },
				source: { surface: "workspace_object" },
				decision: { verdict: "allow", gate: "tool_scope" },
				outcome: "succeeded",
				argsHash: "hash",
			};
			state.storage.sql.exec(
				"INSERT INTO change_records (sequence, id, recorded_at, resource, operation, actor_id, outcome, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				sequence,
				record.id,
				at,
				"output",
				"read",
				"member",
				"succeeded",
				JSON.stringify(record),
			);
		};
		insert(1, "2026-09-30T23:59:59.999Z");
		for (let i = 2; i <= 1006; i++) insert(i, range.from);
		insert(1007, range.until);
	});
	const first = await stub.exportChangeRecords(scope, range);
	expect(first.count).toBe(1005);
	expect(first.records.map((r) => r.sequence)).toEqual([2, 3]);
	expect(first.records[0]?.actor).toEqual({ id: "member", kind: "user" });
	expect(first.nextAfterSequence).toBe(3);
	const last = await stub.exportChangeRecords(scope, {
		...range,
		afterSequence: 1004,
	});
	expect(last.count).toBe(1005);
	expect(last.records.map((r) => r.sequence)).toEqual([1005, 1006]);
	expect(last.nextAfterSequence).toBeNull();
	const empty = await stub.exportChangeRecords(scope, {
		...range,
		from: "2026-10-03T00:00:00.000Z",
		until: "2026-10-04T00:00:00.000Z",
	});
	expect(empty).toMatchObject({
		count: 0,
		records: [],
		nextAfterSequence: null,
	});
	const otherScope = {
		...scope,
		workspaceId: "b1111111-1111-4111-8111-111111111111",
	};
	const other = tenantStoreStub(
		bindings.WORKSPACE,
		bindings,
		otherScope,
	) as unknown as WorkspaceRpc;
	expect(await other.exportChangeRecords(otherScope, range)).toMatchObject({
		count: 0,
		records: [],
	});
	for (const deniedScope of [
		{ ...scope, organizationId: "org_other" },
		otherScope,
	]) {
		let scopeError: unknown;
		try {
			await stub.exportChangeRecords(deniedScope, range);
		} catch (error) {
			scopeError = error;
		}
		expect(scopeError).toBeInstanceOf(Error);
		expect((scopeError as Error).message).toBe(
			"TenantStore scope does not match this object",
		);
	}
	expect((await stub.readChangeRecords(scope, { limit: 1000 })).length).toBe(
		1000,
	);
});
