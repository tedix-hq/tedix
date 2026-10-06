import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import {
	RuntimeAdmissionDO,
	readStoredRuntimeAdmission,
} from "../../src/runtime-admission-do";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vite-plus/test";
import type { PiStorageFixture, PiStorageSnapshot } from "./storage-fixture";
import type { PiFacetMediaFixture } from "./media-fixture";
const bindings = env as unknown as {
	PI_STORAGE: DurableObjectNamespace<PiStorageFixture>;
	PI_FACET_MEDIA: DurableObjectNamespace<PiFacetMediaFixture>;
};
const fixture = (name: string) => getAgentByName(bindings.PI_STORAGE, name);
const inspect = async (
	agent: Awaited<ReturnType<typeof fixture>>,
	runId: string,
): Promise<PiStorageSnapshot> => JSON.parse(await agent.inspectFixture(runId));

describe("native Pi provider and durable storage", () => {
	it("replays the exact owned answer after eviction and a later submission without repeating inference or effects", async () => {
		const name = crypto.randomUUID();
		const agent = await fixture(name);
		const first = await agent.turn("first");
		expect(first.result.assistantText).toBe("completed");
		const before = await inspect(agent, "first");
		expect(before.requests).toHaveLength(2);
		expect(before.effects).toBe(1);
		expect(before.checkpoint.attempts).toHaveLength(2);
		expect(
			before.checkpoint.attempts.every(
				(attempt) => attempt.phase === "completed" && attempt.acknowledged,
			),
		).toBe(true);
		expect(before.budget.usedTokens).toBe(150);
		await abortAllDurableObjects();
		const restarted = await fixture(name);
		expect(await restarted.turn("first")).toEqual(first);
		expect((await inspect(restarted, "first")).requests).toHaveLength(2);
		await restarted.turn("second");
		expect(await restarted.turn("first")).toEqual(first);
		const later = await inspect(restarted, "first");
		expect(later.submission).toEqual(before.submission);
		expect(later.effects).toBe(1);
		expect(later.requests).toHaveLength(3);
		expect(later.budget.usedTokens).toBe(200);
	});
	it("preserves encrypted Responses reasoning, exact tool results and explicit prompt-cache blocks through actual Pi assembly", async () => {
		const agent = await fixture(crypto.randomUUID());
		await agent.turn("responses");
		const { requests } = await inspect(agent, "responses");
		const replay = requests[1]!;
		expect(replay).toMatchObject({
			model: "gpt-5.6-terra",
			reasoning: { effort: "high" },
			max_output_tokens: 16_000,
			store: false,
		});
		expect(replay).not.toHaveProperty("stream_options");
		expect(replay.input).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "reasoning",
					encrypted_content: "opaque-fixture-reasoning",
				}),
				expect.objectContaining({
					type: "function_call",
					call_id: "receipt-1",
					name: "receipt",
				}),
				expect.objectContaining({
					type: "function_call_output",
					call_id: "receipt-1",
					output: [{ type: "input_text", text: JSON.stringify("recorded") }],
				}),
			]),
		);
		for (const request of requests) {
			expect(request.prompt_cache_key).toBe(requests[0]!.prompt_cache_key);
			expect(request.prompt_cache_key).toBeTruthy();
			expect(request.prompt_cache_options).toEqual({
				mode: "explicit",
				ttl: "30m",
			});
			expect(JSON.stringify(request.input)).toContain(
				'"prompt_cache_breakpoint":{"mode":"explicit"}',
			);
		}
	});
	it("fails closed on a durable cancellation before provider admission", async () => {
		const agent = await fixture(crypto.randomUUID());
		await agent.cancelRun("cancelled");
		expect(await agent.rejectedTurn("cancelled")).toMatch(
			/canceled or stopped/,
		);
		const state = await inspect(agent, "cancelled");
		expect(state.requests).toHaveLength(0);
		expect(state.checkpoint.attempts).toHaveLength(0);
		expect(state.effects).toBe(0);
	});
	it("materializes private images through native Pi and replays the settled answer after eviction", async () => {
		const name = crypto.randomUUID();
		const agent = await getAgentByName(bindings.PI_FACET_MEDIA, name);
		await agent.seedImages("images", 2, 5 * 1024 * 1024);
		const first = await agent.finishImages("images");
		expect(first.result.assistantText).toBe("images received");
		const rows = await agent.inspectImageRows();
		expect(rows.input?.images).toEqual([
			{ bytes: 5 * 1024 * 1024, last: 1 },
			{ bytes: 5 * 1024 * 1024, last: 2 },
		]);
		expect(rows.calls).toBe(1);
		await abortAllDurableObjects();
		const restarted = await getAgentByName(bindings.PI_FACET_MEDIA, name);
		expect(await restarted.finishImages("images")).toEqual(first);
		expect((await restarted.inspectImageRows()).calls).toBe(1);
	}, 30_000);
});

it("runs governed provider settings and native SDK authorization regressions in the Worker runtime", async () => {
	await import("../../src/model-generation.test");
});

describe("permanent storage admission adapter", () => {
	it("uses actual SyncKV/SQL evidence, preserves accepted identity through eviction and fences both CAS winners", async () => {
		const name = crypto.randomUUID();
		let agent = await fixture(name);
		let acceptedHash = "";
		await runInDurableObject(agent, async (_agent, state) => {
			const row = state.storage.sql
				.exec<{ state: string }>(
					"SELECT state FROM cf_agents_state WHERE id='cf_state_row_id'",
				)
				.toArray()[0];
			const stored = JSON.parse(row?.state ?? "{}") as Record<string, unknown>;
			state.storage.sql.exec(
				"INSERT OR REPLACE INTO cf_agents_state(id,state) VALUES('cf_state_row_id',?)",
				JSON.stringify({
					...stored,
					tediId: "storage-fixture",
					orgId: "fixture-org",
				}),
			);
			const owner = {
					tediId: "storage-fixture",
					orgId: "fixture-org",
					objectId: state.id.toString(),
				},
				adapter = new RuntimeAdmissionDO(state.storage, owner);
			await state.storage.put(
				"facet-dispatch-call:" + JSON.stringify(["unsafe", "call"]),
				{
					runId: "unsafe",
					toolCallId: "call",
					tool: "send",
					inputHash: "a".repeat(64),
					status: "dispatched",
				},
			);
			expect(
				state.storage.kv.get(
					"facet-dispatch-call:" + JSON.stringify(["unsafe", "call"]),
				),
			).toMatchObject({ status: "dispatched" });
			await expect(adapter.prepareEvidence("initialize")).rejects.toThrow(
				/external effect/,
			);
			expect(adapter.read()).toBeNull();
			expect(
				readStoredRuntimeAdmission(state.storage, state.id.toString()),
			).toBeNull();
			await state.storage.delete(
				"facet-dispatch-call:" + JSON.stringify(["unsafe", "call"]),
			);
			await state.storage.put("wfimages:passive", {
				hasImages: true,
				workflowInstanceId: "archived",
			});
			await state.storage.put("workflow-image-cleanup:unsafe", {
				runId: "unsafe",
				intent: "terminal",
			});
			await expect(adapter.prepareEvidence("initialize")).rejects.toThrow(
				"Runtime admission storage: invalid stored evidence",
			);
			expect(adapter.read()).toBeNull();
			expect(state.storage.kv.get("workflow-image-cleanup:unsafe")).toEqual({
				runId: "unsafe",
				intent: "terminal",
			});
			expect(state.storage.kv.get("wfimages:passive")).toEqual({
				hasImages: true,
				workflowInstanceId: "archived",
			});
			await state.storage.delete("workflow-image-cleanup:unsafe");
			await state.storage.put("computer-acquisition:pending", {
				callId: "pending",
				ownerRunId: "unsafe",
			});
			await expect(adapter.prepareEvidence("initialize")).rejects.toThrow(
				/computer acquisition/,
			);
			await state.storage.delete("computer-acquisition:pending");
			const evidence = await adapter.prepareEvidence("initialize");
			await state.storage.put("pi-facet-pending-submission", {
				submissionId: "unknown",
			});
			expect(() =>
				adapter.gate.initialize({
					operationId: "stale",
					state: "active",
					evidence,
				}),
			).toThrow(/pending/);
			await state.storage.delete("pi-facet-pending-submission");
			adapter.gate.initialize({
				operationId: "init",
				state: "active",
				evidence: await adapter.prepareEvidence("initialize"),
			});
			const result = await adapter.beginAcceptedTurn({
				runId: "owned",
				sessionKey: "session",
				principalId: "service:fixture",
				input: { text: "original", attachments: [] },
				expectedGeneration: 1,
			});
			acceptedHash = result.accepted.inputHash;
			await expect(
				adapter.beginAcceptedTurn({
					runId: "owned",
					sessionKey: "different",
					principalId: "service:fixture",
					input: { text: "original", attachments: [] },
					expectedGeneration: 1,
				}),
			).rejects.toThrow(/identity changed/);
			expect(() =>
				adapter.gate.hold({
					operationId: "hold",
					expectedGeneration: 1,
					evidence,
				}),
			).toThrow(/unresolved/);
			adapter.gate.quarantine({
				operationId: "quarantine",
				expectedGeneration: 1,
				reason: "receipt pending",
			});
		});
		await abortAllDurableObjects();
		agent = bindings.PI_STORAGE.get(bindings.PI_STORAGE.idFromName(name));
		await runInDurableObject(agent, async (_agent, state) => {
			const owner = {
					tediId: "storage-fixture",
					orgId: "fixture-org",
					objectId: state.id.toString(),
				},
				adapter = new RuntimeAdmissionDO(state.storage, owner);
			expect(adapter.read()?.state).toBe("quarantined");
			expect(
				readStoredRuntimeAdmission(state.storage, state.id.toString())?.state,
			).toBe("quarantined");
			expect(() =>
				readStoredRuntimeAdmission(state.storage, "different-object"),
			).toThrow(/physical/);
			expect(
				(
					await adapter.assertOriginalClaim({
						runId: "owned",
						sessionKey: "session",
						inputHash: acceptedHash,
						input: { attachments: [], text: "original" },
					})
				).generation,
			).toBe(1);
			await expect(
				adapter.assertOriginalClaim({
					runId: "owned",
					input: { text: "modified after recovery", attachments: [] },
				}),
			).rejects.toThrow(/identity changed/);
			await expect(
				adapter.assertAcceptedTurn({ runId: "owned" }),
			).rejects.toThrow(/denied/);
			await expect(
				adapter.assertOriginalClaim({ runId: "missing" }),
			).rejects.toThrow(/missing/);
			await expect(
				adapter.recordTerminalReceipt("missing", {
					sourceId: "answer",
					receipt: { settled: true },
				}),
			).rejects.toThrow(/missing/);
			state.storage.sql.exec(
				"UPDATE runtime_admission_identities SET record=json_set(record,'$.sessionKey','changed') WHERE run_id='owned'",
			);
			await expect(
				adapter.assertOriginalClaim({ runId: "owned" }),
			).rejects.toThrow(/hash mismatch/);
			const claim = adapter.gate.claim("owned")!;
			await expect(
				adapter.prepareEvidence("complete", {
					turnId: "owned",
					requestHash: claim.requestHash,
					generation: claim.generation,
					submissionId: "owned",
				}),
			).rejects.toThrow(/hash mismatch/);
			state.storage.sql.exec(
				"UPDATE runtime_admission SET record='invalid' WHERE id=1",
			);
			expect(() =>
				readStoredRuntimeAdmission(state.storage, state.id.toString()),
			).toThrow(/invalid/);
			state.storage.sql.exec("DELETE FROM runtime_admission WHERE id=1");
			expect(() =>
				readStoredRuntimeAdmission(state.storage, state.id.toString()),
			).toThrow(/missing persisted admission/);
		});
	});
	it("binds an actual native owned terminal answer and accounting to the original claim without blocking unrelated work", async () => {
		const agent = await fixture(crypto.randomUUID());
		await runInDurableObject(agent, async (actual, state) => {
			const row = state.storage.sql
				.exec<{ state: string }>(
					"SELECT state FROM cf_agents_state WHERE id='cf_state_row_id'",
				)
				.toArray()[0];
			state.storage.sql.exec(
				"INSERT OR REPLACE INTO cf_agents_state(id,state) VALUES('cf_state_row_id',?)",
				JSON.stringify({
					...JSON.parse(row?.state ?? "{}"),
					tediId: "storage-fixture",
					orgId: "fixture-org",
				}),
			);
			const adapter = new RuntimeAdmissionDO(state.storage, {
				tediId: "storage-fixture",
				orgId: "fixture-org",
				objectId: state.id.toString(),
			});
			adapter.gate.initialize({
				operationId: "init",
				state: "active",
				evidence: await adapter.prepareEvidence("initialize"),
			});
			const accepted = await adapter.beginAcceptedTurn({
				runId: "settle",
				sessionKey: "fixture",
				principalId: "service:fixture",
				input: { durableSubmissionId: "settle", text: "settle" },
				expectedGeneration: 1,
			});
			await adapter.assertAcceptedTurn({
				runId: "settle",
				sessionKey: "fixture",
			});
			const answer = await actual.turn("settle");
			expect(answer.result.assistantText).toBe("completed");
			const native = JSON.parse(
				await actual.inspectFixture("settle"),
			) as PiStorageSnapshot;
			expect(native.requests).toHaveLength(2);
			expect(
				native.checkpoint.attempts.every(
					(a) => a.phase === "completed" && a.acknowledged,
				),
			).toBe(true);
			const directNativeProof = await adapter.prepareEvidence("complete", {
				turnId: "settle",
				requestHash: accepted.claim.requestHash,
				generation: 1,
				submissionId: "settle",
			});
			expect(directNativeProof).toMatch(/^[a-f0-9]{64}$/);
			adapter.gate.quarantine({
				operationId: "quarantine",
				expectedGeneration: 1,
				reason: "operator exclusion",
			});
			await adapter.recordTerminalReceipt("settle", {
				sourceId: "settle",
				receipt: {
					nativeSubmission: native.submission,
					usage: native.checkpoint,
				},
			});
			state.storage.sql.exec(
				"CREATE TABLE unrelated_tasks (id INTEGER,status TEXT,record TEXT)",
			);
			state.storage.sql.exec(
				"INSERT INTO unrelated_tasks VALUES (1,'running',?)",
				JSON.stringify({ state: { status: "running" } }),
			);
			const original = {
				turnId: "settle",
				requestHash: accepted.claim.requestHash,
				generation: 1,
				submissionId: "settle",
			};
			const evidence = await adapter.prepareEvidence("complete", original);
			expect(adapter.gate.completeTurn({ ...original, evidence }).status).toBe(
				"completed",
			);
			expect(adapter.read()?.state).toBe("quarantined");
			await expect(
				adapter.assertAcceptedTurn({ runId: "settle" }),
			).rejects.toThrow(/denied/);
			const currentState = state.storage.sql
				.exec<{ state: string }>(
					"SELECT state FROM cf_agents_state WHERE id='cf_state_row_id'",
				)
				.toArray()[0];
			state.storage.sql.exec(
				"INSERT OR REPLACE INTO cf_agents_state(id,state) VALUES('cf_state_row_id',?)",
				JSON.stringify({
					...JSON.parse(currentState?.state ?? "{}"),
					tediId: "storage-fixture",
					orgId: "fixture-org",
				}),
			);
			await expect(adapter.prepareEvidence("release")).rejects.toThrow(
				/nonterminal/,
			);
		});
	});
});

it("checks child operation completion against its real parent-run accounting checkpoint", async () => {
	const agent = await fixture(crypto.randomUUID());
	await runInDurableObject(agent, async (actual, state) => {
		await actual.turn("accounting-base");
		if (
			typeof actual.state.system !== "string" ||
			!actual.state.aigMetadata ||
			typeof actual.state.sessionKey !== "string"
		)
			throw new Error("Fixture configured owner state missing");
		const configuration = {
			...actual.state,
			system: actual.state.system,
			modelRef: actual.state.modelRef,
			aigMetadata: actual.state.aigMetadata,
			sessionKey: actual.state.sessionKey,
			runId: "accounting-base",
		};
		state.storage.sql.exec(
			"UPDATE cf_agents_state SET state=? WHERE id='cf_state_row_id'",
			JSON.stringify({
				...actual.state,
				tediId: "storage-fixture",
				orgId: "fixture-org",
			}),
		);
		const adapter = new RuntimeAdmissionDO(state.storage, {
			tediId: "storage-fixture",
			orgId: "fixture-org",
			objectId: state.id.toString(),
		});
		adapter.gate.initialize({
			operationId: "init",
			state: "active",
			evidence: await adapter.prepareEvidence("initialize"),
		});
		const accepted = await adapter.beginAcceptedTurn({
			runId: "accounting-base:segment:1",
			sessionKey: "fixture",
			principalId: "fixture",
			input: {
				parentRunId: "accounting-base",
				durableSubmissionId: "accounting-base:segment:1",
				text: "next segment",
			},
			expectedGeneration: 1,
		});
		await actual.runConfiguredConversationTurn({
			configuration,
			text: "next segment",
			durableSubmissionId: "accounting-base:segment:1",
		});
		const original = {
			turnId: "accounting-base:segment:1",
			requestHash: accepted.claim.requestHash,
			generation: 1,
			submissionId: "accounting-base:segment:1",
		};
		const checkpoint = await state.storage.get<
			import("../../src/pi-turn-accounting").PiAccountingCheckpoint
		>("pi-accounting:accounting-base");
		expect(checkpoint?.attempts.at(-1)?.acknowledged).toBe(true);
		await state.storage.put("pi-accounting:accounting-base", {
			...checkpoint,
			attempts: checkpoint!.attempts.map((attempt, index) =>
				index === checkpoint!.attempts.length - 1
					? { ...attempt, acknowledged: false }
					: attempt,
			),
		});
		await expect(adapter.prepareEvidence("complete", original)).rejects.toThrow(
			/unsettled|accounting/,
		);
		await state.storage.put("pi-accounting:accounting-base", checkpoint!);
		const evidence = await adapter.prepareEvidence("complete", original);
		expect(adapter.gate.completeTurn({ ...original, evidence }).status).toBe(
			"completed",
		);
	});
});

it("uses durable original compaction admission for skipped, modified and uncertain queued passes", async () => {
	const { admittedTediDo } = await import("../tedi-do");
	const { TediSessionRepo } = await import("@tedix/tedi-session/session-repo");
	const ns = (env as unknown as { PI_TEST: DurableObjectNamespace }).PI_TEST;
	const stub = ns.get(ns.idFromName(crypto.randomUUID()));
	await runInDurableObject(stub, async (_actual, state) => {
		const owner = { tediId: "compaction-tedi", orgId: "compaction-org" };
		state.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS cf_agents_state (id TEXT PRIMARY KEY,state TEXT)",
		);
		state.storage.sql.exec(
			"INSERT OR REPLACE INTO cf_agents_state VALUES ('cf_state_row_id',?)",
			JSON.stringify(owner),
		);
		const adapter = new RuntimeAdmissionDO(state.storage, {
			...owner,
			objectId: state.id.toString(),
		});
		adapter.gate.initialize({
			operationId: "compaction-init",
			state: "active",
			evidence: await adapter.prepareEvidence("initialize"),
		});
		const parent = admittedTediDo(state, owner);
		parent.ensureIdentity = async () => undefined;
		parent.modelOverrideForSurface = () => null;
		parent.sessionRepo = new TediSessionRepo({
			readDurable: async () => ({ entries: [], compaction: null }),
			sql: (strings, ...values) =>
				state.storage.sql.exec(strings.join("?"), ...values).toArray() as never,
		});
		let queued: { sessionKey: string; operationId: string } | undefined;
		parent.queue = async (_callback: string, payload: typeof queued) => {
			queued = payload;
		};
		let modelCalls = 0;
		parent.summarizeAdmittedCompaction = async () => {
			modelCalls++;
			throw new Error("provider receipt unknown");
		};
		await expect(
			parent.onCompactSession({ sessionKey: "empty" }),
		).rejects.toThrow(/accepted operation/);
		await parent.enqueueCompaction("empty");
		expect(queued).toBeDefined();
		const skipped = queued!;
		expect(adapter.gate.claim(skipped.operationId)?.status).toBe("running");
		await parent.onCompactSession(skipped);
		expect(modelCalls).toBe(0);
		expect(adapter.gate.claim(skipped.operationId)?.status).toBe("completed");
		parent.sessionRepo.appendTurn({
			sessionKey: "history",
			role: "user",
			content: "old source ".repeat(100),
			ts: 1,
		});
		parent.sessionRepo.appendTurn({
			sessionKey: "history",
			role: "assistant",
			content: "recent source",
			ts: 2,
		});
		parent.sessionRepo.appendTurn({
			sessionKey: "history",
			role: "user",
			content: "new source",
			ts: 3,
		});
		parent.sessionRepo.appendTurn({
			sessionKey: "history",
			role: "assistant",
			content: "new answer",
			ts: 4,
		});
		expect(parent.sessionRepo.getBranch("history")).toHaveLength(4);
		const uncertain = await parent.prepareCompaction("history", {
			keepRecentTokens: 0,
		});
		await expect(
			parent.onCompactSession({
				sessionKey: "different",
				operationId: uncertain,
			}),
		).rejects.toThrow(/original/);
		expect(modelCalls).toBe(0);
		await expect(
			parent.onCompactSession({
				sessionKey: "history",
				operationId: uncertain,
			}),
		).rejects.toThrow(/verified commit/);
		expect(modelCalls).toBe(1);
		await expect(
			parent.onCompactSession({
				sessionKey: "history",
				operationId: uncertain,
			}),
		).rejects.toThrow(/already dispatched/);
		expect(modelCalls).toBe(1);
		expect(adapter.gate.claim(uncertain)?.status).toBe("running");
		for (let n = 0; n < 4; n++)
			parent.sessionRepo.appendTurn({
				sessionKey: "race",
				role: n % 2 ? "assistant" : "user",
				content: `race source ${n}`,
				ts: n + 1,
			});
		const raced = await parent.prepareCompaction("race", {
			keepRecentTokens: 0,
		});
		parent.summarizeAdmittedCompaction = async () => {
			modelCalls++;
			adapter.gate.quarantine({
				operationId: "compaction-quarantine",
				expectedGeneration: 1,
				reason: "model returned after epoch quarantine",
			});
			return "actual scripted summary";
		};
		await expect(
			parent.onCompactSession({ sessionKey: "race", operationId: raced }),
		).rejects.toThrow(/verified commit/);
		const racedJournal = state.storage.kv.get<{
			stage: string;
			modelReceipt?: { summaryHash: string };
		}>(`runtime-compaction:${raced}`)!;
		expect(racedJournal.stage).toBe("running");
		expect(racedJournal.modelReceipt?.summaryHash).toHaveLength(64);
		expect(
			parent.sessionRepo
				.getBranch("race")
				.some((entry: { type: string }) => entry.type === "compaction"),
		).toBe(false);

		await parent.onCompactSession(skipped);
		expect(adapter.read()?.state).toBe("quarantined");
		expect(modelCalls).toBe(2);
	});
});

it("commits a known compaction summary and its original ledger receipt exactly once", async () => {
	const { admittedTediDo } = await import("../tedi-do");
	const { TediSessionRepo } = await import("@tedix/tedi-session/session-repo");
	const ns = (env as unknown as { PI_TEST: DurableObjectNamespace }).PI_TEST;
	const stub = ns.get(ns.idFromName(crypto.randomUUID()));
	await runInDurableObject(stub, async (_actual, state) => {
		const owner = {
			tediId: "positive-compaction-tedi",
			orgId: "positive-compaction-org",
		};
		state.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS cf_agents_state (id TEXT PRIMARY KEY,state TEXT)",
		);
		state.storage.sql.exec(
			"INSERT OR REPLACE INTO cf_agents_state VALUES ('cf_state_row_id',?)",
			JSON.stringify(owner),
		);
		const adapter = new RuntimeAdmissionDO(state.storage, {
			...owner,
			objectId: state.id.toString(),
		});
		adapter.gate.initialize({
			operationId: "positive-init",
			state: "active",
			evidence: await adapter.prepareEvidence("initialize"),
		});
		const parent = admittedTediDo(state, owner);
		parent.ensureIdentity = async () => undefined;
		parent.modelOverrideForSurface = () => null;
		parent.sessionRepo = new TediSessionRepo({
			readDurable: async () => ({ entries: [], compaction: null }),
			sql: (strings, ...values) =>
				state.storage.sql.exec(strings.join("?"), ...values).toArray() as never,
		});
		for (let n = 0; n < 4; n++)
			parent.sessionRepo.appendTurn({
				sessionKey: "known",
				role: n % 2 ? "assistant" : "user",
				content: `known source ${n}`,
				ts: n + 1,
			});
		let modelCalls = 0;
		const summary = "Known scripted summary preserves the first complete turn.";
		parent.summarizeAdmittedCompaction = async (entries: unknown[]) => {
			modelCalls++;
			expect(entries).toHaveLength(2);
			return summary;
		};
		parent.getPlatformClient = async () => ({
			recordRuntimeEvent: async (event: {
				id: string;
				kind: string;
				payload: unknown;
			}) => {
				expect(event.kind).toBe("context.compacted");
				expect(adapter.gate.claim(operationId)?.status).toBe("running");
				expect(
					state.storage.sql
						.exec(
							"SELECT id FROM session_entries WHERE session_key='known' AND type='compaction'",
						)
						.toArray(),
				).toHaveLength(1);
				expect(
					state.storage.kv.get<{ stage: string }>(
						`runtime-compaction:${operationId}`,
					)?.stage,
				).toBe("running");
				const previous =
					(await state.storage.get<unknown[]>("positive-ledger-receipts")) ??
					[];
				await state.storage.put("positive-ledger-receipts", [
					...previous,
					event,
				]);
			},
		});
		const operationId = await parent.prepareCompaction("known", {
			keepRecentTokens: 0,
		});
		await parent.onCompactSession({ sessionKey: "known", operationId });
		const journal = state.storage.kv.get<{
			stage: string;
			result: { compacted: boolean; summary: string };
			modelReceipt: { summaryHash: string };
		}>(`runtime-compaction:${operationId}`)!;
		expect(journal.stage).toBe("completed");
		expect(journal.result).toMatchObject({ compacted: true, summary });
		expect(journal.modelReceipt.summaryHash).toBe(
			await parent.runtimeReceiptHash(summary),
		);
		const rows = state.storage.sql
			.exec<{ type: string; content: string }>(
				"SELECT type,content FROM session_entries WHERE session_key='known'",
			)
			.toArray();
		expect(rows.filter((row) => row.type === "message")).toHaveLength(4);
		expect(rows.filter((row) => row.type === "compaction")).toEqual([
			{ type: "compaction", content: summary },
		]);
		expect(adapter.gate.claim(operationId)?.status).toBe("completed");
		const terminal = JSON.parse(
			state.storage.sql
				.exec<{ record: string }>(
					"SELECT record FROM runtime_admission_receipts WHERE run_id=?",
					operationId,
				)
				.toArray()[0]!.record,
		);
		expect(terminal.sourceId).toBe(operationId);
		expect(terminal.accepted.owner).toEqual({
			...owner,
			objectId: state.id.toString(),
		});
		expect(terminal.receipt.result).toMatchObject({ compacted: true, summary });
		expect(
			await state.storage.get<unknown[]>("positive-ledger-receipts"),
		).toHaveLength(1);
		await parent.onCompactSession({ sessionKey: "known", operationId });
		adapter.gate.quarantine({
			operationId: "positive-held-reconciliation",
			expectedGeneration: 1,
			reason: "verify original completed receipt while inactive",
		});
		await parent.onCompactSession({ sessionKey: "known", operationId });
		expect(modelCalls).toBe(1);
		expect(
			await state.storage.get<unknown[]>("positive-ledger-receipts"),
		).toHaveLength(1);
		expect(
			state.storage.sql
				.exec(
					"SELECT id FROM session_entries WHERE session_key='known' AND type='compaction'",
				)
				.toArray(),
		).toHaveLength(1);
		expect(adapter.read()?.state).toBe("quarantined");
	});
});
