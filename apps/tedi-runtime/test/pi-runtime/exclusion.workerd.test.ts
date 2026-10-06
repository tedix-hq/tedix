import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { expect, it as test } from "vite-plus/test";
import type {
	ExclusionAgent,
	ExclusionBarrier,
	ExclusionChild,
} from "./exclusion-worker";
const local = env as unknown as {
	DB: D1Database;
	EXCLUSION_TEST_LANE?: string;
	TEDI_AGENT: DurableObjectNamespace<ExclusionAgent>;
	EXCLUSION_BARRIER: DurableObjectNamespace<ExclusionBarrier>;
};
// A broken dedicated configuration must fail rather than silently skip its proof.
if (local.EXCLUSION_TEST_LANE === "dedicated" && !local.EXCLUSION_BARRIER)
	throw new Error("Dedicated exclusion fixture binding unavailable");
// The general Worker lane intentionally lacks this dedicated fixture binding.
const it = test.skipIf(!local.EXCLUSION_BARRIER);
const TOKEN = "exclusion-native-token",
	URL = "https://fixture/__admin/pi-state-cutover";
async function seed() {
	const name = "exclusion-" + crypto.randomUUID(),
		id = local.TEDI_AGENT.idFromName(name);
	const owner = {
		tediId: crypto.randomUUID(),
		orgId: crypto.randomUUID(),
		objectId: id.toString(),
	};
	await local.DB.exec(
		"CREATE TABLE IF NOT EXISTS tedis(id TEXT PRIMARY KEY,organization_id TEXT,slug TEXT,isolate_agent_id TEXT,runtime_kind TEXT,status TEXT)",
	);
	await local.DB.prepare("INSERT INTO tedis VALUES(?,?,?,?,?,?)")
		.bind(owner.tediId, owner.orgId, name, name, "agent", "active")
		.run();
	const stub = await getAgentByName(local.TEDI_AGENT, name);
	await stub.initializeFixture(owner, name);
	return {
		name,
		owner,
		stub,
		barrier: local.EXCLUSION_BARRIER.get(
			local.EXCLUSION_BARRIER.idFromName(id.toString()),
		),
	};
}
function request(
	f: Awaited<ReturnType<typeof seed>>,
	command: string,
	generation: number,
	extra = {},
) {
	return new Request(URL, {
		method: "POST",
		headers: { "X-Tedix-Admin-Token": TOKEN },
		body: JSON.stringify({
			command,
			objectId: f.owner.objectId,
			operationId: crypto.randomUUID(),
			expectedGeneration: generation,
			custody: {
				tediId: f.owner.tediId,
				orgId: f.owner.orgId,
				objectName: f.name,
			},
			...(command === "quarantine" ? { reasonCode: "operator_hold" } : {}),
			...extra,
		}),
	});
}
async function snapshot(stub: DurableObjectStub<ExclusionAgent>) {
	return runInDurableObject(stub, (_, ctx) => ({
		kv: [...ctx.storage.kv.list()],
		tables: ctx.storage.sql
			.exec<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%' ORDER BY name",
			)
			.toArray()
			.map(({ name }) => ({
				name,
				rows: ctx.storage.sql
					.exec(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
					.toArray(),
			})),
	}));
}
async function entered(
	barrier: DurableObjectStub<ExclusionBarrier>,
	kind: string,
) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (await barrier.entered(kind)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Actual event did not enter " + kind);
}
it("actual warm SDK callback interrupted by real abort; cold production Raw preserves source", async () => {
	const f = await seed();
	const pending = f.stub
		._workflow_handleCallback({
			workflowName: "CHAT_TURN_WORKFLOW",
			workflowId: "provider-original",
			type: "complete",
			result: { text: "original" },
			timestamp: Date.now(),
		})
		.catch(() => "interrupted");
	await entered(f.barrier, "callback");
	expect((await f.stub.fetch(request(f, "quarantine", 1))).status).toBe(200);
	const before = await snapshot(f.stub);
	await expect(
		f.stub.fetch(request(f, "exclude_writers", 2)),
	).rejects.toThrow();
	const raw = local.TEDI_AGENT.get(local.TEDI_AGENT.idFromName(f.name));
	expect(
		await (
			await raw.fetch(
				new Request(URL, { headers: { "X-Tedix-Admin-Token": TOKEN } }),
			)
		).json(),
	).toMatchObject({
		receiver: "raw-cutover-v1",
		id: f.owner.objectId,
		admission: { state: "quarantined", generation: 2 },
	});
	await f.barrier.release("callback");
	await pending;
	expect(await snapshot(raw)).toEqual(before);
});
it("actual delivered platform alarm interrupted; entered scheduler intent preserved", async () => {
	const f = await seed();
	await f.stub.queueAlarm();
	await entered(f.barrier, "alarm");
	expect((await f.stub.fetch(request(f, "quarantine", 1))).status).toBe(200);
	const before = await snapshot(f.stub);
	await expect(
		f.stub.fetch(request(f, "exclude_writers", 2)),
	).rejects.toThrow();
	await f.barrier.release("alarm");
	const raw = local.TEDI_AGENT.get(local.TEDI_AGENT.idFromName(f.name));
	expect(
		await (
			await raw.fetch(
				new Request(URL, { headers: { "X-Tedix-Admin-Token": TOKEN } }),
			)
		).json(),
	).toMatchObject({ receiver: "raw-cutover-v1" });
	expect(await snapshot(raw)).toEqual(before); // This proves real alarm interruption, not platform retry disposition.
	// Local retry-enabled control did not expose a retry event; source pins retryAlarm:false.

	expect(await snapshot(raw)).toEqual(before);
});
it("active, stale generation, wrong owner and nested requests do not reset warm receiver", async () => {
	const f = await seed();
	for (const req of [
		request(f, "exclude_writers", 1),
		request(f, "exclude_writers", 2),
		request(f, "exclude_writers", 1, { custody: null }),
		request(f, "exclude_writers", 1, { targetPath: [] }),
	])
		expect((await f.stub.fetch(req)).status).not.toBe(200);
	expect((await f.stub.fetch(request(f, "quarantine", 1))).status).toBe(200);
	const before = await snapshot(f.stub);
	for (const req of [
		request(f, "exclude_writers", 1),
		request(f, "exclude_writers", 2, {
			custody: {
				tediId: f.owner.tediId,
				orgId: crypto.randomUUID(),
				objectName: f.name,
			},
		}),
	])
		expect((await f.stub.fetch(req)).status).not.toBe(200);
	expect(await snapshot(f.stub)).toEqual(before);
});

it.each(["owner", "epoch"])(
	"actual awaited D1 boundary %s race refuses abort",
	async (kind) => {
		const f = await seed();
		expect((await f.stub.fetch(request(f, "quarantine", 1))).status).toBe(200);
		await runInDurableObject(f.stub, (_, ctx) =>
			ctx.storage.kv.put("fixture:exclusion-race", kind),
		);
		const response = await f.stub.fetch(request(f, "exclude_writers", 2));
		expect(response.status).toBe(409);
		expect(await f.stub.ping()).toBe("warm-sdk");
	},
);
it("unauthenticated and forwarded facet custody deny without altering storage or warm receiver", async () => {
	const f = await seed();
	expect((await f.stub.fetch(request(f, "quarantine", 1))).status).toBe(200);
	const before = await snapshot(f.stub);
	for (const header of [
		"X-Tedix-Admin-Token",
		"X-Tedix-Cutover-Facet-Custody",
		"X-Tedix-Cutover-Inspection-Custody",
	]) {
		const req = request(f, "exclude_writers", 2);
		req.headers.set(header, "PRIVATE forged");
		expect((await f.stub.fetch(req)).status).not.toBe(200);
	}
	expect(await f.stub.ping()).toBe("warm-sdk");
	expect(await snapshot(f.stub)).toEqual(before);
	const warm = await f.stub.fetch(
		new Request(URL, { headers: { "X-Tedix-Admin-Token": TOKEN } }),
	);
	expect(await warm.json()).not.toHaveProperty("receiver");
});

it("actual Raw ancestor cannot certify a warm registered child as Raw", async () => {
	const f = await seed();
	expect((await f.stub.fetch(request(f, "quarantine", 1))).status).toBe(200);
	await expect(
		f.stub.fetch(request(f, "exclude_writers", 2)),
	).rejects.toThrow();
	const raw = local.TEDI_AGENT.get(local.TEDI_AGENT.idFromName(f.name));
	const childName = "child-" + crypto.randomUUID(),
		childId = local.TEDI_AGENT.idFromName(childName);
	await runInDurableObject(raw, async (_, ctx) => {
		ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS cf_agents_sub_agents(class TEXT NOT NULL,name TEXT NOT NULL,created_at INTEGER NOT NULL,identity_version TEXT,identity_name TEXT,PRIMARY KEY(class,name))",
		);
		ctx.storage.sql.exec(
			"INSERT INTO cf_agents_sub_agents VALUES('ExclusionChild',?,?,NULL,NULL)",
			childName,
			Date.now(),
		);
		const native = ctx as DurableObjectState & {
			exports: { ExclusionChild: DurableObjectNamespace };
		};
		const child = ctx.facets.get(`ExclusionChild\0${childName}`, () => ({
			class: native.exports.ExclusionChild,
			id: childId,
		})) as unknown as DurableObjectStub<ExclusionChild>;
		await child.initializeChild({
			owner: f.owner,
			rootId: f.owner.objectId,
			name: childName,
			rootName: f.name,
		});
	});
	const custody = {
		tediId: f.owner.tediId,
		orgId: f.owner.orgId,
		objectName: f.name,
		rootId: f.owner.objectId,
		parentPath: [],
		current: null,
	};
	const headers = {
		"X-Tedix-Admin-Token": TOKEN,
		"X-Tedix-Cutover-Inspection-Custody": JSON.stringify(custody),
	};
	const rootResponse = await raw.fetch(new Request(URL, { headers }));
	const root = (await rootResponse.json()) as {
		receiver: string;
		inspectionTargets: unknown[];
	};
	expect(root.receiver).toBe("raw-cutover-v1");
	expect(root.inspectionTargets).toHaveLength(1);
	const nested = await raw.fetch(
		new Request(
			URL +
				"?targetPath=" +
				encodeURIComponent(JSON.stringify(root.inspectionTargets)),
			{ headers },
		),
	);
	expect(nested.status).toBe(200);
	const leaf = await nested.json();
	expect(leaf).toMatchObject({ id: childId.toString() });
	expect(leaf).not.toHaveProperty("receiver");
});

it.each([
	"name",
	"facet",
	"malformed-facet",
	"path",
	"unselected",
	"state-owner",
])(
	"stored %s mismatch refuses reset and preserves warm receiver",
	async (kind) => {
		const f = await seed();
		expect((await f.stub.fetch(request(f, "quarantine", 1))).status).toBe(200);
		await runInDurableObject(f.stub, (_, ctx) => {
			if (kind === "name") ctx.storage.kv.put("__ps_name", "foreign-name");
			if (kind === "facet") ctx.storage.kv.put("cf_agents_is_facet", true);
			if (kind === "malformed-facet")
				ctx.storage.kv.put("cf_agents_is_facet", "true");
			if (kind === "path")
				ctx.storage.kv.put("cf_agents_parent_path", [
					{ className: "parent", name: "foreign" },
				]);
			if (kind === "unselected") ctx.storage.kv.put("fixture:unselected", true);
			if (kind === "state-owner")
				ctx.storage.sql.exec(
					"UPDATE cf_agents_state SET state=? WHERE id='cf_state_row_id'",
					JSON.stringify({
						tediId: f.owner.tediId,
						orgId: crypto.randomUUID(),
					}),
				);
		});
		const before = await snapshot(f.stub);
		expect(
			(await f.stub.fetch(request(f, "exclude_writers", 2))).status,
		).not.toBe(200);
		expect(await f.stub.ping()).toBe("warm-sdk");
		expect(await snapshot(f.stub)).toEqual(before);
	},
);
it("wrong requested physical object and canonical D1 name cannot reset registered warm root", async () => {
	const f = await seed();
	expect((await f.stub.fetch(request(f, "quarantine", 1))).status).toBe(200);
	const before = await snapshot(f.stub);
	expect(
		(
			await f.stub.fetch(
				request(f, "exclude_writers", 2, { objectId: "f".repeat(64) }),
			)
		).status,
	).toBe(404);
	await local.DB.prepare("UPDATE tedis SET isolate_agent_id=? WHERE id=?")
		.bind("foreign-canonical", f.owner.tediId)
		.run();
	expect((await f.stub.fetch(request(f, "exclude_writers", 2))).status).toBe(
		409,
	);
	expect(await f.stub.ping()).toBe("warm-sdk");
	expect(await snapshot(f.stub)).toEqual(before);
});
