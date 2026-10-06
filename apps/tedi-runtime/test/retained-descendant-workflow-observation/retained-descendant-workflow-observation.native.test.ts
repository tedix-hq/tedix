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
it.each(["complete", "error"])(
	"actual AgentWorkflow facet origin reports %s through cold nested Raw with original facts unchanged",
	async (mode) => {
		const s = await seed(false, mode),
			before = await s.witness();
		const instance = await local.CHAT_TURN_WORKFLOW.get(s.workflowId);
		await instance.sendEvent({ type: "finish", payload: {} });
		const after = await eventually(
			() => s.witness(),
			(value) => value.observations.length === 1,
		);
		expect(core(after)).toEqual(core(before));
		const record = after.observations[0][1];
		expect(record).toMatchObject({
			kind: "unqualified_namespace_rpc_observation",
			providerAttested: false,
			workflowId: s.workflowId,
			provenance: {
				kind: "unknown",
				nativeDispatch: "absent",
				qualified: false,
			},
			payload: { type: mode },
		});
		expect(after.workflows[0].status).toBe("queued");
		expect(
			(
				await eventually(
					() => instance.status(),
					(value) => value.status === "complete",
				)
			).output,
		).toBe("reported");
		await abortAllDurableObjects();
		expect(core(await s.witness())).toEqual(core(before));
	},
);
it("deduplicates original complete after eviction, rejects conflicts and observes distinct late errors without outcomes", async () => {
	const s = await seed(),
		before = await s.witness();
	expect(
		await s.raw().attempt(s.path, "_workflow_handleCallback", [s.callback]),
	).toBe("observed");
	await abortAllDurableObjects();
	expect(
		await s
			.raw()
			.attempt(s.path, "_workflow_handleCallback", [
				{ ...s.callback, timestamp: 99 },
			]),
	).toBe("observed");
	expect(
		await s
			.raw()
			.attempt(s.path, "_workflow_handleCallback", [
				{ ...s.callback, result: { text: "conflict" } },
			]),
	).toBe("rejected");
	const error = {
		workflowName: "CHAT_TURN_WORKFLOW",
		workflowId: s.workflowId,
		type: "error",
		error: "PRIVATE late error",
		timestamp: 2,
	};
	expect(
		await s.raw().attempt(s.path, "_workflow_handleCallback", [error]),
	).toBe("observed");
	expect(
		await s.raw().attempt(s.path, "_workflow_handleCallback", [error]),
	).toBe("observed");
	const after = await s.witness();
	expect(after.observations).toHaveLength(2);
	expect(core(after)).toEqual(core(before));
});
it("genuine original claim stays running and await-time canonical mutation denies before observation", async () => {
	const s = await seed(true),
		before = await s.witness();
	expect(
		await s.raw().attempt(s.path, "_workflow_handleCallback", [s.callback]),
	).toBe("observed");
	expect(JSON.parse(before.claims[0].record).status).toBe("running");
	let after = await s.witness();
	expect(after.observations[0][1].provenance.kind).toBe(
		"stored_native_dispatch",
	);
	expect(core(after)).toEqual(core(before));
	await s.witness(undefined, { kind: "fixture:claim-race", value: true });
	const error = {
		workflowName: "CHAT_TURN_WORKFLOW",
		workflowId: s.workflowId,
		type: "error",
		error: "PRIVATE late",
		timestamp: 4,
	};
	expect(
		await s.raw().attempt(s.path, "_workflow_handleCallback", [error]),
	).toBe("rejected");
	after = await s.witness();
	expect(after.verified).toBe("original-run");
	expect(after.observations).toHaveLength(1);
	expect(after.claims).toEqual(before.claims);
	expect(after.identities).toEqual(before.identities);
	expect(after.admission).toEqual(before.admission);
	expect(after.original).toEqual(before.original);
});
it("uses fully audited original workflow after actual tracking retirement, rejects corrupt archive", async () => {
	const s = await seed(),
		before = await s.witness();
	await s.witness(undefined, { kind: "archive", value: null });
	expect((await s.witness()).workflows).toEqual([]);
	expect(
		await s.raw().attempt(s.path, "_workflow_handleCallback", [s.callback]),
	).toBe("observed");
	await abortAllDurableObjects();
	expect(
		await s.raw().attempt(s.path, "_workflow_handleCallback", [s.callback]),
	).toBe("observed");
	const after = await s.witness();
	expect(after.observations).toHaveLength(1);
	expect(after.admission).toEqual(before.admission);
	expect(after.original).toEqual(before.original);
	await s.witness(undefined, { kind: "archive_corrupt", value: null });
	expect(
		await s.raw().attempt(s.path, "_workflow_handleCallback", [s.callback]),
	).toBe("rejected");
	expect((await s.witness()).observations).toEqual(after.observations);
});
it("strict method, payload and original path refusals do not create observations", async () => {
	const s = await seed(),
		before = await s.witness();
	for (const [path, method, args] of [
		[s.path, "fetch", [s.callback]],
		[s.path, "startFiber", [s.callback]],
		[s.path, "_workflow_handleCallback", []],
		[s.path, "_workflow_handleCallback", [s.callback, s.callback]],
		[s.path, "_workflow_handleCallback", [{ ...s.callback, type: "progress" }]],
		[
			s.path.map((part, n) => (n === 0 ? { ...part, name: "forged" } : part)),
			"_workflow_handleCallback",
			[s.callback],
		],
		[
			s.path.map((part, n) => (n === 2 ? { ...part, name: "missing" } : part)),
			"_workflow_handleCallback",
			[s.callback],
		],
	])
		expect(await s.raw().attempt(path, method, args)).toBe("rejected");
	expect(await s.witness()).toEqual(before);
});
it("inconsistent original registry identity pairs and tampered leaf markers refuse without changing source", async () => {
	const s = await seed(),
		before = await s.witness(),
		parent = await s.witness(["original"]),
		row = parent.registry[0];
	for (const sql of [
		"UPDATE cf_agents_sub_agents SET identity_version='path-v2',identity_name=NULL",
		"UPDATE cf_agents_sub_agents SET identity_version=NULL,identity_name='forged'",
	]) {
		await s.witness(["original"], { kind: "registry", value: sql });
		expect(
			await s.raw().attempt(s.path, "_workflow_handleCallback", [s.callback]),
		).toBe("rejected");
		await s.witness(["original"], {
			kind: "registry",
			value: `UPDATE cf_agents_sub_agents SET identity_version='${row.identity_version}',identity_name='${row.identity_name}'`,
		});
	}
	for (const [bad, restore] of [
		[
			{ kind: "cf_agents_parent_path", value: [] },
			{ kind: "cf_agents_parent_path", value: before.path },
		],
		[
			{ kind: "cf_agents_facet_name", value: "forged" },
			{ kind: "cf_agents_facet_name", value: before.facetName },
		],
		[
			{
				kind: "tenant",
				value: { aigMetadata: { tediId: crypto.randomUUID(), orgId: s.orgId } },
			},
			{ kind: "tenant", value: JSON.parse(before.state[0].state) },
		],
	]) {
		await s.witness(undefined, bad!);
		expect(
			await s.raw().attempt(s.path, "_workflow_handleCallback", [s.callback]),
		).toBe("rejected");
		await s.witness(undefined, restore!);
	}
	expect(await s.witness()).toEqual(before);
});
it("unsupported warm original facet cannot be replaced or initialized by the receipt relay", async () => {
	const s = await seed(),
		before = await s.witness();
	const starts = await s.raw().warmOriginal(["original", "nested"]);
	expect(starts).toBeGreaterThan(before.starts);
	expect(
		await s.raw().attempt(s.path, "_workflow_handleCallback", [s.callback]),
	).toBe("rejected");
	await abortAllDurableObjects();
	const after = await s.witness();
	expect(after.observations).toEqual([]);
	expect(after.claims).toEqual(before.claims);
	expect(after.original).toEqual(before.original);
});

it.each(["registry", "epoch"])(
	"actual canonical await rechecks %s before any observation",
	async (race) => {
		const s = await seed(),
			before = await s.witness(),
			parent = await s.witness([]);
		const target = race === "registry" ? [] : ["original", "nested"];
		await s.witness(target, { kind: "fixture:db-race", value: race });
		expect(
			await s.raw().attempt(s.path, "_workflow_handleCallback", [s.callback]),
		).toBe("rejected");
		if (race === "registry") {
			const row = parent.registry[0];
			await s.witness([], {
				kind: "registry",
				value: `UPDATE cf_agents_sub_agents SET identity_name='${row.identity_name}' WHERE name='${row.name}'`,
			});
		}
		const after = await s.witness();
		expect(after.observations).toEqual([]);
		expect(after.workflows).toEqual(before.workflows);
		expect(after.claims).toEqual(before.claims);
		expect(after.original).toEqual(before.original);
		if (race === "epoch")
			expect(JSON.parse(after.admission[0].record).generation).toBe(
				JSON.parse(before.admission[0].record).generation + 1,
			);
	},
);
