import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vite-plus/test";
import { RuntimeAdmission } from "../../src/runtime-admission";
import { PiCutoverOperator } from "../../src/pi-cutover-operator";
import { planPiTranscriptCutover } from "../../src/pi-state-cutover-transcript";
import type { PiRuntimeFixture } from "./worker";
import { admittedTediDo } from "../tedi-do";
import { RuntimeAdmissionDO } from "../../src/runtime-admission-do";
import { buildRunId } from "../../src/ledger-mirror";
import {
	maintenanceCompletionReceiptHash,
	type ParentServiceOperation,
	type MaintenanceEffectReceipt,
} from "../../src/pi-parent-services";
const OWNER = { tediId: "tedi", orgId: "org" },
	EVIDENCE = "e".repeat(64);
function fixture() {
	const ns = (
		env as unknown as { PI_TEST: DurableObjectNamespace<PiRuntimeFixture> }
	).PI_TEST;
	return ns.get(ns.idFromName(crypto.randomUUID()));
}
function seed(storage: DurableObjectStorage) {
	storage.sql.exec(
		"CREATE TABLE cf_agents_state (id TEXT PRIMARY KEY,state TEXT)",
	);
	storage.sql.exec(
		"INSERT INTO cf_agents_state VALUES ('cf_state_row_id',?)",
		JSON.stringify(OWNER),
	);
	storage.sql.exec(
		"CREATE TABLE cf_agents_session_messages (session_id TEXT,id TEXT,seq INTEGER,parent_id TEXT,role TEXT,content TEXT,content_chunks INTEGER,created_at INTEGER)",
	);
	storage.sql.exec(
		"INSERT INTO cf_agents_session_messages VALUES ('','root',1,NULL,'user',?,0,1000)",
		JSON.stringify({
			id: "root",
			role: "user",
			parts: [{ type: "text", text: "PRIVATE transcript" }],
		}),
	);
}
describe("passive cutover operator", () => {
	it("preserves unselected empty-image preparation without upload authority or R2 writes", async () => {
		await runInDurableObject(fixture(), async (_agent, ctx) => {
			const parent = admittedTediDo(ctx, OWNER);
			parent.runtimeAdmission = () => null;
			let writes = 0;
			parent.env = {
				TEDI_STORAGE: {
					put: async () => {
						writes++;
					},
				},
			} as any;
			expect(
				await parent.prepareWorkflowImages(
					"empty-run",
					"empty-workflow",
					[],
					"actual-session",
				),
			).toEqual([]);
			expect(writes).toBe(0);
			expect(ctx.storage.kv.get("wfimages:empty-run")).toEqual({
				hasImages: false,
				workflowInstanceId: "empty-workflow",
				refs: [],
			});
		});
	});
	it("requires canonical original terminal custody for retained Computer receipts and validates actual Telegram message acknowledgments", async () => {
		await runInDurableObject(fixture(), async (_agent, state) => {
			seed(state.storage);
			const admission = new RuntimeAdmissionDO(state.storage, {
				...OWNER,
				objectId: state.id.toString(),
			});
			const evidence = await admission.prepareEvidence("initialize");
			admission.gate.initialize({
				operationId: "baseline",
				state: "active",
				evidence,
			});
			await admission.beginAcceptedTurn({
				runId: "run",
				sessionKey: "session",
				principalId: "tedi",
				input: { workItemId: "work", homeRunId: "home", sessionKey: "session" },
				expectedGeneration: 1,
			});
			await state.storage.put("computer-continuation:run", {
				identity: JSON.stringify(["run", "work", "home", "session"]),
				activeSegment: 0,
			});
			await state.storage.put('computer-continuation-segment:["run",0]', {
				text: "actual acknowledged result",
				stopReason: "end_turn",
				toolCalls: [],
			});
			await expect(admission.prepareEvidence("hold")).rejects.toThrow(
				"unknown external effect receipt",
			);
			await admission.recordTerminalReceipt("run", {
				sourceId: "canonical-result",
				receipt: { text: "actual acknowledged result" },
			});
			await admission.prepareEvidence("hold");
			const input = {
				turn: { operationId: "reply", sessionKey: "session" },
				thread: { id: "thread" },
			};
			const requestHash = Array.from(
				new Uint8Array(
					await crypto.subtle.digest(
						"SHA-256",
						new TextEncoder().encode(JSON.stringify(input)),
					),
				),
				(b) => b.toString(16).padStart(2, "0"),
			).join("");
			const reply = {
				version: 1,
				stage: "completed",
				...input,
				operation: {
					operationId: "reply",
					kind: "telegram",
					sessionKey: "session",
					input,
					requestHash,
				},
				claim: null,
				chunks: ["delivered"],
				messageIds: ["actual-message"],
				nextChunk: 1,
			};
			await state.storage.put("tedix:pi:telegram:reply:reply", reply);
			await admission.prepareEvidence("hold");
			await state.storage.put("tedix:pi:telegram:reply:reply", {
				...reply,
				claim: { generation: 1 },
			});
			await expect(admission.prepareEvidence("hold")).rejects.toThrow();
			const telegramRun = buildRunId(OWNER.tediId, "reply", "chat");
			await admission.beginAcceptedTurn({
				runId: telegramRun,
				sessionKey: "session",
				principalId: OWNER.tediId,
				input: reply.operation,
				expectedGeneration: 1,
			});
			const receiptHash = Array.from(
				new Uint8Array(
					await crypto.subtle.digest(
						"SHA-256",
						new TextEncoder().encode(
							JSON.stringify({
								operationId: "reply",
								messageIds: reply.messageIds,
								nextChunk: reply.nextChunk,
							}),
						),
					),
				),
				(b) => b.toString(16).padStart(2, "0"),
			).join("");
			await state.storage.put(`runtime-admission-settlement:${telegramRun}`, {
				sessionKey: "session",
				assistant: { content: "delivered" },
				stopReason: "end_turn",
			});
			await admission.recordTerminalReceipt(telegramRun, {
				sourceId: "reply",
				receipt: { terminal: "completed", receiptHash },
			});
			await admission.prepareEvidence("hold");
			await state.storage.put("tedix:pi:telegram:reply:reply", {
				...reply,
				claim: { generation: 2 },
			});
			await expect(admission.prepareEvidence("hold")).rejects.toThrow(
				"unknown external effect receipt",
			);
			await state.storage.put("tedix:pi:telegram:reply:reply", {
				...reply,
				messageIds: [],
			});
			await expect(admission.prepareEvidence("hold")).rejects.toThrow(
				"unknown external effect receipt",
			);
		});
	});
	it("checks actual SDK detached delivery SQL and binds the retained receipt into baseline evidence", async () => {
		await runInDurableObject(fixture(), async (_agent, state) => {
			seed(state.storage);
			state.storage.sql.exec(
				"INSERT INTO cf_agent_tool_runs (run_id,agent_type,started_at,status,completed_at,child_still_running,detached,finish_delivered_at,give_up_delivered_at,output_json,error_message) VALUES ('child','fixture-child',0,'interrupted',1,1,1,NULL,2,NULL,'gave up')",
			);
			const admission = new RuntimeAdmissionDO(state.storage, {
				...OWNER,
				objectId: state.id.toString(),
			});
			await expect(admission.prepareEvidence("initialize")).rejects.toThrow(
				"unknown external effect receipt",
			);
			state.storage.sql.exec(
				"UPDATE cf_agent_tool_runs SET status='completed',child_still_running=0,output_json='null',error_message=NULL",
			);
			await expect(admission.prepareEvidence("initialize")).rejects.toThrow(
				"unknown external effect receipt",
			);
			state.storage.sql.exec(
				"UPDATE cf_agent_tool_runs SET finish_delivered_at=3",
			);
			const first = await admission.prepareEvidence("initialize");
			state.storage.sql.exec(
				"UPDATE cf_agent_tool_runs SET output_json='false'",
			);
			expect(await admission.prepareEvidence("initialize")).not.toBe(first);
		});
	});
	it.each([
		[
			"computer-effect:call",
			{
				scopeKey: "computer-environment:scope",
				executionId: "exec",
				environment: { leaseId: "lease" },
				inputHash: "a".repeat(64),
			},
		],
		[
			"computer-environment:scope:execution:exec",
			{ leaseId: "lease", ready: true },
		],
		[
			"computer-continuation:run",
			{ identity: JSON.stringify(["run", "work", "home"]), activeSegment: 0 },
		],
		[
			'computer-continuation-segment:["run",0]',
			{ text: "cached before commit", stopReason: "end_turn" },
		],
		[
			"computer-exec-wake:exec",
			{
				executionId: "exec",
				launchedByRunId: "run",
				environment: { leaseId: "lease" },
				terminalReceipt: { terminal: true },
				workItemId: "work",
			},
		],
		[
			"tedix:pi:telegram:reply:reply",
			{ version: 1, stage: "uncertain", operation: {}, turn: {} },
		],
	])("rejects unresolved actual KV effect %s", async (key, value) => {
		await runInDurableObject(fixture(), async (_agent, state) => {
			seed(state.storage);
			await state.storage.put(key, value);
			const admission = new RuntimeAdmissionDO(state.storage, {
				...OWNER,
				objectId: state.id.toString(),
			});
			await expect(admission.prepareEvidence("initialize")).rejects.toThrow();
		});
	});
	it("binds real parent service authority to native stored claims and denies completion without an effect journal", async () => {
		await runInDurableObject(fixture(), async (_agent, state) => {
			seed(state.storage);
			const owner = { ...OWNER, objectId: state.id.toString() };
			const admission = new RuntimeAdmissionDO(state.storage, owner);
			const evidence = await admission.prepareEvidence("initialize");
			admission.gate.initialize({
				operationId: "native-baseline",
				state: "active",
				evidence,
			});
			const parent = admittedTediDo(state, OWNER);
			const ports = parent.parentServiceAdmission();
			const operation: ParentServiceOperation = {
				operationId: "maintenance:native-schedule:1",
				kind: "maintenance",
				requestHash: "a".repeat(64),
				scheduledAt: 1000,
				input: {
					taskId: "isolate-corpus-audit",
					scheduleId: "native-schedule",
					scheduleType: "interval",
					scheduledAt: 1000,
					bridge: false,
				},
			};
			const claim = await ports.admitAccepted(operation);
			await ports.assertActive(operation, claim);
			await expect(
				ports.assertActive(
					{ ...operation, input: { ...operation.input, bridge: true } },
					claim,
				),
			).rejects.toThrow(/input changed|immutable|identity/i);
			await expect(
				ports.completeOriginal(operation, claim, {
					terminal: "completed",
					receiptHash: "b".repeat(64),
				}),
			).rejects.toThrow(/maintenance|effect|journal|acknowledg/i);
			expect(admission.gate.claim(operation.operationId)?.status).toBe(
				"running",
			);
			expect(
				state.storage.sql
					.exec(
						"SELECT name FROM sqlite_master WHERE name='runtime_admission_receipts'",
					)
					.toArray(),
			).toHaveLength(0);
			admission.gate.quarantine({
				operationId: "native-custody",
				expectedGeneration: 1,
				reason: "uncertain maintenance effect",
			});
			await expect(ports.assertActive(operation, claim)).rejects.toThrow(
				/inactive|dispatch denied|generation/i,
			);
			expect(admission.read()?.state).toBe("quarantined");
			const effectEvidence = {
				operation,
				task: "isolate-corpus-audit",
				acknowledgmentId: `${operation.operationId}:effects`,
				status: "acknowledged",
			};
			const effectReceipt: MaintenanceEffectReceipt = {
				status: "acknowledged",
				operationId: operation.operationId,
				requestHash: operation.requestHash,
				taskId: "isolate-corpus-audit",
				acknowledgmentId: effectEvidence.acknowledgmentId,
				receiptHash: await parent.runtimeReceiptHash(effectEvidence),
			};
			const fireKey = `tedix:pi:maintenance:fire:${operation.operationId}`;
			const effectKey = `tedix:pi:maintenance:effect:${operation.operationId}`;
			const fire = { operation, claim, stage: "acknowledged", effectReceipt };
			const actual = {
				operation,
				stage: "acknowledged",
				evidence: effectEvidence,
				receipt: effectReceipt,
			};
			const terminal = {
				terminal: "completed",
				receiptHash: await maintenanceCompletionReceiptHash(
					operation,
					effectReceipt,
				),
			};
			await state.storage.put(fireKey, fire);
			await state.storage.put(effectKey, {
				...actual,
				receipt: { ...effectReceipt, acknowledgmentId: "forged" },
			});
			await expect(
				ports.completeOriginal(operation, claim, terminal),
			).rejects.toThrow(/journal|acknowledgment/i);
			expect(admission.gate.claim(operation.operationId)?.status).toBe(
				"running",
			);
			await state.storage.put(effectKey, {
				...actual,
				evidence: { ...effectEvidence, status: "uncertain" },
			});
			await expect(
				ports.completeOriginal(operation, claim, terminal),
			).rejects.toThrow(/hash|changed/i);
			await state.storage.put(effectKey, actual);
			await ports.completeOriginal(operation, claim, terminal);
			expect(admission.gate.claim(operation.operationId)?.status).toBe(
				"completed",
			);
			expect(admission.read()?.state).toBe("quarantined");
			await state.storage.put(fireKey, { ...fire, stage: "completed" });
			await ports.completeOriginal(operation, claim, terminal);
			await state.storage.delete(effectKey);
			await expect(
				ports.completeOriginal(operation, claim, terminal),
			).rejects.toThrow(/journal|acknowledgment/i);
			expect(admission.read()?.state).toBe("quarantined");
		});
	});
	it("requires admission, holds all cognition, preserves exact checkpoint/source and releases explicitly", async () => {
		await runInDurableObject(fixture(), async (_agent, state) => {
			seed(state.storage);
			const owner = { ...OWNER, objectId: state.id.toString() };
			const admission = new RuntimeAdmission(state.storage, owner, () => ({
				owner,
				digest: EVIDENCE,
				complete: true,
				unknown: 0,
				nonterminal: 0,
			}));
			const operator = new PiCutoverOperator(
				state.storage,
				admission,
				(_action, actual) => {
					expect(actual).toEqual(owner);
				},
				(run) => state.blockConcurrencyWhile(run),
			);
			const checkpoint = {
				version: 1,
				runId: "run",
				attempts: [],
				fault: null,
			};
			await state.storage.put("think-accounting:run", checkpoint);
			const plan = await planPiTranscriptCutover(state.storage, OWNER);
			await expect(
				operator.prepareCutover({
					operationId: "migration",
					expectedGeneration: 1,
					sourceHash: plan.sourceHash,
					evidence: EVIDENCE,
				}),
			).rejects.toThrow(/unverified baseline/);
			admission.initialize({
				operationId: "baseline",
				state: "active",
				evidence: EVIDENCE,
			});
			const before = state.storage.sql
				.exec("SELECT * FROM cf_agents_session_messages")
				.toArray();
			const held = await operator.prepareCutover({
				operationId: "migration",
				expectedGeneration: 1,
				sourceHash: plan.sourceHash,
				evidence: EVIDENCE,
			});
			expect(admission.read()?.state).toBe("held");
			await expect(
				operator.prepareCutover({
					operationId: "migration",
					expectedGeneration: 99,
					sourceHash: plan.sourceHash,
					evidence: EVIDENCE,
				}),
			).rejects.toThrow(/operation id conflict/);
			expect(
				await operator.prepareCutover({
					operationId: "migration",
					expectedGeneration: 1,
					sourceHash: plan.sourceHash,
					evidence: EVIDENCE,
				}),
			).toEqual(held);
			expect(() =>
				admission.beginTurn({
					turnId: "new",
					requestHash: EVIDENCE,
					expectedGeneration: held.generation,
				}),
			).toThrow(/dispatch denied/);
			await expect(
				operator.release({
					operationId: "migration",
					generation: held.generation,
					sourceHash: plan.sourceHash,
					evidence: EVIDENCE,
				}),
			).rejects.toThrow(/destination changed or unverified/);
			const result = await operator.apply({
				operationId: "migration",
				generation: held.generation,
				sourceHash: plan.sourceHash,
			});
			expect(result.entries).toBe(1);
			expect(JSON.stringify(result)).not.toContain("PRIVATE");
			expect(
				await operator.apply({
					operationId: "migration",
					generation: held.generation,
					sourceHash: plan.sourceHash,
				}),
			).toEqual(result);
			expect(
				state.storage.sql
					.exec("SELECT * FROM cf_agents_session_messages")
					.toArray(),
			).toEqual(before);
			expect(await state.storage.get("think-accounting:run")).toEqual(
				checkpoint,
			);
			expect(
				state.storage.sql
					.exec<{ record: string }>(
						"SELECT record FROM pi_cutover_checkpoints WHERE id=?",
						"think-accounting:run",
					)
					.toArray()[0]?.record,
			).toBe(JSON.stringify(checkpoint));
			expect(await state.storage.get("pi-accounting:run")).toBeUndefined();

			const displays = await state.storage.list({ prefix: "pi-ui-entry:" });
			const displayKey = [...displays.keys()][0]!;
			await state.storage.put(displayKey, { private: "tampered" });
			await expect(
				operator.release({
					operationId: "migration",
					generation: held.generation,
					sourceHash: plan.sourceHash,
					evidence: EVIDENCE,
				}),
			).rejects.toThrow(/destination changed/);
			expect(admission.read()?.state).toBe("held");
			await state.storage.put(displayKey, displays.get(displayKey));
			const released = await operator.release({
				operationId: "migration",
				generation: held.generation,
				sourceHash: plan.sourceHash,
				evidence: EVIDENCE,
			});
			expect(released.state).toBe("active");
			admission.quarantine({
				operationId: "later",
				expectedGeneration: released.generation,
				reason: "later conflict",
			});
			await expect(
				operator.release({
					operationId: "migration",
					generation: held.generation,
					sourceHash: plan.sourceHash,
					evidence: EVIDENCE,
				}),
			).rejects.toThrow(/release epoch changed/);
			expect(admission.read()?.state).toBe("quarantined");
			await expect(
				operator.apply({
					operationId: "migration",
					generation: held.generation,
					sourceHash: plan.sourceHash,
				}),
			).rejects.toThrow(/writer exclusion/);
		});
	});
	it("denies boundary authority, live claims, source changes and unresolved native tasks", async () => {
		await runInDurableObject(fixture(), async (_agent, state) => {
			seed(state.storage);
			const owner = { ...OWNER, objectId: state.id.toString() };
			const admission = new RuntimeAdmission(state.storage, owner, () => ({
				owner,
				digest: EVIDENCE,
				complete: true,
				unknown: 0,
				nonterminal: 0,
			}));
			const denied = new PiCutoverOperator(
				state.storage,
				admission,
				() => {
					throw new Error("unauthorized");
				},
				(run) => state.blockConcurrencyWhile(run),
			);
			await expect(denied.inspect({ offset: 0, limit: 1 })).rejects.toThrow(
				/unauthorized/,
			);
			admission.initialize({
				operationId: "baseline",
				state: "active",
				evidence: EVIDENCE,
			});
			admission.beginTurn({
				turnId: "healthy",
				requestHash: EVIDENCE,
				expectedGeneration: 1,
			});
			const operator = new PiCutoverOperator(
				state.storage,
				admission,
				() => {},
				(run) => state.blockConcurrencyWhile(run),
			);
			const plan = await planPiTranscriptCutover(state.storage, OWNER);
			await expect(
				operator.prepareCutover({
					operationId: "blocked",
					expectedGeneration: 1,
					sourceHash: plan.sourceHash,
					evidence: EVIDENCE,
				}),
			).rejects.toThrow(/unresolved accepted claim/);
			expect(admission.read()?.state).toBe("active");
			await expect(
				operator.prepareCutover({
					operationId: "changed",
					expectedGeneration: 1,
					sourceHash: "f".repeat(64),
					evidence: EVIDENCE,
				}),
			).rejects.toThrow(/source changed/);
			state.storage.sql.exec("CREATE TABLE pi_tasks (record TEXT,status TEXT)");
			state.storage.sql.exec(
				"INSERT INTO pi_tasks VALUES (?, 'pending')",
				JSON.stringify({ state: { status: "pending" } }),
			);
			await expect(
				operator.prepareCutover({
					operationId: "native",
					expectedGeneration: 1,
					sourceHash: plan.sourceHash,
					evidence: EVIDENCE,
				}),
			).rejects.toThrow(/unresolved native work/);
		});
	});
	it("rejects a conflicting checkpoint destination before native graph writes", async () => {
		await runInDurableObject(fixture(), async (_agent, state) => {
			seed(state.storage);
			await state.storage.put("think-accounting:run", {
				version: 1,
				runId: "run",
				attempts: [],
				fault: null,
			});
			const owner = { ...OWNER, objectId: state.id.toString() };
			const admission = new RuntimeAdmission(state.storage, owner, () => ({
				owner,
				digest: EVIDENCE,
				complete: true,
				unknown: 0,
				nonterminal: 0,
			}));
			admission.initialize({
				operationId: "baseline",
				state: "active",
				evidence: EVIDENCE,
			});
			const operator = new PiCutoverOperator(
				state.storage,
				admission,
				() => {},
				(run) => state.blockConcurrencyWhile(run),
			);
			const plan = await planPiTranscriptCutover(state.storage, OWNER);
			const held = await operator.prepareCutover({
				operationId: "migration",
				expectedGeneration: 1,
				sourceHash: plan.sourceHash,
				evidence: EVIDENCE,
			});
			state.storage.sql.exec(
				"INSERT INTO pi_cutover_checkpoints VALUES ('think-accounting:run','PRIVATE-conflicting-destination')",
			);
			await expect(
				operator.apply({
					operationId: "migration",
					generation: held.generation,
					sourceHash: plan.sourceHash,
				}),
			).rejects.toThrow(/checkpoint destination conflict/);
			expect(
				state.storage.sql
					.exec("SELECT name FROM sqlite_master WHERE name='pi_entries'")
					.toArray(),
			).toEqual([]);
			expect(admission.read()?.state).toBe("held");
		});
	});
});

describe("explicit accounting prefix transfer", () => {
	it("atomically copies exact acknowledged journals, retains archives and verifies release after eviction", async () => {
		const stub = fixture();
		const receipt = await runInDurableObject(stub, async (_agent, state) => {
			seed(state.storage);
			const owner = { ...OWNER, objectId: state.id.toString() };
			const admission = new RuntimeAdmission(state.storage, owner, () => ({
				owner,
				digest: EVIDENCE,
				complete: true,
				unknown: 0,
				nonterminal: 0,
			}));
			admission.initialize({
				operationId: "baseline",
				state: "active",
				evidence: EVIDENCE,
			});
			const operator = new PiCutoverOperator(
				state.storage,
				admission,
				() => {},
				(run) => state.blockConcurrencyWhile(run),
			);
			const checkpoint = {
				version: 1,
				runId: "run",
				fault: null,
				attempts: [
					{
						id: "attempt",
						phase: "completed",
						acknowledged: true,
						effectsStarted: true,
						effectsSealed: true,
						usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
					},
				],
			};
			await state.storage.put("think-accounting:run", checkpoint);
			await state.storage.put("pi-accounting:run", checkpoint);
			const plan = await planPiTranscriptCutover(state.storage, OWNER);
			const held = await operator.prepareCutover({
				operationId: "transfer",
				expectedGeneration: 1,
				sourceHash: plan.sourceHash,
				evidence: EVIDENCE,
			});
			await operator.apply({
				operationId: "transfer",
				generation: held.generation,
				sourceHash: plan.sourceHash,
			});
			const input = {
				operationId: "transfer",
				generation: held.generation,
				sourceHash: plan.sourceHash,
			};
			const inspected = await operator.inspectAccounting(input);
			expect(JSON.stringify(inspected)).not.toContain("attempt");
			expect(inspected.legacyCount).toBe(1);
			expect(inspected.nativeCount).toBe(1);
			await expect(
				operator.transferAccounting({
					...input,
					accountingManifestHash: "0".repeat(64),
				}),
			).rejects.toThrow(/manifest changed/);
			expect(await state.storage.get("think-accounting:run")).toEqual(
				checkpoint,
			);
			expect(await state.storage.get("pi-accounting:run")).toEqual(checkpoint);
			const transferred = await operator.transferAccounting({
				...input,
				accountingManifestHash: inspected.accountingManifestHash,
			});
			expect(await state.storage.get("think-accounting:run")).toBeUndefined();
			expect(await state.storage.get("pi-accounting:run")).toEqual(checkpoint);
			expect(
				state.storage.sql
					.exec<{ record: string }>(
						"SELECT record FROM pi_cutover_checkpoints WHERE id='think-accounting:run'",
					)
					.toArray()[0]?.record,
			).toBe(JSON.stringify(checkpoint));
			expect(transferred.preSourceHash).toBe(plan.sourceHash);
			expect(transferred.postSourceHash).not.toBe(plan.sourceHash);
			expect(
				(await planPiTranscriptCutover(state.storage, OWNER)).sourceHash,
			).toBe(transferred.postSourceHash);
			await expect(
				operator.transferAccounting({
					...input,
					accountingManifestHash: "1".repeat(64),
				}),
			).rejects.toThrow(/transfer conflict/);
			return {
				...input,
				accountingManifestHash: inspected.accountingManifestHash,
				transferred,
				checkpoint,
			};
		});
		await (await import("cloudflare:test")).evictDurableObject(stub);
		await runInDurableObject(stub, async (_agent, state) => {
			const owner = { ...OWNER, objectId: state.id.toString() };
			const admission = new RuntimeAdmission(state.storage, owner, () => ({
				owner,
				digest: EVIDENCE,
				complete: true,
				unknown: 0,
				nonterminal: 0,
			}));
			const operator = new PiCutoverOperator(
				state.storage,
				admission,
				() => {},
				(run) => state.blockConcurrencyWhile(run),
			);
			expect(await operator.transferAccounting(receipt)).toEqual(
				receipt.transferred,
			);
			await state.storage.put("pi-accounting:run", {
				...receipt.checkpoint,
				fault: "tampered",
			});
			await expect(
				operator.release({ ...receipt, evidence: EVIDENCE }),
			).rejects.toThrow(/accounting changed/);
			expect(admission.read()?.state).toBe("held");
			await state.storage.put("pi-accounting:run", receipt.checkpoint);
			const archive = state.storage.sql
				.exec<{ record: string }>(
					"SELECT record FROM pi_cutover_checkpoints WHERE id='think-accounting:run'",
				)
				.toArray()[0]!.record;
			state.storage.sql.exec(
				"UPDATE pi_cutover_checkpoints SET record=? WHERE id='think-accounting:run'",
				JSON.stringify({ ...receipt.checkpoint, fault: "archive tampered" }),
			);
			await expect(
				operator.release({ ...receipt, evidence: EVIDENCE }),
			).rejects.toThrow(/accounting archive changed/);
			state.storage.sql.exec(
				"UPDATE pi_cutover_checkpoints SET record=? WHERE id='think-accounting:run'",
				archive,
			);

			expect(
				(await operator.release({ ...receipt, evidence: EVIDENCE })).state,
			).toBe("active");
		});
	});
	it("rejects conflicting destinations and unresolved effects without partial prefix writes", async () => {
		await runInDurableObject(fixture(), async (_agent, state) => {
			seed(state.storage);
			const owner = { ...OWNER, objectId: state.id.toString() };
			const admission = new RuntimeAdmission(state.storage, owner, () => ({
				owner,
				digest: EVIDENCE,
				complete: true,
				unknown: 0,
				nonterminal: 0,
			}));
			admission.initialize({
				operationId: "baseline",
				state: "active",
				evidence: EVIDENCE,
			});
			const operator = new PiCutoverOperator(
				state.storage,
				admission,
				() => {},
				(run) => state.blockConcurrencyWhile(run),
			);
			const checkpoint = {
				version: 1,
				runId: "run",
				fault: null,
				attempts: [],
			};
			await state.storage.put("think-accounting:run", checkpoint);
			await state.storage.put("pi-accounting:run", {
				...checkpoint,
				extra: "conflict",
			});
			const plan = await planPiTranscriptCutover(state.storage, OWNER);
			const held = await operator.prepareCutover({
				operationId: "conflict",
				expectedGeneration: 1,
				sourceHash: plan.sourceHash,
				evidence: EVIDENCE,
			});
			await operator.apply({
				operationId: "conflict",
				generation: held.generation,
				sourceHash: plan.sourceHash,
			});
			const input = {
				operationId: "conflict",
				generation: held.generation,
				sourceHash: plan.sourceHash,
			};
			await expect(operator.inspectAccounting(input)).rejects.toThrow(
				/destination conflict/,
			);
			expect(await state.storage.get("think-accounting:run")).toEqual(
				checkpoint,
			);
			expect(await state.storage.get("pi-accounting:run")).toEqual({
				...checkpoint,
				extra: "conflict",
			});
			await state.storage.put("think-accounting:run", {
				...checkpoint,
				attempts: [
					{
						id: "pending",
						phase: "started",
						acknowledged: false,
						effectsStarted: true,
						effectsSealed: false,
						usage: null,
					},
				],
			});
			await expect(
				operator.transferAccounting({
					...input,
					accountingManifestHash: "2".repeat(64),
				}),
			).rejects.toThrow(/unresolved accounting effects/);
			expect(await state.storage.get("pi-accounting:run")).toEqual({
				...checkpoint,
				extra: "conflict",
			});
		});
	});
});

describe("accounting transfer atomic failure", () => {
	it("rolls back every native prefix write and receipt when the second copy is interrupted", async () => {
		await runInDurableObject(fixture(), async (_agent, state) => {
			seed(state.storage);
			const owner = { ...OWNER, objectId: state.id.toString() };
			const admission = new RuntimeAdmission(state.storage, owner, () => ({
				owner,
				digest: EVIDENCE,
				complete: true,
				unknown: 0,
				nonterminal: 0,
			}));
			admission.initialize({
				operationId: "baseline",
				state: "active",
				evidence: EVIDENCE,
			});
			const create = (storage: DurableObjectStorage) =>
				new PiCutoverOperator(
					storage,
					admission,
					() => {},
					(run) => state.blockConcurrencyWhile(run),
				);
			const operator = create(state.storage);
			for (const runId of ["a", "b"])
				await state.storage.put(`think-accounting:${runId}`, {
					version: 1,
					runId,
					fault: null,
					attempts: [],
				});
			const plan = await planPiTranscriptCutover(state.storage, OWNER);
			const held = await operator.prepareCutover({
				operationId: "atomic",
				expectedGeneration: 1,
				sourceHash: plan.sourceHash,
				evidence: EVIDENCE,
			});
			await operator.apply({
				operationId: "atomic",
				generation: held.generation,
				sourceHash: plan.sourceHash,
			});
			const input = {
				operationId: "atomic",
				generation: held.generation,
				sourceHash: plan.sourceHash,
			};
			const manifest = await operator.inspectAccounting(input);
			let writes = 0;
			const faultyKv = new Proxy(state.storage.kv, {
				get(target, key) {
					const value = Reflect.get(target, key, target);
					if (key === "put")
						return (name: string, data: unknown) => {
							if (++writes === 2)
								throw new Error("interrupted second native copy");
							return target.put(name, data);
						};
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const faultyStorage = new Proxy(state.storage, {
				get(target, key) {
					if (key === "kv") return faultyKv;
					const value = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			await expect(
				create(faultyStorage).transferAccounting({
					...input,
					accountingManifestHash: manifest.accountingManifestHash,
				}),
			).rejects.toThrow(/interrupted second native copy/);
			expect(
				(await state.storage.list({ prefix: "pi-accounting:" })).size,
			).toBe(0);
			expect(
				(await state.storage.list({ prefix: "think-accounting:" })).size,
			).toBe(2);
			expect(
				(await operator.inspectAccounting(input)).accountingManifestHash,
			).toBe(manifest.accountingManifestHash);
			const receipt = await operator.transferAccounting({
				...input,
				accountingManifestHash: manifest.accountingManifestHash,
			});
			expect(receipt.legacyCount).toBe(2);
			expect(
				(await state.storage.list({ prefix: "think-accounting:" })).size,
			).toBe(0);
			expect(
				(await state.storage.list({ prefix: "pi-accounting:" })).size,
			).toBe(2);
		});
	});
});

describe("authenticated stored cutover operator boundary", () => {
	it("quarantines finite unknown custody without owner inference, survives rejection and exposes no payload", async () => {
		await runInDurableObject(fixture(), async (_agent, state) => {
			const { operateStoredCutover } =
				await import("../../src/pi-cutover-admin");
			const id = state.id.toString();
			const localEnv = {
				...env,
				SECRETS_MASTER_KEY: "operator-token",
				PI_CUTOVER_KNOWN_PARENT_IDS: JSON.stringify([id]),
			} as Cloudflare.Env;
			const command = {
				command: "quarantine",
				objectId: id,
				operationId: "unknown-custody",
				expectedGeneration: 0,
				reasonCode: "unknown_owner",
				custody: null,
			};
			const request = (body: unknown, token = "operator-token") =>
				new Request("https://fixture/__admin/pi-state-cutover", {
					method: "POST",
					headers: { "X-Tedix-Admin-Token": token },
					body: JSON.stringify(body),
				});
			expect(
				(
					await operateStoredCutover({
						ctx: state,
						env: localEnv,
						request: request(command, "wrong"),
					})
				).status,
			).toBe(403);
			const response = await operateStoredCutover({
				ctx: state,
				env: localEnv,
				request: request(command),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				ok: true,
				id,
				command: "quarantine",
				operationId: "unknown-custody",
				generation: 1,
				state: "quarantined",
			});
			const rejected = await operateStoredCutover({
				ctx: state,
				env: localEnv,
				request: request({
					...command,
					operationId: "bad",
					expectedGeneration: 1,
					command: "apply",
					sourceHash: "a".repeat(64),
					private: "CUSTOMER-CONTENT",
				}),
			});
			expect(rejected.status).toBe(400);
			expect(await rejected.text()).not.toContain("CUSTOMER-CONTENT");
			const stored = state.storage.sql
				.exec<{ record: string }>(
					"SELECT record FROM runtime_admission WHERE id=1",
				)
				.toArray()[0]!;
			expect(JSON.parse(stored.record).owner).toEqual({
				tediId: null,
				orgId: null,
				objectId: id,
			});
			expect(JSON.parse(stored.record).state).toBe("quarantined");
			expect(
				(
					await operateStoredCutover({
						ctx: state,
						env: localEnv,
						request: new Request("https://fixture/__admin/pi-state-cutover", {
							headers: { "X-Tedix-Admin-Token": "operator-token" },
						}),
					})
				).status,
			).toBe(200);
		});
	});
});

it("canonical D1 owner bootstraps directly into held custody, retries current receipt, and rejects stale history", async () => {
	await runInDurableObject(fixture(), async (_agent, state) => {
		const { operateStoredCutover } = await import("../../src/pi-cutover-admin");
		const owner = {
			tediId: "00000000-0000-4000-8000-000000000002",
			orgId: "00000000-0000-4000-8000-000000000003",
		};
		seed(state.storage);
		state.storage.sql.exec(
			"UPDATE cf_agents_state SET state=? WHERE id='cf_state_row_id'",
			JSON.stringify(owner),
		);
		const id = state.id.toString(),
			objectName = "canonical-fixture";
		const db = {
			prepare: (sql: string) => ({
				bind: () => ({
					first: async () =>
						sql.includes("SELECT isolate_agent_id")
							? { isolateAgentId: objectName }
							: {
									id: owner.tediId,
									orgId: owner.orgId,
									slug: "fixture",
									isolateAgentId: objectName,
								},
				}),
			}),
		};
		const localEnv = {
			...env,
			DB: db,
			TEDI_AGENT: {
				idFromName: (name: string) => {
					if (name !== objectName) throw new Error("Unknown name");
					return state.id;
				},
			},
			SECRETS_MASTER_KEY: "operator-token",
			PI_CUTOVER_KNOWN_PARENT_IDS: JSON.stringify([id]),
		} as unknown as Cloudflare.Env;
		const base = {
			objectId: id,
			operationId: "canonical-migration",
			custody: { ...owner, objectName },
		};
		const send = (command: Record<string, unknown>) =>
			operateStoredCutover({
				ctx: state,
				env: localEnv,
				request: new Request("https://fixture/__admin/pi-state-cutover", {
					method: "POST",
					headers: { "X-Tedix-Admin-Token": "operator-token" },
					body: JSON.stringify({ ...base, ...command }),
				}),
			});
		const planResponse = await send({
			command: "plan",
			expectedGeneration: 0,
			verificationAction: "initialize",
		});
		expect(planResponse.status).toBe(200);
		const plan = (await planResponse.json()) as {
			sourceHash: string;
			evidenceHash: string;
		};
		const prepare = {
			command: "bootstrap_prepare",
			expectedGeneration: 0,
			sourceHash: plan.sourceHash,
			evidenceHash: plan.evidenceHash,
		};
		expect(
			(await send({ ...prepare, sourceHash: "f".repeat(64) })).status,
		).toBe(409);
		expect(
			state.storage.sql
				.exec("SELECT name FROM sqlite_master WHERE name='runtime_admission'")
				.toArray(),
		).toHaveLength(0);
		const held = await send(prepare);
		expect(held.status).toBe(200);
		expect(await held.json()).toMatchObject({
			id,
			generation: 2,
			state: "held",
			sourceHash: plan.sourceHash,
		});
		expect((await send(prepare)).status).toBe(200);
		const applied = await send({
			command: "apply",
			expectedGeneration: 2,
			sourceHash: plan.sourceHash,
		});
		expect(applied.status).toBe(200);
		expect(await applied.json()).toMatchObject({
			id,
			generation: 2,
			state: "held",
			entries: 1,
		});
		const releaseProof = await send({
			command: "plan",
			operationId: "release-proof",
			expectedGeneration: 2,
			verificationAction: "release",
		});
		expect(releaseProof.status).toBe(200);
		const releasePlan = (await releaseProof.json()) as {
			sourceHash: string;
			evidenceHash: string;
		};
		const released = await send({
			command: "release",
			expectedGeneration: 2,
			sourceHash: releasePlan.sourceHash,
			evidenceHash: releasePlan.evidenceHash,
		});
		expect(released.status).toBe(200);
		expect(await released.json()).toMatchObject({
			id,
			generation: 3,
			state: "active",
		});
		expect(
			(
				await send({
					command: "quarantine",
					operationId: "operator-stop",
					expectedGeneration: 3,
					reasonCode: "operator_hold",
				})
			).status,
		).toBe(200);
		expect((await send(prepare)).status).toBe(409);
	});
});

it("untracked native work denies plan and never installs an active baseline", async () => {
	await runInDurableObject(fixture(), async (_agent, state) => {
		const { operateStoredCutover } = await import("../../src/pi-cutover-admin");
		const owner = {
			tediId: "00000000-0000-4000-8000-000000000002",
			orgId: "00000000-0000-4000-8000-000000000003",
		};
		seed(state.storage);
		state.storage.sql.exec(
			"UPDATE cf_agents_state SET state=?",
			JSON.stringify(owner),
		);
		state.storage.sql.exec(
			"CREATE TABLE unknown_tasks(id TEXT,status TEXT,record TEXT)",
		);
		state.storage.sql.exec(
			"INSERT INTO unknown_tasks VALUES('pending','running',?)",
			JSON.stringify({ state: { status: "running" }, input: "PRIVATE TASK" }),
		);
		const id = state.id.toString(),
			objectName = "canonical-fixture";
		const db = {
			prepare: (sql: string) => ({
				bind: () => ({
					first: async () =>
						sql.includes("SELECT isolate_agent_id")
							? { isolateAgentId: objectName }
							: { id: owner.tediId, orgId: owner.orgId, slug: "fixture" },
				}),
			}),
		};
		const localEnv = {
			...env,
			DB: db,
			TEDI_AGENT: { idFromName: () => state.id },
			SECRETS_MASTER_KEY: "operator-token",
			PI_CUTOVER_KNOWN_PARENT_IDS: JSON.stringify([id]),
		} as unknown as Cloudflare.Env;
		const response = await operateStoredCutover({
			ctx: state,
			env: localEnv,
			request: new Request("https://fixture/__admin/pi-state-cutover", {
				method: "POST",
				headers: { "X-Tedix-Admin-Token": "operator-token" },
				body: JSON.stringify({
					command: "plan",
					objectId: id,
					operationId: "deny-untracked",
					expectedGeneration: 0,
					verificationAction: "initialize",
					custody: { ...owner, objectName },
				}),
			}),
		});
		expect(response.status).toBe(409);
		expect(await response.text()).not.toContain("PRIVATE TASK");
		expect(
			state.storage.sql
				.exec("SELECT name FROM sqlite_master WHERE name='runtime_admission'")
				.toArray(),
		).toHaveLength(0);
	});
});

it("selects the SDK primary session graph atomically and rejects pointer tampering before release", async () => {
	const { Lifecycle } = await import("agents/lifecycle");
	const { Sessions } = await import("agents/sessions");
	await runInDurableObject(fixture(), async (agent, state) => {
		state.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS cf_agents_state (id TEXT PRIMARY KEY,state TEXT)",
		);
		state.storage.sql.exec(
			"INSERT OR REPLACE INTO cf_agents_state VALUES ('cf_state_row_id',?)",
			JSON.stringify(OWNER),
		);
		const sdk = new Sessions();
		new Lifecycle(agent).use(sdk);
		await sdk.session().appendMessage({
			id: "primary-root",
			role: "user",
			parts: [{ type: "text", text: "primary root" }],
		});
		await sdk.session().appendMessage({
			id: "primary-latest",
			role: "assistant",
			parts: [{ type: "text", text: "primary answer" }],
		});
		await sdk.session("named").appendMessage({
			id: "named-root",
			role: "user",
			parts: [{ type: "text", text: "named retained" }],
		});
		const sdkHistory = [];
		for await (const message of sdk.session().history())
			sdkHistory.push(message.id);
		expect(sdkHistory).toEqual(["primary-root", "primary-latest"]);
		state.storage.kv.put("cf_agents_is_facet", true);
		const admission = new RuntimeAdmission(
			state.storage,
			{ ...OWNER, objectId: state.id.toString() },
			() => ({
				owner: { ...OWNER, objectId: state.id.toString() },
				digest: EVIDENCE,
				complete: true,
				unknown: 0,
				nonterminal: 0,
			}),
		);
		admission.initialize({
			operationId: "activation-init",
			state: "active",
			evidence: EVIDENCE,
		});
		const operator = new PiCutoverOperator(
			state.storage,
			admission,
			() => undefined,
			async (run) => run(),
		);
		const plan = await planPiTranscriptCutover(state.storage, OWNER);
		expect(plan.sessions.find((session) => session.id === "")?.activeLeaf).toBe(
			"primary-latest",
		);
		const held = await operator.prepareCutover({
			operationId: "activation",
			expectedGeneration: 1,
			sourceHash: plan.sourceHash,
			evidence: EVIDENCE,
		});
		await operator.apply({
			operationId: "activation",
			generation: held.generation,
			sourceHash: plan.sourceHash,
		});
		const mapping = state.storage.kv.get<{
			hash: string;
			selectedSessionId: string;
			conversationId: number;
			sessions: Record<string, { activeLeaf: string; conversationId: number }>;
		}>("pi-cutover-active-graph:v1")!;
		expect(mapping.selectedSessionId).toBe("");
		expect(mapping.sessions[""]?.activeLeaf).toBe("primary-latest");
		expect(mapping.sessions.named?.activeLeaf).toBe("named-root");
		expect(mapping.hash).toHaveLength(64);
		expect(state.storage.kv.get("pi-active-conversation-id:v1")).toBe(
			mapping.sessions[""]!.conversationId,
		);
		expect(state.storage.kv.get("pi:legacy-imported:v1")).toBeUndefined();
		expect(admission.read()?.state).toBe("held");
		state.storage.kv.put(
			"pi-active-conversation-id:v1",
			mapping.sessions.named!.conversationId,
		);
		await expect(
			operator.release({
				operationId: "activation",
				generation: held.generation,
				sourceHash: plan.sourceHash,
				evidence: EVIDENCE,
			}),
		).rejects.toThrow(/destination changed/);
		expect(admission.read()?.state).toBe("held");
		state.storage.kv.put(
			"pi-active-conversation-id:v1",
			mapping.conversationId,
		);
		expect(
			(
				await operator.release({
					operationId: "activation",
					generation: held.generation,
					sourceHash: plan.sourceHash,
					evidence: EVIDENCE,
				})
			).state,
		).toBe("active");
	});
});

it("denies named-only private graph selection before native writes and rejects an unknown original pointer", async () => {
	await runInDurableObject(fixture(), async (_agent, state) => {
		seed(state.storage);
		state.storage.sql.exec(
			"UPDATE cf_agents_session_messages SET session_id='named-only'",
		);
		state.storage.kv.put("cf_agents_is_facet", true);
		const owner = { ...OWNER, objectId: state.id.toString() };
		const admission = new RuntimeAdmission(state.storage, owner, () => ({
			owner,
			digest: EVIDENCE,
			complete: true,
			unknown: 0,
			nonterminal: 0,
		}));
		admission.initialize({
			operationId: "named-only-init",
			state: "active",
			evidence: EVIDENCE,
		});
		const operator = new PiCutoverOperator(
			state.storage,
			admission,
			() => undefined,
			async (run) => run(),
		);
		const plan = await planPiTranscriptCutover(state.storage, OWNER);
		const held = await operator.prepareCutover({
			operationId: "named-only",
			expectedGeneration: 1,
			sourceHash: plan.sourceHash,
			evidence: EVIDENCE,
		});
		const before = state.storage.sql
			.exec(
				"SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name GLOB 'pi_*' ORDER BY name",
			)
			.toArray();
		await expect(
			operator.apply({
				operationId: "named-only",
				generation: held.generation,
				sourceHash: plan.sourceHash,
			}),
		).rejects.toThrow(/default session/);
		expect(
			state.storage.sql
				.exec(
					"SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name GLOB 'pi_*' ORDER BY name",
				)
				.toArray(),
		).toEqual(before);
		expect(
			state.storage.kv.get("pi-active-conversation-id:v1"),
		).toBeUndefined();
		expect(state.storage.kv.get("pi-cutover-active-graph:v1")).toBeUndefined();
		state.storage.kv.put("pi-active-conversation-id:v1", 999999);
		await expect(planPiTranscriptCutover(state.storage, OWNER)).rejects.toThrow(
			/active pointer/,
		);
		expect(admission.read()?.state).toBe("held");
	});
});

it.each([
	"acknowledged",
	"active-ack",
	"unknown",
	"held-before-delete",
	"cancel-upload",
	"kind-last-upload",
	"intent-last-upload",
] as const)(
	"actual parent image ports retain independent original cleanup authority: %s",
	async (mode) => {
		await runInDurableObject(fixture(), async (_agent, ctx) => {
			seed(ctx.storage);
			const admission = new RuntimeAdmissionDO(ctx.storage, {
				...OWNER,
				objectId: ctx.id.toString(),
			});
			admission.gate.initialize({
				operationId: "baseline",
				state: "active",
				evidence: await admission.prepareEvidence("initialize"),
			});
			await admission.beginAcceptedTurn({
				runId: "image-run",
				sessionKey: "actual-session",
				principalId: "original-principal",
				input: { text: "accepted" },
				expectedGeneration: 1,
			});
			if (mode === "acknowledged" || mode === "active-ack")
				await admission.beginAcceptedTurn({
					runId: "image-child",
					sessionKey: "actual-session",
					principalId: "original-principal",
					input: { parentRunId: "image-run", actual: "owned child operation" },
					expectedGeneration: 1,
				});
			const parent = admittedTediDo(ctx, OWNER);
			const objects = new Map<string, string>();
			let writes = 0,
				deletes = 0;
			parent.env = {
				TEDI_STORAGE: {
					get: async (key: string) =>
						objects.has(key) ? { text: async () => objects.get(key) } : null,
					put: async (key: string, body: string) => {
						const row = await ctx.storage.get<any>(
							"workflow-image-cleanup:image-run",
						);
						expect(row.authority.runId).not.toBe("image-run");
						expect(
							(await admission.lookupAcceptedTurn(row.authority.runId))
								.principalId,
						).toBe("original-principal");
						objects.set(key, body);
						writes++;
						if (mode === "cancel-upload")
							ctx.storage.kv.put("wfcancel:image-run", true);
						return {};
					},
					list: async () => {
						if (mode === "held-before-delete")
							admission.gate.quarantine({
								operationId: "hold-list-boundary",
								expectedGeneration: 1,
								reason: "test hold",
							});
						return {
							objects: [...objects.keys()].map((key) => ({ key })),
							truncated: false,
						};
					},
					delete: async (keys: string[]) => {
						deletes++;
						if (mode === "unknown") throw new Error("unknown external ACK");
						for (const key of keys) objects.delete(key);
						if (mode === "acknowledged")
							admission.gate.quarantine({
								operationId: "hold-after-real-scripted-ACK",
								expectedGeneration: 1,
								reason: "test hold",
							});
					},
				},
				CHAT_TURN_WORKFLOW: {
					get: async () => ({ status: async () => ({ status: "complete" }) }),
				},
			};
			const image = {
				kind: "base64",
				data: "aGVsbG8=",
				mediaType: "image/png",
				fileName: "actual.png",
			};
			await expect(
				parent.prepareWorkflowImages(
					"unaccepted",
					"unknown-workflow",
					[image],
					"actual-session",
				),
			).rejects.toThrow();
			expect(writes).toBe(0);

			if (mode === "kind-last-upload" || mode === "intent-last-upload") {
				const actualAdmission = parent.runtimeAdmission.bind(parent);
				parent.runtimeAdmission = () => {
					const actual = actualAdmission();
					const verify = actual.assertAcceptedTurn.bind(actual);
					actual.assertAcceptedTurn = async (input: any) => {
						const accepted = await verify(input);
						const row = ctx.storage.kv.get<any>(
							"workflow-image-cleanup:image-run",
						);
						if (input.runId === "image-run" && input.inputHash && row)
							ctx.storage.kv.put("workflow-image-cleanup:image-run", {
								...row,
								[mode === "kind-last-upload" ? "kind" : "intent"]: "tampered",
							});
						return accepted;
					};
					return actual;
				};
				await expect(
					parent.prepareWorkflowImages(
						"image-run",
						"actual-workflow",
						[image],
						"actual-session",
					),
				).rejects.toThrow();
				expect(writes).toBe(0);
				expect(deletes).toBe(0);
				return;
			}
			if (mode === "cancel-upload") {
				await expect(
					parent.prepareWorkflowImages(
						"image-run",
						"actual-workflow",
						[image],
						"actual-session",
					),
				).rejects.toThrow("canceled");
				expect(writes).toBe(1);
				expect(ctx.storage.kv.get("wfcancel:image-run")).toBe(true);
				expect(
					await parent.imageCleanupJournal().terminal({
						runId: "image-run",
						workflowInstanceId: "actual-workflow",
						intent: "cancelled",
					}),
				).toBe("cleaned");
				expect(deletes).toBe(1);
				return;
			}
			const refs = await parent.prepareWorkflowImages(
				"image-run",
				"actual-workflow",
				[image],
				"actual-session",
			);
			expect(writes).toBeGreaterThan(0);

			await expect(
				parent.prepareWorkflowImages(
					"image-run",
					"actual-workflow",
					[image],
					"wrong-session",
				),
			).rejects.toThrow();
			const journal = parent.imageCleanupJournal();
			expect(
				await journal.terminal({
					runId: "image-run",
					workflowInstanceId: "actual-workflow",
					intent: "terminal",
				}),
			).toBe(
				mode === "acknowledged" || mode === "active-ack" ? "cleaned" : "failed",
			);
			const row = await ctx.storage.get<any>(
				"workflow-image-cleanup:image-run",
			);
			expect(row.refs).toEqual(refs);
			if (mode === "acknowledged" || mode === "active-ack") {
				expect(row.page.stage).toBe("acknowledged");
				expect(row.completed).toBe(true);
				expect(admission.read()?.state).toBe(
					mode === "acknowledged" ? "quarantined" : "active",
				);
				expect(admission.gate.claim(row.authority.runId)?.status).toBe(
					"completed",
				);
				expect(deletes).toBe(1);
				expect(await journal.redrive()).toMatchObject({ failed: 0 });

				// Independent cleanup completed while its retained row was not yet marked completed.
				// Its verified final facts then permit the original accepted chat claim to settle while inactive.
				await parent.completeRuntimeTurn(
					"image-child",
					"scripted-owned-child-answer",
					{ text: "actual scripted owned child answer" },
				);
				await parent.completeRuntimeTurn(
					"image-run",
					"scripted-owned-chat-answer",
					{ text: "actual scripted owned answer" },
				);
				await parent.completeRuntimeTurn(
					"image-run",
					"scripted-owned-chat-answer",
					{ text: "actual scripted owned answer" },
				);
				await parent.completeRuntimeTurn(
					"image-child",
					"scripted-owned-child-answer",
					{ text: "actual scripted owned child answer" },
				);
				expect(deletes).toBe(1);

				await admission.prepareEvidence("hold");
				if (mode === "active-ack") {
					admission.gate.hold({
						operationId: "verified-cleanup-hold",
						expectedGeneration: 1,
						evidence: await admission.prepareEvidence("hold"),
					});
					expect(admission.read()?.state).toBe("held");
					await admission.prepareEvidence("hold");
				}

				const key = "workflow-image-cleanup:image-run";
				for (const mutate of [
					(r: any) => {
						r.tediId = "wrong-owner";
					},
					(r: any) => {
						r.authority.generation++;
					},
					(r: any) => {
						r.authority.requestHash = "a".repeat(64);
					},
					(r: any) => {
						r.sessionKey = "modified-input";
					},
					(r: any) => {
						r.refs[0].key = "foreign-ref";
					},
					(r: any) => {
						r.page.stage = "issued";
					},
					(r: any) => {
						r.page.keys.push("foreign-ACK");
					},
					(r: any) => {
						r.page.truncated = true;
					},
					(r: any) => {
						r.completed = false;
					},
				]) {
					const changed = structuredClone(row);
					mutate(changed);
					ctx.storage.kv.put(key, changed);
					await expect(admission.prepareEvidence("hold")).rejects.toThrow();
					ctx.storage.kv.put(key, row);
				}
				const identity = ctx.storage.sql
					.exec<{ input: string }>(
						"SELECT input FROM runtime_admission_identities WHERE run_id=?",
						row.authority.runId,
					)
					.toArray()[0]!;
				ctx.storage.sql.exec(
					"UPDATE runtime_admission_identities SET input=? WHERE run_id=?",
					JSON.stringify({ corrupt: "input" }),
					row.authority.runId,
				);
				await expect(admission.prepareEvidence("hold")).rejects.toThrow();
				ctx.storage.sql.exec(
					"UPDATE runtime_admission_identities SET input=? WHERE run_id=?",
					identity.input,
					row.authority.runId,
				);

				const originalIdentity = ctx.storage.sql
					.exec<{ input: string }>(
						"SELECT input FROM runtime_admission_identities WHERE run_id='image-run'",
					)
					.toArray()[0]!;
				ctx.storage.sql.exec(
					"UPDATE runtime_admission_identities SET input='{}' WHERE run_id='image-run'",
				);
				await expect(admission.prepareEvidence("hold")).rejects.toThrow();
				ctx.storage.sql.exec(
					"UPDATE runtime_admission_identities SET input=? WHERE run_id='image-run'",
					originalIdentity.input,
				);
				const originalReceipt = ctx.storage.sql
					.exec<{ record: string }>(
						"SELECT record FROM runtime_admission_receipts WHERE run_id=?",
						row.authority.runId,
					)
					.toArray()[0]!;
				for (const mutate of [
					(r: any) => {
						r.sourceId = "forged-source";
					},
					(r: any) => {
						r.accepted.principalId = "forged-principal";
					},
					(r: any) => {
						r.receipt.receipt.keys = ["forged-ACK"];
					},
				]) {
					const changed = JSON.parse(originalReceipt.record);
					mutate(changed);
					ctx.storage.sql.exec(
						"UPDATE runtime_admission_receipts SET record=? WHERE run_id=?",
						JSON.stringify(changed),
						row.authority.runId,
					);
					await expect(admission.prepareEvidence("hold")).rejects.toThrow();
					ctx.storage.sql.exec(
						"UPDATE runtime_admission_receipts SET record=? WHERE run_id=?",
						originalReceipt.record,
						row.authority.runId,
					);
				}
				const completion = admission.gate.claim(
					row.authority.runId,
				)!.completion!;
				const evidence = ctx.storage.sql
					.exec<{ snapshot: string }>(
						"SELECT snapshot FROM runtime_admission_evidence WHERE digest=?",
						completion,
					)
					.toArray()[0]!;
				ctx.storage.sql.exec(
					"UPDATE runtime_admission_evidence SET snapshot='{}' WHERE digest=?",
					completion,
				);
				await expect(admission.prepareEvidence("hold")).rejects.toThrow();
				ctx.storage.sql.exec(
					"UPDATE runtime_admission_evidence SET snapshot=? WHERE digest=?",
					evidence.snapshot,
					completion,
				);
				const pending = admission.prepareEvidence("hold");
				const changed = structuredClone(row);
				changed.dispatchRequested = !changed.dispatchRequested;
				ctx.storage.kv.put(key, changed);
				await expect(pending).rejects.toThrow("baseline changed while hashing");
				ctx.storage.kv.put(key, row);
				await admission.prepareEvidence("hold");
				expect(deletes).toBe(1);
			} else {
				expect(row.completed).not.toBe(true);
				expect(admission.gate.claim(row.authority.runId)?.status).toBe(
					"running",
				);
				expect(deletes).toBe(mode === "unknown" ? 1 : 0);
				expect(await journal.redrive()).toMatchObject({ failed: 1 });
				expect(deletes).toBe(mode === "unknown" ? 1 : 0);
			}
		});
	},
);

it.each([
	"healthy",
	"after-put",
	"last-admission",
	"cancel-last-admission",
	"input-last-admission",
] as const)(
	"native permanent-history image upload has its own original turn guard (hold boundary: %s)",
	async (mode) => {
		await runInDurableObject(fixture(), async (_agent, ctx) => {
			seed(ctx.storage);
			const admission = new RuntimeAdmissionDO(ctx.storage, {
				...OWNER,
				objectId: ctx.id.toString(),
			});
			admission.gate.initialize({
				operationId: "baseline",
				state: "active",
				evidence: await admission.prepareEvidence("initialize"),
			});
			await admission.beginAcceptedTurn({
				runId: "native-image",
				sessionKey: "actual-native-session",
				principalId: "native-principal",
				input: { actual: "accepted native input" },
				expectedGeneration: 1,
			});
			const parent = admittedTediDo(ctx, OWNER);
			let asyncOwnerReads = 0;
			const nativeGet = ctx.storage.get.bind(ctx.storage);
			const storage = new Proxy(ctx.storage, {
				get(target, property) {
					if (property === "get")
						return async (key: string) => {
							if (key === "pi-native-image-owner:native-image") {
								asyncOwnerReads++;
								admission.gate.quarantine({
									operationId: "hold-owner-await",
									expectedGeneration: 1,
									reason: "unchanged owner bytes returned after hold",
								});
							}
							return nativeGet(key);
						};
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			parent.ctx = { id: ctx.id, storage };
			const actualAdmission = parent.runtimeAdmission.bind(parent);
			parent.runtimeAdmission = () => {
				const actual = actualAdmission();
				const verify = actual.assertAcceptedTurn.bind(actual);
				actual.assertAcceptedTurn = async (input: any) => {
					const result = await verify(input);
					if (mode === "cancel-last-admission" && input.inputHash)
						ctx.storage.kv.put("wfcancel:native-image", true);
					if (mode === "input-last-admission" && input.inputHash)
						ctx.storage.sql.exec(
							"UPDATE runtime_admission_identities SET input=? WHERE run_id=?",
							JSON.stringify({ changed: "after async verification" }),
							"native-image",
						);
					if (mode === "last-admission" && input.inputHash)
						admission.gate.quarantine({
							operationId: "hold-last-admission",
							expectedGeneration: 1,
							reason: "hold at actual verification boundary",
						});
					return result;
				};
				return actual;
			};

			const { FacetDispatchJournal } =
				await import("../../src/facet-dispatch-journal");
			parent.facetDispatchJournal = new FacetDispatchJournal(ctx.storage);
			let puts = 0,
				deletes = 0;
			const objects = new Map<string, string>();
			parent.env = {
				TEDI_STORAGE: {
					get: async (key: string) =>
						objects.has(key) ? { text: async () => objects.get(key) } : null,
					put: async (key: string, body: string) => {
						puts++;
						objects.set(key, body);
						if (mode === "after-put")
							admission.gate.quarantine({
								operationId: "hold-upload",
								expectedGeneration: 1,
								reason: "scripted boundary hold",
							});
						return {};
					},
					delete: async () => {
						deletes++;
					},
				},
			};
			const promise = parent.prepareNativeConversationImages({
				runId: "native-image",
				operationId: "native-operation",
				sessionKey: "actual-native-session",
				images: [
					{
						kind: "base64",
						data: "aGVsbG8=",
						mediaType: "image/png",
						fileName: "permanent.png",
					},
				],
			});
			if (mode !== "healthy") {
				await expect(promise).rejects.toThrow();
				expect(puts).toBe(mode === "after-put" ? 1 : 0);
			} else {
				expect(await promise).toHaveLength(1);
				expect(puts).toBeGreaterThan(0);
			}
			expect(deletes).toBe(0);
			expect(asyncOwnerReads).toBe(0);
			expect(
				await ctx.storage.get("workflow-image-cleanup:native-image"),
			).toBeUndefined();
			expect(
				await ctx.storage.get("pi-native-image-owner:native-image"),
			).toMatchObject({
				operationId: "native-operation",
				sessionKey: "actual-native-session",
			});
		});
	},
);

it("v2 passive metadata leaves existing cutover, accounting and source storage unchanged", async () => {
	await runInDurableObject(fixture(), async (_instance, ctx) => {
		ctx.storage.kv.put("think-accounting:observation", {
			version: 1,
			runId: "observation",
			fault: null,
			attempts: [
				{
					id: "a",
					estimatedTokens: 1,
					phase: "started",
					acknowledged: false,
					effectsStarted: true,
					effectsSealed: false,
					usage: null,
				},
			],
		});
		const { inspectCutoverParent } = await import("../../src/pi-cutover-admin");
		const tables = ctx.storage.sql
			.exec<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
			)
			.toArray();
		const kv = [...ctx.storage.kv.list()],
			alarm = await ctx.storage.getAlarm();
		const observed = await inspectCutoverParent(ctx.storage, ctx.id.toString());
		const row = observed.qualification.rows.find(
			(r) => r.family === "legacy_accounting",
		)!;
		expect(row.structuralState).toBe("known");
		expect(row.phaseCounts).toEqual({ started: 1 });
		expect(row.completionValidation).toBe("not_passed");
		expect(row.unsealedEffectsCount).toBe(1);
		expect([...ctx.storage.kv.list()]).toEqual(kv);
		expect(
			ctx.storage.sql
				.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
				.toArray(),
		).toEqual(tables);
		expect(await ctx.storage.getAlarm()).toBe(alarm);
		expect(observed.version).toBe("pi-cutover-inspection-v2");
		expect(JSON.stringify(observed.qualification)).not.toContain(
			'"observation"',
		);
	});
});

it("new native preservation root port retains unknown local owner and refuses normal Agent execution", async () => {
	const local = env as unknown as Cloudflare.Env,
		namespace = (
			env as unknown as { PI_TEST: DurableObjectNamespace<PiRuntimeFixture> }
		).PI_TEST;
	const name = "native-preserve-" + crypto.randomUUID(),
		stub = namespace.get(namespace.idFromName(name)),
		tediId = crypto.randomUUID(),
		orgId = crypto.randomUUID(),
		key = Buffer.alloc(32, 7).toString("base64");
	await local.DB.exec(
		"CREATE TABLE IF NOT EXISTS tedis(id TEXT PRIMARY KEY,organization_id TEXT,slug TEXT,isolate_agent_id TEXT,runtime_kind TEXT,status TEXT)",
	);
	await local.DB.prepare("INSERT INTO tedis VALUES (?,?,?,?,?,?)")
		.bind(tediId, orgId, name, name, "agent", "active")
		.run();
	await runInDurableObject(stub, async (_instance, ctx) => {
		const { operateStoredCutover } = await import("../../src/pi-cutover-admin");
		const id = ctx.id.toString();
		new RuntimeAdmissionDO(ctx.storage, {
			objectId: id,
			tediId,
			orgId,
		}).gate.initialize({
			operationId: "fixture",
			state: "quarantined",
			reason: "fixture",
		});
		ctx.storage.sql.exec(
			"CREATE TABLE cf_agents_state(id TEXT PRIMARY KEY,state TEXT)",
		);
		ctx.storage.sql.exec(
			"INSERT INTO cf_agents_state VALUES('cf_state_row_id',?)",
			JSON.stringify({ tediId: null, orgId: null }),
		);
		ctx.storage.kv.put("__ps_name", name);
		const custom = {
			...local,
			TEDI_AGENT: namespace,
			SECRETS_MASTER_KEY: key,
			PI_CUTOVER_KNOWN_PARENT_IDS: JSON.stringify([id]),
		} as unknown as Cloudflare.Env;
		const body = {
			command: "inspect_native_preservation",
			objectId: id,
			operationId: "original",
			expectedGeneration: 1,
			custody: { tediId, orgId, objectName: name },
		};
		const req = (v: unknown) =>
			new Request("https://fixture/__admin/pi-state-cutover", {
				method: "POST",
				headers: { "X-Tedix-Admin-Token": key },
				body: JSON.stringify(v),
			});
		expect(
			(await operateStoredCutover({ ctx, env: custom, request: req(body) }))
				.status,
		).toBe(409);
		const planResponse = await operateStoredCutover({
			ctx,
			env: custom,
			request: req(body),
			receiver: "raw-cutover-v1",
		});
		expect(planResponse.status).toBe(200);
		const plan = (await planResponse.json()) as {
			archive: { archiveId: string; metadata: { localOwnerUnknown: boolean } };
			proof: string;
		};
		expect(plan.archive.metadata.localOwnerUnknown).toBe(true);
		expect(
			ctx.storage.sql
				.exec(
					"SELECT name FROM sqlite_master WHERE name='native_preservation_snapshot'",
				)
				.toArray(),
		).toEqual([]);
		// Mutate actual D1 tenant on the post-decrypt canonical re-observation.
		let canonicalReads = 0;
		const racedDB = {
			prepare(sql: string) {
				const stmt = local.DB.prepare(sql);
				if (!sql.startsWith("SELECT isolate_agent_id AS isolateAgentId"))
					return stmt;
				return {
					bind(...values: unknown[]) {
						const bound = stmt.bind(...values);
						return {
							async first() {
								if (++canonicalReads === 2)
									await local.DB.prepare(
										"UPDATE tedis SET organization_id=? WHERE id=?",
									)
										.bind(crypto.randomUUID(), tediId)
										.run();
								return bound.first();
							},
						};
					},
				};
			},
		} as unknown as D1Database;
		const refused = await operateStoredCutover({
			ctx,
			env: { ...custom, DB: racedDB },
			request: req({
				...body,
				command: "capture_native_preservation",
				archiveId: plan.archive.archiveId,
				proof: plan.proof,
			}),
			receiver: "raw-cutover-v1",
		});
		expect(refused.status).toBe(409);
		expect(canonicalReads).toBe(2);
		expect(
			ctx.storage.sql
				.exec(
					"SELECT name FROM sqlite_master WHERE name='native_preservation_snapshot'",
				)
				.toArray(),
		).toEqual([]);
		await local.DB.prepare("UPDATE tedis SET organization_id=? WHERE id=?")
			.bind(orgId, tediId)
			.run();
		const captured = await operateStoredCutover({
			ctx,
			env: custom,
			request: req({
				...body,
				command: "capture_native_preservation",
				archiveId: plan.archive.archiveId,
				proof: plan.proof,
			}),
			receiver: "raw-cutover-v1",
		});
		expect(captured.status).toBe(200);
		const audit = await operateStoredCutover({
			ctx,
			env: custom,
			request: req({
				...body,
				command: "audit_native_preservation",
				operationId: "new-audit",
				archiveId: plan.archive.archiveId,
			}),
			receiver: "raw-cutover-v1",
		});
		expect(audit.status).toBe(200);
		expect(
			JSON.parse(
				ctx.storage.sql
					.exec<{ state: string }>("SELECT state FROM cf_agents_state")
					.one().state,
			),
		).toEqual({ tediId: null, orgId: null });
		ctx.storage.sql.exec(
			"UPDATE cf_agents_state SET state=?",
			JSON.stringify({ tediId: crypto.randomUUID(), orgId }),
		);
		expect(
			(
				await operateStoredCutover({
					ctx,
					env: custom,
					request: req(body),
					receiver: "raw-cutover-v1",
				})
			).status,
		).toBe(409);
	});
});

it("registered native preservation preserves null leaf owner and rejects changed path or registry", async () => {
	const local = env as unknown as Cloudflare.Env;
	const namespace = (
		env as unknown as { PI_TEST: DurableObjectNamespace<PiRuntimeFixture> }
	).PI_TEST;
	const name = "native-registered-" + crypto.randomUUID(),
		leafName = "native-leaf-" + crypto.randomUUID(),
		tediId = crypto.randomUUID(),
		orgId = crypto.randomUUID(),
		key = btoa("n".repeat(32));
	const root = namespace.get(namespace.idFromName(name)),
		leaf = namespace.get(namespace.idFromName(leafName));
	const rootId = namespace.idFromName(name).toString(),
		leafId = namespace.idFromName(leafName).toString();
	await local.DB.exec(
		"CREATE TABLE IF NOT EXISTS tedis (id TEXT PRIMARY KEY,organization_id TEXT,slug TEXT,isolate_agent_id TEXT,runtime_kind TEXT,status TEXT)",
	);
	await local.DB.prepare("INSERT INTO tedis VALUES (?,?,?,?,?,?)")
		.bind(tediId, orgId, name, name, "agent", "active")
		.run();
	const custom = {
		...local,
		TEDI_AGENT: namespace,
		SECRETS_MASTER_KEY: key,
		PI_CUTOVER_KNOWN_PARENT_IDS: JSON.stringify([rootId]),
	} as unknown as Cloudflare.Env;
	const hop = await runInDurableObject(root, async (_instance, ctx) => {
		const { inspectCutoverParent } = await import("../../src/pi-cutover-admin");
		new RuntimeAdmissionDO(ctx.storage, {
			objectId: rootId,
			tediId,
			orgId,
		}).gate.initialize({
			operationId: "root",
			state: "quarantined",
			reason: "fixture",
		});
		ctx.storage.kv.put("__ps_name", name);
		ctx.storage.sql.exec(
			"CREATE TABLE cf_agents_sub_agents(class TEXT,name TEXT)",
		);
		ctx.storage.sql.exec(
			"INSERT INTO cf_agents_sub_agents VALUES ('ConversationFacet',?)",
			leafName,
		);
		return (
			await inspectCutoverParent(
				ctx.storage,
				rootId,
				{ offset: 0, limit: 200 },
				namespace,
				"raw-cutover-v1",
			)
		).inspectionTargets[0]!;
	});
	expect(hop.objectId).toBe(leafId);
	await runInDurableObject(leaf, async (_instance, ctx) => {
		new RuntimeAdmissionDO(ctx.storage, {
			objectId: leafId,
			tediId,
			orgId,
		}).gate.initialize({
			operationId: "leaf",
			state: "quarantined",
			reason: "fixture",
		});
		ctx.storage.sql.exec(
			"CREATE TABLE cf_agents_state(id TEXT PRIMARY KEY,state TEXT)",
		);
		ctx.storage.sql.exec(
			"INSERT INTO cf_agents_state VALUES ('cf_state_row_id',?)",
			JSON.stringify({ aigMetadata: { tediId: null, orgId: null } }),
		);
		ctx.storage.kv.put("__ps_name", leafName);
		ctx.storage.kv.put("cf_agents_is_facet", true);
		ctx.storage.kv.put("cf_agents_facet_name", leafName);
		ctx.storage.kv.put("cf_agents_parent_path", [
			{ className: "AgentTediDO", name },
		]);
	});
	const base = {
		objectId: rootId,
		operationId: "leaf-original",
		expectedGeneration: 1,
		custody: { tediId, orgId, objectName: name },
		targetPath: [hop],
	};
	const custody = {
		rootId,
		tediId,
		orgId,
		objectName: name,
		parentPath: [{ className: "AgentTediDO", name }],
		current: {
			className: "ConversationFacet",
			name: leafName,
			identityName: leafName,
			objectId: leafId,
		},
	};
	const leafCall = (body: unknown) =>
		runInDurableObject(leaf, async (_i, child) => {
			const { passiveRegisteredCutover } =
				await import("../../src/pi-cutover-admin");
			return passiveRegisteredCutover(child, custom, {
				token: key,
				body: JSON.stringify(body),
				custody: JSON.stringify(custody),
				index: 1,
			});
		});
	const rootCall = (
		body: unknown,
		reply: { status: number; body: string },
		shouldDispatch = true,
	) =>
		runInDurableObject(root, async (_i, ctx) => {
			const { operateStoredCutover } =
				await import("../../src/pi-cutover-admin");
			let calls = 0;
			const wrapped = new Proxy(ctx, {
				get(target, property) {
					if (property === "facets")
						return {
							get: () => ({
								async operateRegisteredStoredCutover(input: {
									body: string;
									custody: string;
									index: number;
								}) {
									calls++;
									expect(JSON.parse(input.body)).toEqual(body);
									expect(JSON.parse(input.custody)).toEqual(custody);
									expect(input.index).toBe(1);
									return reply;
								},
							}),
						};
					const value = Reflect.get(target, property);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const response = await operateStoredCutover({
				ctx: wrapped,
				env: custom,
				receiver: "raw-cutover-v1",
				request: new Request("https://fixture/__admin/pi-state-cutover", {
					method: "POST",
					headers: { "X-Tedix-Admin-Token": key },
					body: JSON.stringify(body),
				}),
			});
			expect(calls).toBe(shouldDispatch ? 1 : 0);
			return response.status;
		});
	const inspectBody = { ...base, command: "inspect_native_preservation" };
	const inspected = await leafCall(inspectBody);
	expect(inspected.status).toBe(200);
	expect(await rootCall(inspectBody, inspected)).toBe(200);
	expect(
		await rootCall(
			{
				...inspectBody,
				targetPath: [{ ...hop, registryHash: "f".repeat(64) }],
			},
			inspected,
			false,
		),
	).toBe(409);
	const plan = JSON.parse(inspected.body) as {
		archive: { archiveId: string; metadata: { localOwnerUnknown: boolean } };
		proof: string;
	};
	expect(plan.archive.metadata.localOwnerUnknown).toBe(true);
	const captureBody = {
		...base,
		command: "capture_native_preservation",
		archiveId: plan.archive.archiveId,
		proof: plan.proof,
	};
	await runInDurableObject(leaf, (_i, child) =>
		child.storage.kv.put("cf_agents_parent_path", [
			{ className: "AgentTediDO", name: "changed" },
		]),
	);
	expect((await leafCall(captureBody)).status).toBe(409);
	await runInDurableObject(leaf, (_i, child) => {
		expect(
			child.storage.sql
				.exec(
					"SELECT name FROM sqlite_master WHERE name='native_preservation_snapshot'",
				)
				.toArray(),
		).toEqual([]);
		child.storage.kv.put("cf_agents_parent_path", [
			{ className: "AgentTediDO", name },
		]);
	});
	const captured = await leafCall(captureBody);
	expect(captured.status).toBe(200);
	expect(await rootCall(captureBody, captured)).toBe(200);
	const auditBody = {
			...base,
			command: "audit_native_preservation",
			operationId: "leaf-audit",
			archiveId: plan.archive.archiveId,
		},
		audited = await leafCall(auditBody);
	expect(audited.status).toBe(200);
	expect(await rootCall(auditBody, audited)).toBe(200);
	await runInDurableObject(leaf, (_i, child) =>
		expect(
			JSON.parse(
				child.storage.sql
					.exec<{ state: string }>("SELECT state FROM cf_agents_state")
					.one().state,
			),
		).toEqual({ aigMetadata: { tediId: null, orgId: null } }),
	);
});
