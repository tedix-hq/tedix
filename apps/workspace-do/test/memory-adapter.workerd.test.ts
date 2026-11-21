import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vite-plus/test";
import { hashValue } from "@tedix/agent-governance/hash";
import { InMemoryMemoryAdapter } from "@tedix/agent-governance/in-memory";
import {
	exportMemory,
	importMemory,
} from "@tedix/agent-governance/memory-transfer";
import type { MemoryProvenance } from "@tedix/agent-governance/types";
import { SqlMemoryAdapter } from "../src/memory-adapter";
import { buildMemoryBinding } from "../src/memory-binding";
import {
	SqlAccountabilityAdapter,
	SqlComplianceAdapter,
} from "../src/adapters";
import type { WorkspaceStorage } from "../src/runtime";
import type { WorkspaceEnv } from "../src/env";

function storageFor(storage: DurableObjectStorage): WorkspaceStorage {
	return {
		exec: <T>(sql: string, ...params: unknown[]) =>
			storage.sql.exec(sql, ...(params as SqlStorageValue[])).toArray() as T[],
		run: (sql, ...params) => {
			storage.sql.exec(sql, ...(params as SqlStorageValue[]));
		},
		get: <T>(key: string) => storage.kv.get<T>(key),
		put: (key, value) => {
			storage.kv.put(key, value);
		},
		delete: (key) => {
			storage.kv.delete(key);
		},
	};
}
const provenance: MemoryProvenance = {
	actor: { id: "agent-a", kind: "agent", organizationId: "fictional-org" },
	source: { surface: "workspace_object", traceId: "turn-a" },
	changeRecordId: "change-a",
};
const reviewer = { id: "reviewer", kind: "user" };
function stub() {
	const namespace = (env as unknown as WorkspaceEnv).WORKSPACE;
	return namespace.get(
		namespace.idFromName(`memory-test:${crypto.randomUUID()}`),
	);
}

describe("SQL MemoryAdapter", () => {
	test("moves JSON-lines history from memory to SQL and back", async () => {
		await runInDurableObject(stub(), async (_instance, state) => {
			const source = new InMemoryMemoryAdapter();
			const first = await source.write({
				key: "policy",
				value: { mode: "careful" },
				provenance,
			});
			await source.review(first.revisionId, "approve", reviewer, "Checked");
			const second = await source.write({
				key: "policy",
				value: "wrong",
				provenance,
			});
			await source.review(second.revisionId, "reject", reviewer);
			await source.rollback("policy", first.revisionId, provenance);
			await source.write({
				key: "pending",
				value: [null, true, "line\nbreak"],
				provenance,
			});
			const bundle = await exportMemory(source);
			const original = bundle
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(original).toHaveLength(4);
			const sql = new SqlMemoryAdapter(storageFor(state.storage));
			expect(await importMemory(sql, bundle, "source-store")).toBe(4);
			const restored = new InMemoryMemoryAdapter();
			// Offset local ids so an unchanged rollback id cannot accidentally pass.
			await restored.write({ key: "unrelated", value: false, provenance });
			expect(
				await importMemory(
					restored,
					await exportMemory(sql),
					"workspace-store",
				),
			).toBe(4);
			for (const memory of [sql, restored]) {
				for (const key of ["policy", "pending"]) {
					const before = await source.history(key);
					const after = await memory.history(key);
					expect(after).toHaveLength(before.length);
					for (const [index, row] of after.entries()) {
						const {
							revisionId,
							provenance: _origin,
							rolledBackFrom: _rollback,
							...content
						} = before[index]!;
						expect(row).toMatchObject(content);
						expect(row.provenance).toMatchObject(provenance);
						expect(row.provenance.importedFrom?.[0]).toEqual({
							store: "source-store",
							revisionId,
						});
					}
				}
				const history = await memory.history("policy");
				expect(history[2]!.rolledBackFrom).toBe(history[0]!.revisionId);
				expect((await memory.read("policy"))?.approved).toEqual(history[2]);
			}
			expect(
				(await restored.history("policy"))[0]!.provenance.importedFrom?.[1],
			).toEqual({
				store: "workspace-store",
				revisionId: (await sql.history("policy"))[0]!.revisionId,
			});
			expect((await restored.read("unrelated"))?.current.value).toBe(false);
		});
	});

	test("links each memory mutation to its recorded call in the result and persisted history", async () => {
		const object = stub();
		const saved = await runInDurableObject(object, async (_instance, state) => {
			const storage = storageFor(state.storage);
			const accountability = new SqlAccountabilityAdapter(storage);
			const memory = buildMemoryBinding({
				memory: new SqlMemoryAdapter(storage),
				accountability,
				compliance: new SqlComplianceAdapter(storage, {
					writesNeedApproval: false,
				}),
				actor: provenance.actor,
				source: provenance.source,
			});
			const written = await memory.write({ key: "policy", value: "careful" });
			const writeRecord = (
				await accountability.list({ resource: "memory" })
			).find((record) => record.operation === "write")!;
			expect(written.provenance.changeRecordId).toBe(writeRecord.id);
			expect(await memory.history("policy")).toEqual([written]);
			const reviewed = await memory.review({
				revisionId: written.revisionId,
				decision: "approve",
			});
			const reviewRecord = (
				await accountability.list({ resource: "memory" })
			).find((record) => record.operation === "review")!;
			expect(reviewed.provenance.changeRecordId).toBe(reviewRecord.id);
			expect(reviewRecord.id).not.toBe(writeRecord.id);
			expect(await memory.history("policy")).toEqual([reviewed]);
			const restored = await memory.rollback({
				key: "policy",
				toRevisionId: written.revisionId,
			});
			const rollbackRecord = (
				await accountability.list({ resource: "memory" })
			).find((record) => record.operation === "rollback")!;
			expect(restored.provenance.changeRecordId).toBe(rollbackRecord.id);
			expect(rollbackRecord.id).not.toBe(reviewRecord.id);
			for (const [record, revision] of [
				[writeRecord, written],
				[reviewRecord, reviewed],
				[rollbackRecord, restored],
			] as const) {
				expect(record).toMatchObject({
					resource: "memory",
					outcome: "applied",
					after: { revisionId: revision.revisionId },
				});
			}
			expect(await memory.history("policy")).toEqual([reviewed, restored]);
			return [reviewed, restored];
		});
		await evictDurableObject(object);
		await runInDurableObject(object, async (_instance, state) => {
			expect(
				await new SqlMemoryAdapter(storageFor(state.storage)).history("policy"),
			).toEqual(saved);
		});
	});

	test("persists provenance, immutable snapshots, hashes and history across eviction", async () => {
		const object = stub();
		const saved = await runInDurableObject(object, async (_instance, state) => {
			const memory = new SqlMemoryAdapter(storageFor(state.storage));
			const value = { language: "German" };
			const input = {
				key: "preferences",
				value,
				provenance: structuredClone(provenance),
			};
			const pending = memory.write(input);
			value.language = "French";
			input.provenance.source.traceId = "forged-later";
			const revision = await pending;
			expect(revision).toMatchObject({
				revision: 1,
				value: { language: "German" },
				provenance,
				review: "pending",
			});
			expect(revision.hash).toBe(await hashValue({ language: "German" }));
			revision.value = "mutated response";
			return (await memory.read("preferences"))!;
		});
		await evictDurableObject(object);
		await runInDurableObject(object, async (_instance, state) => {
			const memory = new SqlMemoryAdapter(storageFor(state.storage));
			expect(await memory.read("preferences")).toEqual(saved);
			expect(await memory.history("preferences")).toEqual([saved.current]);
			expect(await memory.read("missing")).toBeNull();
		});
		expect(
			await runInDurableObject(stub(), async (_instance, state) =>
				new SqlMemoryAdapter(storageFor(state.storage)).list(),
			),
		).toEqual([]);
	});

	test("approves and rejects pending revisions once, retaining the newest approved value", async () => {
		await runInDurableObject(stub(), async (_instance, state) => {
			const memory = new SqlMemoryAdapter(storageFor(state.storage));
			const first = await memory.write({
				key: "policy",
				value: "first",
				provenance,
			});
			const approved = await memory.review(
				first.revisionId,
				"approve",
				reviewer,
				"Checked source",
			);
			expect(approved).toMatchObject({
				review: "approved",
				reviewedBy: "reviewer",
				reviewNote: "Checked source",
				provenance,
			});
			expect(approved.reviewedAt).toBeTruthy();
			const second = await memory.write({
				key: "policy",
				value: "wrong",
				provenance,
			});
			expect((await memory.read("policy"))?.approved).toEqual(approved);
			const rejected = await memory.review(
				second.revisionId,
				"reject",
				reviewer,
				"Wrong source",
			);
			expect(await memory.read("policy")).toEqual({
				key: "policy",
				current: rejected,
				approved,
			});
			await expect(
				memory.review(second.revisionId, "approve", reviewer),
			).rejects.toThrow("already rejected");
			await expect(
				memory.review("missing", "reject", reviewer),
			).rejects.toThrow("Unknown memory revision");
			expect(await memory.history("policy")).toEqual([approved, rejected]);
		});
	});

	test("rolls back by appending, preserves provenance and refuses foreign keys", async () => {
		await runInDurableObject(stub(), async (_instance, state) => {
			const memory = new SqlMemoryAdapter(storageFor(state.storage));
			const first = await memory.write({
				key: "policy",
				value: { mode: "careful" },
				provenance,
				review: "approved",
			});
			const second = await memory.write({
				key: "policy",
				value: "wrong",
				provenance,
			});
			await memory.review(second.revisionId, "reject", reviewer);
			const rollbackSource = {
				actor: reviewer,
				source: { surface: "workspace_object", traceId: "undo-turn" },
			};
			const restored = await memory.rollback(
				"policy",
				first.revisionId,
				rollbackSource,
			);
			expect(restored).toMatchObject({
				revision: 3,
				value: first.value,
				hash: first.hash,
				provenance: rollbackSource,
				review: "approved",
				rolledBackFrom: first.revisionId,
			});
			expect(restored.revisionId).not.toBe(first.revisionId);
			expect((await memory.history("policy")).map((r) => r.revisionId)).toEqual(
				[first.revisionId, second.revisionId, restored.revisionId],
			);
			expect(await memory.read("policy")).toEqual({
				key: "policy",
				current: restored,
				approved: restored,
			});
			await expect(
				memory.rollback("other", first.revisionId, provenance),
			).rejects.toThrow("not a revision of other");
			await expect(
				memory.rollback("policy", "missing", provenance),
			).rejects.toThrow("not a revision of policy");
			const pending = await memory.rollback(
				"policy",
				second.revisionId,
				rollbackSource,
			);
			expect(pending.review).toBe("pending");
			expect((await memory.read("policy"))?.approved).toEqual(restored);
		});
	});

	test("allocates concurrent revisions and treats prefixes literally", async () => {
		await runInDurableObject(stub(), async (_instance, state) => {
			const memory = new SqlMemoryAdapter(storageFor(state.storage));
			await Promise.all(
				Array.from({ length: 12 }, (_, value) =>
					memory.write({ key: "a_%", value, provenance }),
				),
			);
			expect((await memory.history("a_%")).map((r) => r.revision)).toEqual(
				Array.from({ length: 12 }, (_, i) => i + 1),
			);
			for (const key of ["a_other", "A_%", "z", "a_%second"])
				await memory.write({ key, value: null, provenance });
			expect((await memory.list("a_%")).map((e) => e.key)).toEqual([
				"a_%",
				"a_%second",
			]);
			expect((await memory.list()).map((e) => e.key)).toEqual([
				"A_%",
				"a_%",
				"a_%second",
				"a_other",
				"z",
			]);
			await expect(
				memory.write({ key: "", value: 0, provenance }),
			).rejects.toThrow("nonempty");
			await expect(
				memory.write({ key: "invalid", value: undefined, provenance }),
			).rejects.toThrow("must be JSON");
		});
	});
});
