import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { getAgentByName } from "agents";
import { expect, it } from "vite-plus/test";
import type { AgentTediDO } from "./worker";
const local = env as unknown as Cloudflare.Env;
const namespace =
	local.TEDI_AGENT as unknown as DurableObjectNamespace<AgentTediDO>;
async function seed(native = false, mode = "complete") {
	const name = "original-callback-" + crypto.randomUUID(),
		tediId = crypto.randomUUID(),
		orgId = crypto.randomUUID();
	await local.DB.exec(
		"CREATE TABLE IF NOT EXISTS tedis(id TEXT PRIMARY KEY,organization_id TEXT,slug TEXT,isolate_agent_id TEXT,runtime_kind TEXT,status TEXT)",
	);
	await local.DB.prepare("INSERT INTO tedis VALUES(?,?,?,?,?,?)")
		.bind(tediId, orgId, name, name, "agent", "active")
		.run();
	await local.DB.exec(
		"CREATE TABLE IF NOT EXISTS billing_historical_exposures(id TEXT PRIMARY KEY,organization_id TEXT,tedi_id TEXT,object_id TEXT,object_name TEXT,generation INTEGER,snapshot_id TEXT,source_hash TEXT,operation_id TEXT,request_hash TEXT,exposure TEXT,payload TEXT,observed_by TEXT,observed_user_id TEXT,observed_at TEXT)",
	);
	const root = await getAgentByName(namespace, name),
		result = await root.seed({ tediId, orgId }, native, mode);
	await abortAllDurableObjects();
	const raw = () => namespace.get(namespace.idFromName(name));
	const witness = async (
		path = ["original", "nested"],
		mutation?: { kind: string; value: unknown },
	) => JSON.parse(await raw().witness(path, mutation));
	const callback = {
		workflowName: "CHAT_TURN_WORKFLOW",
		workflowId: result.workflowId,
		type: "complete",
		result: { text: "PRIVATE original output" },
		timestamp: 1,
	};
	return { ...result, tediId, orgId, raw, witness, callback };
}
async function eventually<T>(
	read: () => Promise<T>,
	accept: (value: T) => boolean,
): Promise<T> {
	let value = await read();
	for (let n = 0; n < 100 && !accept(value); n++) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		value = await read();
	}
	expect(accept(value)).toBe(true);
	return value;
}
const core = (facts: Record<string, unknown>) =>
	Object.fromEntries(
		Object.entries(facts).filter(
			([key]) => key !== "observations" && key !== "verified",
		),
	);

async function retained(native = false, mode = "complete") {
	const s = await seed(native, mode);
	const exposure = (await s
		.raw()
		.freezeRoot()) as import("@tedix/api-contract/schemas/billing").HistoricalExposure;
	const freshName = "fresh-root-" + crypto.randomUUID();
	await local.DB.prepare("UPDATE tedis SET isolate_agent_id=? WHERE id=?")
		.bind(freshName, s.tediId)
		.run();
	return { ...s, exposure, freshName };
}
it.each(["complete", "error"])(
	"actual SDK origin %s survives recorded old-root/fresh-name split without starting fresh root",
	async (mode) => {
		const s = await retained(false, mode),
			before = await s.witness();
		const instance = await local.CHAT_TURN_WORKFLOW.get(s.workflowId);
		await instance.sendEvent({ type: "finish", payload: {} });
		const after = await eventually(
			() => s.witness(),
			(v) => v.observations.length === 1,
		);
		expect(core(after)).toEqual(core(before));
		expect(after.observations[0][1]).toMatchObject({
			providerAttested: false,
			provenance: { kind: "unknown", qualified: false },
		});
		await abortAllDurableObjects();
		expect(
			await s.raw().attempt(s.path, "_workflow_handleCallback", [
				mode === "complete"
					? s.callback
					: {
							workflowName: "CHAT_TURN_WORKFLOW",
							workflowId: s.workflowId,
							type: "error",
							error: "PRIVATE original error",
							timestamp: 9,
						},
			]),
		).toBe("observed");
		expect((await s.witness()).observations).toHaveLength(1);
		expect(
			(await local.DB.prepare("SELECT isolate_agent_id FROM tedis WHERE id=?")
				.bind(s.tediId)
				.first<{ isolate_agent_id: string }>())!.isolate_agent_id,
		).toBe(s.freshName);
	},
);
it("frozen original archive audit and exact capture retry survive split and eviction; no generic command qualification", async () => {
	const s = await retained(),
		before = await s.witness([]);
	for (const command of [
		"inspect_historical_custody",
		"capture_historical_custody",
		"audit_historical_custody",
	]) {
		const result = await s
			.raw()
			.historical(
				command,
				s.exposure.generation,
				command === "inspect_historical_custody"
					? undefined
					: s.exposure.sourceHash,
			);
		expect(result.status, result.body).toBe(200);
		expect(JSON.parse(result.body)).toMatchObject({
			snapshotId: s.exposure.snapshotId,
			sourceHash: s.exposure.sourceHash,
			generation: s.exposure.generation,
		});
	}
	await abortAllDurableObjects();
	expect(
		(
			await s
				.raw()
				.historical(
					"audit_historical_custody",
					s.exposure.generation,
					s.exposure.sourceHash,
				)
		).status,
	).toBe(200);
	expect(core(await s.witness([]))).toEqual(core(before));
	expect(await s.raw().attempt(s.path, "startFiber", [{}])).toBe("rejected");
	expect(
		(
			await s
				.raw()
				.historical("hold", s.exposure.generation, s.exposure.sourceHash)
		).status,
	).not.toBe(200);
});
it("genuine original claim remains running/UNKNOWN; final D1 recheck follows its awaited verification", async () => {
	const s = await retained(true),
		before = await s.witness();
	expect(
		await s.raw().attempt(s.path, "_workflow_handleCallback", [s.callback]),
	).toBe("observed");
	expect((await s.witness()).observations[0][1].provenance.kind).toBe(
		"stored_native_dispatch",
	);
	await s.witness(undefined, { kind: "fixture:claim-race", value: true });
	expect(
		await s.raw().attempt(s.path, "_workflow_handleCallback", [
			{
				workflowName: "CHAT_TURN_WORKFLOW",
				workflowId: s.workflowId,
				type: "error",
				error: "late",
				timestamp: 2,
			},
		]),
	).toBe("rejected");
	const after = await s.witness();
	expect(after.verified).toBe("original-run");
	expect(after.claims).toEqual(before.claims);
	expect(after.observations).toHaveLength(1);
});
it.each(["missing", "cross-org", "leaf-only", "hash", "generation"])(
	"refuses %s recorded custody without original observations",
	async (kind) => {
		const s = await retained();
		if (kind === "missing")
			await local.DB.prepare(
				"DELETE FROM billing_historical_exposures WHERE tedi_id=?",
			)
				.bind(s.tediId)
				.run();
		if (kind === "cross-org")
			await local.DB.prepare("UPDATE tedis SET organization_id=? WHERE id=?")
				.bind(crypto.randomUUID(), s.tediId)
				.run();
		if (kind === "leaf-only")
			await local.DB.prepare(
				"UPDATE billing_historical_exposures SET payload=json_set(payload,'$.targetPath',json('[{}]')) WHERE tedi_id=?",
			)
				.bind(s.tediId)
				.run();
		if (kind === "hash")
			await local.DB.prepare(
				"UPDATE billing_historical_exposures SET request_hash=? WHERE tedi_id=?",
			)
				.bind("f".repeat(64), s.tediId)
				.run();
		if (kind === "generation")
			await local.DB.prepare(
				"UPDATE billing_historical_exposures SET generation=generation+1 WHERE tedi_id=?",
			)
				.bind(s.tediId)
				.run();
		expect(
			await s.raw().attempt(s.path, "_workflow_handleCallback", [s.callback]),
		).toBe("rejected");
		expect((await s.witness()).observations).toHaveLength(0);
	},
);
it("archive corruption fails closed after split", async () => {
	const s = await retained();
	await s.witness([], { kind: "archive_corrupt", value: true });
	expect(
		await s.raw().attempt(s.path, "_workflow_handleCallback", [s.callback]),
	).toBe("rejected");
	expect((await s.witness()).observations).toHaveLength(0);
});

it("original archived workflow rows still receive late observations after a distinct fresh root selection", async () => {
	const s = await retained();
	await s.witness(undefined, { kind: "archive", value: true });
	const before = await s.witness();
	expect(before.workflows).toHaveLength(0);
	expect(
		await s.raw().attempt(s.path, "_workflow_handleCallback", [s.callback]),
	).toBe("observed");
	await abortAllDurableObjects();
	expect(
		await s.raw().attempt(s.path, "_workflow_handleCallback", [s.callback]),
	).toBe("observed");
	const after = await s.witness();
	expect(after.workflows).toHaveLength(0);
	expect(after.observations).toHaveLength(1);
	expect(core(after)).toEqual(core(before));
});
it.each(["registry", "exposure", "canonical"])(
	"final awaited D1 %s race rejects without original observations",
	async (kind) => {
		const s = await retained();
		await s.witness([], { kind: "fixture:db-race", value: kind });
		expect(
			await s.raw().attempt(s.path, "_workflow_handleCallback", [s.callback]),
		).toBe("rejected");
		expect((await s.witness()).observations).toHaveLength(0);
	},
);
it("active original epoch is never qualified by historical evidence", async () => {
	const s = await retained();
	// Test-only custody corruption, not a release or activation authorization.
	await s.witness([], {
		kind: "registry",
		value:
			"UPDATE runtime_admission SET record=json_set(record,'$.state','active')",
	});
	expect(
		await s.raw().attempt(s.path, "_workflow_handleCallback", [s.callback]),
	).toBe("rejected");
	expect(
		(
			await s
				.raw()
				.historical(
					"audit_historical_custody",
					s.exposure.generation,
					s.exposure.sourceHash,
				)
		).status,
	).not.toBe(200);
});

it.each(["complete", "error"])(
	"genuine original ROOT SDK %s preserves claim after fresh name selection and cold retry",
	async (mode) => {
		const name = "root-origin-" + crypto.randomUUID(),
			tediId = crypto.randomUUID(),
			orgId = crypto.randomUUID();
		await local.DB.exec(
			"CREATE TABLE IF NOT EXISTS tedis(id TEXT PRIMARY KEY,organization_id TEXT,slug TEXT,isolate_agent_id TEXT,runtime_kind TEXT,status TEXT)",
		);
		await local.DB.exec(
			"CREATE TABLE IF NOT EXISTS billing_historical_exposures(id TEXT PRIMARY KEY,organization_id TEXT,tedi_id TEXT,object_id TEXT,object_name TEXT,generation INTEGER,snapshot_id TEXT,source_hash TEXT,operation_id TEXT,request_hash TEXT,exposure TEXT,payload TEXT,observed_by TEXT,observed_user_id TEXT,observed_at TEXT)",
		);
		await local.DB.prepare("INSERT INTO tedis VALUES(?,?,?,?,?,?)")
			.bind(tediId, orgId, name, name, "agent", "active")
			.run();
		const root = await getAgentByName(namespace, name),
			result = await root.seedRoot({ tediId, orgId }, mode);
		await abortAllDurableObjects();
		const raw = () => namespace.get(namespace.idFromName(name));
		const exposure =
			(await raw().freezeRoot()) as import("@tedix/api-contract/schemas/billing").HistoricalExposure;
		await local.DB.prepare("UPDATE tedis SET isolate_agent_id=? WHERE id=?")
			.bind("fresh-" + crypto.randomUUID(), tediId)
			.run();
		const witness = async () => JSON.parse(await raw().witness([])),
			before = await witness();
		const instance = await local.CHAT_TURN_WORKFLOW.get(result.workflowId);
		await instance.sendEvent({ type: "finish", payload: {} });
		const after = await eventually(witness, (v) => v.observations.length === 1);
		expect(core(after)).toEqual(core(before));
		expect(after.observations[0][1].provenance.kind).toBe(
			"stored_native_dispatch",
		);
		expect(
			(
				await raw().historical(
					"audit_historical_custody",
					exposure.generation,
					exposure.sourceHash,
				)
			).status,
		).toBe(200);
		const callback =
			mode === "complete"
				? {
						workflowName: "CHAT_TURN_WORKFLOW",
						workflowId: result.workflowId,
						type: "complete",
						result: { text: "PRIVATE original output" },
						timestamp: 9,
					}
				: {
						workflowName: "CHAT_TURN_WORKFLOW",
						workflowId: result.workflowId,
						type: "error",
						error: "PRIVATE original error",
						timestamp: 9,
					};
		await abortAllDurableObjects();
		expect(await raw().rootAttempt(callback)).toBe("observed");
		expect((await witness()).observations).toHaveLength(1);
		expect((await witness()).claims).toEqual(before.claims);
	},
);
