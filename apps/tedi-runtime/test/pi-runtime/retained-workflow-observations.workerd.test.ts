import { env } from "cloudflare:workers";
import { runInDurableObject, evictDurableObject } from "cloudflare:test";
import { getAgentByName, type Agent } from "agents";
import { expect, it, vi } from "vite-plus/test";
import { RuntimeAdmissionDO } from "../../src/runtime-admission-do";
import { RawCutoverDO } from "../../src/pi-cutover-maintenance-do";
const local = env as unknown as Cloudflare.Env & {
	PI_CUTOVER_EARLY: DurableObjectNamespace<RawCutoverDO>;
};
const complete = {
	workflowName: "CHAT_TURN_WORKFLOW",
	workflowId: "provider-id",
	type: "complete",
	result: { text: "PRIVATE result", stopReason: "done", toolCalls: [] },
	timestamp: 123,
};
async function seed(native = false) {
	const name = "retained-" + crypto.randomUUID(),
		owner = {
			tediId: crypto.randomUUID(),
			orgId: crypto.randomUUID(),
			objectId: local.PI_CUTOVER_EARLY.idFromName(name).toString(),
		};
	await local.DB.exec(
		"CREATE TABLE IF NOT EXISTS tedis(id TEXT PRIMARY KEY,organization_id TEXT,slug TEXT,isolate_agent_id TEXT,runtime_kind TEXT,status TEXT)",
	);
	await local.DB.prepare("INSERT INTO tedis VALUES(?,?,?,?,?,?)")
		.bind(owner.tediId, owner.orgId, name, name, "agent", "active")
		.run();
	const raw = local.PI_CUTOVER_EARLY.get(
		local.PI_CUTOVER_EARLY.idFromName(name),
	);
	await runInDurableObject(raw, async (_, ctx) => {
		ctx.storage.sql.exec(
			"CREATE TABLE cf_agents_state(id TEXT PRIMARY KEY,state TEXT)",
		);
		ctx.storage.sql.exec(
			"INSERT INTO cf_agents_state VALUES('cf_state_row_id',?)",
			JSON.stringify(owner),
		);
		ctx.storage.kv.put("__ps_name", name);
		const admission = new RuntimeAdmissionDO(ctx.storage, owner);
		admission.gate.initialize({
			operationId: "baseline",
			state: "active",
			evidence: await admission.prepareEvidence("initialize"),
		});
		if (native) {
			await admission.beginAcceptedTurn({
				runId: "original",
				sessionKey: "session",
				principalId: "original-principal",
				input: { text: "PRIVATE original input" },
				expectedGeneration: 1,
			});
			ctx.storage.kv.put("runtime-admission-workflow:original", {
				id: complete.workflowId,
				stage: "dispatched",
				params: { runId: "original", sessionKey: "session", userTs: 1 },
			});
		}
		admission.gate.quarantine({
			operationId: "explicit-quarantine",
			expectedGeneration: 1,
			reason: "fixture",
		});
		ctx.storage.sql.exec(
			"CREATE TABLE cf_agents_workflows(id TEXT PRIMARY KEY,workflow_id TEXT NOT NULL UNIQUE,workflow_name TEXT NOT NULL,status TEXT NOT NULL,metadata TEXT,completed_at INTEGER)",
		);
		ctx.storage.sql.exec(
			"INSERT INTO cf_agents_workflows VALUES('local-id',?,'CHAT_TURN_WORKFLOW','queued','PRIVATE metadata',NULL)",
			complete.workflowId,
		);
	});
	return { name, owner, raw };
}
async function named(name: string, props?: object) {
	return (await getAgentByName(
		local.PI_CUTOVER_EARLY as unknown as DurableObjectNamespace<Agent>,
		name,
		{ props },
	)) as unknown as DurableObjectStub<RawCutoverDO>;
}
async function facts(raw: DurableObjectStub<RawCutoverDO>) {
	return runInDurableObject(raw, async (_, ctx) => ({
		workflows: ctx.storage.sql
			.exec("SELECT * FROM cf_agents_workflows")
			.toArray(),
		admission: ctx.storage.sql
			.exec("SELECT * FROM runtime_admission")
			.toArray(),
		claims: ctx.storage.sql
			.exec(
				"SELECT name FROM sqlite_master WHERE name='runtime_admission_turns'",
			)
			.toArray().length
			? ctx.storage.sql.exec("SELECT * FROM runtime_admission_turns").toArray()
			: [],
		kv: [...ctx.storage.kv.list()].filter(
			([key]) => !key.startsWith("runtime-workflow-observation:v1:"),
		),
	}));
}
async function callback(
	stub: DurableObjectStub<RawCutoverDO>,
	input: unknown,
): Promise<void> {
	await stub._workflow_handleCallback(input);
}
async function observations(raw: DurableObjectStub<RawCutoverDO>) {
	return runInDurableObject(raw, async (_, ctx) =>
		[
			...ctx.storage.kv.list({ prefix: "runtime-workflow-observation:v1:" }),
		].map(([, value]) => value as Record<string, unknown>),
	);
}
it.each([false, true])(
	"actual SDK cold callbacks retain private unqualified observation, native=%s",
	async (native) => {
		const f = await seed(native),
			before = await facts(f.raw),
			log = vi.spyOn(console, "log"),
			error = vi.spyOn(console, "error");
		try {
			await (await named(f.name))._workflow_handleCallback(complete);
			await evictDurableObject(f.raw);
			await (
				await named(f.name)
			)._workflow_handleCallback({ ...complete, timestamp: 456 });
			const rows = await observations(f.raw);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				providerAttested: false,
				kind: "unqualified_namespace_rpc_observation",
				provenance: {
					kind: native ? "stored_native_dispatch" : "unknown",
					qualified: false,
				},
			});
			expect(await facts(f.raw)).toEqual(before);
			expect(log).not.toHaveBeenCalled();
			expect(error).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
			error.mockRestore();
		}
	},
);
it("conflicting completion rejects, distinct attempt errors remain observations before completion", async () => {
	const f = await seed(),
		stub = await named(f.name),
		before = await facts(f.raw);
	for (const error of ["PRIVATE attempt one", "PRIVATE attempt two"]) {
		await callback(stub, {
			workflowName: complete.workflowName,
			workflowId: complete.workflowId,
			type: "error",
			error,
			timestamp: 123,
		});
	}
	await callback(stub, complete);
	await expect(
		callback(stub, { ...complete, result: { changed: true } }),
	).rejects.toThrow("Retained workflow observation rejected");
	expect(await observations(f.raw)).toHaveLength(3);
	expect(await facts(f.raw)).toEqual(before);
});
it.each([
	"wrong-owner",
	"wrong-name",
	"wrong-d1",
	"missing-admission",
	"props",
	"wrong-workflow",
	"wrong-binding",
	"malformed-journal",
])("refuses %s without callback writes", async (mode) => {
	const f = await seed(mode === "malformed-journal");
	await runInDurableObject(f.raw, async (_, ctx) => {
		if (mode === "wrong-owner")
			ctx.storage.sql.exec(
				"UPDATE cf_agents_state SET state=?",
				JSON.stringify({ ...f.owner, orgId: "foreign" }),
			);
		if (mode === "wrong-name") ctx.storage.kv.put("__ps_name", "wrong");
		if (mode === "missing-admission")
			ctx.storage.sql.exec("DELETE FROM runtime_admission");
		if (mode === "malformed-journal")
			ctx.storage.kv.put("runtime-admission-workflow:original", {
				id: complete.workflowId,
				stage: "dispatched",
				params: { runId: "other", sessionKey: "session" },
			});
	});
	if (mode === "wrong-d1")
		await local.DB.prepare(
			"UPDATE tedis SET organization_id='foreign' WHERE id=?",
		)
			.bind(f.owner.tediId)
			.run();
	const before = await facts(f.raw);
	await expect(
		(async () => {
			const stub = await named(
				f.name,
				mode === "props" ? { anything: true } : undefined,
			);
			await callback(stub, {
				...complete,
				...(mode === "wrong-workflow" ? { workflowId: "unknown" } : {}),
				...(mode === "wrong-binding" ? { workflowName: "OTHER" } : {}),
			});
		})(),
	).rejects.toThrow("Retained workflow observation rejected");
	expect(await observations(f.raw)).toHaveLength(0);
	expect(await facts(f.raw)).toEqual(before);
});
it("HTTP cannot expose the callback RPC", async () => {
	const f = await seed(),
		before = await facts(f.raw);
	const response = await f.raw.fetch(
		new Request("https://fixture/_workflow_handleCallback", {
			method: "POST",
			body: JSON.stringify(complete),
		}),
	);
	expect(response.status).not.toBe(200);
	expect(await observations(f.raw)).toHaveLength(0);
	expect(await facts(f.raw)).toEqual(before);
});

it("optional SDK completion result stays explicitly absent, not null", async () => {
	const f = await seed(),
		stub = await named(f.name);
	const { result: _, ...absent } = complete;
	await callback(stub, absent);
	expect((await observations(f.raw))[0]).toMatchObject({
		payload: { type: "complete", resultPresence: "absent" },
	});
	await expect(callback(stub, { ...complete, result: null })).rejects.toThrow(
		"Retained workflow observation rejected",
	);
});
it.each(["payload", "owner", "metadata", "null", "scalar"])(
	"tampered retained observation %s never qualifies a repeat",
	async (part) => {
		const f = await seed(),
			stub = await named(f.name);
		await callback(stub, complete);
		await runInDurableObject(f.raw, async (_, ctx) => {
			const [key, value] = [
				...ctx.storage.kv.list<Record<string, unknown>>({
					prefix: "runtime-workflow-observation:v1:",
				}),
			][0]!;
			ctx.storage.kv.put(
				key,
				part === "null"
					? null
					: part === "scalar"
						? 0
						: {
								...value,
								...(part === "payload"
									? {
											payload: { type: "complete", result: { tampered: true } },
										}
									: part === "owner"
										? { owner: { foreign: true } }
										: { sourceRowHash: "0".repeat(64) }),
							},
			);
		});
		const before = await observations(f.raw);
		await expect(
			callback(stub, { ...complete, timestamp: 999 }),
		).rejects.toThrow("Retained workflow observation rejected");
		expect(await observations(f.raw)).toEqual(before);
	},
);
it.each(["epoch", "row", "owner"])(
	"D1 awaited %s change rejects without observation",
	async (kind) => {
		const f = await seed(),
			stub = await named(f.name);
		await runInDurableObject(f.raw, async (_, ctx) => {
			ctx.storage.kv.put("fixture:retained-callback-race", {
				kind,
				owner: f.owner,
				workflowId: complete.workflowId,
			});
		});
		await expect(callback(stub, complete)).rejects.toThrow(
			"Retained workflow observation rejected",
		);
		expect(await observations(f.raw)).toHaveLength(0);
	},
);
it("unknown callback extra fields are rejected privately", async () => {
	const f = await seed(),
		stub = await named(f.name),
		before = await facts(f.raw);
	await expect(
		callback(stub, { ...complete, extra: "PRIVATE" }),
	).rejects.toThrow("Retained workflow observation rejected");
	expect(await facts(f.raw)).toEqual(before);
	expect(await observations(f.raw)).toHaveLength(0);
});
