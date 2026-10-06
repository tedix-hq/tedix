import { env } from "cloudflare:workers";
import { runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { describe, it, expect } from "vite-plus/test";
import { openPiSessionStore } from "agents/harness/pi";
import {
	Harness,
	createSession,
	createRegistry,
	type ConversationId,
	type TaskId,
} from "@earendil-works/pi-durable";
import { createModels, type Model, type Api } from "@earendil-works/pi-ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { createTedixPiProvider } from "../../src/pi-model";
import { selectCutoverGraphActivation } from "../../src/pi-cutover-operator";
import {
	planPiTranscriptCutover,
	applyPiTranscriptCutover,
	projectedTranscriptContext,
} from "../../src/pi-state-cutover-transcript";
import type { PiRuntimeFixture } from "./worker";
const OWNER = { tediId: "tedi", orgId: "org" };
const context = {
	abortSignal: undefined,
	value: () => undefined,
	toString: () => "graph-proof",
};
function fixture() {
	const ns = (
		env as unknown as { PI_TEST: DurableObjectNamespace<PiRuntimeFixture> }
	).PI_TEST;
	return ns.get(ns.idFromName(crypto.randomUUID()));
}
function seedEmptyOwner(storage: DurableObjectStorage) {
	storage.sql.exec(
		"CREATE TABLE IF NOT EXISTS cf_agents_state (id TEXT PRIMARY KEY,state TEXT)",
	);
	storage.sql.exec(
		"INSERT OR REPLACE INTO cf_agents_state VALUES ('cf_state_row_id',?)",
		JSON.stringify(OWNER),
	);
}

describe("strictly empty root transcript", () => {
	it("retains an empty manifest across apply, exact retry and actual eviction without creating a conversation", async () => {
		const stub = fixture();
		const original = await runInDurableObject(stub, async (_agent, state) => {
			seedEmptyOwner(state.storage);
			const plan = await planPiTranscriptCutover(
				state.storage,
				OWNER,
				"empty_root_",
			);
			expect(plan.sessions).toEqual([]);
			expect(plan.nodes).toEqual([]);
			expect(plan.chunks.length).toBeGreaterThan(0);
			const result = await applyPiTranscriptCutover(state.storage, plan);
			expect(result).toMatchObject({
				entries: {},
				leaves: {},
				activeConversations: {},
				contexts: {},
				preservedNativeConversations: [],
			});
			expect(selectCutoverGraphActivation(plan, result, false)).toMatchObject({
				sessions: {},
				selectedSessionId: null,
				conversationId: null,
			});
			expect(
				state.storage.sql
					.exec("SELECT * FROM empty_root_conversations")
					.toArray(),
			).toEqual([]);
			expect(
				state.storage.sql.exec("SELECT * FROM empty_root_entries").toArray(),
			).toEqual([]);
			expect(await applyPiTranscriptCutover(state.storage, plan)).toEqual(
				result,
			);
			return { plan, result };
		});
		await abortAllDurableObjects();
		const namespace = (
			env as unknown as { PI_TEST: DurableObjectNamespace<PiRuntimeFixture> }
		).PI_TEST;
		await runInDurableObject(namespace.get(stub.id), async (_agent, state) => {
			expect(
				await planPiTranscriptCutover(state.storage, OWNER, "empty_root_"),
			).toEqual(original.plan);
			expect(
				await applyPiTranscriptCutover(state.storage, original.plan),
			).toEqual(original.result);
			expect(
				state.storage.sql
					.exec("SELECT * FROM empty_root_conversations")
					.toArray(),
			).toEqual([]);
		});
	});
	it.each([
		"message-chunk",
		"attachment-chunk",
		"attachment-meta",
		"config-malformed",
		"native-conversation",
		"native-entry",
		"pointer",
		"facet",
		"malformed-facet",
		"facet-name",
		"parent-path",
		"owner",
		"accounting",
	])("rejects %s rather than treating it as an empty root", async (kind) => {
		await runInDurableObject(fixture(), async (_agent, state) => {
			seedEmptyOwner(state.storage);
			switch (kind) {
				case "message-chunk":
					state.storage.sql.exec(
						"CREATE TABLE cf_agents_session_message_chunks (session_id TEXT,id TEXT,idx INTEGER,content TEXT)",
					);
					state.storage.sql.exec(
						"INSERT INTO cf_agents_session_message_chunks VALUES ('','orphan',0,'{}')",
					);
					break;
				case "attachment-chunk":
					state.storage.sql.exec(
						"CREATE TABLE cf_agents_session_attachment_chunks (hash TEXT,idx INTEGER,data BLOB)",
					);
					state.storage.sql.exec(
						"INSERT INTO cf_agents_session_attachment_chunks VALUES ('orphan',0,?)",
						new Uint8Array([1]),
					);
					break;
				case "attachment-meta":
					state.storage.sql.exec(
						"CREATE TABLE cf_agents_session_attachment_meta (hash TEXT,chunks INTEGER,bytes INTEGER,media_type TEXT)",
					);
					state.storage.sql.exec(
						"INSERT INTO cf_agents_session_attachment_meta VALUES ('orphan',1,1,'image/png')",
					);
					break;
				case "config-malformed":
					state.storage.sql.exec(
						"CREATE TABLE cf_agents_session_config (session_id INTEGER)",
					);
					state.storage.sql.exec(
						"INSERT INTO cf_agents_session_config VALUES (1)",
					);
					break;
				case "native-conversation":
					state.storage.sql.exec(
						"CREATE TABLE empty_root_conversations (id INTEGER)",
					);
					state.storage.sql.exec(
						"INSERT INTO empty_root_conversations VALUES (1)",
					);
					break;
				case "native-entry":
					state.storage.sql.exec(
						"CREATE TABLE empty_root_entries (record TEXT)",
					);
					state.storage.sql.exec(
						"INSERT INTO empty_root_entries VALUES ('{}')",
					);
					break;
				case "pointer":
					await state.storage.put("pi-active-conversation-id:v1", 1);
					break;
				case "facet":
					await state.storage.put("cf_agents_is_facet", true);
					break;
				case "malformed-facet":
					await state.storage.put("cf_agents_is_facet", "false");
					break;
				case "facet-name":
					await state.storage.put("cf_agents_facet_name", "child");
					break;
				case "parent-path":
					await state.storage.put("cf_agents_parent_path", []);
					break;
				case "owner":
					state.storage.sql.exec("UPDATE cf_agents_state SET state='{}'");
					break;
				case "accounting":
					await state.storage.put("pi-accounting:run", {
						version: 1,
						runId: "run",
						fault: "unresolved",
						attempts: [],
					});
					break;
			}
			await expect(
				planPiTranscriptCutover(state.storage, OWNER, "empty_root_"),
			).rejects.toThrow("Transcript cutover:");
		});
	});
});
function seed(storage: DurableObjectStorage) {
	storage.sql.exec(
		"CREATE TABLE IF NOT EXISTS cf_agents_state (id TEXT PRIMARY KEY,state TEXT)",
	);
	storage.sql.exec(
		"INSERT OR REPLACE INTO cf_agents_state VALUES ('cf_state_row_id',?)",
		JSON.stringify(OWNER),
	);
	storage.sql.exec(
		"CREATE TABLE cf_agents_session_messages (session_id TEXT,id TEXT,seq INTEGER,parent_id TEXT,role TEXT,content TEXT,content_chunks INTEGER,created_at INTEGER)",
	);
	storage.sql.exec(
		"CREATE TABLE cf_agents_session_message_chunks (session_id TEXT,id TEXT,idx INTEGER,content TEXT)",
	);
	storage.sql.exec(
		"CREATE TABLE cf_agents_session_compactions (session_id TEXT,id TEXT,seq INTEGER,from_message_id TEXT,to_message_id TEXT,summary TEXT,created_at INTEGER)",
	);
	for (const [id, seq, parent] of [
		["r", 1, null],
		["a", 2, "r"],
		["b", 3, "a"],
		["c", 4, "a"],
		["d", 5, "c"],
		["e", 6, "c"],
	] as const) {
		const content = JSON.stringify({
			id,
			role: "user",
			parts: [{ type: "text", text: id }],
		});
		storage.sql.exec(
			"INSERT INTO cf_agents_session_messages VALUES ('',?,?,?,?,?,?,?)",
			id,
			seq,
			parent,
			"user",
			id === "a" ? content.slice(0, 20) : content,
			id === "a" ? 1 : 0,
			1000,
		);
		if (id === "a")
			storage.sql.exec(
				"INSERT INTO cf_agents_session_message_chunks VALUES ('',?,0,?)",
				id,
				content.slice(20),
			);
	}
	storage.sql.exec(
		"INSERT INTO cf_agents_session_compactions VALUES ('','short',1,'r','a','short summary',1000)",
	);
	storage.sql.exec(
		"INSERT INTO cf_agents_session_compactions VALUES ('','long',2,'r','c','long summary',1000)",
	);
	const other = JSON.stringify({
		id: "other",
		role: "user",
		parts: [{ type: "text", text: "other session" }],
	});
	storage.sql.exec(
		"INSERT INTO cf_agents_session_messages VALUES ('second','other',1,NULL,'user',?,0,1000)",
		other,
	);
}
function source(storage: DurableObjectStorage) {
	return [
		"cf_agents_session_messages",
		"cf_agents_session_message_chunks",
		"cf_agents_session_compactions",
	].map((name) => ({
		name,
		rows: storage.sql.exec(`SELECT * FROM ${name}`).toArray(),
	}));
}
const model: Model<Api> = {
	id: "test",
	name: "Test",
	provider: "tedix",
	api: "openai-completions",
	baseUrl: "",
	input: ["text"],
	reasoning: false,
	contextWindow: 8192,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function scripted(counters: {
	requests: number;
	reservations: number;
	receipts: number;
}): LanguageModelV3 {
	return {
		specificationVersion: "v3",
		provider: "test",
		modelId: "test",
		supportedUrls: {},
		doGenerate: async () => {
			throw new Error("stream only");
		},
		doStream: async () => {
			counters.requests++;
			return {
				stream: new ReadableStream({
					start(controller) {
						controller.enqueue({ type: "text-start", id: "t" });
						controller.enqueue({
							type: "text-delta",
							id: "t",
							delta: "native branch answer",
						});
						controller.enqueue({ type: "text-end", id: "t" });
						controller.enqueue({
							type: "finish",
							finishReason: { unified: "stop", raw: "stop" },
							usage: {
								inputTokens: {
									total: 2,
									noCache: 2,
									cacheRead: 0,
									cacheWrite: 0,
								},
								outputTokens: { total: 3, text: 3, reasoning: 0 },
							},
						});
						controller.close();
					},
				}),
			};
		},
	};
}
describe("complete passive transcript graph cutover", () => {
	it.each([
		{ state: "output-error", errorText: "original persisted tool error" },
		{ state: "output-error", errorText: "" },
		{ state: "output-available", output: null },
		{ state: "output-available", output: false },
		{ state: "output-available", output: 0 },
		{ state: "output-available", output: "" },
	])(
		"preserves the actual terminal tool receipt %j without replay",
		async (receipt) => {
			await runInDurableObject(fixture(), async (_agent, state) => {
				seed(state.storage);
				const part = {
					type: "tool-probe",
					toolCallId: "original-call",
					input: { original: true },
					...receipt,
				};
				state.storage.sql.exec(
					"UPDATE cf_agents_session_messages SET role='assistant',content=? WHERE id='d'",
					JSON.stringify({ id: "d", role: "assistant", parts: [part] }),
				);
				const before = source(state.storage);
				const plan = await planPiTranscriptCutover(
					state.storage,
					OWNER,
					"tool_receipt_",
				);
				const node = plan.nodes.find((entry) => entry.id === "d")!;
				const expected =
					"errorText" in receipt
						? receipt.errorText
						: typeof receipt.output === "string"
							? receipt.output
							: JSON.stringify(receipt.output);
				expect(node.model[1]).toMatchObject({
					role: "toolResult",
					toolCallId: "original-call",
					isError: receipt.state === "output-error",
					content: [{ type: "text", text: expected }],
				});
				expect(node.display.parts).toEqual([part]);
				const result = await applyPiTranscriptCutover(state.storage, plan);
				expect(result.sourceHash).toBe(plan.sourceHash);
				expect(await applyPiTranscriptCutover(state.storage, plan)).toEqual(
					result,
				);
				expect(source(state.storage)).toEqual(before);
			});
		},
	);
	it.each([
		{ state: "output-available" },
		// Persisted JSON drops undefined; it must remain missing evidence.
		{ state: "output-available", output: undefined },
		{ state: "output-error" },
		{ state: "output-error", errorText: undefined },
		{ state: "input-available", output: "not a receipt" },
		{ state: "output-available", output: null, result: "conflict" },
		{ state: "output-error", errorText: "error", output: "conflict" },
		{ state: "output-available", output: "value", errorText: "error" },
	])(
		"refuses missing or conflicting terminal tool evidence %j",
		async (receipt) => {
			await runInDurableObject(fixture(), async (_agent, state) => {
				seed(state.storage);
				state.storage.sql.exec(
					"UPDATE cf_agents_session_messages SET role='assistant',content=? WHERE id='d'",
					JSON.stringify({
						id: "d",
						role: "assistant",
						parts: [
							{
								type: "tool-probe",
								toolCallId: "original-call",
								input: {},
								...receipt,
							},
						],
					}),
				);
				const before = source(state.storage);
				await expect(
					planPiTranscriptCutover(state.storage, OWNER, "rejected_receipt_"),
				).rejects.toThrow("Transcript cutover:");
				expect(source(state.storage)).toEqual(before);
			});
		},
	);
	it("preserves all inactive forks and overlays, repeats stable mappings, then executes governed native turns on every leaf", async () => {
		await runInDurableObject(fixture(), async (agent, state) => {
			seed(state.storage);
			const original = source(state.storage),
				alarm = await state.storage.getAlarm(),
				before = structuredClone(agent.state);
			const plan = await planPiTranscriptCutover(
				state.storage,
				OWNER,
				"graph_",
			);
			const result = await applyPiTranscriptCutover(state.storage, plan);
			expect(Object.keys(result.entries)).toHaveLength(7);
			expect(Object.keys(result.leaves)).toHaveLength(4);
			expect(await applyPiTranscriptCutover(state.storage, plan)).toEqual(
				result,
			);
			expect(source(state.storage)).toEqual(original);
			expect(await state.storage.getAlarm()).toBe(alarm);
			expect(agent.state).toEqual(before);
			const native = await openPiSessionStore(state.storage, {
					prefix: "graph_",
				}),
				models = createModels(),
				counters = { requests: 0, reservations: 0, receipts: 0 };
			models.setProvider(
				createTedixPiProvider({
					catalog: () => [model],
					resolveModel: () => scripted(counters),
					prepare: async () => {
						counters.reservations++;
						return { receipt: "exact-approved" };
					},
					settled: async (receipt, _message, measurement) => {
						expect(receipt).toBe("exact-approved");
						expect(measurement.hasUsage).toBe(true);
						counters.receipts++;
					},
				}),
			);
			const pi = await Harness.open(
				native,
				{
					models,
					registry: createRegistry(),
					settings: { retry: { enabled: false, maxRetries: 0 } },
				},
				context,
			);
			try {
				for (const [sourceLeaf, id] of Object.entries(result.leaves)) {
					const [sessionId, leaf] = JSON.parse(sourceLeaf) as [string, string],
						conversation = (await pi.conversation(
							id as ConversationId,
							context,
						))!;
					const actual = (await conversation.context(context)).messages;
					const expected = projectedTranscriptContext(plan, sessionId, leaf);
					expect(actual).toEqual(expected);
					await conversation.configure(
						{ model: { provider: "tedix", modelId: "test" } },
						context,
					);
					const accepted = await conversation.submit(
						{
							type: "input",
							content: "prove this restored branch",
							requestId: `proof:${sourceLeaf}`,
						},
						context,
					);
					expect((await accepted.wait(context)).status).toBe("done");
				}
			} finally {
				await pi.close(context);
			}
			expect(counters).toEqual({ requests: 4, reservations: 4, receipts: 4 });
			expect(agent.state).toEqual(before);
		});
	});
	it("hydrates private attachments and normalizes owner-bound R2 references without fetching or changing source bytes", async () => {
		await runInDurableObject(fixture(), async (agent, state) => {
			seed(state.storage);
			const bytes = new Uint8Array([1, 2, 3]);
			const hash = Array.from(
				new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
				(byte) => byte.toString(16).padStart(2, "0"),
			).join("");
			state.storage.sql.exec(
				"CREATE TABLE cf_agents_session_attachment_meta (hash TEXT,bytes INTEGER,media_type TEXT,chunks INTEGER)",
			);
			state.storage.sql.exec(
				"CREATE TABLE cf_agents_session_attachment_chunks (hash TEXT,idx INTEGER,data BLOB)",
			);
			state.storage.sql.exec(
				"CREATE TABLE cf_agents_session_attachment_refs (session_id TEXT,message_id TEXT,hash TEXT)",
			);
			state.storage.sql.exec(
				"INSERT INTO cf_agents_session_attachment_meta VALUES (?,3,'image/png',1)",
				hash,
			);
			state.storage.sql.exec(
				"INSERT INTO cf_agents_session_attachment_chunks VALUES (?,0,?)",
				hash,
				bytes,
			);
			state.storage.sql.exec(
				"INSERT INTO cf_agents_session_attachment_refs VALUES ('','d',?)",
				hash,
			);
			const raw = JSON.stringify({
				id: "d",
				role: "user",
				parts: [
					{ type: "text", text: "d" },
					{
						type: "file",
						url: `attachment:sha256:${hash}`,
						mediaType: "image/png",
					},
				],
			});
			state.storage.sql.exec(
				"UPDATE cf_agents_session_messages SET content=? WHERE id='d'",
				raw,
			);
			const r2Hash = "a".repeat(64),
				r2Key = `__runtime/workflow-images/tedi/run/${r2Hash}.json`,
				url = `tedix-r2://workflow-image/${r2Key}?sha256=${r2Hash}`;
			state.storage.sql.exec(
				"UPDATE cf_agents_session_messages SET content=? WHERE id='e'",
				JSON.stringify({
					id: "e",
					role: "user",
					parts: [
						{
							type: "file",
							url,
							mediaType: "image/png",
							filename: "private.png",
						},
					],
				}),
			);
			const bucket = (env as unknown as { TEDI_STORAGE: R2Bucket })
				.TEDI_STORAGE;
			await bucket.put(r2Key, "private unchanged object");
			const original = source(state.storage),
				alarm = await state.storage.getAlarm(),
				before = structuredClone(agent.state);
			const plan = await planPiTranscriptCutover(
				state.storage,
				OWNER,
				"images_graph_",
			);
			expect(
				JSON.stringify(plan.nodes.find((node) => node.id === "d")!.model),
			).toContain('"data":"AQID"');
			expect(plan.descriptors).toHaveLength(1);
			expect(plan.descriptors[0]!.descriptor).not.toHaveProperty("legacy");
			expect(plan.descriptors[0]!.descriptor.url).toBe(url);
			await applyPiTranscriptCutover(state.storage, plan);
			expect(source(state.storage)).toEqual(original);
			expect(await state.storage.getAlarm()).toBe(alarm);
			expect(agent.state).toEqual(before);
			expect(await (await bucket.get(r2Key))!.text()).toBe(
				"private unchanged object",
			);
			expect(
				await state.storage.get(
					`pi-image-projection:v1:${plan.descriptors[0]!.token}`,
				),
			).toEqual(plan.descriptors[0]!.descriptor);
			state.storage.sql.exec("DELETE FROM cf_agents_session_attachment_chunks");
			const current = await state.storage.list();
			await expect(
				planPiTranscriptCutover(state.storage, OWNER, "rejected_images_"),
			).rejects.toThrow(/missing attachment chunks/);
			expect(await state.storage.list()).toEqual(current);
		});
	});
	it("preserves hidden overlay ancestry, standalone summaries and configured empty sessions", async () => {
		await runInDurableObject(fixture(), async (_agent, state) => {
			seed(state.storage);
			for (const [id, seq, parent, text] of [
				["compaction_short", 7, "e", "hidden duplicate"],
				[
					"compaction_external",
					8,
					"compaction_short",
					"standalone preserved summary",
				],
			] as const)
				state.storage.sql.exec(
					"INSERT INTO cf_agents_session_messages VALUES ('',?,?,?,?,?,0,1000)",
					id,
					seq,
					parent,
					"assistant",
					JSON.stringify({
						id,
						role: "assistant",
						parts: [{ type: "text", text }],
					}),
				);
			state.storage.sql.exec(
				"CREATE TABLE cf_agents_session_config (session_id TEXT,key TEXT,value TEXT)",
			);
			state.storage.sql.exec(
				"INSERT INTO cf_agents_session_config VALUES ('empty','compactionThreshold','123')",
			);
			const plan = await planPiTranscriptCutover(
				state.storage,
				OWNER,
				"overlays_graph_",
			);
			expect(
				plan.sessions.find((session) => session.id === "empty")!.activeLeaf,
			).toBe(null);
			const projected = projectedTranscriptContext(
				plan,
				"",
				"compaction_external",
			);
			expect(JSON.stringify(projected)).not.toContain("hidden duplicate");
			expect(JSON.stringify(projected)).toContain(
				"standalone preserved summary",
			);
			const result = await applyPiTranscriptCutover(state.storage, plan);
			expect(Object.keys(result.entries)).toHaveLength(9);
			expect(result.activeConversations.empty).toBeGreaterThan(0);
			expect(await applyPiTranscriptCutover(state.storage, plan)).toEqual(
				result,
			);
			const pi = await Harness.open(
				await openPiSessionStore(state.storage, { prefix: "overlays_graph_" }),
				{ models: createModels(), registry: createRegistry() },
				context,
			);
			try {
				expect(
					(
						await (await pi.conversation(
							result.activeConversations[""] as ConversationId,
							context,
						))!.context(context)
					).messages,
				).toEqual(projected);
				expect(
					(
						await (await pi.conversation(
							result.activeConversations.empty as ConversationId,
							context,
						))!.context(context)
					).messages,
				).toEqual([]);
			} finally {
				await pi.close(context);
			}
		});
	});
	it("repairs a crash after atomic graph commit without recreating conversations", async () => {
		await runInDurableObject(fixture(), async (_agent, state) => {
			seed(state.storage);
			const plan = await planPiTranscriptCutover(
				state.storage,
				OWNER,
				"crash_graph_",
			);
			let crashed = false;
			const storage = new Proxy(state.storage, {
				get(target, id) {
					if (id === "put")
						return async (key: string, value: unknown) => {
							if (!crashed && key.startsWith("crash_graph_ui-entry:")) {
								crashed = true;
								throw new Error("simulated mapping projection crash");
							}
							return target.put(key, value);
						};
					const value = Reflect.get(target, id, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			await expect(applyPiTranscriptCutover(storage, plan)).rejects.toThrow(
				/simulated/,
			);
			const rows = state.storage.sql
				.exec("SELECT * FROM crash_graph_conversations")
				.toArray();
			const recovered = await applyPiTranscriptCutover(state.storage, plan);
			expect(
				state.storage.sql
					.exec("SELECT * FROM crash_graph_conversations")
					.toArray(),
			).toEqual(rows);
			expect(await applyPiTranscriptCutover(state.storage, plan)).toEqual(
				recovered,
			);
			await state.storage.put(
				`crash_graph_ui-entry:${Object.values(recovered.entries)[0]}`,
				{ conflict: true },
			);
			const entriesBeforeConflict = state.storage.sql
				.exec("SELECT * FROM crash_graph_entries")
				.toArray();
			await expect(
				applyPiTranscriptCutover(state.storage, plan),
			).rejects.toThrow(/stored display conflict/);
			expect(
				state.storage.sql.exec("SELECT * FROM crash_graph_entries").toArray(),
			).toEqual(entriesBeforeConflict);
		});
	});
	it("reconciles an exact prior active import and preserves its immutable rows while constructing the full graph", async () => {
		await runInDurableObject(fixture(), async (_agent, state) => {
			seed(state.storage);
			const base = await planPiTranscriptCutover(
				state.storage,
				OWNER,
				"existing_graph_",
			);
			const native = await openPiSessionStore(state.storage, {
					prefix: "existing_graph_",
				}),
				session = createSession(native);
			const conversation = await session.commit(
				(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
				context,
			);
			for (const [index, message] of projectedTranscriptContext(
				base,
				"",
				"e",
			).entries())
				await session.commit(
					(tx) =>
						tx.appendEntry(conversation.id, {
							kind: "tedix.legacy-message",
							model: [message],
							data: {
								originalId: `prior:${index}`,
								originalRole: message.role,
							},
						}),
					context,
				);
			await session.close(context);
			const prior = state.storage.sql
				.exec("SELECT * FROM existing_graph_entries ORDER BY id")
				.toArray();
			const plan = await planPiTranscriptCutover(
				state.storage,
				OWNER,
				"existing_graph_",
			);
			const result = await applyPiTranscriptCutover(state.storage, plan);
			expect(result.preservedNativeConversations).toContain(conversation.id);
			expect(Object.values(result.activeConversations)).not.toContain(
				conversation.id,
			);
			expect(
				state.storage.sql
					.exec(
						"SELECT * FROM existing_graph_entries WHERE conversation_id=? ORDER BY id",
						conversation.id,
					)
					.toArray(),
			).toEqual(prior);
			expect(await applyPiTranscriptCutover(state.storage, plan)).toEqual(
				result,
			);
		});
	});
	it("rejects conflicting native imported context before any graph write", async () => {
		await runInDurableObject(fixture(), async (_agent, state) => {
			seed(state.storage);
			const native = await openPiSessionStore(state.storage, {
					prefix: "conflict_graph_",
				}),
				session = createSession(native);
			await session.commit(async (tx) => {
				const conversation = await tx.createConversation({
					ownership: { kind: "ownerless" },
				});
				await tx.appendEntry(conversation.id, {
					kind: "tedix.legacy-message",
					model: [
						{ role: "user", content: "conflicting source", timestamp: 1000 },
					],
				});
			}, context);
			await session.close(context);
			const prior = state.storage.sql
					.exec("SELECT * FROM conflict_graph_entries")
					.toArray(),
				keys = await state.storage.list();
			await expect(
				planPiTranscriptCutover(state.storage, OWNER, "conflict_graph_"),
			).rejects.toThrow(/context conflict/);
			expect(
				state.storage.sql
					.exec("SELECT * FROM conflict_graph_entries")
					.toArray(),
			).toEqual(prior);
			expect(await state.storage.list()).toEqual(keys);
		});
	});
	it("resumes a partial graph after a failed native commit without duplicating committed prefixes", async () => {
		await runInDurableObject(fixture(), async (_agent, state) => {
			seed(state.storage);
			const plan = await planPiTranscriptCutover(
				state.storage,
				OWNER,
				"partial_graph_",
			);
			let inserts = 0;
			const sql = new Proxy(state.storage.sql, {
				get(target, id) {
					if (id === "exec")
						return (query: string, ...args: unknown[]) => {
							if (
								/INSERT INTO partial_graph_entries/.test(query) &&
								++inserts === 4
							)
								throw new Error("simulated native commit crash");
							return Reflect.apply(target.exec, target, [query, ...args]);
						};
					const value = Reflect.get(target, id, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const storage = new Proxy(state.storage, {
				get(target, id) {
					if (id === "sql") return sql;
					const value = Reflect.get(target, id, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			await expect(applyPiTranscriptCutover(storage, plan)).rejects.toThrow(
				/simulated/,
			);
			const prefix = state.storage.sql
				.exec<{ id: number }>("SELECT * FROM partial_graph_entries")
				.toArray();
			expect(prefix.length).toBeGreaterThan(0);
			const recovered = await applyPiTranscriptCutover(state.storage, plan);
			for (const entry of prefix)
				expect(
					state.storage.sql
						.exec("SELECT * FROM partial_graph_entries WHERE id=?", entry.id)
						.toArray()[0],
				).toEqual(entry);
			expect(Object.keys(recovered.entries)).toHaveLength(7);
			expect(await applyPiTranscriptCutover(state.storage, plan)).toEqual(
				recovered,
			);
		});
	});
	for (const status of ["running", "queued"] as const)
		it(`rejects ${status} native work without modifying its populated namespace`, async () => {
			await runInDurableObject(fixture(), async (_agent, state) => {
				seed(state.storage);
				const prefix = `${status}_graph_`,
					native = await openPiSessionStore(state.storage, { prefix }),
					session = createSession(native),
					conversation = await session.commit(
						(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
						context,
					);
				if (status === "queued")
					await session.commit(
						(tx) =>
							tx.createSubmission({
								type: "write",
								status: "queued",
								conversationId: conversation.id,
								requestId: "unknown-intent",
							}),
						context,
					);
				else
					await native.commit(
						[
							{
								type: "task",
								value: {
									id: await native.mintId<TaskId<null>>(),
									conversationId: conversation.id,
									kind: "unknown-intent",
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
				await session.close(context);
				const original = state.storage.sql
						.exec(
							`SELECT * FROM ${prefix}${status === "queued" ? "submissions" : "tasks"}`,
						)
						.toArray(),
					keys = await state.storage.list(),
					alarm = await state.storage.getAlarm();
				await expect(
					planPiTranscriptCutover(state.storage, OWNER, prefix),
				).rejects.toThrow(/unresolved native/);
				expect(
					state.storage.sql
						.exec(
							`SELECT * FROM ${prefix}${status === "queued" ? "submissions" : "tasks"}`,
						)
						.toArray(),
				).toEqual(original);
				expect(await state.storage.list()).toEqual(keys);
				expect(await state.storage.getAlarm()).toBe(alarm);
			});
		});
	it("rejects corrupt source and unknown effects before creating native tables or changing alarm/KV", async () => {
		await runInDurableObject(fixture(), async (_agent, state) => {
			seed(state.storage);
			await state.storage.put("__cf_messenger_recovery:unknown", {
				stage: "send-intent",
				operationId: "unknown",
			});
			const original = source(state.storage),
				keys = await state.storage.list(),
				alarm = await state.storage.getAlarm();
			await expect(
				planPiTranscriptCutover(state.storage, OWNER, "blocked_graph_"),
			).rejects.toThrow(/unresolved/);
			expect(source(state.storage)).toEqual(original);
			expect(await state.storage.list()).toEqual(keys);
			expect(await state.storage.getAlarm()).toBe(alarm);
			expect(
				state.storage.sql
					.exec(
						"SELECT name FROM sqlite_master WHERE name LIKE 'blocked_graph_%'",
					)
					.toArray(),
			).toHaveLength(0);
		});
	});
});

describe("Native facet custody transfer", () => {
	it("clones SQL/KV custody and initializes the renamed recorded identity", async () => {
		const namespace = (
			env as unknown as {
				PI_CUTOVER_PARENT: DurableObjectNamespace<
					import("./worker").PiCutoverParentFixture
				>;
			}
		).PI_CUTOVER_PARENT;
		const parent = namespace.get(namespace.idFromName(crypto.randomUUID()));
		const token = "cutover-native-fixture-token";
		const name = "custody";
		const before = await parent.seed(name, token);
		const row = await parent.identity(name, token);
		const oldKey = `PiCutoverOriginalFacetFixture\0${name}`;
		const newKey = `PiCutoverParentFixture\0${name}`;
		const result = await runInDurableObject(parent, async (instance, state) => {
			const exports = state.exports as unknown as {
				PiCutoverOriginalFacetFixture: DurableObjectClass<
					import("./worker").PiCutoverOriginalFacetFixture
				>;
				PiCutoverParentFixture: DurableObjectClass<
					import("./worker").PiCutoverParentFixture
				>;
			};
			const id = namespace.idFromName(row.identity_name!);
			const source = state.facets.get(oldKey, () => ({
				class: exports.PiCutoverOriginalFacetFixture,
				id,
			}));
			const alarm = Date.now() + 3_600_000;
			await state.storage.setAlarm(alarm);
			const original = await source.custodySeed(token);
			state.facets.abort(oldKey, "held before clone");
			state.facets.clone(oldKey, newKey);
			const target = () =>
				state.facets.get(newKey, () => ({
					class: exports.PiCutoverParentFixture,
					id,
				}));
			const cloned = await target().custodySnapshot(token);
			state.facets.abort(newKey, "evict cloned target");
			const evicted = await target().custodySnapshot(token);
			state.storage.transactionSync(() => {
				state.storage.sql.exec(
					"UPDATE cf_agents_sub_agents SET class=? WHERE class=? AND name=?",
					"PiCutoverParentFixture",
					"PiCutoverOriginalFacetFixture",
					name,
				);
			});
			state.facets.abort(newKey, "initialize renamed recorded identity");
			// Resolve the real exported replacement class and execute the pinned
			// SDK's native _cf_initAsFacet handshake using the recorded identity.
			const initialized = (await instance._cf_invokeSubAgent(
				"PiCutoverParentFixture",
				name,
				"custodySnapshot",
				[token],
			)) as Awaited<
				ReturnType<import("./worker").PiCutoverParentFixture["custodySnapshot"]>
			>;
			state.facets.abort(newKey, "evict initialized target");
			state.facets.abort(oldKey, "evict archived source");
			// Reading the old key under the replacement fixture avoids restarting
			// the old fixture's deliberate startup counter. No storage is rewritten.
			const archived = await state.facets
				.get(oldKey, () => ({ class: exports.PiCutoverParentFixture, id }))
				.custodySnapshot(token);
			const final = await target().custodySnapshot(token);
			await target().custodyChangeWitness(token);
			const changed = await target().custodySnapshot(token);
			const retained = await state.facets
				.get(oldKey, () => ({ class: exports.PiCutoverParentFixture, id }))
				.custodySnapshot(token);
			const registry = state.storage.sql
				.exec<{
					class: string;
					name: string;
					identity_name: string;
					identity_version: string;
				}>(
					"SELECT class,name,identity_name,identity_version FROM cf_agents_sub_agents WHERE name=?",
					name,
				)
				.toArray();
			return {
				alarm,
				parentAlarm: await state.storage.getAlarm(),
				original,
				cloned,
				evicted,
				initialized,
				archived,
				final,
				changed,
				retained,
				registry,
			};
		});
		expect(result.original.id).toBe(before.objectId);
		expect(result.cloned.id).toBe(before.objectId);
		expect(result.cloned.kv).toBe("preserved-kv");
		expect(result.cloned.sql).toEqual([{ witness: "preserved-sql" }]);
		expect(result.cloned.witness).toEqual({ epoch: 7, owner: "original" });
		expect(result.parentAlarm).toBe(result.alarm);
		expect(result.cloned.starts).toBe(result.original.starts);
		expect(result.cloned.parentPath).toEqual(result.original.parentPath);
		expect(result.evicted).toEqual(result.cloned);
		expect(result.initialized.id).toBe(before.objectId);
		expect(result.initialized.name).toBe(name);
		expect(result.initialized.path).toEqual(result.original.path);
		expect(result.original.selfPath.at(-1)).toEqual({
			className: "PiCutoverOriginalFacetFixture",
			name,
		});
		expect(result.initialized.selfPath.at(-1)).toEqual({
			className: "PiCutoverParentFixture",
			name,
		});
		expect(result.registry).toEqual([
			{
				class: "PiCutoverParentFixture",
				name,
				identity_name: row.identity_name,
				identity_version: "path-v2",
			},
		]);
		expect(result.initialized.witness).toEqual(result.cloned.witness);
		expect(result.archived.witness).toEqual(result.cloned.witness);
		expect(result.archived.sql).toEqual(result.cloned.sql);
		expect(result.final).toEqual(result.initialized);
		expect(result.changed.witness).toEqual({ epoch: 7, owner: "new" });
		expect(result.retained.witness).toEqual({ epoch: 7, owner: "original" });
	});
	it("private facets cannot own an alarm; parent alarm custody is separate", async () => {
		const ns = (
			env as unknown as {
				PI_CUTOVER_PARENT: DurableObjectNamespace<
					import("./worker").PiCutoverParentFixture
				>;
			}
		).PI_CUTOVER_PARENT;
		const parent = ns.get(ns.idFromName(crypto.randomUUID()));
		const token = "cutover-native-fixture-token";
		await parent.seed("alarm-limit", token);
		const row = await parent.identity("alarm-limit", token);
		await expect(
			runInDurableObject(parent, async (_instance, state) => {
				const exports = state.exports as unknown as {
					PiCutoverOriginalFacetFixture: DurableObjectClass<
						import("./worker").PiCutoverOriginalFacetFixture
					>;
				};
				const child = state.facets.get(
					"PiCutoverOriginalFacetFixture\0alarm-limit",
					() => ({
						class: exports.PiCutoverOriginalFacetFixture,
						id: ns.idFromName(row.identity_name!),
					}),
				);
				await child.custodySetAlarm(token, Date.now() + 3_600_000);
			}),
		).rejects.toThrow("Facets currently cannot set alarms.");
	});
});
