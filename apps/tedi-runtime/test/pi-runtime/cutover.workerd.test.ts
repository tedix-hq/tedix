import { openPiSessionStore } from "agents/harness/pi";
import {
	createSession,
	type TaskId,
	type ConversationId,
} from "@earendil-works/pi-durable";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import {
	importPiStateCutover,
	inventoryPiStateCutover,
	type CutoverMessage,
} from "../../src/pi-state-cutover";
import type { PiRuntimeFixture } from "./worker";

const context = {
	abortSignal: undefined,
	value: () => undefined,
	toString: () => "cutover-proof",
};
function snapshot(storage: DurableObjectStorage, prefix: string) {
	return storage.sql
		.exec<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE ? ORDER BY name",
			`${prefix}%`,
		)
		.toArray()
		.map(({ name }) => ({
			name,
			rows: storage.sql
				.exec(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
				.toArray(),
		}));
}
const OWNER = { tediId: "tedi", orgId: "org" };
const message: CutoverMessage = {
	id: "source-1",
	original: {
		id: "source-1",
		role: "user",
		parts: [{ type: "text", text: "original" }],
	},
	display: {
		id: "source-1",
		role: "user",
		parts: [{ type: "text", text: "original" }],
	},
	model: [{ role: "user", content: "original", timestamp: 1 }],
	privateImages: [
		{
			...OWNER,
			url: "tedix-r2://workflow-image/private-key",
			mediaType: "image/png",
		},
	],
};
const fixture = () => {
	const namespace = (
		env as unknown as { PI_TEST: DurableObjectNamespace<PiRuntimeFixture> }
	).PI_TEST;
	return namespace.get(namespace.idFromName(crypto.randomUUID()));
};
describe("explicit standalone Pi state cutover", () => {
	it("proves empty unfamiliar receipt tables without changing their schema", async () => {
		await runInDurableObject(fixture(), async (_agent, state) => {
			// The fresh fixture has an empty current Agents run table. Replace it
			// only in this isolated test to reproduce the stored historical shape.
			expect(
				state.storage.sql
					.exec<{ count: number }>(
						"SELECT COUNT(*) AS count FROM cf_agents_runs",
					)
					.toArray()[0]?.count,
			).toBe(0);
			state.storage.sql.exec("DROP TABLE cf_agents_runs");
			state.storage.sql.exec(
				"CREATE TABLE cf_agents_runs (id TEXT, name TEXT)",
			);
			const before = snapshot(state.storage, "cf_agents_runs");
			const alarm = await state.storage.getAlarm();
			const inventory = await inventoryPiStateCutover(state.storage);
			expect(inventory.blocked).toBe(false);
			expect(inventory.receipts).toEqual([]);
			expect(snapshot(state.storage, "cf_agents_runs")).toEqual(before);
			expect(await state.storage.getAlarm()).toBe(alarm);
			state.storage.sql.exec(
				"INSERT INTO cf_agents_runs VALUES ('unknown', 'effect')",
			);
			const populated = snapshot(state.storage, "cf_agents_runs");
			const blocked = await inventoryPiStateCutover(state.storage);
			expect(blocked.blocked).toBe(true);
			expect(blocked.receipts).toEqual([
				{
					id: "cf_agents_runs",
					source: "schema",
					status: "unknown",
					terminal: false,
				},
			]);
			expect(snapshot(state.storage, "cf_agents_runs")).toEqual(populated);
		});
	});
	it("settles passive native writes without dispatch and repeats exact entries", async () => {
		const stub = fixture();
		await runInDurableObject(stub, async (agent, state) => {
			const before = structuredClone(agent.state);
			const alarm = await state.storage.getAlarm();
			const input = {
				owner: OWNER,
				messages: [message],
				prefix: "cutover_proof_",
			};
			const first = await importPiStateCutover(state.storage, input);
			const repeated = await importPiStateCutover(state.storage, input);
			expect(repeated).toEqual(first);
			expect(first.entries).toHaveLength(1);
			expect(agent.state).toEqual(before);
			expect(agent.state).toMatchObject({
				requests: 0,
				reservations: 0,
				receipts: 0,
				effects: 0,
			});
			expect(await state.storage.getAlarm()).toBe(alarm);
			expect(
				await state.storage.get(
					`cutover_proof_ui-entry:${first.entries[0]!.entryId}`,
				),
			).toEqual(message.display);
			await expect(
				importPiStateCutover(state.storage, {
					...input,
					owner: { ...OWNER, orgId: "different" },
				}),
			).rejects.toThrow(/owner mismatch/);
			await expect(
				importPiStateCutover(state.storage, {
					...input,
					messages: [
						{
							...message,
							original: {
								...message.original,
								parts: [{ type: "text", text: "changed" }],
							},
						},
					],
				}),
			).rejects.toThrow(/changed|conflict/);
		});
	});
	it("admits exactly one immutable source under concurrent import requests", async () => {
		const stub = fixture();
		await runInDurableObject(stub, async (agent, state) => {
			const input = {
				owner: OWNER,
				messages: [message],
				prefix: "cutover_concurrent_",
			};
			const changed = {
				...input,
				messages: [
					{
						...message,
						model: [
							{ role: "user" as const, content: "different", timestamp: 1 },
						],
					},
				],
			};
			const results = await Promise.allSettled([
				importPiStateCutover(state.storage, input),
				importPiStateCutover(state.storage, changed),
			]);
			expect(
				results.filter((result) => result.status === "fulfilled"),
			).toHaveLength(1);
			expect(
				results.filter((result) => result.status === "rejected"),
			).toHaveLength(1);
			expect(agent.state).toMatchObject({
				requests: 0,
				reservations: 0,
				receipts: 0,
				effects: 0,
			});
		});
	});
	it("repairs a crash after settlement and before application entry mapping", async () => {
		const stub = fixture();
		await runInDurableObject(stub, async (agent, state) => {
			const input = {
				owner: OWNER,
				messages: [message],
				prefix: "cutover_crash_",
			};
			const storage = state.storage;
			let interrupted = false;
			const wrapper = new Proxy(storage, {
				get(target, key) {
					if (key === "put")
						return async (...args: Parameters<DurableObjectStorage["put"]>) => {
							const value = args[0];
							if (
								!interrupted &&
								typeof value === "object" &&
								value !== null &&
								Object.keys(value).some((key) =>
									key.startsWith("cutover_crash_ui-entry:"),
								)
							) {
								interrupted = true;
								throw new Error("simulated post-settlement crash");
							}
							return Reflect.apply(target.put, target, args);
						};
					const value = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			await expect(importPiStateCutover(wrapper, input)).rejects.toThrow(
				/simulated/,
			);
			await expect(
				importPiStateCutover(storage, {
					...input,
					messages: [
						{
							...message,
							model: [
								{ role: "user", content: "changed after crash", timestamp: 1 },
							],
						},
					],
				}),
			).rejects.toThrow(/changed after durable admission|conflict/);
			const recovered = await importPiStateCutover(storage, input);
			expect(recovered.entries).toHaveLength(1);
			const tables = storage.sql
				.exec<{ name: string }>(
					"SELECT name FROM sqlite_master WHERE name LIKE 'cutover_crash_%' AND type='table'",
				)
				.toArray();
			expect(tables.length).toBeGreaterThan(0);
			expect(agent.state).toMatchObject({
				requests: 0,
				reservations: 0,
				receipts: 0,
				effects: 0,
			});
		});
	});
	for (const blocker of ["running", "queued"] as const) {
		it(`rejects populated ${blocker} work in another conversation without changing storage or alarms`, async () => {
			await runInDurableObject(fixture(), async (agent, state) => {
				const prefix = `cutover_${blocker}_`;
				await importPiStateCutover(state.storage, {
					owner: OWNER,
					messages: [message],
					prefix,
				});
				const native = await openPiSessionStore(state.storage, { prefix });
				const session = createSession(native);
				const other = await session.commit(
					(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
					context,
				);
				if (blocker === "queued")
					await session.commit(
						(tx) =>
							tx.createSubmission({
								type: "write",
								status: "queued",
								conversationId: other.id,
								requestId: "unknown-effect",
							}),
						context,
					);
				else {
					const id = await native.mintId<TaskId<null>>();
					await native.commit(
						[
							{
								type: "task",
								value: {
									id,
									conversationId: other.id,
									kind: "unknown-effect",
									version: 1,
									input: { externalIntent: "preserve" },
									background: false,
									abortRequested: false,
									state: {
										status: "running",
										checkpoint: { phase: "dispatch" },
									},
								},
							},
						],
						context,
					);
				}
				await session.close(context);
				const before = snapshot(state.storage, prefix);
				const keys = await state.storage.list();
				const alarm = await state.storage.getAlarm();
				const dispatch = structuredClone(agent.state);
				await expect(
					importPiStateCutover(state.storage, {
						owner: OWNER,
						messages: [message],
						prefix,
					}),
				).rejects.toThrow(/unresolved native/);
				expect(snapshot(state.storage, prefix)).toEqual(before);
				expect(await state.storage.list()).toEqual(keys);
				expect(await state.storage.getAlarm()).toBe(alarm);
				expect(agent.state).toEqual(dispatch);
			});
		});
	}
	it("reuses inherited imports in a fork and rejects changed sources before any append", async () => {
		await runInDurableObject(fixture(), async (agent, state) => {
			const prefix = "cutover_fork_";
			const root = await importPiStateCutover(state.storage, {
				owner: OWNER,
				messages: [message],
				prefix,
			});
			const native = await openPiSessionStore(state.storage, { prefix });
			const session = createSession(native);
			const fork = await session.commit(
				(tx) =>
					tx.forkConversation(
						1 as ConversationId,
						root.entries[0]!.entryId as Parameters<
							typeof tx.forkConversation
						>[1],
						{ ownership: { kind: "ownerless" } },
					),
				context,
			);
			await session.close(context);
			const before = snapshot(state.storage, prefix);
			const input = {
				owner: OWNER,
				messages: [message],
				prefix,
				conversationId: fork.id,
			};
			const keys = await state.storage.list();
			const changed = {
				...message,
				original: {
					...message.original,
					parts: [{ type: "text" as const, text: "changed private source" }],
				},
			};
			await expect(
				importPiStateCutover(state.storage, {
					...input,
					messages: [
						{
							...message,
							id: "new-first",
							original: { ...message.original, id: "new-first" },
							display: { ...message.display, id: "new-first" },
						},
						changed,
					],
				}),
			).rejects.toThrow(/inherited source changed/);
			expect(snapshot(state.storage, prefix)).toEqual(before);
			expect(await state.storage.list()).toEqual(keys);
			const imported = await importPiStateCutover(state.storage, input);
			expect(imported.entries).toEqual(root.entries);
			expect(snapshot(state.storage, prefix)).toEqual(before);
			expect(await importPiStateCutover(state.storage, input)).toEqual(
				imported,
			);
			await expect(
				importPiStateCutover(state.storage, {
					...input,
					messages: [
						{
							...message,
							model: [{ role: "user", content: "conflicting", timestamp: 1 }],
						},
					],
				}),
			).rejects.toThrow(/changed|conflict/);
			expect(snapshot(state.storage, prefix)).toEqual(before);
			expect(agent.state).toMatchObject({
				requests: 0,
				reservations: 0,
				effects: 0,
			});
		});
	});
	it("projects bounded stored ownership without exposing State payload or repairing malformed rows", async () => {
		await runInDurableObject(fixture(), async (_agent, state) => {
			state.storage.sql.exec(
				"CREATE TABLE IF NOT EXISTS cf_agents_state (id TEXT PRIMARY KEY, state TEXT)",
			);
			const stored = JSON.stringify({
				...OWNER,
				slug: "stored-slug",
				sessionKey: "stored-session",
				config: { token: "OWNER-SECRET" },
				messages: ["OWNER-PRIVATE-CONTENT"],
			});
			state.storage.sql.exec(
				"INSERT OR REPLACE INTO cf_agents_state (id,state) VALUES (?,?)",
				"cf_state_row_id",
				stored,
			);
			const inventory = await inventoryPiStateCutover(state.storage);
			expect(inventory.storedOwner).toEqual({
				...OWNER,
				slug: "stored-slug",
				sessionKey: "stored-session",
				unknown: false,
			});
			expect(JSON.stringify(inventory)).not.toMatch(
				/OWNER-SECRET|OWNER-PRIVATE-CONTENT/,
			);
			const malformed = "{OWNER-MALFORMED-SECRET";
			state.storage.sql.exec(
				"UPDATE cf_agents_state SET state=? WHERE id=?",
				malformed,
				"cf_state_row_id",
			);
			expect(
				(await inventoryPiStateCutover(state.storage)).storedOwner,
			).toEqual({
				tediId: null,
				orgId: null,
				slug: null,
				sessionKey: null,
				unknown: true,
			});
			expect(
				state.storage.sql
					.exec<{ state: string }>(
						"SELECT state FROM cf_agents_state WHERE id=?",
						"cf_state_row_id",
					)
					.toArray()[0]!.state,
			).toBe(malformed);
		});
	});
	it("inventory preserves unknown effects and private descriptors without exposing payloads", async () => {
		const stub = fixture();
		await runInDurableObject(stub, async (agent, state) => {
			const receipt = {
				stage: "send-intent",
				secret: "external-token",
				operationId: "delivery-1",
			};
			const image = {
				...OWNER,
				url: "tedix-r2://workflow-image/private-key",
				privateBytes: "image-secret",
				mediaType: "image/png",
			};
			await state.storage.put({
				"__cf_messenger_recovery:delivery-1": receipt,
				"pi-image-projection:v1:image-1": image,
			});
			const before = await state.storage.list();
			const inventory = await inventoryPiStateCutover(state.storage);
			expect(inventory.blocked).toBe(true);
			expect(inventory.receipts).toMatchObject([
				{
					id: "__cf_messenger_recovery:delivery-1",
					status: "send-intent",
					terminal: false,
				},
			]);
			expect(inventory.privateImages).toMatchObject([
				{ tediId: "tedi", orgId: "org", scheme: "tedix-r2:" },
			]);
			const serialized = JSON.stringify(inventory);
			expect(serialized).not.toContain("external-token");
			expect(serialized).not.toContain("image-secret");
			expect(serialized).not.toContain("private-key");
			await expect(
				importPiStateCutover(state.storage, {
					owner: OWNER,
					messages: [message],
					prefix: "cutover_blocked_",
				}),
			).rejects.toThrow(/unresolved/);
			expect(await state.storage.list()).toEqual(before);
			expect(
				state.storage.sql
					.exec(
						"SELECT name FROM sqlite_master WHERE name LIKE 'cutover_blocked_%'",
					)
					.toArray(),
			).toHaveLength(0);
			expect(agent.state).toMatchObject({
				requests: 0,
				reservations: 0,
				receipts: 0,
				effects: 0,
			});
		});
	});
});
