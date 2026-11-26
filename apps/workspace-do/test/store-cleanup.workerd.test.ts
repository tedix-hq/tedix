import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { tenantStoreStub } from "@tedix/db/tenant-store/router";
import { expect, test } from "vite-plus/test";
import type { WorkspaceRpc } from "../src/do";
import type { WorkspaceEnv } from "../src/env";
import { sweepWorkspaceSchemaVersions } from "../src/schema-sweep";
import { migrateWorkspaceSchema } from "../src/workspace-schema";
import type { WorkspaceStorage } from "../src/runtime";

const testEnv = env as unknown as WorkspaceEnv;

test.each([true, false])(
	"versions a store and runs legacy repairs only once (legacy: %s)",
	async (legacy) => {
		const scope = {
			organizationId: "org_test",
			workspaceId: crypto.randomUUID(),
		};
		const ws = tenantStoreStub(testEnv.WORKSPACE, testEnv, scope);
		const before = await runInDurableObject(ws, async (_instance, state) => {
			await state.storage.put({
				"output-authority": "object",
				"output-import-generation": 3,
				"moved-chat-visible-archives": true,
				"unrelated-setting": { enabled: false, values: [1, "kept"] },
			});
			if (legacy) {
				state.storage.sql.exec("DELETE FROM workspace_schema_version");
				state.storage.sql.exec(
					"ALTER TABLE approvals DROP COLUMN action_class",
				);
				state.storage.sql.exec(`INSERT INTO approvals
					(approval_id, turn_id, conversation_id, step_id, binding, method, args,
					resource, args_hash, actor_id, actor_kind, status)
					VALUES ('kept', 't', 'c', 's', 'outputs', 'revise', '{}',
					'output', 'hash', 'person', 'user', 'pending')`);
				await state.storage.put("auto-approval-rules", [
					{ toolName: "example_read" },
				]);
			}
			return state.storage.list();
		});
		const expected = new Map(before);
		expected.delete("auto-approval-rules");
		await evictDurableObject(ws);
		const rpc = ws as unknown as WorkspaceRpc;
		const version = await rpc.readOwnSchemaVersion();
		expect(version.version).toBe(1);
		expect(version.appliedAt).toEqual(expect.any(String));
		await runInDurableObject(ws, async (_instance, state) => {
			expect(await state.storage.list()).toEqual(expected);
			if (legacy) {
				expect(
					state.storage.sql
						.exec("SELECT approval_id, status, action_class FROM approvals")
						.toArray(),
				).toEqual([
					{ approval_id: "kept", status: "pending", action_class: null },
				]);
			}
			// A sentinel proves the retired cleanup never runs again after v1.
			await state.storage.put("auto-approval-rules", "not touched again");
		});
		await evictDurableObject(ws);
		expect(await rpc.readOwnSchemaVersion()).toEqual(version);
		await runInDurableObject(ws, async (_instance, state) => {
			expect(await state.storage.get("auto-approval-rules")).toBe(
				"not touched again",
			);
		});
	},
);

test("sweeps new and existing object IDs and reports an unreadable ID", async () => {
	const existing = tenantStoreStub(testEnv.WORKSPACE, testEnv, {
		organizationId: "org_test",
		workspaceId: crypto.randomUUID(),
	});
	const fresh = testEnv.WORKSPACE.newUniqueId();
	const result = await sweepWorkspaceSchemaVersions(testEnv, [
		existing.id.toString(),
		fresh.toString(),
		"invalid",
	]);
	expect(result.expectedVersion).toBe(1);
	expect(result.stores).toEqual([
		{
			objectId: existing.id.toString(),
			version: 1,
			appliedAt: expect.any(String),
		},
		{ objectId: fresh.toString(), version: 1, appliedAt: expect.any(String) },
		{ objectId: "invalid", error: "unavailable" },
	]);
});

test("a failed version write rolls back the schema upgrade and retired-key deletion", async () => {
	const ws = tenantStoreStub(testEnv.WORKSPACE, testEnv, {
		organizationId: "org_test",
		workspaceId: crypto.randomUUID(),
	});
	await runInDurableObject(ws, async (_instance, state) => {
		state.storage.sql.exec("DELETE FROM workspace_schema_version");
		state.storage.sql.exec("ALTER TABLE approvals DROP COLUMN action_class");
		await state.storage.put("auto-approval-rules", "legacy");
		const storage: WorkspaceStorage = {
			exec<T>(sql: string, ...params: unknown[]) {
				return state.storage.sql
					.exec(sql, ...(params as SqlStorageValue[]))
					.toArray() as T[];
			},
			run(sql, ...params) {
				if (sql.startsWith("INSERT OR REPLACE INTO workspace_schema_version"))
					throw new Error("Injected version write failure");
				state.storage.sql.exec(sql, ...(params as SqlStorageValue[]));
			},
			get: (key) => state.storage.kv.get(key),
			put: (key, value) => state.storage.kv.put(key, value),
			delete: (key) => {
				state.storage.kv.delete(key);
			},
		};
		expect(() =>
			state.storage.transactionSync(() => migrateWorkspaceSchema(storage)),
		).toThrow("Injected version write failure");
		expect(
			state.storage.sql
				.exec("SELECT version FROM workspace_schema_version")
				.toArray(),
		).toEqual([]);
		expect(
			state.storage.sql
				.exec("PRAGMA table_info(approvals)")
				.toArray()
				.some((column) => column.name === "action_class"),
		).toBe(false);
		expect(await state.storage.get("auto-approval-rules")).toBe("legacy");
	});
});
