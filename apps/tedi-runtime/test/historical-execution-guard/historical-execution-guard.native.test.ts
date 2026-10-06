import { RuntimeAdmissionDO } from "../../src/runtime-admission-do";
import { createHash } from "node:crypto";
import { HistoricalTrackingRetirement } from "../../src/historical-tracking-retirement";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, it, expect } from "vite-plus/test";
import { HistoricalExecutionGuard } from "../../src/historical-execution-guard";
import { HistoricalLiabilityCustody } from "../../src/historical-liability-custody";
import { RuntimeAdmission } from "../../src/runtime-admission";
import { RawCutoverDO } from "../../src/pi-cutover-maintenance-do";
import {
	setObserverFixturePorts,
	seedCustody,
	seedRetirementFixture,
	releaseRetirementFixture,
	type GuardParent,
	type GuardPi,
	type GuardProbe,
} from "./worker";
function currentBindings() {
	return env as unknown as {
		TEDI_AGENT: DurableObjectNamespace<GuardParent>;
		GUARD_PI: DurableObjectNamespace<GuardPi>;
		GUARD_PROBE: DurableObjectNamespace<GuardProbe>;
		CHAT_TURN_WORKFLOW: Workflow<{ runId?: string }>;
	};
}
async function parent() {
	return getAgentByName(currentBindings().TEDI_AGENT, crypto.randomUUID());
}
function track(ctx: DurableObjectState, workflowId: string) {
	ctx.storage.sql.exec(
		"INSERT INTO cf_agents_workflows(id,workflow_id,workflow_name,status) VALUES (?,?, 'CHAT_TURN_WORKFLOW','queued')",
		crypto.randomUUID(),
		workflowId,
	);
	ctx.storage.kv.put(`wfctx:${workflowId}`, { runId: `run:${workflowId}` });
}
function freeze(ctx: DurableObjectState) {
	seedCustody(ctx);
	const store = new HistoricalLiabilityCustody(ctx.storage, ctx.id.toString()),
		s = store.inspectSnapshot({ expectedGeneration: 1 });
	store.captureSnapshot({
		expectedGeneration: 1,
		expectedSourceHash: s.sourceHash,
	});
	return store;
}
function rows(ctx: DurableObjectState) {
	return {
		workflows: ctx.storage.sql
			.exec("SELECT * FROM cf_agents_workflows ORDER BY id")
			.toArray(),
		fibers: ctx.storage.sql
			.exec("SELECT * FROM cf_agents_fibers ORDER BY fiber_id")
			.toArray(),
		runs: ctx.storage.sql
			.exec("SELECT * FROM cf_agents_runs ORDER BY id")
			.toArray(),
	};
}
async function nativeStarted(instance: WorkflowInstance, minimum = 1) {
	for (let i = 0; i < 300; i++) {
		const status = await instance.status();
		if (
			status.status === "running" &&
			(await currentBindings()
				.GUARD_PROBE.getByName("global")
				.count(instance.id)) >= minimum
		)
			return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(
		"native workflow did not execute its effect: " +
			JSON.stringify(await instance.status()),
	);
}
async function nativeCompleted(instance: WorkflowInstance) {
	for (let i = 0; i < 300; i++) {
		const result = await instance.status();
		if (result.status === "complete") {
			expect(result.output).toBe("completed");
			return;
		}
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error(
		"native workflow did not complete: " +
			JSON.stringify(await instance.status()),
	);
}

describe("native historical replay boundaries", () => {
	it("real native binding brand, SDK workflow and generated fiber paths remain functional when unselected", async () => {
		const stub = await parent();
		const id = crypto.randomUUID();
		expect(await stub.sdkCreate(id)).toBe(id);
		const native = await currentBindings().CHAT_TURN_WORKFLOW.get(id);
		await nativeStarted(native);
		expect(await stub.observe(id)).toBe("running");
		expect(
			await currentBindings().GUARD_PROBE.getByName("global").count(id),
		).toBe(1);
		await stub.mutate(id, "sendEvent");
		await nativeCompleted(native);
		const fiber = await stub.invokeFiber("fresh-fiber", "fresh-key");
		expect(fiber.status).toBe("completed");
		expect(await stub.invokeRunFiber()).toBeTypeOf("string");
		await runInDurableObject(stub, async (_agent, ctx) => {
			expect(ctx.storage.kv.get("fixture:effects")).toBe(2);
			expect(
				new HistoricalLiabilityCustody(
					ctx.storage,
					ctx.id.toString(),
				).hasSnapshot(),
			).toBe(false);
		});
	});
	it("unsealed real native instance permits pause/resume/restart with original receiver brands", async () => {
		const stub = await parent(),
			id = crypto.randomUUID();
		await stub.sdkCreate(id);
		const native = await currentBindings().CHAT_TURN_WORKFLOW.get(id);
		await nativeStarted(native);
		await runInDurableObject(stub, async (agent) => {
			const handle = await agent.nativeHandle(id);
			await handle.pause();
			expect((await handle.status()).status).toBe("paused");
			await handle.resume();
			expect((await handle.status()).status).toBe("running");
			await handle.restart();
			expect((await handle.status()).status).toBe("running");
			await nativeStarted(handle, 2);
			await handle.sendEvent({ type: "finish", payload: {} });
			await nativeCompleted(handle);
		});
	});

	it("real binding direct/SDK creates and batch deny ALL sealed identities before any dispatch", async () => {
		const stub = await parent();
		await runInDurableObject(stub, async (_agent, ctx) => {
			const id = "sealed-no-provider";
			track(ctx, id);
			freeze(ctx);
			const port = new HistoricalExecutionGuard(
				ctx.storage,
				ctx.id.toString(),
			).environment(currentBindings());
			expect(port.GUARD_PROBE).toBe(currentBindings().GUARD_PROBE);
			expect(port.CHAT_TURN_WORKFLOW).not.toBe(
				currentBindings().CHAT_TURN_WORKFLOW,
			);
			const before = rows(ctx);
			await expect(port.CHAT_TURN_WORKFLOW.create({ id })).rejects.toThrow(
				"permanently sealed",
			);
			await expect(
				port.CHAT_TURN_WORKFLOW.createBatch([{ id: "fresh-batch" }, { id }]),
			).rejects.toThrow("permanently sealed");
			await expect(
				port.CHAT_TURN_WORKFLOW.create({
					id: "fresh-run-alias",
					params: { runId: `run:${id}` },
				}),
			).rejects.toThrow("permanently sealed");
			expect(rows(ctx)).toEqual(before);
			expect(
				await currentBindings().GUARD_PROBE.getByName("global").count(id),
			).toBe(0);
			await expect(
				currentBindings().CHAT_TURN_WORKFLOW.get("fresh-batch"),
			).rejects.toThrow();
		});
		await runInDurableObject(stub, async (agent) => {
			await expect(agent.sdkCreate("sealed-no-provider")).rejects.toThrow(
				"permanently sealed",
			);
		});
	});
	it("native get handle acquired before freeze rechecks every restart/resume/event on repeated invocations", async () => {
		const stub = await parent(),
			id = crypto.randomUUID();
		const native = await currentBindings().CHAT_TURN_WORKFLOW.create({ id });
		await nativeStarted(native);
		await native.pause();
		await runInDurableObject(stub, async (_agent, ctx) => {
			const port = new HistoricalExecutionGuard(
				ctx.storage,
				ctx.id.toString(),
			).environment(currentBindings());
			const acquiring = port.CHAT_TURN_WORKFLOW.get(id);
			track(ctx, id);
			freeze(ctx);
			const instance = await acquiring;
			expect((await instance.status()).status).toBe("paused");
			for (let retry = 0; retry < 2; retry++) {
				await expect(instance.restart()).rejects.toThrow("permanently sealed");
				await expect(instance.resume()).rejects.toThrow("permanently sealed");
				await expect(
					instance.sendEvent({ type: "finish", payload: {} }),
				).rejects.toThrow("permanently sealed");
			}
			expect(
				await currentBindings().GUARD_PROBE.getByName("global").count(id),
			).toBe(1);
			expect((await native.status()).status).toBe("paused");
			await instance.terminate();
			expect((await native.status()).status).toBe("terminated");
		});
	});
	it("actual SDK restartWorkflow retries after provider failure and denies a seal persisted at the first dispatch barrier without resetting tracking", async () => {
		const stub = await parent(),
			id = crypto.randomUUID();
		await stub.sdkCreate(id);
		const native = await currentBindings().CHAT_TURN_WORKFLOW.get(id);
		await nativeStarted(native);
		await stub.armSdkRetry(id);
		await runInDurableObject(stub, async (agent, ctx) => {
			const before = ctx.storage.sql
				.exec("SELECT * FROM cf_agents_workflows WHERE workflow_id=?", id)
				.toArray();
			await expect(agent.restartWorkflow(id)).rejects.toThrow(
				"permanently sealed",
			);
			expect(ctx.storage.kv.get("fixture:first-provider-failure")).toBe(true);
			expect(ctx.storage.kv.get("fixture:retry-barrier-sealed")).toBe(true);
			expect(
				ctx.storage.kv.get("fixture:restart-provider-dispatches") ?? 0,
			).toBe(0);
			expect(
				ctx.storage.sql
					.exec("SELECT * FROM cf_agents_workflows WHERE workflow_id=?", id)
					.toArray(),
			).toEqual(before);
		});
		expect(
			await currentBindings().GUARD_PROBE.getByName("global").count(id),
		).toBe(1);
		await native.terminate();
	});

	it("parent public startFiber existing ID/key fastpaths reject via promises; new callbacks use actual SDK ID", async () => {
		const stub = await parent();
		expect(
			(await stub.invokeFiber("original-fiber", "original-key")).status,
		).toBe("completed");
		await runInDurableObject(stub, async (_agent, ctx) => {
			freeze(ctx);
		});
		await runInDurableObject(stub, async (agent) => {
			await expect(agent.invokeFiber("original-fiber")).rejects.toThrow(
				"permanently sealed",
			);
			await expect(
				agent.invokeFiber("fresh-id", "original-key"),
			).rejects.toThrow("permanently sealed");
		});
		await runInDurableObject(stub, async (_agent, ctx) => {
			expect(ctx.storage.kv.get("fixture:effects")).toBe(1);
		});
	});
	it("actual child facet registration await seals original execution before Pi user callback", async () => {
		const stub = await parent();
		await stub.armRegistrationRace();
		const result = await stub.raceFacetFiber();
		expect(result.status).toBe("error");
		await runInDurableObject(stub, async (agent) => {
			const facet = await agent.subAgent(
				(await import("./worker")).GuardPi,
				"race",
			);
			expect(await facet.inspectSeal()).toEqual({ effects: 0, sealed: true });
		});
	});
	for (const kind of ["parent", "pi"] as const)
		it(`${kind} cold constructor returns Raw before actual SDK recovery changes historical rows`, async () => {
			const ns =
				kind === "parent"
					? currentBindings().TEDI_AGENT
					: currentBindings().GUARD_PI;
			const stub = await getAgentByName(
				ns as DurableObjectNamespace<GuardParent>,
				crypto.randomUUID(),
			);
			const before = await runInDurableObject(stub, async (_agent, ctx) => {
				ctx.storage.sql.exec(
					"INSERT INTO cf_agents_fibers(fiber_id,idempotency_key,name,status,created_at) VALUES ('old-recovery','old-key','retained','running',123)",
				);
				ctx.storage.sql.exec(
					"INSERT INTO cf_agents_runs(id,name,snapshot,created_at) VALUES ('old-recovery','retained',NULL,123)",
				);
				freeze(ctx);
				// Explicit TEST-only verified release isolates replay startup fence from existing inactive-admission Raw fence.
				const owner = {
						objectId: ctx.id.toString(),
						tediId: "native-tedi",
						orgId: "native-org",
					},
					gate = new RuntimeAdmission(ctx.storage, owner, () => ({
						owner,
						digest: "a".repeat(64),
						complete: true,
						unknown: 0,
						nonterminal: 0,
					}));
				gate.release({
					operationId: "native-verified-release",
					expectedGeneration: 1,
					evidence: "a".repeat(64),
				});
				return rows(ctx);
			});
			await abortAllDurableObjects();
			const fresh = ns.get(stub.id);
			await runInDurableObject(fresh, async (raw, ctx) => {
				expect(raw).toBeInstanceOf(RawCutoverDO);
				expect(rows(ctx)).toEqual(before);
				expect(ctx.storage.kv.get("fixture:recovery") ?? 0).toBe(0);
				expect(
					new HistoricalExecutionGuard(
						ctx.storage,
						ctx.id.toString(),
					).requiresRawStartup(),
				).toBe(true);
			});
			if (kind === "parent")
				await runInDurableObject(fresh, async (raw) => {
					await expect(
						(raw as unknown as RawCutoverDO).recordPiStep({
							runId: "unknown-original",
							stepId: "attempt",
							actualTokens: 1,
						}),
					).rejects.toThrow("Original inference receipt rejected");
				});
		});
	it("partial compact store denies startup and empty batch without fabricating admission", async () => {
		const stub = await parent();
		await runInDurableObject(stub, async (_agent, ctx) => {
			ctx.storage.sql.exec(
				"CREATE TABLE historical_replay_seals(identity TEXT)",
			);
			const guard = new HistoricalExecutionGuard(
				ctx.storage,
				ctx.id.toString(),
			);
			expect(guard.requiresRawStartup()).toBe(true);
			expect(() => guard.assert([])).toThrow("incomplete custody");
			expect(
				ctx.storage.sql
					.exec("SELECT name FROM sqlite_master WHERE name='runtime_admission'")
					.toArray(),
			).toEqual([]);
		});
	});
});

const retirementRows = (ctx: DurableObjectState) =>
	["cf_agents_workflows", "cf_agents_fibers", "cf_agents_runs"].map((table) =>
		ctx.storage.sql.exec(`SELECT * FROM ${table}`).toArray(),
	);
const archiveRows = (ctx: DurableObjectState) =>
	[
		"historical_custody_snapshot",
		"historical_custody_parts",
		"historical_liability_refs",
		"historical_replay_seals",
	].map((table) => ctx.storage.sql.exec(`SELECT * FROM ${table}`).toArray());
describe("native conditional tracking retirement", () => {
	it("deletes exact tracking only; immutable archive, private unknown reservations and permanent identities survive cold exact retry", async () => {
		const stub = await parent();
		const result = await runInDurableObject(stub, async (_agent, ctx) => {
			const input = seedRetirementFixture(ctx, undefined, _agent.state),
				before = archiveRows(ctx),
				admission = ctx.storage.sql
					.exec("SELECT * FROM runtime_admission")
					.toArray(),
				facts = ctx.storage.kv.get("think-accounting:retained"),
				alarm = await ctx.storage.getAlarm();
			const archive = new HistoricalLiabilityCustody(
					ctx.storage,
					ctx.id.toString(),
				),
				retirement = new HistoricalTrackingRetirement(
					ctx.storage,
					ctx.id.toString(),
				),
				receipt = retirement.retire(input);
			expect(retirementRows(ctx)).toEqual([[], [], []]);
			expect(archiveRows(ctx)).toEqual(before);
			expect(
				ctx.storage.sql.exec("SELECT * FROM runtime_admission").toArray(),
			).toEqual(admission);
			expect(ctx.storage.kv.get("think-accounting:retained")).toEqual(facts);
			expect(await ctx.storage.getAlarm()).toBe(alarm);
			expect(archive.audit()?.sourceHash).toBe(input.sourceHash);
			expect(() =>
				archive.captureSnapshot({
					expectedGeneration: 1,
					expectedSourceHash: input.sourceHash,
				}),
			).toThrow();
			for (const identity of [
				{ kind: "fiber", id: "retained-fiber" },
				{ kind: "fiber_key", id: "retained-key" },
				{ kind: "run", id: "retained-original-run" },
				{
					kind: "workflow",
					binding: "CHAT_TURN_WORKFLOW",
					id: "retained-provider",
				},
			] as const)
				expect(() => archive.assertNotSealed(identity)).toThrow(
					"permanently sealed",
				);
			return { input, receipt };
		});
		await abortAllDurableObjects();
		const cold = currentBindings().TEDI_AGENT.get(stub.id);
		await runInDurableObject(cold, async (raw, ctx) => {
			expect(raw.constructor.name).toBe("RawCutoverDO");
			expect(
				new HistoricalTrackingRetirement(ctx.storage, ctx.id.toString()).retire(
					result.input,
				),
			).toEqual(result.receipt);
			expect(retirementRows(ctx)).toEqual([[], [], []]);
		});
	});
	for (const kind of ["parent", "pi"] as const)
		it(`${kind} actual SDK startup after explicit test-only release admits fresh native work but never original identities`, async () => {
			const ns =
				kind === "parent"
					? currentBindings().TEDI_AGENT
					: currentBindings().GUARD_PI;
			const stub = await getAgentByName(
				ns as DurableObjectNamespace<GuardParent>,
				crypto.randomUUID(),
			);
			await runInDurableObject(stub, async (_agent, ctx) => {
				const input = seedRetirementFixture(ctx, undefined, _agent.state);
				new HistoricalTrackingRetirement(ctx.storage, ctx.id.toString()).retire(
					input,
				);
				expect(
					new HistoricalExecutionGuard(
						ctx.storage,
						ctx.id.toString(),
					).requiresRawStartup(),
				).toBe(false);
				releaseRetirementFixture(ctx);
			});
			await abortAllDurableObjects();
			const cold = ns.get(stub.id);
			await runInDurableObject(
				cold as DurableObjectStub<GuardParent>,
				async (agent, ctx) => {
					expect(agent.constructor.name).toBe(
						kind === "parent" ? "GuardParent" : "GuardPi",
					);
					expect(ctx.storage.kv.get("fixture:recovery") ?? 0).toBe(0);
					await expect(agent.invokeFiber("retained-fiber")).rejects.toThrow(
						"permanently sealed",
					);
					await expect(
						agent.invokeFiber("fresh-alias", "retained-key"),
					).rejects.toThrow("permanently sealed");
					expect((await agent.invokeFiber("fresh-native")).status).toBe(
						"completed",
					);
					expect(ctx.storage.kv.get("fixture:effects")).toBe(1);
					const guarded = new HistoricalExecutionGuard(
						ctx.storage,
						ctx.id.toString(),
					).environment(currentBindings());
					await expect(
						guarded.CHAT_TURN_WORKFLOW.create({ id: "retained-provider" }),
					).rejects.toThrow("permanently sealed");
					await expect(
						guarded.CHAT_TURN_WORKFLOW.create({
							id: crypto.randomUUID(),
							params: { runId: "retained-original-run" },
						}),
					).rejects.toThrow("permanently sealed");
					if (kind === "parent") {
						const id = crypto.randomUUID();
						await agent.sdkCreate(id);
						const native = await currentBindings().CHAT_TURN_WORKFLOW.get(id);
						await nativeStarted(native);
						await native.sendEvent({ type: "finish", payload: {} });
						await nativeCompleted(native);
					}
				},
			);
		});
	it("unmanaged orphan executor refuses without deleting tracking or creating a receipt", async () => {
		const stub = await parent();
		await runInDurableObject(stub, async (_agent, ctx) => {
			const input = seedRetirementFixture(ctx, "unmanaged", _agent.state),
				before = retirementRows(ctx);
			expect(() =>
				new HistoricalTrackingRetirement(ctx.storage, ctx.id.toString()).retire(
					input,
				),
			).toThrow("historical_tracking_retirement_unavailable");
			expect(retirementRows(ctx)).toEqual(before);
			expect(
				ctx.storage.sql
					.exec(
						"SELECT name FROM sqlite_master WHERE name='historical_tracking_retirement'",
					)
					.toArray(),
			).toEqual([]);
		});
	});
	it("last receipt write resurrection rolls back deletes and receipt while preserving all four archive tables", async () => {
		const stub = await parent();
		await runInDurableObject(stub, async (_agent, ctx) => {
			const input = seedRetirementFixture(ctx, undefined, _agent.state),
				before = retirementRows(ctx),
				archive = archiveRows(ctx),
				original = ctx.storage.sql.exec.bind(ctx.storage.sql);
			let fired = false;
			Object.defineProperty(ctx.storage.sql, "exec", {
				configurable: true,
				value: (sql: string, ...values: SqlStorageValue[]) => {
					const result = original(sql, ...values);
					if (
						sql.startsWith("INSERT INTO historical_tracking_retirement") &&
						!fired
					) {
						fired = true;
						original(
							"INSERT INTO cf_agents_runs(id,name,snapshot,created_at) VALUES('retained-fiber','retained','late',123)",
						);
					}
					return result;
				},
			});
			try {
				expect(() =>
					new HistoricalTrackingRetirement(
						ctx.storage,
						ctx.id.toString(),
					).retire(input),
				).toThrow("historical_tracking_retirement_unavailable");
			} finally {
				Object.defineProperty(ctx.storage.sql, "exec", {
					configurable: true,
					value: original,
				});
			}
			expect(fired).toBe(true);
			expect(retirementRows(ctx)).toEqual(before);
			expect(archiveRows(ctx)).toEqual(archive);
			expect(
				ctx.storage.sql
					.exec(
						"SELECT name FROM sqlite_master WHERE name='historical_tracking_retirement'",
					)
					.toArray(),
			).toEqual([]);
		});
	});
	it("changed facts plus a recomputed forged post hash and receipt hash refuse immutable retry", async () => {
		const stub = await parent();
		await runInDurableObject(stub, async (_agent, ctx) => {
			const input = seedRetirementFixture(ctx, undefined, _agent.state),
				archive = new HistoricalLiabilityCustody(
					ctx.storage,
					ctx.id.toString(),
				),
				retirement = new HistoricalTrackingRetirement(
					ctx.storage,
					ctx.id.toString(),
				),
				receipt = retirement.retire(input);
			ctx.storage.kv.put("think-accounting:retained", { changed: true });
			const forged = {
				...receipt,
				postRetirementSourceHash: archive.inspectSnapshot({
					expectedGeneration: 1,
				}).sourceHash,
			};
			ctx.storage.sql.exec(
				"UPDATE historical_tracking_retirement SET receipt=?,receipt_hash=?",
				JSON.stringify(forged),
				createHash("sha256").update(JSON.stringify(forged)).digest("hex"),
			);
			expect(() => retirement.retire(input)).toThrow(
				"historical_tracking_retirement_unavailable",
			);
		});
	});
	for (const [label, sql] of [
		[
			"lifecycle",
			"INSERT INTO cf_agents_jobs(id,capability,fn,time) VALUES('unqualified','pi','wake',123)",
		],
		[
			"task",
			"INSERT INTO cf_agents_task_runs(run_id,definition,state,created_at,updated_at) VALUES('pending-task','unobserved','pending',123,123)",
		],
		[
			"descendant",
			"INSERT INTO cf_agents_facet_runs(owner_path,owner_path_key,run_id,created_at) VALUES('[]','child','child-run',123)",
		],
		[
			"tool",
			"INSERT INTO cf_agent_tool_runs(run_id,agent_type,status,started_at) VALUES('tool','unobserved','running',123)",
		],
	] as const)
		it(`refuses actual SDK ${label} recovery without source deletion`, async () => {
			const stub = await parent();
			await runInDurableObject(stub, async (_agent, ctx) => {
				const input = seedRetirementFixture(ctx, undefined, _agent.state);
				ctx.storage.sql.exec(sql);
				const before = retirementRows(ctx);
				expect(() =>
					new HistoricalTrackingRetirement(
						ctx.storage,
						ctx.id.toString(),
					).retire(input),
				).toThrow("historical_tracking_retirement_unavailable");
				expect(retirementRows(ctx)).toEqual(before);
			});
		});
});

describe("actual pinned Pi SQLite recovery qualification", () => {
	for (const status of ["pending", "running", "waiting", "completing"] as const)
		it(`refuses native Pi ${status} tasks without changing stored rows`, async () => {
			const stub = await parent();
			await runInDurableObject(stub, async (_agent, ctx) => {
				const { openPiSessionStore } = await import("agents/harness/pi");
				await openPiSessionStore(ctx.storage);
				ctx.storage.sql.exec(
					"INSERT INTO pi_tasks(id,conversation_id,kind,status,abort_requested,background,record) VALUES(2,1,'fixture',?,0,0,?)",
					status,
					JSON.stringify({ state: { status } }),
				);
				const input = seedRetirementFixture(ctx, undefined, _agent.state),
					original = ctx.storage.sql.exec("SELECT * FROM pi_tasks").toArray(),
					before = retirementRows(ctx);
				expect(() =>
					new HistoricalTrackingRetirement(
						ctx.storage,
						ctx.id.toString(),
					).retire(input),
				).toThrow("historical_tracking_retirement_unavailable");
				expect(retirementRows(ctx)).toEqual(before);
				expect(
					ctx.storage.sql.exec("SELECT * FROM pi_tasks").toArray(),
				).toEqual(original);
			});
		});
	for (const status of ["queued", "placed"] as const)
		it(`refuses native Pi ${status} submission`, async () => {
			const stub = await parent();
			await runInDurableObject(stub, async (_agent, ctx) => {
				const { openPiSessionStore } = await import("agents/harness/pi");
				await openPiSessionStore(ctx.storage);
				ctx.storage.sql.exec(
					"INSERT INTO pi_submissions(id,conversation_id,request_id,status,record) VALUES(2,1,'fixture',?,?)",
					status,
					JSON.stringify({ status }),
				);
				const input = seedRetirementFixture(ctx, undefined, _agent.state),
					before = retirementRows(ctx);
				expect(() =>
					new HistoricalTrackingRetirement(
						ctx.storage,
						ctx.id.toString(),
					).retire(input),
				).toThrow("historical_tracking_retirement_unavailable");
				expect(retirementRows(ctx)).toEqual(before);
			});
		});
	it("actual empty pinned Pi schema can retire, while future schema or mismatched terminal record refuses", async () => {
		for (const mode of ["empty", "future", "mismatched"] as const) {
			const stub = await parent();
			await runInDurableObject(stub, async (_agent, ctx) => {
				const { openPiSessionStore } = await import("agents/harness/pi");
				await openPiSessionStore(ctx.storage);
				if (mode === "future")
					ctx.storage.sql.exec("UPDATE pi_durable_schema SET version=2");
				if (mode === "mismatched")
					ctx.storage.sql.exec(
						"INSERT INTO pi_tasks(id,conversation_id,kind,status,abort_requested,background,record) VALUES(2,1,'fixture','terminal',0,0,?)",
						JSON.stringify({ state: { status: "waiting" } }),
					);
				const input = seedRetirementFixture(ctx, undefined, _agent.state),
					retirement = new HistoricalTrackingRetirement(
						ctx.storage,
						ctx.id.toString(),
					),
					before = retirementRows(ctx);
				if (mode === "empty") {
					expect(retirement.retire(input).runCount).toBe(1);
					expect(
						ctx.storage.sql
							.exec("SELECT version FROM pi_durable_schema")
							.toArray(),
					).toEqual([{ version: 1 }]);
				} else {
					expect(() => retirement.retire(input)).toThrow(
						"historical_tracking_retirement_unavailable",
					);
					expect(retirementRows(ctx)).toEqual(before);
				}
			});
		}
	});
	it("known terminal SDK Task rows survive retirement unchanged", async () => {
		const stub = await parent();
		await runInDurableObject(stub, async (_agent, ctx) => {
			ctx.storage.sql.exec(
				"INSERT INTO cf_agents_task_runs(run_id,definition,state,created_at,updated_at,settled_at) VALUES('terminal-task','fixture','completed',123,123,124)",
			);
			const input = seedRetirementFixture(ctx, undefined, _agent.state),
				tasks = ctx.storage.sql
					.exec("SELECT * FROM cf_agents_task_runs")
					.toArray();
			expect(
				new HistoricalTrackingRetirement(ctx.storage, ctx.id.toString()).retire(
					input,
				).runCount,
			).toBe(1);
			expect(
				ctx.storage.sql.exec("SELECT * FROM cf_agents_task_runs").toArray(),
			).toEqual(tasks);
		});
	});
	it("exact archived workflow accessor retains private original row after retirement, refuses foreign binding/pins and detects corrupt archive", async () => {
		const stub = await parent();
		await runInDurableObject(stub, async (_agent, ctx) => {
			const input = seedRetirementFixture(ctx, undefined, _agent.state),
				before = ctx.storage.sql
					.exec("SELECT * FROM cf_agents_workflows")
					.toArray()[0]!,
				store = new HistoricalLiabilityCustody(ctx.storage, ctx.id.toString()),
				query = {
					expectedGeneration: 1,
					snapshotId: input.snapshotId,
					sourceHash: input.sourceHash,
					workflowId: "retained-provider",
					binding: "CHAT_TURN_WORKFLOW",
				};
			new HistoricalTrackingRetirement(ctx.storage, ctx.id.toString()).retire(
				input,
			);
			expect(store.retainedWorkflowRow(query)).toEqual(before);
			expect(
				store.retainedWorkflowRow({ ...query, binding: "FOREIGN" }),
			).toBeNull();
			expect(() =>
				store.retainedWorkflowRow({ ...query, expectedGeneration: 2 }),
			).toThrow();
			ctx.storage.sql.exec(
				"DELETE FROM historical_replay_seals WHERE identity=(SELECT identity FROM historical_replay_seals LIMIT 1)",
			);
			expect(() => store.retainedWorkflowRow(query)).toThrow();
		});
	});
});

it("post-retirement unsupported executor schema refuses exact retry despite empty source rows", async () => {
	const stub = await parent();
	await runInDurableObject(stub, async (_agent, ctx) => {
		const input = seedRetirementFixture(ctx, undefined, _agent.state),
			retirement = new HistoricalTrackingRetirement(
				ctx.storage,
				ctx.id.toString(),
			);
		retirement.retire(input);
		ctx.storage.sql.exec(
			"ALTER TABLE cf_agents_runs ADD COLUMN unsupported_recovery TEXT",
		);
		expect(() => retirement.retire(input)).toThrow(
			"historical_tracking_retirement_unavailable",
		);
		expect(retirementRows(ctx)).toEqual([[], [], []]);
	});
});

const observerAdmissionResponse = () =>
	Response.json({
		json: {
			allowed: true,
			settlementMode: "disabled",
			attributionVersion: 3,
			executionId: "12345678-1234-4123-8123-123456789abc",
			sendBefore: "2099-01-01T00:00:00.000Z",
			reservationId: null,
			expiresAt: null,
			estimatedChargeMicros: null,
		},
	});
async function seedObserverClaim(
	agent: GuardParent,
	ctx: DurableObjectState,
	runId = "original:memory",
) {
	agent.setState({
		...agent.state,
		tediId: "native-tedi",
		orgId: "native-org",
	});
	const owner = {
		objectId: ctx.id.toString(),
		tediId: "native-tedi",
		orgId: "native-org",
	};
	const gate = new RuntimeAdmission(ctx.storage, owner, () => ({
		owner,
		digest: "a".repeat(64),
		complete: true,
		unknown: 0,
		nonterminal: 0,
	}));
	gate.initialize({
		operationId: "test-only-independent-release",
		state: "active",
		evidence: "a".repeat(64),
	});
	const admission = new RuntimeAdmissionDO(ctx.storage, owner);
	const accepted = (
		await admission.beginAcceptedTurn({
			runId,
			sessionKey: "original-session",
			principalId: "service:maintenance",
			input: { kind: "memory_effects", payload: { text: "original-private" } },
			expectedGeneration: 1,
		})
	).accepted;
	return { admission, accepted, gate };
}
describe("root observer final wire custody", () => {
	for (const change of [
		"hold",
		"quarantine",
		"cancel",
		"parentCancel",
		"owner",
		"storedOwner",
		"input",
		"claim",
		"generation",
		"identity",
		"selection",
	] as const)
		it(`real observer billing barrier ${change} rejects without a wire or settlement`, async () => {
			const stub = await parent();
			await runInDurableObject(stub, async (agent, ctx) => {
				const { accepted, gate } = await seedObserverClaim(agent, ctx);
				const unknownUsage = {
					reservationId: "original-reservation",
					measured: null,
					outcome: "unknown",
				};
				ctx.storage.kv.put("think-accounting:original", unknownUsage);
				let entered!: () => void,
					release!: () => void,
					sends = 0,
					bills = 0;
				const started = new Promise<void>((r) => (entered = r)),
					barrier = new Promise<void>((r) => (release = r));
				setObserverFixturePorts(ctx, {
					billing: async (body) => {
						bills++;
						expect(body).not.toContain("beforeDispatch");
						entered();
						await barrier;
						return observerAdmissionResponse();
					},
					wire: async () => {
						sends++;
						return Response.json({
							choices: [{ message: { content: "fixture" } }],
						});
					},
				});
				const pending = agent.observerFixtureCall(accepted.runId, "original");
				await Promise.race([
					started,
					pending.then(() => {
						throw new Error("observer completed before billing");
					}),
				]);
				expect(sends).toBe(0);
				if (change === "hold") {
					// Fault-injected held record: ordinary hold correctly refuses an unresolved claim.
					ctx.storage.sql.exec(
						"UPDATE runtime_admission SET record=? WHERE id=1",
						JSON.stringify({ ...gate.read()!, state: "held" }),
					);
				}
				if (change === "quarantine")
					gate.quarantine({
						operationId: "stop-during-billing",
						expectedGeneration: 1,
						reason: "test-only stop",
					});
				if (change === "parentCancel")
					ctx.storage.kv.put("wfcancel:original", true);
				if (change === "cancel")
					ctx.storage.kv.put(`wfcancel:${accepted.runId}`, true);
				if (change === "owner")
					agent.setState({ ...agent.state, orgId: "wrong-org" });
				if (change === "storedOwner") {
					ctx.storage.sql.exec(
						"UPDATE cf_agents_state SET state=? WHERE id='cf_state_row_id'",
						JSON.stringify({ ...agent.state, orgId: "wrong-org" }),
					);
				}
				if (change === "input")
					ctx.storage.sql.exec(
						"UPDATE runtime_admission_identities SET input=? WHERE run_id=?",
						'{"changed":true}',
						accepted.runId,
					);
				if (change === "claim")
					ctx.storage.sql.exec(
						"DELETE FROM runtime_admission_turns WHERE id=?",
						accepted.runId,
					);
				if (change === "generation") {
					const r = gate.read()!;
					ctx.storage.sql.exec(
						"UPDATE runtime_admission SET record=? WHERE id=1",
						JSON.stringify({ ...r, generation: 2 }),
					);
				}
				if (change === "identity") {
					const fields = {
						generation: accepted.generation,
						inputHash: accepted.inputHash,
						owner: {
							objectId: accepted.owner.objectId,
							orgId: accepted.owner.orgId,
							tediId: accepted.owner.tediId,
						},
						principalId: accepted.principalId,
						runId: accepted.runId,
						sessionKey: "coherently-changed",
					};
					const altered = {
						...fields,
						requestHash: createHash("sha256")
							.update(JSON.stringify(fields))
							.digest("hex"),
					};
					ctx.storage.sql.exec(
						"UPDATE runtime_admission_identities SET record=? WHERE run_id=?",
						JSON.stringify(altered),
						accepted.runId,
					);
					ctx.storage.sql.exec(
						"UPDATE runtime_admission_turns SET record=? WHERE id=?",
						JSON.stringify({
							...gate.claim(accepted.runId)!,
							requestHash: altered.requestHash,
						}),
						accepted.runId,
					);
					// Changed tuple is internally valid; only the original captured identity may send.
					expect(
						new RuntimeAdmissionDO(
							ctx.storage,
							accepted.owner,
						).assertAcceptedTurnSync({ runId: accepted.runId }).sessionKey,
					).toBe("coherently-changed");
				}
				if (change === "selection")
					ctx.storage.sql.exec("DROP TABLE runtime_admission");
				const facts = ctx.storage.sql
					.exec("SELECT name FROM sqlite_master ORDER BY name")
					.toArray();
				release();
				await expect(pending).rejects.toMatchObject({
					name: "ProviderDispatchGuardError",
					phase: "before_dispatch",
					providerRequestSent: false,
				});
				expect({ sends, bills }).toEqual({ sends: 0, bills: 1 });
				expect(ctx.storage.kv.get("think-accounting:original")).toEqual(
					unknownUsage,
				);
				expect(
					ctx.storage.sql
						.exec("SELECT name FROM sqlite_master ORDER BY name")
						.toArray(),
				).toEqual(facts);
				expect(
					ctx.storage.sql
						.exec(
							"SELECT name FROM sqlite_master WHERE name='runtime_admission_receipts'",
						)
						.toArray(),
				).toEqual([]);
			});
		});
	it("gen0 observer cannot acquire a new admission while billing is pending", async () => {
		const stub = await parent();
		await runInDurableObject(stub, async (agent, ctx) => {
			agent.setState({
				...agent.state,
				tediId: "native-tedi",
				orgId: "native-org",
			});
			let entered!: () => void,
				release!: () => void,
				sends = 0;
			const started = new Promise<void>((r) => (entered = r)),
				barrier = new Promise<void>((r) => (release = r));
			setObserverFixturePorts(ctx, {
				billing: async () => {
					entered();
					await barrier;
					return observerAdmissionResponse();
				},
				wire: async () => {
					sends++;
					return Response.json({
						choices: [{ message: { content: "fixture" } }],
					});
				},
			});
			const pending = agent.observerFixtureCall();
			await Promise.race([started, pending]);
			await seedObserverClaim(agent, ctx);
			release();
			await expect(pending).rejects.toMatchObject({
				name: "ProviderDispatchGuardError",
			});
			expect(sends).toBe(0);
		});
	});
	it("quarantine plus permanent original run seal during billing leaves the archived facts and claim unresolved", async () => {
		const stub = await parent();
		await runInDurableObject(stub, async (agent, ctx) => {
			const { accepted, gate } = await seedObserverClaim(agent, ctx);
			let entered!: () => void,
				release!: () => void,
				sends = 0;
			const started = new Promise<void>((r) => (entered = r)),
				barrier = new Promise<void>((r) => (release = r));
			setObserverFixturePorts(ctx, {
				billing: async () => {
					entered();
					await barrier;
					return observerAdmissionResponse();
				},
				wire: async () => {
					sends++;
					return Response.json({
						choices: [{ message: { content: "fixture" } }],
					});
				},
			});
			const pending = agent.observerFixtureCall(accepted.runId);
			await Promise.race([started, pending]);
			track(ctx, "original-observer-provider");
			ctx.storage.kv.put("wfctx:original-observer-provider", {
				runId: accepted.runId,
			});
			const stopped = gate.quarantine({
				operationId: "archive-stop",
				expectedGeneration: 1,
				reason: "test-only historical stop",
			});
			const store = new HistoricalLiabilityCustody(
				ctx.storage,
				ctx.id.toString(),
			);
			const snapshot = store.inspectSnapshot({
				expectedGeneration: stopped.generation,
			});
			store.captureSnapshot({
				expectedGeneration: stopped.generation,
				expectedSourceHash: snapshot.sourceHash,
			});
			expect(() =>
				new HistoricalExecutionGuard(ctx.storage, ctx.id.toString()).assertRun(
					accepted.runId,
				),
			).toThrow();
			const before = store.audit();
			release();
			await expect(pending).rejects.toMatchObject({
				name: "ProviderDispatchGuardError",
			});
			expect(sends).toBe(0);
			expect(store.audit()).toEqual(before);
			expect(gate.claim(accepted.runId)?.status).toBe("running");
			// Capture requires nonactive custody: this proves the coupled stop+seal, not an active archival writer.
		});
	});
	it("actual original observer accepts repeated wires; no inferred claim for unselected gen0", async () => {
		for (const selected of [true, false]) {
			const stub = await parent();
			await runInDurableObject(stub, async (agent, ctx) => {
				agent.setState({
					...agent.state,
					tediId: "native-tedi",
					orgId: "native-org",
				});
				const runId = selected
					? (await seedObserverClaim(agent, ctx)).accepted.runId
					: undefined;
				let sends = 0,
					bills = 0;
				setObserverFixturePorts(ctx, {
					billing: async () => {
						bills++;
						return observerAdmissionResponse();
					},
					wire: async () => {
						sends++;
						return Response.json({
							choices: [{ message: { content: "fixture" } }],
						});
					},
				});
				await agent.observerFixtureCall(runId);
				await agent.observerFixtureCall(runId);
				expect({ sends, bills }).toEqual({ sends: 2, bills: 2 });
				if (!selected)
					expect(
						ctx.storage.sql
							.exec(
								"SELECT name FROM sqlite_master WHERE name LIKE 'runtime_admission%'",
							)
							.toArray(),
					).toEqual([]);
			});
		}
	});
	it("actual SDK retry reuses production root closure and denies second wire after first send cancellation", async () => {
		const stub = await parent();
		await runInDurableObject(stub, async (agent, ctx) => {
			const { accepted } = await seedObserverClaim(agent, ctx);
			let sends = 0,
				bills = 0;
			setObserverFixturePorts(ctx, {
				billing: async () => {
					bills++;
					return observerAdmissionResponse();
				},
				wire: async () => {
					sends++;
					ctx.storage.kv.put(`wfcancel:${accepted.runId}`, true);
					return new Response("temporary", { status: 503 });
				},
			});
			try {
				await agent.observerSdkRetryFixture(accepted.runId);
				throw new Error("retry should deny");
			} catch (error) {
				expect(error).toMatchObject({
					name: "AI_RetryError",
					lastError: { phase: "before_dispatch", providerRequestSent: false },
				});
			}
			expect({ sends, bills }).toEqual({ sends: 1, bills: 1 });
			// The first wire is UNKNOWN; this is not a whole-operation zero-send receipt.
			expect(
				ctx.storage.sql
					.exec(
						"SELECT name FROM sqlite_master WHERE name='runtime_admission_receipts'",
					)
					.toArray(),
			).toEqual([]);
		});
	});
});

describe("retired direct brain compilation", () => {
	it("removed admin route returns 404 without platform, billing or provider effects", async () => {
		const stub = await parent();
		await runInDurableObject(stub, async (agent, ctx) => {
			await agent.installCompilationFixture();
			let bills = 0,
				sends = 0;
			setObserverFixturePorts(ctx, {
				billing: async () => {
					bills++;
					return observerAdmissionResponse();
				},
				wire: async () => {
					sends++;
					throw new Error("unexpected provider wire");
				},
			});
			for (const method of ["GET", "POST"]) {
				const response = await agent.onRequest(
					new Request("https://fixture/__admin/compile-brain", {
						method,
						headers: { "X-Tedix-Admin-Token": "fixture-token" },
					}),
				);
				expect(response.status).toBe(404);
				expect(await response.text()).toBe("Not Found");
			}
			expect(agent.compilationFixtureCounts()).toEqual({
				identity: 0,
				platform: 0,
				domains: 0,
				search: 0,
				rationale: 0,
			});
			expect(bills).toBe(0);
			expect(sends).toBe(0);
		});
	});
	for (const kind of ["digest", "directives"] as const) {
		it(`${kind} refuses missing, empty or whitespace operation ID before effects`, async () => {
			const stub = await parent();
			await runInDurableObject(stub, async (agent) => {
				await agent.installCompilationFixture();
				for (const id of [undefined, null, "", " "])
					await expect(agent.compileFixture(kind, id)).rejects.toThrow(
						/original run ID/,
					);
				expect(agent.compilationFixtureCounts()).toEqual({
					identity: 0,
					platform: 0,
					domains: 0,
					search: 0,
					rationale: 0,
				});
			});
		});
		it(`${kind} rejects a different operation ID before effects in an admitted root`, async () => {
			const stub = await parent();
			await runInDurableObject(stub, async (agent, ctx) => {
				await seedObserverClaim(agent, ctx);
				await agent.installCompilationFixture();
				await expect(
					agent.compileFixture(kind, "another-unaccepted-operation"),
				).rejects.toThrow();
				expect(agent.compilationFixtureCounts()).toEqual({
					identity: 0,
					platform: 0,
					domains: 0,
					search: 0,
					rationale: 0,
				});
			});
		});

		it(`${kind} propagates platform failure under the original admitted claim`, async () => {
			const stub = await parent();
			await runInDurableObject(stub, async (agent, ctx) => {
				const { accepted } = await seedObserverClaim(agent, ctx);
				await agent.installCompilationFixture(true);
				await expect(
					agent.compileFixture(kind, accepted.runId),
				).rejects.toThrow("scripted compilation platform failure");
				expect(agent.compilationFixtureCounts()).toMatchObject({
					identity: 1,
					platform: 1,
				});
			});
		});
		for (const epoch of ["admitted", "unselected"] as const)
			it(`${kind} keeps ${epoch} original maintenance operation routing and uncertain failures`, async () => {
				const stub = await parent();
				await runInDurableObject(stub, async (agent, ctx) => {
					const task =
						kind === "digest"
							? "isolate-brain-digest"
							: "isolate-directive-compile";
					const operation = {
						operationId: `maintenance:${kind}:${epoch}`,
						kind: "maintenance" as const,
						requestHash: "c".repeat(64),
						input: { taskId: task },
					};
					agent.setState({
						...agent.state,
						tediId: "native-tedi",
						orgId: "native-org",
					});
					if (epoch === "admitted") {
						const { admission } = await seedObserverClaim(
							agent,
							ctx,
							"setup-original",
						);
						await admission.beginAcceptedTurn({
							runId: operation.operationId,
							sessionKey: "maintenance-session",
							principalId: "service:maintenance",
							input: operation,
							expectedGeneration: 1,
						});
					}
					await agent.installCompilationFixture();
					const result = await agent.maintenanceCompilationFixture(
						task,
						operation,
					);
					expect(result).toMatchObject({
						operationId: operation.operationId,
						requestHash: operation.requestHash,
						taskId: task,
						status: "acknowledged",
					});
					const key = `tedix:pi:maintenance:effect:${operation.operationId}`;
					expect(await ctx.storage.get(key)).toMatchObject({
						operation,
						stage: "acknowledged",
					});
					expect(agent.compilationFixtureCounts()).toMatchObject({
						identity: 1,
						platform: 1,
					});
					if (kind === "digest")
						expect(agent.compilationFixtureCounts()).toMatchObject({
							domains: 1,
							search: 1,
						});
					else
						expect(agent.compilationFixtureCounts().rationale).toBeGreaterThan(
							0,
						);
					const failed = {
						...operation,
						operationId: operation.operationId + ":failed",
					};
					if (epoch === "admitted")
						await new RuntimeAdmissionDO(ctx.storage, {
							objectId: ctx.id.toString(),
							orgId: "native-org",
							tediId: "native-tedi",
						}).beginAcceptedTurn({
							runId: failed.operationId,
							sessionKey: "maintenance-session",
							principalId: "service:maintenance",
							input: failed,
							expectedGeneration: 1,
						});
					await agent.installCompilationFixture(true);
					expect(
						await agent.maintenanceCompilationFixture(task, failed),
					).toMatchObject({
						operationId: failed.operationId,
						status: "uncertain",
						reason: "failed",
					});
					expect(
						await ctx.storage.get(
							`tedix:pi:maintenance:effect:${failed.operationId}`,
						),
					).toMatchObject({ operation: failed, stage: "uncertain" });
				});
			});
	}
});
