import { env } from "cloudflare:workers";
import { runInDurableObject, evictDurableObject } from "cloudflare:test";
import { expect, it } from "vite-plus/test";
import type { CaptureRoot } from "./worker";
import { RuntimeAdmissionDO } from "../../src/runtime-admission-do";
import { HistoricalTrackingRetirement } from "../../src/historical-tracking-retirement";
import { TediRuntimeCaptureSizeResponseSchema } from "@tedix/api-contract/schemas/tedi";
import {
	HISTORICAL_CAPTURE_SELECTORS,
	historicalCaptureItemBytes,
} from "../../src/historical-liability-custody";
import {
	decryptTediSecret,
	encryptTediSecret,
} from "@tedix/db/utils/secrets-encryption";
const local = env as unknown as {
	DB: D1Database;
	TEDI_AGENT: DurableObjectNamespace<CaptureRoot>;
};
const TOKEN = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
	URL = "https://fixture/__admin/pi-state-cutover";
async function seed(state?: "active" | "quarantined" | "retired", entries = 2) {
	const name = "capture-" + crypto.randomUUID(),
		id = local.TEDI_AGENT.idFromName(name),
		owner = {
			objectId: id.toString(),
			tediId: crypto.randomUUID(),
			orgId: crypto.randomUUID(),
		};
	await local.DB.exec(
		"CREATE TABLE IF NOT EXISTS tedis(id TEXT PRIMARY KEY,organization_id TEXT,slug TEXT,isolate_agent_id TEXT,runtime_kind TEXT,status TEXT)",
	);
	await local.DB.prepare("INSERT INTO tedis VALUES(?,?,?,?,?,?)")
		.bind(owner.tediId, owner.orgId, name, name, "agent", "active")
		.run();
	const stub = local.TEDI_AGENT.get(id);
	const generation = await runInDurableObject(stub, (_, ctx) => {
		ctx.storage.kv.put("__ps_name", name);
		ctx.storage.sql.exec(
			"CREATE TABLE cf_agents_state(id TEXT PRIMARY KEY,state TEXT)",
		);
		ctx.storage.sql.exec(
			"INSERT INTO cf_agents_state VALUES('cf_state_row_id',?)",
			JSON.stringify(owner),
		);
		ctx.storage.sql.exec(
			"CREATE TABLE cf_agents_fibers(a TEXT,b BLOB,c INTEGER,n TEXT)",
		);
		ctx.storage.sql.exec(
			"INSERT INTO cf_agents_fibers VALUES(?,?,?,NULL)",
			"😀",
			new Uint8Array([1, 2, 3]).buffer,
			-123,
		);
		ctx.storage.kv.put(
			"private:irrelevant",
			"PRIVATE_IRRELEVANT".repeat(100_000),
		);
		ctx.storage.kv.put("wfctx:PRIVATE_FIRST", { private: "😀".repeat(60_000) });
		ctx.storage.kv.put("wfctx:PRIVATE_SECOND", new Uint8Array([3, 2, 1]));
		for (let i = 2; i < entries; i++)
			ctx.storage.kv.put(`wfctx:ZZ_PRIVATE_${String(i).padStart(3, "0")}`, {
				index: i,
			});
		if (!state) return 0;
		const helper = new RuntimeAdmissionDO(ctx.storage, owner);
		helper.gate.initialize({
			operationId: "init",
			state: "quarantined",
			reason: "fixture",
		});
		if (state !== "quarantined")
			ctx.storage.sql.exec(
				"UPDATE runtime_admission SET record=json_set(record,'$.state',?)",
				state,
			);
		return helper.read()!.generation;
	});
	return { name, owner, stub, generation };
}
function request(
	f: Awaited<ReturnType<typeof seed>>,
	extra: Record<string, unknown> = {},
	token = TOKEN,
	headers = {},
) {
	return new Request(URL, {
		method: "POST",
		headers: { "X-Tedix-Admin-Token": token, ...headers },
		body: JSON.stringify({
			command: "inspect_capture_size",
			objectId: f.owner.objectId,
			operationId: "diagnostic",
			expectedGeneration: f.generation,
			custody: {
				tediId: f.owner.tediId,
				orgId: f.owner.orgId,
				objectName: f.name,
			},
			...extra,
		}),
	});
}
async function snapshot(stub: DurableObjectStub<CaptureRoot>) {
	return runInDurableObject(stub, (_, ctx) => ({
		kv: [...ctx.storage.kv.list()],
		sql: ctx.storage.sql
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
async function page(
	f: Awaited<ReturnType<typeof seed>>,
	continuation?: string,
) {
	const response = await f.stub.fetch(
		request(f, continuation ? { continuation } : {}),
	);
	expect(response.status).toBe(200);
	const text = await response.text();
	expect(text).not.toContain("PRIVATE");
	expect(text).not.toContain("wfctx:");
	return TediRuntimeCaptureSizeResponseSchema.parse(JSON.parse(text));
}
it.each([undefined, "active", "quarantined", "retired"] as const)(
	"observes %s without initialization/writes and processes selected items sequentially in bounded pages",
	async (state) => {
		const f = await seed(state),
			before = await snapshot(f.stub);
		let p = await page(f);
		expect(p.receiver).toBeUndefined();
		expect(p.generation).toBe(f.generation);
		expect(p.state).toBe(state ?? "uninitialized");
		expect(p.observation).toBe("read_window_not_atomic_snapshot");
		const fiber = p.sql.find(
			(row) => row.category === "sdk" && row.selector === 1,
		)!;
		expect(fiber).toEqual({
			category: "sdk",
			selector: 1,
			present: true,
			rows: 1,
			castValueBytes: 11,
			maxRowCastValueBytes: 11,
		});
		expect(p.kv.entries).toBe(2);
		expect(p.kv.canonicalItemBytes).toBe(
			historicalCaptureItemBytes([
				"wfctx:PRIVATE_FIRST",
				{ private: "😀".repeat(60_000) },
			]) +
				historicalCaptureItemBytes([
					"wfctx:PRIVATE_SECOND",
					new Uint8Array([3, 2, 1]),
				]),
		);
		expect(p.complete).toBe(true);
		expect(p.continuation).toBeUndefined();
		expect(await snapshot(f.stub)).toEqual(before);
		const calls = await f.stub.accesses();
		expect(
			calls
				.filter((call) => call.kind === "list")
				.every(
					(call) =>
						call.limit === 1 &&
						[
							...HISTORICAL_CAPTURE_SELECTORS.kvPrefixes,
							...HISTORICAL_CAPTURE_SELECTORS.kvKeys,
						].includes(call.prefix as never),
				),
		).toBe(true);
		expect(
			calls.some((call) => call.key?.startsWith("private:irrelevant")),
		).toBe(false);
	},
);
it("reports only actual cold production Raw receiver", async () => {
	const f = await seed("quarantined");
	await runInDurableObject(f.stub, (_, ctx) =>
		ctx.storage.kv.put("fixture:raw", true),
	);
	const before = await snapshot(f.stub);
	await evictDurableObject(f.stub);
	expect((await page(f)).receiver).toBe("raw-cutover-v1");
	expect(await snapshot(f.stub)).toEqual(before);
});
it.each(["owner", "name", "epoch", "canonical"])(
	"rejects actual awaited D1 %s race without diagnostic writes",
	async (race) => {
		const f = await seed("active");
		await runInDurableObject(f.stub, (_, ctx) =>
			ctx.storage.kv.put("fixture:race", race),
		);
		const before = await snapshot(f.stub);
		const response = await f.stub.fetch(request(f));
		expect(response.status).toBe(409);
		expect(await response.text()).not.toContain("foreign");
		const after = await snapshot(f.stub);
		const expected = structuredClone(before);
		if (race === "owner")
			expected.sql.find(
				(row) => row.name === "cf_agents_state",
			)!.rows[0]!.state = JSON.stringify({
				tediId: "foreign",
				orgId: "foreign",
			});
		if (race === "name")
			expected.kv.find(([key]) => key === "__ps_name")![1] = "foreign";
		if (race === "epoch") {
			const row = expected.sql.find((row) => row.name === "runtime_admission")!
				.rows[0]!;
			const admission = JSON.parse(row.record as string);
			admission.generation = 99;
			row.record = JSON.stringify(admission);
		}
		expect(after).toEqual(expected);
		expect(after.sql.some((row) => row.name === "cutover_admin_receipts")).toBe(
			false,
		);
	},
);
it("refuses private, corrupt, cross-owner/epoch/purpose continuations without writes", async () => {
	const f = await seed(undefined, 34),
		first = await page(f),
		before = await snapshot(f.stub);
	const plain = JSON.parse(
		await decryptTediSecret(TOKEN, f.owner.tediId, first.continuation!),
	);
	const corrupt = ["PRIVATE_TOKEN", first.continuation!.slice(0, -4) + "AAAA"];
	for (const change of [
		{ purpose: "wrong" },
		{ orgId: crypto.randomUUID() },
		{ objectId: "a".repeat(64) },
		{ objectName: "foreign" },
		{ generation: 3 },
		{ selectorVersion: "wrong" },
		{ position: 99999 },
		{ extra: "PRIVATE" },
	])
		corrupt.push(
			await encryptTediSecret(
				TOKEN,
				f.owner.tediId,
				JSON.stringify({ ...plain, ...change }),
			),
		);
	for (const continuation of corrupt) {
		const r = await f.stub.fetch(request(f, { continuation }));
		expect(r.status).toBe(409);
		expect(await r.text()).not.toContain("PRIVATE");
	}
	const other = await seed();
	expect(
		(
			await other.stub.fetch(
				request(other, { continuation: first.continuation }),
			)
		).status,
	).toBe(409);
	expect(await snapshot(f.stub)).toEqual(before);
});
it("rejects bad token, physical/name/owner/facet/generation and extra inputs without writes", async () => {
	const f = await seed(),
		before = await snapshot(f.stub);
	expect((await f.stub.fetch(request(f, {}, "wrong"))).status).toBe(403);
	for (const extra of [
		{ objectId: "f".repeat(64) },
		{ expectedGeneration: 1 },
		{ target: {} },
		{ targetPath: [] },
		{ sourceHash: "a".repeat(64) },
		{
			custody: {
				tediId: f.owner.tediId,
				orgId: f.owner.orgId,
				objectName: "foreign",
			},
		},
		{ custody: null },
	])
		expect((await f.stub.fetch(request(f, extra))).status).not.toBe(200);
	expect(
		(
			await f.stub.fetch(
				request(f, {}, TOKEN, { "X-Tedix-Cutover-Facet-Custody": "{}" }),
			)
		).status,
	).not.toBe(200);
	expect(await snapshot(f.stub)).toEqual(before);
});
it("observes an exact selected false value without hydrating adjacent nonselected keys", async () => {
	const f = await seed();
	await runInDurableObject(f.stub, (_, ctx) => {
		ctx.storage.kv.put("cf_agents_is_facet", false);
		ctx.storage.kv.put(
			"cf_agents_is_facet_PRIVATE",
			"PRIVATE_ADJACENT".repeat(100_000),
		);
	});
	const before = await snapshot(f.stub),
		p = await page(f);
	expect(p.kv.canonicalItemBytes).toBe(
		historicalCaptureItemBytes(["cf_agents_is_facet", false]) +
			historicalCaptureItemBytes([
				"wfctx:PRIVATE_FIRST",
				{ private: "😀".repeat(60_000) },
			]) +
			historicalCaptureItemBytes([
				"wfctx:PRIVATE_SECOND",
				new Uint8Array([3, 2, 1]),
			]),
	);
	expect(await snapshot(f.stub)).toEqual(before);
	const calls = await f.stub.accesses();
	expect(calls.some((call) => call.key === "cf_agents_is_facet_PRIVATE")).toBe(
		false,
	);
});
it("does not silently treat stored undefined as an absent selected item", async () => {
	const f = await seed();
	const supported = await runInDurableObject(f.stub, (_, ctx) => {
		try {
			ctx.storage.kv.put("agent_name", undefined);
			return true;
		} catch {
			return false;
		}
	});
	const before = await snapshot(f.stub);
	const response = await f.stub.fetch(request(f));
	expect(response.status).toBe(supported ? 409 : 200);
	expect(await snapshot(f.stub)).toEqual(before);
});

it("does not expose diagnostic via ordinary or callback HTTP paths", async () => {
	const f = await seed(),
		before = await snapshot(f.stub);
	for (const path of [
		"/",
		"/inspect_capture_size",
		"/_workflow_handleCallback",
	])
		expect(
			(
				await f.stub.fetch(
					new Request("https://fixture" + path, {
						method: "POST",
						body: "PRIVATE",
					}),
				)
			).status,
		).toBe(404);
	expect(await snapshot(f.stub)).toEqual(before);
});
it("refuses stored root/facet/tenant contradictions without diagnostic writes", async () => {
	for (const mutation of [
		"facet",
		"path",
		"malformedPath",
		"tenant",
		"metadata",
		"name",
		"d1Owner",
	]) {
		const f = await seed("active");
		await runInDurableObject(f.stub, (_, ctx) => {
			if (mutation === "facet") ctx.storage.kv.put("cf_agents_is_facet", true);
			if (mutation === "path")
				ctx.storage.kv.put("cf_agents_parent_path", [
					{ className: "AgentTediDO", name: "foreign" },
				]);
			if (mutation === "malformedPath")
				ctx.storage.kv.put("cf_agents_parent_path", {});
			if (mutation === "tenant")
				ctx.storage.sql.exec(
					"UPDATE cf_agents_state SET state=?",
					JSON.stringify({ tediId: crypto.randomUUID(), orgId: f.owner.orgId }),
				);
			if (mutation === "metadata")
				ctx.storage.sql.exec(
					"UPDATE cf_agents_state SET state=?",
					JSON.stringify({
						...f.owner,
						aigMetadata: { orgId: crypto.randomUUID() },
					}),
				);
			if (mutation === "name") ctx.storage.kv.put("__ps_name", "foreign");
		});
		if (mutation === "d1Owner")
			await local.DB.prepare("UPDATE tedis SET organization_id=? WHERE id=?")
				.bind(crypto.randomUUID(), f.owner.tediId)
				.run();
		const before = await snapshot(f.stub),
			r = await f.stub.fetch(request(f));
		expect(r.status).toBe(409);
		expect(await snapshot(f.stub)).toEqual(before);
	}
});
it("follows native Unicode key ordering without imposing JavaScript string ordering", async () => {
	const f = await seed();
	const pairs: Array<[string, string]> = [
		...Array.from({ length: 31 }, (_, i): [string, string] => [
			`wfctx:PRIVATE_${String(i).padStart(2, "0")}`,
			String(i),
		]),
		["wfctx:\uE000", "first"],
		["wfctx:😀", "second"],
	];
	await runInDurableObject(f.stub, (_, ctx) => {
		ctx.storage.kv.delete("wfctx:PRIVATE_FIRST");
		ctx.storage.kv.delete("wfctx:PRIVATE_SECOND");
		for (const [key, value] of pairs) ctx.storage.kv.put(key, value);
	});
	const before = await snapshot(f.stub);
	let p = await page(f),
		observed = p.kv.canonicalItemBytes,
		entries = p.kv.entries;
	while (!p.complete) {
		p = await page(f, p.continuation);
		observed += p.kv.canonicalItemBytes;
		entries += p.kv.entries;
	}
	expect(entries).toBe(33);
	expect(observed).toBe(
		pairs.reduce((sum, pair) => sum + historicalCaptureItemBytes([...pair]), 0),
	);
	expect(await snapshot(f.stub)).toEqual(before);
});

it.each([32, 64, 65])(
	"paginates %i actual selected values with honest boundary exhaustion",
	async (total) => {
		const f = await seed(undefined, total),
			before = await snapshot(f.stub);
		const expected = await runInDurableObject(f.stub, (_, ctx) => {
			let bytes = 0;
			for (const pair of ctx.storage.kv.list({ prefix: "wfctx:" }))
				bytes += historicalCaptureItemBytes(pair);
			return bytes;
		});
		let p = await page(f),
			entries = p.kv.entries,
			bytes = p.kv.canonicalItemBytes,
			pages = 1;
		expect(p.kv.entries).toBe(32);
		expect(p.complete).toBe(false);
		while (!p.complete) {
			p = await page(f, p.continuation);
			pages++;
			expect(p.sql).toEqual([]);
			expect(p.kv.entries).toBeLessThanOrEqual(32);
			entries += p.kv.entries;
			bytes += p.kv.canonicalItemBytes;
		}
		expect(entries).toBe(total);
		expect(bytes).toBe(expected);
		expect(pages).toBe(Math.floor(total / 32) + 1);
		expect(p.kv.entries).toBe(total % 32);
		expect(p.continuation).toBeUndefined();
		expect(await snapshot(f.stub)).toEqual(before);
		const reads = await f.stub.accesses();
		expect(
			reads
				.filter((r) => r.kind === "list")
				.every((r) => r.limit === 1 && r.prefix),
		).toBe(true);
	},
);

it("refuses an unsupported private item on a later batch without a partial response or writes", async () => {
	const f = await seed(undefined, 32);
	await runInDurableObject(f.stub, (_, ctx) =>
		ctx.storage.kv.put("wfctx:zz_PRIVATE_UNSUPPORTED", undefined),
	);
	const before = await snapshot(f.stub),
		first = await page(f);
	expect(first.kv.entries).toBe(32);
	expect(first.complete).toBe(false);
	const response = await f.stub.fetch(
		request(f, { continuation: first.continuation }),
	);
	expect(response.status).toBe(409);
	const body = await response.text();
	expect(body).not.toContain("PRIVATE");
	expect(body).not.toContain("wfctx:");
	expect(await snapshot(f.stub)).toEqual(before);
});

async function historicalSeed(
	state: "active" | "quarantined" | "retired" = "quarantined",
	raw = true,
) {
	const f = await seed(state);
	await runInDurableObject(f.stub, (_, ctx) => {
		ctx.storage.sql.exec("DROP TABLE cf_agents_fibers");
		ctx.storage.sql.exec(
			"CREATE TABLE cf_agents_workflows(id TEXT PRIMARY KEY,workflow_id TEXT,workflow_name TEXT,status TEXT,metadata TEXT,error_name TEXT,error_message TEXT,created_at INTEGER,updated_at INTEGER,completed_at INTEGER)",
		);
		ctx.storage.sql.exec(
			"INSERT INTO cf_agents_workflows(id,workflow_id,workflow_name,status,metadata) VALUES ('tracking','retained-workflow','CHAT_TURN_WORKFLOW','queued',?)",
			JSON.stringify({ private: "PRIVATE metadata" }),
		);
		ctx.storage.sql.exec(
			"CREATE TABLE cf_agents_fibers(fiber_id TEXT PRIMARY KEY,idempotency_key TEXT,name TEXT,status TEXT,snapshot TEXT,metadata_json TEXT,error_message TEXT,created_at INTEGER,started_at INTEGER,completed_at INTEGER)",
		);
		ctx.storage.sql.exec(
			"INSERT INTO cf_agents_fibers(fiber_id,idempotency_key,name,status,snapshot) VALUES ('retained-fiber','retained-key','original','interrupted','PRIVATE snapshot')",
		);
		ctx.storage.sql.exec(
			"CREATE TABLE inference_step_usage(turn_id TEXT,step_id TEXT,estimated_tokens INTEGER,actual_tokens INTEGER)",
		);
		ctx.storage.sql.exec(
			"INSERT INTO inference_step_usage VALUES ('retained-run','original-step',100,NULL)",
		);
		ctx.storage.kv.put("wfctx:retained-workflow", {
			runId: "retained-run",
			workflowInstanceId: "retained-workflow",
		});
		ctx.storage.kv.put("pi-accounting:retained-run", {
			runId: "retained-run",
			attempts: [{ phase: "unknown", usage: null, effectsSealed: false }],
		});
		ctx.storage.kv.put("ledger-outbox:retained-event", {
			runId: "retained-run",
			kind: "tool.started",
			private: "PRIVATE effect",
		});
		if (raw) ctx.storage.kv.put("fixture:raw", true);
	});
	await runInDurableObject(f.stub, (_, ctx) =>
		ctx.storage.setAlarm(Date.now() + 3_600_000),
	);
	if (raw) {
		await evictDurableObject(f.stub);
		f.stub = local.TEDI_AGENT.get(local.TEDI_AGENT.idFromName(f.name));
	}
	return f;
}
async function historical(
	f: Awaited<ReturnType<typeof seed>>,
	command:
		| "inspect_historical_custody"
		| "capture_historical_custody"
		| "audit_historical_custody",
	expectedSourceHash?: string,
) {
	const response = await f.stub.fetch(
		request(f, {
			command,
			...(expectedSourceHash === undefined ? {} : { expectedSourceHash }),
		}),
	);
	expect(response.status).toBe(200);
	const text = await response.text();
	expect(text).not.toContain("PRIVATE");
	expect(text).not.toContain("wfctx:");
	const { TediRuntimeHistoricalCustodyResponseSchema } =
		await import("@tedix/api-contract/schemas/tedi");
	return TediRuntimeHistoricalCustodyResponseSchema.parse(JSON.parse(text));
}
const archiveTables = new Set([
	"historical_custody_snapshot",
	"historical_custody_parts",
	"historical_liability_refs",
	"historical_replay_seals",
]);
async function originalState(f: Awaited<ReturnType<typeof seed>>) {
	const state = await snapshot(f.stub);
	return {
		...state,
		sql: state.sql.filter((row) => !archiveTables.has(row.name)),
		alarm: await runInDurableObject(f.stub, (_, ctx) => ctx.storage.getAlarm()),
	};
}
it("cold actual Raw captures one immutable root archive with all original seals, audit and exact retry", async () => {
	const f = await historicalSeed(),
		before = await originalState(f);
	await runInDurableObject(f.stub, async (_, ctx) => {
		const { HistoricalLiabilityCustody } =
			await import("../../src/historical-liability-custody");
		new HistoricalLiabilityCustody(
			ctx.storage,
			f.owner.objectId,
		).inspectSnapshot({ expectedGeneration: f.generation });
	});
	const inspected = await historical(f, "inspect_historical_custody");
	expect(inspected.receiver).toBe("raw-cutover-v1");
	expect(inspected.workflowCount).toBe(1);
	expect(inspected.fiberCount).toBe(1);
	expect(inspected.identityCount).toBe(4);
	expect(await originalState(f)).toEqual(before);
	const captured = await historical(
		f,
		"capture_historical_custody",
		inspected.sourceHash,
	);
	expect(captured).toEqual({
		...inspected,
		command: "capture_historical_custody",
	});
	const stored = await snapshot(f.stub);
	expect(stored.sql.filter((row) => archiveTables.has(row.name))).toHaveLength(
		4,
	);
	expect(
		stored.sql.find((row) => row.name === "historical_liability_refs")!.rows,
	).toHaveLength(2);
	expect(
		stored.sql.find((row) => row.name === "historical_replay_seals")!.rows,
	).toHaveLength(4);
	await runInDurableObject(f.stub, async (_, ctx) => {
		const { HistoricalLiabilityCustody } =
			await import("../../src/historical-liability-custody");
		const engine = new HistoricalLiabilityCustody(
			ctx.storage,
			ctx.id.toString(),
		);
		for (const identity of [
			{
				kind: "workflow",
				binding: "CHAT_TURN_WORKFLOW",
				id: "retained-workflow",
			},
			{ kind: "fiber", id: "retained-fiber" },
			{ kind: "fiber_key", id: "retained-key" },
			{ kind: "run", id: "retained-run" },
		] as const)
			expect(() => engine.assertNotSealed(identity)).toThrow(
				"permanently sealed",
			);
	});
	await evictDurableObject(f.stub);
	f.stub = local.TEDI_AGENT.get(local.TEDI_AGENT.idFromName(f.name));
	expect(
		await historical(f, "audit_historical_custody", inspected.sourceHash),
	).toEqual({ ...inspected, command: "audit_historical_custody" });
	expect(
		await historical(f, "capture_historical_custody", inspected.sourceHash),
	).toEqual(captured);
	expect(await snapshot(f.stub)).toEqual(stored);
	expect(await originalState(f)).toEqual(before);
	expect(
		stored.sql.some((row) =>
			["pi_cutover_operator", "cutover_admin_receipts", "pi_tasks"].includes(
				row.name,
			),
		),
	).toBe(false);
});
it("refuses absent audit and wrong source pins without creating archive or receipts", async () => {
	const f = await historicalSeed(),
		before = await snapshot(f.stub);
	for (const command of [
		"capture_historical_custody",
		"audit_historical_custody",
	]) {
		const response = await f.stub.fetch(
			request(f, { command, expectedSourceHash: "f".repeat(64) }),
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			ok: false,
			rejection: "historical_custody_unavailable",
		});
	}
	expect(await snapshot(f.stub)).toEqual(before);
});
it("late original facts invalidate capture retry while original archive audit remains truthful", async () => {
	const f = await historicalSeed(),
		source = await historical(f, "inspect_historical_custody");
	await historical(f, "capture_historical_custody", source.sourceHash);
	await runInDurableObject(f.stub, (_, ctx) =>
		ctx.storage.kv.put("ledger-outbox:retained-event", {
			runId: "retained-run",
			kind: "tool.completed",
			private: "PRIVATE late ACK",
		}),
	);
	const before = await snapshot(f.stub);
	expect(
		(await historical(f, "inspect_historical_custody")).sourceHash,
	).not.toBe(source.sourceHash);
	expect(
		(
			await f.stub.fetch(
				request(f, {
					command: "capture_historical_custody",
					expectedSourceHash: source.sourceHash,
				}),
			)
		).status,
	).toBe(409);
	expect(
		(await historical(f, "audit_historical_custody", source.sourceHash))
			.sourceHash,
	).toBe(source.sourceHash);
	expect(await snapshot(f.stub)).toEqual(before);
});
it.each(["chunk", "seal", "generation"])(
	"refuses %s archive mismatch without repair or settlement",
	async (mutation) => {
		const f = await historicalSeed(),
			source = await historical(f, "inspect_historical_custody");
		await historical(f, "capture_historical_custody", source.sourceHash);
		await runInDurableObject(f.stub, (_, ctx) => {
			if (mutation === "chunk")
				ctx.storage.sql.exec(
					"UPDATE historical_custody_parts SET chunk=x'01' WHERE kind='source' AND part=0",
				);
			if (mutation === "seal")
				ctx.storage.sql.exec(
					"DELETE FROM historical_replay_seals WHERE identity=(SELECT identity FROM historical_replay_seals LIMIT 1)",
				);
			if (mutation === "generation")
				ctx.storage.sql.exec(
					"UPDATE runtime_admission SET record=json_set(record,'$.generation',99)",
				);
		});
		if (mutation === "generation") f.generation = 99;
		const before = await snapshot(f.stub),
			response = await f.stub.fetch(
				request(f, {
					command: "audit_historical_custody",
					expectedSourceHash: source.sourceHash,
				}),
			);
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			ok: false,
			rejection: "historical_custody_unavailable",
		});
		expect(await snapshot(f.stub)).toEqual(before);
	},
);
it("native transaction rolls back all four archive tables after late seal insertion failure", async () => {
	const f = await historicalSeed(),
		source = await historical(f, "inspect_historical_custody");
	await runInDurableObject(f.stub, (_, ctx) =>
		ctx.storage.kv.put("fixture:fail-seal", true),
	);
	const before = await snapshot(f.stub),
		response = await f.stub.fetch(
			request(f, {
				command: "capture_historical_custody",
				expectedSourceHash: source.sourceHash,
			}),
		);
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({
		ok: false,
		rejection: "historical_custody_unavailable",
	});
	expect(
		await runInDurableObject(f.stub, (_, ctx) => {
			const sql = ctx.storage.sql as SqlStorage & {
				fixtureSealAttempts: number;
				fixtureRefsAtFailure: number;
			};
			return {
				attempts: sql.fixtureSealAttempts,
				refs: sql.fixtureRefsAtFailure,
			};
		}),
	).toEqual({ attempts: 1, refs: 2 });
	expect(await snapshot(f.stub)).toEqual(before);
});
it("denies warm, ACTIVE and header-derived Raw custody and facets without writes", async () => {
	for (const mode of ["warm", "active", "facet", "ancestor"]) {
		const f = await historicalSeed(
			mode === "active" ? "active" : "quarantined",
			mode !== "warm",
		);
		if (mode === "facet")
			await runInDurableObject(f.stub, (_, ctx) => {
				ctx.storage.kv.put("cf_agents_is_facet", true);
				ctx.storage.kv.put("cf_agents_parent_path", [
					{ className: "AgentTediDO", name: "parent" },
				]);
			});
		const before = await snapshot(f.stub),
			response = await f.stub.fetch(
				request(
					f,
					{ command: "inspect_historical_custody" },
					TOKEN,
					mode === "ancestor"
						? { "X-Tedix-Cutover-Inspection-Custody": "{}" }
						: { "X-Tedix-Raw-Receiver": "raw-cutover-v1" },
				),
			);
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			ok: false,
			rejection: "historical_custody_unavailable",
		});
		expect(await snapshot(f.stub)).toEqual(before);
	}
});
it.each(["owner", "epoch", "canonical", "d1Owner"])(
	"cold Raw refuses final awaited %s custody race before capture",
	async (race) => {
		const f = await historicalSeed(),
			source = await historical(f, "inspect_historical_custody");
		await runInDurableObject(f.stub, (_, ctx) =>
			ctx.storage.kv.put("fixture:raw-race", race),
		);
		await evictDurableObject(f.stub);
		f.stub = local.TEDI_AGENT.get(local.TEDI_AGENT.idFromName(f.name));
		const before = await snapshot(f.stub),
			response = await f.stub.fetch(
				request(f, {
					command: "capture_historical_custody",
					expectedSourceHash: source.sourceHash,
				}),
			);
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			ok: false,
			rejection: "historical_custody_unavailable",
		});
		const after = await snapshot(f.stub),
			expected = structuredClone(before);
		if (race === "owner")
			expected.sql.find(
				(row) => row.name === "cf_agents_state",
			)!.rows[0]!.state = JSON.stringify({
				tediId: "PRIVATE",
				orgId: "PRIVATE",
			});
		if (race === "epoch") {
			const row = expected.sql.find((row) => row.name === "runtime_admission")!
				.rows[0]!;
			const r = JSON.parse(row.record as string);
			r.generation = 99;
			row.record = JSON.stringify(r);
		}
		expect(after).toEqual(expected);
		expect(after.sql.some((row) => archiveTables.has(row.name))).toBe(false);
	},
);

it("actual Raw historical command denies forged canonical physical/name/tenant custody and bad auth", async () => {
	const f = await historicalSeed(),
		before = await snapshot(f.stub);
	expect(
		(
			await f.stub.fetch(
				request(f, { command: "inspect_historical_custody" }, "wrong"),
			)
		).status,
	).toBe(403);
	for (const extra of [
		{ objectId: "f".repeat(64) },
		{ expectedGeneration: f.generation + 1 },
		{
			custody: {
				tediId: f.owner.tediId,
				orgId: crypto.randomUUID(),
				objectName: f.name,
			},
		},
		{
			custody: {
				tediId: crypto.randomUUID(),
				orgId: f.owner.orgId,
				objectName: f.name,
			},
		},
		{
			custody: {
				tediId: f.owner.tediId,
				orgId: f.owner.orgId,
				objectName: "PRIVATE_OTHER",
			},
		},
	]) {
		const r = await f.stub.fetch(
			request(f, { command: "inspect_historical_custody", ...extra }),
		);
		expect(r.status).not.toBe(200);
		expect(await r.text()).not.toContain("PRIVATE_OTHER");
	}
	expect(await snapshot(f.stub)).toEqual(before);
});

async function rawCallback(
	f: Awaited<ReturnType<typeof seed>>,
	input: unknown,
) {
	return await (
		f.stub as unknown as {
			_workflow_handleCallback(input: unknown): Promise<void>;
		}
	)._workflow_handleCallback(input);
}
function completedCallback(result: unknown) {
	return {
		workflowName: "CHAT_TURN_WORKFLOW",
		workflowId: "retained-workflow",
		type: "complete",
		result,
		timestamp: 1,
	};
}
async function observations(f: Awaited<ReturnType<typeof seed>>) {
	return runInDurableObject(f.stub, (_, ctx) => [
		...ctx.storage.kv.list<Record<string, unknown>>({
			prefix: "runtime-workflow-observation:v1:",
		}),
	]);
}
async function retireForCallback(f: Awaited<ReturnType<typeof seed>>) {
	const inspected = await historical(f, "inspect_historical_custody");
	const captured = await historical(
		f,
		"capture_historical_custody",
		inspected.sourceHash,
	);
	const archive = (await snapshot(f.stub)).sql.filter((row) =>
		archiveTables.has(row.name),
	);
	const request = {
		operationId: "tracking-retirement",
		expectedGeneration: f.generation,
		snapshotId: captured.snapshotId,
		sourceHash: captured.sourceHash,
	};
	await runInDurableObject(f.stub, (_, ctx) =>
		new HistoricalTrackingRetirement(ctx.storage, f.owner.objectId).retire(
			request,
		),
	);
	return { archive, request };
}
it.each([null, false, 0, ""])(
	"preserves original Raw ACK %j on the SAME retired root through eviction",
	async (result) => {
		const f = await historicalSeed();
		const callback = completedCallback(result);
		await rawCallback(f, callback);
		const original = await observations(f);
		expect(original).toHaveLength(1);
		const { archive, request: retiredRequest } = await retireForCallback(f);
		expect(
			await runInDurableObject(f.stub, (_, ctx) =>
				ctx.storage.sql.exec("SELECT * FROM cf_agents_workflows").toArray(),
			),
		).toEqual([]);
		await rawCallback(f, callback);
		expect(await observations(f)).toEqual(original);
		await evictDurableObject(f.stub);
		f.stub = local.TEDI_AGENT.get(local.TEDI_AGENT.idFromName(f.name));
		await rawCallback(f, callback);
		expect(await observations(f)).toEqual(original);
		await rawCallback(f, {
			workflowName: "CHAT_TURN_WORKFLOW",
			workflowId: "retained-workflow",
			type: "error",
			error: "PRIVATE late observation",
			timestamp: 2,
		});
		const retained = await observations(f);
		expect(retained).toHaveLength(2);
		expect(
			retained.every(
				([, value]) =>
					value.providerAttested === false &&
					value.kind === "unqualified_namespace_rpc_observation",
			),
		).toBe(true);
		expect((retained[0]![1].provenance as { kind: string }).kind).toBe(
			"unknown",
		);
		expect(
			(await snapshot(f.stub)).sql.filter((row) => archiveTables.has(row.name)),
		).toEqual(archive);
		await expect(
			rawCallback(f, completedCallback({ conflicting: true })),
		).rejects.toThrow("Retained workflow observation rejected");
		// A new observation changes selected live source. It does not silently renew the original capture/retirement proof.
		await expect(
			runInDurableObject(f.stub, (_, ctx) =>
				new HistoricalTrackingRetirement(ctx.storage, f.owner.objectId).retire(
					retiredRequest,
				),
			),
		).rejects.toThrow("historical_tracking_retirement_unavailable");
		expect(await observations(f)).toEqual(retained);
	},
);
it.each([
	"archive",
	"seal",
	"generation",
	"owner",
	"canonical",
	"d1Owner",
	"unknown",
	"resurrected",
])(
	"denies archived callback %s without observation or private error",
	async (mutation) => {
		const f = await historicalSeed();
		await retireForCallback(f);
		await runInDurableObject(f.stub, (_, ctx) => {
			if (mutation === "archive")
				ctx.storage.sql.exec(
					"UPDATE historical_custody_parts SET chunk=zeroblob(length(chunk)) WHERE kind='source'",
				);
			if (mutation === "seal")
				ctx.storage.sql.exec("DELETE FROM historical_replay_seals");
			if (mutation === "generation")
				ctx.storage.sql.exec(
					"UPDATE runtime_admission SET record=json_set(record,'$.generation',99)",
				);
			if (mutation === "owner")
				ctx.storage.sql.exec(
					"UPDATE cf_agents_state SET state=?",
					JSON.stringify({ tediId: "PRIVATE forged", orgId: f.owner.orgId }),
				);
			if (mutation === "resurrected")
				ctx.storage.sql.exec(
					"INSERT INTO cf_agents_workflows(id,workflow_id,workflow_name,status,metadata) VALUES('resurrected','PRIVATE-other','CHAT_TURN_WORKFLOW','queued','PRIVATE')",
				);
		});
		if (mutation === "canonical")
			await local.DB.prepare(
				"UPDATE tedis SET isolate_agent_id='PRIVATE' WHERE id=?",
			)
				.bind(f.owner.tediId)
				.run();
		if (mutation === "d1Owner")
			await local.DB.prepare(
				"UPDATE tedis SET organization_id='PRIVATE' WHERE id=?",
			)
				.bind(f.owner.tediId)
				.run();
		const before = await observations(f),
			callback = completedCallback(null);
		if (mutation === "unknown") callback.workflowId = "PRIVATE-unknown";
		let error = "";
		try {
			await rawCallback(f, callback);
		} catch (e) {
			error = String(e);
		}
		expect(error).toContain("Retained workflow observation rejected");
		expect(error).not.toContain("PRIVATE");
		expect(await observations(f)).toEqual(before);
	},
);
it.each(["owner", "epoch", "canonical", "d1Owner"])(
	"rechecks archived callback custody after awaited %s lookup",
	async (race) => {
		const f = await historicalSeed();
		await retireForCallback(f);
		await runInDurableObject(f.stub, (_, ctx) =>
			ctx.storage.kv.put("fixture:raw-race", race),
		);
		await evictDurableObject(f.stub);
		f.stub = local.TEDI_AGENT.get(local.TEDI_AGENT.idFromName(f.name));
		const before = await observations(f);
		await expect(rawCallback(f, completedCallback(null))).rejects.toThrow(
			"Retained workflow observation rejected",
		);
		expect(await observations(f)).toEqual(before);
	},
);

async function nativeClaimCallbackSeed() {
	const f = await seed();
	const accepted = await runInDurableObject(f.stub, async (_, ctx) => {
		// Remove this diagnostic fixture's synthetic non-work rows before the genuine empty baseline.
		ctx.storage.sql.exec("DROP TABLE cf_agents_fibers");
		ctx.storage.kv.delete("wfctx:PRIVATE_FIRST");
		ctx.storage.kv.delete("wfctx:PRIVATE_SECOND");
		const helper = new RuntimeAdmissionDO(ctx.storage, f.owner);
		helper.gate.initialize({
			operationId: "original-baseline",
			state: "active",
			evidence: await helper.prepareEvidence("initialize"),
		});
		const accepted = await helper.beginAcceptedTurn({
			runId: "retained-run",
			sessionKey: "original-session",
			principalId: "original-principal",
			input: { text: "PRIVATE admitted original" },
			expectedGeneration: 1,
		});
		ctx.storage.kv.put("runtime-admission-workflow:retained-run", {
			id: "retained-workflow",
			stage: "dispatched",
			params: {
				runId: "retained-run",
				sessionKey: "original-session",
				userTs: 1,
			},
		});
		helper.gate.quarantine({
			operationId: "original-custody",
			expectedGeneration: 1,
			reason: "fixture",
		});
		ctx.storage.sql.exec(
			"CREATE TABLE cf_agents_workflows(id TEXT PRIMARY KEY,workflow_id TEXT,workflow_name TEXT,status TEXT,metadata TEXT,error_name TEXT,error_message TEXT,created_at INTEGER,updated_at INTEGER,completed_at INTEGER)",
		);
		ctx.storage.sql.exec(
			"INSERT INTO cf_agents_workflows(id,workflow_id,workflow_name,status,metadata) VALUES('tracking','retained-workflow','CHAT_TURN_WORKFLOW','queued','PRIVATE original')",
		);
		ctx.storage.sql.exec(
			"CREATE TABLE cf_agents_fibers(fiber_id TEXT PRIMARY KEY,idempotency_key TEXT,name TEXT,status TEXT,snapshot TEXT,metadata_json TEXT,error_message TEXT,created_at INTEGER,started_at INTEGER,completed_at INTEGER)",
		);
		ctx.storage.sql.exec(
			"INSERT INTO cf_agents_fibers(fiber_id,idempotency_key,name,status,snapshot) VALUES('retained-fiber','retained-key','original','interrupted','PRIVATE unknown')",
		);
		ctx.storage.kv.put("wfctx:retained-workflow", {
			runId: "retained-run",
			workflowInstanceId: "retained-workflow",
		});
		ctx.storage.kv.put("pi-accounting:retained-run", {
			runId: "retained-run",
			attempts: [{ phase: "unknown", usage: null, effectsSealed: false }],
		});
		ctx.storage.kv.put("fixture:raw", true);
		return {
			identity: accepted.accepted,
			generation: helper.read()!.generation,
		};
	});
	f.generation = accepted.generation;
	await evictDurableObject(f.stub);
	f.stub = local.TEDI_AGENT.get(local.TEDI_AGENT.idFromName(f.name));
	return { f, accepted: accepted.identity };
}
async function unchangedClaimCore(f: Awaited<ReturnType<typeof seed>>) {
	const snap = await snapshot(f.stub);
	return {
		sql: snap.sql.filter(
			(table) =>
				!archiveTables.has(table.name) &&
				table.name !== "cf_agents_workflows" &&
				table.name !== "cf_agents_fibers" &&
				table.name !== "historical_tracking_retirement",
		),
		kv: snap.kv.filter(
			([key]) =>
				!key.startsWith("runtime-workflow-observation:") &&
				!key.startsWith("fixture:claim-provenance-"),
		),
	};
}
it("genuine original claim and dispatch journal survive normal ACK before/after same-root retirement, cold dedup and late error without settlement", async () => {
	const { f, accepted } = await nativeClaimCallbackSeed(),
		core = await unchangedClaimCore(f),
		callback = completedCallback({ text: "PRIVATE original answer" });
	await rawCallback(f, callback);
	const original = await observations(f);
	expect(original).toHaveLength(1);
	expect(original[0]![1]).toMatchObject({
		providerAttested: false,
		provenance: { kind: "stored_native_dispatch", qualified: false, accepted },
	});
	const { archive } = await retireForCallback(f);
	await rawCallback(f, callback);
	expect(await observations(f)).toEqual(original);
	await evictDurableObject(f.stub);
	f.stub = local.TEDI_AGENT.get(local.TEDI_AGENT.idFromName(f.name));
	await rawCallback(f, callback);
	expect(await observations(f)).toEqual(original);
	await rawCallback(f, {
		workflowName: "CHAT_TURN_WORKFLOW",
		workflowId: "retained-workflow",
		type: "error",
		error: "PRIVATE original late error",
		timestamp: 2,
	});
	const retained = await observations(f);
	expect(retained).toHaveLength(2);
	for (const [, observation] of retained)
		expect(observation).toMatchObject({
			providerAttested: false,
			kind: "unqualified_namespace_rpc_observation",
			provenance: {
				kind: "stored_native_dispatch",
				qualified: false,
				accepted,
			},
		});
	expect(await unchangedClaimCore(f)).toEqual(core);
	expect(
		(await snapshot(f.stub)).sql.filter((table) =>
			archiveTables.has(table.name),
		),
	).toEqual(archive);
	await runInDurableObject(f.stub, (_, ctx) => {
		const helper = new RuntimeAdmissionDO(ctx.storage, f.owner);
		expect(helper.gate.claim("retained-run")?.status).toBe("running");
		expect(
			ctx.storage.sql
				.exec(
					"SELECT name FROM sqlite_master WHERE name='runtime_admission_receipts'",
				)
				.toArray(),
		).toEqual([]);
	});
});
it.each(["canonical", "tenant"] as const)(
	"final D1 %s validation follows awaited genuine original-claim provenance and refuses observation",
	async (race) => {
		const { f, accepted } = await nativeClaimCallbackSeed();
		const { archive } = await retireForCallback(f),
			core = await unchangedClaimCore(f);
		await runInDurableObject(f.stub, (_, ctx) =>
			ctx.storage.kv.put("fixture:claim-provenance-race", race),
		);
		await evictDurableObject(f.stub);
		f.stub = local.TEDI_AGENT.get(local.TEDI_AGENT.idFromName(f.name));
		await expect(rawCallback(f, completedCallback(null))).rejects.toThrow(
			"Retained workflow observation rejected",
		);
		expect(await observations(f)).toEqual([]);
		expect(
			await runInDurableObject(f.stub, (_, ctx) =>
				ctx.storage.kv.get("fixture:claim-provenance-verified"),
			),
		).toEqual({
			runId: accepted.runId,
			generation: accepted.generation,
			requestHash: accepted.requestHash,
		});
		expect(await unchangedClaimCore(f)).toEqual(core);
		expect(
			(await snapshot(f.stub)).sql.filter((table) =>
				archiveTables.has(table.name),
			),
		).toEqual(archive);
		const row = await local.DB.prepare(
			"SELECT organization_id,isolate_agent_id FROM tedis WHERE id=?",
		)
			.bind(f.owner.tediId)
			.first<{ organization_id: string; isolate_agent_id: string }>();
		expect(
			race === "canonical" ? row!.isolate_agent_id : row!.organization_id,
		).toBe("PRIVATE changed during real provenance");
	},
);
