import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import type {
	PiCutoverParentFixture,
	PiCutoverEarlyReturnFixture,
} from "./worker";
import { tediDo } from "../tedi-do";
const TOKEN = "cutover-native-fixture-token";
const CUTOVER_URL = "https://fixture/__admin/pi-state-cutover";
const ns = () =>
	env as unknown as {
		PI_CUTOVER_PARENT: DurableObjectNamespace<PiCutoverParentFixture>;
		PI_CUTOVER_EARLY: DurableObjectNamespace<PiCutoverEarlyReturnFixture>;
	};
it("parent inspection rejects a registered identity changed during its hash await", async () => {
	const namespace = ns().PI_CUTOVER_EARLY;
	const stub = namespace.get(namespace.idFromName(crypto.randomUUID()));
	await runInDurableObject(stub, async (_instance, state) => {
		const { inspectCutoverParent } = await import("../../src/pi-cutover-admin");
		state.storage.sql.exec(
			"CREATE TABLE cf_agents_sub_agents (class TEXT, name TEXT)",
		);
		state.storage.sql.exec(
			"INSERT INTO cf_agents_sub_agents VALUES ('ConversationFacet','original')",
		);
		const stable = await inspectCutoverParent(
			state.storage,
			state.id.toString(),
			{ offset: 0, limit: 200 },
			namespace,
		);
		expect(stable.inspectionTargets).toHaveLength(1);
		expect(stable.inspectionTargets.at(0)?.name).toBe("original");
		let changed = false;
		const changingNamespace = {
			idFromName(name: string) {
				if (!changed) {
					changed = true;
					queueMicrotask(() => {
						state.storage.sql.exec(
							"UPDATE cf_agents_sub_agents SET name='renamed' WHERE name='original'",
						);
					});
				}
				return namespace.idFromName(name);
			},
		};
		await expect(
			inspectCutoverParent(
				state.storage,
				state.id.toString(),
				{ offset: 0, limit: 200 },
				changingNamespace,
			),
		).rejects.toThrow("Inspection metadata changed");
		expect(changed).toBe(true);
		expect(
			state.storage.sql
				.exec<{ name: string }>("SELECT name FROM cf_agents_sub_agents")
				.one().name,
		).toBe("renamed");
	});
});
describe("native raw cutover storage maintenance", () => {
	it("actual warm parent onRequest accepts authenticated POST through the storage-only operator", async () => {
		const id = ns().PI_CUTOVER_EARLY.idFromName(crypto.randomUUID());
		const stub = ns().PI_CUTOVER_EARLY.get(id);
		await runInDurableObject(stub, async (_instance, ctx) => {
			const probe = tediDo({
				ctx,
				env: {
					SECRETS_MASTER_KEY: TOKEN,
					PI_CUTOVER_KNOWN_PARENT_IDS: JSON.stringify([ctx.id.toString()]),
				},
				hintsFromHeaders: () => ({}),
			});
			const body = {
				command: "quarantine",
				objectId: ctx.id.toString(),
				operationId: "warm-parent-quarantine",
				expectedGeneration: 0,
				reasonCode: "unknown_owner",
				custody: null,
			};
			const request = (token: string) =>
				new Request(CUTOVER_URL, {
					method: "POST",
					headers: { "X-Tedix-Admin-Token": token },
					body: JSON.stringify(body),
				});
			expect((await probe.onRequest(request("wrong"))).status).toBe(403);
			const response = await probe.onRequest(request(TOKEN));
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				ok: true,
				id: ctx.id.toString(),
				generation: 1,
				state: "quarantined",
			});
		});
	});

	it("warm class override stays original; targeted abort preserves identity and storage with siblings usable", async () => {
		const parent = ns().PI_CUTOVER_PARENT.get(
			ns().PI_CUTOVER_PARENT.idFromName(crypto.randomUUID()),
		);
		const before = await parent.seed("target", TOKEN);
		const sibling = await parent.seed("sibling", TOKEN);
		const identity = await parent.identity("target", TOKEN);
		expect(identity.identity_version).toBe("path-v2");
		expect(identity.identity_name).toBeTruthy();
		expect(await parent.rawRejected("target", TOKEN, false)).not.toBe(
			"unexpected success",
		);
		expect(await parent.original("target", TOKEN)).toEqual(before);
		expect(await parent.rawRejected("unknown", TOKEN, true)).toMatch(
			/unregistered/,
		);
		expect(await parent.rawRejected("target", "wrong", true)).toMatch(
			/unauthorized/,
		);
		const raw = JSON.parse(await parent.raw("target", TOKEN, true));
		expect(raw.id).toBe(before.objectId);
		expect(await parent.rawRejected("target", TOKEN, false, "wrong")).toMatch(
			/unauthorized/,
		);
		expect(raw.inventory.tables).toContainEqual({
			name: "cf_agents_session_config",
			rows: 1,
		});
		expect(raw.inventory.privateImages).toHaveLength(1);
		expect(JSON.stringify(raw)).not.toContain("workflow-image/secret");
		expect(JSON.stringify(raw)).not.toContain(TOKEN);
		expect(await parent.original("sibling", TOKEN)).toEqual(sibling);
		const denied = await parent.rawFetch(
			"target",
			TOKEN,
			new Request(CUTOVER_URL),
		);
		expect(denied.status).toBe(403);
		const response = await parent.rawFetch(
			"target",
			TOKEN,
			new Request(CUTOVER_URL, { headers: { "X-Tedix-Admin-Token": TOKEN } }),
		);
		expect(response.status).toBe(200);
		expect(((await response.json()) as { id: string }).id).toBe(
			before.objectId,
		);
		const restored = await parent.restore("target", TOKEN);
		expect(restored.objectId).toBe(before.objectId);
		expect(restored.kv).toBe(before.kv);
		expect(restored.sql).toEqual(before.sql);
		expect(restored.starts).toBe(before.starts! + 1);
		expect(await parent.identity("target", TOKEN)).toEqual(identity);
		expect(await parent.original("sibling", TOKEN)).toEqual(sibling);
		await parent.seed("bad-identity", TOKEN);
		await runInDurableObject(parent, async (_agent, state) => {
			state.storage.sql.exec(
				"UPDATE cf_agents_sub_agents SET identity_version=? WHERE name=?",
				"unknown",
				"bad-identity",
			);
		});
		expect(await parent.rawRejected("bad-identity", TOKEN, true)).toMatch(
			/unknown facet identity/,
		);
	});
	it("returning native Raw before Agent super serves RPC/fetch without hooks and retains storage", async () => {
		const id = ns().PI_CUTOVER_EARLY.idFromName(crypto.randomUUID());
		const stub = ns().PI_CUTOVER_EARLY.get(id);
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.put("early-witness", "preserved");
			state.storage.sql.exec(
				"CREATE TABLE cf_agents_session_config (witness TEXT)",
			);
			state.storage.sql.exec(
				"INSERT INTO cf_agents_session_config VALUES ('early-preserved')",
			);
		});
		const raw = stub as unknown as {
			inventory(token: string): Promise<{
				id: string;
				inventory: { tables: { name: string; rows: number }[] };
			}>;
		};
		await runInDurableObject(stub, async (instance) => {
			const reader = instance as unknown as {
				inventory(token: string): Promise<unknown>;
			};
			await expect(reader.inventory("wrong")).rejects.toThrow(/unauthorized/);
		});
		const snapshot = await raw.inventory(TOKEN);
		expect(snapshot.id).toBe(id.toString());
		expect(snapshot.inventory.tables).toEqual([
			{ name: "cf_agents_session_config", rows: 1 },
		]);
		expect((await stub.fetch(new Request(CUTOVER_URL))).status).toBe(403);
		expect(
			(
				await stub.fetch(
					new Request(CUTOVER_URL, {
						headers: { "X-Tedix-Admin-Token": TOKEN },
					}),
				)
			).status,
		).toBe(200);
		expect(
			(
				await stub.fetch(
					new Request(CUTOVER_URL, {
						method: "POST",
						headers: { "X-Tedix-Admin-Token": TOKEN },
					}),
				)
			).status,
		).toBe(400);
		expect(
			(
				await stub.fetch(
					new Request("https://fixture/unknown", {
						headers: { "X-Tedix-Admin-Token": TOKEN },
					}),
				)
			).status,
		).toBe(404);
		await runInDurableObject(stub, async (_instance, state) => {
			expect(await state.storage.get("early-witness")).toBe("preserved");
			expect(await state.storage.get("fixture-starts")).toBeUndefined();
			expect(
				state.storage.sql
					.exec("SELECT witness FROM cf_agents_session_config")
					.toArray(),
			).toEqual([{ witness: "early-preserved" }]);
		});
	});
});

it("finite inventory routing rejects unknown IDs before object creation", async () => {
	const { cutoverObjectIds, routeCutoverInventory } =
		await import("../../src/pi-cutover-admin");
	const storedId = "a".repeat(64);
	assert.equal(cutoverObjectIds(undefined).size, 0);
	assert.throws(() => cutoverObjectIds('["*"]'));
	assert.throws(() => cutoverObjectIds(JSON.stringify([storedId, storedId])));
	let opened = 0;
	let disposed = 0;
	const namespace = {
		idFromString(id: string) {
			assert.equal(id, storedId);
			return id;
		},
		get() {
			opened++;
			return {
				fetch: async () => new Response("bounded metadata"),
				[Symbol.dispose]() {
					disposed++;
				},
			};
		},
	} as unknown as Pick<
		DurableObjectNamespace,
		"idFromString" | "idFromName" | "get"
	>;
	const inspect = (id: string, credential?: string) =>
		routeCutoverInventory({
			request: new Request(
				`https://fixture/__admin/pi-state-cutover?objectId=${id}`,
				{ headers: credential ? { "X-Tedix-Admin-Token": credential } : {} },
			),
			masterKey: TOKEN,
			knownIds: JSON.stringify([storedId]),
			namespace,
		});
	assert.equal((await inspect(storedId, "wrong"))?.status, 403);
	assert.equal((await inspect("b".repeat(64), TOKEN))?.status, 404);
	assert.equal(opened, 0);
	assert.equal(
		await (await inspect(storedId, TOKEN))?.text(),
		"bounded metadata",
	);
	assert.equal(opened, 1);
	assert.equal(disposed, 1);
	console.log(
		"Finite object selection rejects unauthorized and unknown IDs before opening storage",
	);
});

it("name candidates preserve original namespace addressing only after exact ID match", async () => {
	const { routeCutoverInventory } = await import("../../src/pi-cutover-admin");
	const id = "c".repeat(64);
	const named = { toString: () => id, name: "original-name" };
	let opened: unknown;
	const namespace = {
		idFromString: () => ({ toString: () => id }),
		idFromName: (name: string) =>
			name === "original-name" ? named : { toString: () => "d".repeat(64) },
		get: (value: unknown) => {
			opened = value;
			return { fetch: async () => new Response("metadata") };
		},
	} as unknown as Pick<
		DurableObjectNamespace,
		"idFromString" | "idFromName" | "get"
	>;
	const sample = (names: unknown) =>
		routeCutoverInventory({
			request: new Request(
				"https://fixture/__admin/pi-state-cutover?" +
					new URLSearchParams({
						objectId: id,
						candidateObjectNames: JSON.stringify(names),
					}),
				{ headers: { "X-Tedix-Admin-Token": TOKEN } },
			),
			masterKey: TOKEN,
			knownIds: JSON.stringify([id]),
			namespace,
		});
	expect((await sample(["other", "original-name"]))?.status).toBe(200);
	expect(opened).toBe(named);
	opened = undefined;
	expect((await sample(["other"]))?.status).toBe(200);
	expect(opened).not.toBe(named);
	opened = undefined;
	expect((await sample([42]))?.status).toBe(400);
	expect(opened).toBeUndefined();
	expect((await sample(Array(101).fill("candidate")))?.status).toBe(400);
	expect(opened).toBeUndefined();
});

it("reads every raw metadata page with stable full counts and fails stale or unhashed continuations", async () => {
	const id = ns().PI_CUTOVER_EARLY.idFromName(crypto.randomUUID());
	const stub = ns().PI_CUTOVER_EARLY.get(id);
	await runInDurableObject(stub, async (_instance, state) => {
		state.storage.sql.exec(
			"CREATE TABLE cf_agents_sub_agents (class TEXT,name TEXT)",
		);
		for (let i = 0; i < 1205; i++)
			state.storage.sql.exec(
				"INSERT INTO cf_agents_sub_agents VALUES ('ConversationFacet',?)",
				`synthetic-${i}`,
			);
	});
	const headers = { "X-Tedix-Admin-Token": TOKEN };
	const first = await stub.fetch(new Request(CUTOVER_URL, { headers }));
	expect(first.status).toBe(200);
	const start = (await first.json()) as {
		hash: string;
		inspectionHash: string;
		targetsKnown: boolean;
		inspectionTargets: unknown[];
		counts: { children: number };
		nextOffset: number | null;
		inventory: { children: unknown[] };
	};
	expect(start.targetsKnown).toBe(false);
	expect(start.inspectionTargets).toEqual([]);
	expect(start.counts.children).toBe(1205);
	expect(start.inventory.children).toHaveLength(200);
	let count = start.inventory.children.length,
		offset = start.nextOffset;
	while (offset !== null) {
		const response = await stub.fetch(
			new Request(
				`${CUTOVER_URL}?offset=${offset}&limit=200&expectedHash=${start.hash}&expectedInspectionHash=${start.inspectionHash}`,
				{ headers },
			),
		);
		expect(response.status).toBe(200);
		const page = (await response.json()) as typeof start;
		expect(page.hash).toBe(start.hash);
		expect(page.counts.children).toBe(1205);
		expect(page.inventory.children.length).toBeLessThanOrEqual(200);
		count += page.inventory.children.length;
		offset = page.nextOffset;
	}
	expect(count).toBe(1205);
	expect(
		(await stub.fetch(new Request(`${CUTOVER_URL}?offset=200`, { headers })))
			.status,
	).toBe(400);
	expect(
		(
			await stub.fetch(
				new Request(
					`${CUTOVER_URL}?offset=200&expectedHash=${"b".repeat(64)}&expectedInspectionHash=${"b".repeat(64)}`,
					{
						headers,
					},
				),
			)
		).status,
	).toBe(409);
	await runInDurableObject(stub, async (_instance, state) => {
		expect(await state.storage.get("fixture-starts")).toBeUndefined();
		expect(
			state.storage.sql
				.exec<{ count: number }>(
					"SELECT COUNT(*) AS count FROM cf_agents_sub_agents",
				)
				.toArray()[0]?.count,
		).toBe(1205);
	});
});

it("raw custody records only previously reserved original usage after quarantine and eviction", async () => {
	const id = ns().PI_CUTOVER_EARLY.idFromName(crypto.randomUUID());
	const stub = ns().PI_CUTOVER_EARLY.get(id);
	await stub.fetch(new Request(CUTOVER_URL));
	await runInDurableObject(stub, async (_instance, state) => {
		const { RuntimeAdmissionDO } =
			await import("../../src/runtime-admission-do");
		const { DoInferenceBudgetStore } =
			await import("../../src/inference-budget-store-do");
		const { TediBudgetsSchema } =
			await import("@tedix/api-contract/schemas/tedi");
		const owner = {
			tediId: "00000000-0000-4000-8000-000000000002",
			orgId: "00000000-0000-4000-8000-000000000003",
			objectId: state.id.toString(),
		};
		state.storage.sql.exec(
			"CREATE TABLE cf_agents_state(id TEXT PRIMARY KEY,state TEXT)",
		);
		state.storage.sql.exec(
			"INSERT INTO cf_agents_state VALUES('cf_state_row_id',?)",
			JSON.stringify({ tediId: owner.tediId, orgId: owner.orgId }),
		);
		const helper = new RuntimeAdmissionDO(state.storage, owner);
		const evidence = await helper.prepareEvidence("initialize");
		helper.gate.initialize({
			operationId: "original-baseline",
			state: "active",
			evidence,
		});
		await helper.beginAcceptedTurn({
			runId: "original-run",
			sessionKey: "original-session",
			principalId: "original-principal",
			input: { prompt: "PRIVATE original input" },
			expectedGeneration: 1,
		});
		const runner = {
			sql: <T>(
				strings: TemplateStringsArray,
				...values: (string | number | boolean | null)[]
			) =>
				state.storage.sql
					.exec(
						strings.join("?"),
						...values.map((value) =>
							typeof value === "boolean" ? Number(value) : value,
						),
					)
					.toArray() as T[],
		};
		const budget = new DoInferenceBudgetStore(runner),
			limits = TediBudgetsSchema.parse({});
		budget.admit("original-run", limits, 1);
		budget.reserveStep("original-run", "original-step", 1, limits);
		helper.gate.quarantine({
			operationId: "operator-custody",
			expectedGeneration: 1,
			reason: "operator_hold",
		});
		await state.storage.put("durable-receipt-proof", true);
	});
	await expect(
		runInDurableObject(stub, async (_instance, state) => {
			state.abort("native receipt proof eviction");
		}),
	).rejects.toThrow();
	const raw = ns().PI_CUTOVER_EARLY.get(id) as unknown as DurableObjectStub<
		import("../../src/pi-cutover-maintenance-do").RawCutoverDO
	>;
	expect(
		(
			await raw.recordPiStep({
				runId: "original-run",
				stepId: "original-step",
				actualTokens: 3,
			})
		).usedTokens,
	).toBe(3);
	expect(
		(
			await raw.recordPiStep({
				runId: "original-run",
				stepId: "original-step",
				actualTokens: 3,
			})
		).usedTokens,
	).toBe(3);
	// Catch expected denial inside the native object: Vitest RPC wrappers emit
	// rejected receiver promises as unhandled errors even when clients await them.
	await runInDurableObject(raw, async (instance) => {
		await expect(
			instance.recordPiStep({
				runId: "foreign-run",
				stepId: "original-step",
				actualTokens: 3,
			}),
		).rejects.toThrow(/rejected/);
		await expect(
			instance.recordPiStep({
				runId: "original-run",
				stepId: "unreserved-step",
				actualTokens: 3,
			}),
		).rejects.toThrow(/rejected/);
	});
	await runInDurableObject(raw, async (_instance, state) => {
		expect(await state.storage.get("durable-receipt-proof")).toBe(true);
		const row = state.storage.sql
			.exec<{ record: string }>(
				"SELECT record FROM runtime_admission WHERE id=1",
			)
			.toArray()[0]!;
		expect(JSON.parse(row.record).state).toBe("quarantined");
		expect(
			state.storage.sql
				.exec("SELECT name FROM sqlite_master WHERE name LIKE 'pi%tasks'")
				.toArray(),
		).toHaveLength(0);
	});
});

// Actual native facets and local D1 custody; these fixtures do not call a production model.
it("passive registered graph inspection preserves warm Telegram and refuses unknown warm Researcher, then reads cold original storage", async () => {
	const { getAgentByName } = await import("agents");
	const { routeCutoverInventory } = await import("../../src/pi-cutover-admin");
	const local = env as unknown as Cloudflare.Env;
	const name = "inspection-" + crypto.randomUUID(),
		tediId = crypto.randomUUID(),
		orgId = crypto.randomUUID();
	await local.DB.exec(
		"CREATE TABLE IF NOT EXISTS tedis (id TEXT PRIMARY KEY,organization_id TEXT,slug TEXT,isolate_agent_id TEXT,runtime_kind TEXT,status TEXT)",
	);
	await local.DB.prepare("INSERT INTO tedis VALUES (?,?,?,?,?,?)")
		.bind(tediId, orgId, name, name, "agent", "active")
		.run();
	const namespace = local.TEDI_AGENT as unknown as DurableObjectNamespace<
		import("./worker").AgentTediDO
	>;
	const root = await getAgentByName(namespace, name);
	const seeded = await root.seedInspection();
	const researchBefore = JSON.parse(await root.researchSnapshot()) as {
			registry: Array<{ class: string; identity_name: string }>;
		},
		telegramBefore = await root.telegramWitness();

	const rootId = namespace.idFromName(name).toString();
	const send = async (
		path?: unknown[],
		generation?: number,
		page?: Record<string, string>,
	) => {
		const url = new URL(CUTOVER_URL);
		url.searchParams.set("objectId", rootId);
		url.searchParams.set("custodyTediId", tediId);
		if (path) url.searchParams.set("targetPath", JSON.stringify(path));
		for (const [key, value] of Object.entries(page ?? {}))
			url.searchParams.set(key, value);
		if (generation !== undefined)
			url.searchParams.set("expectedGeneration", String(generation));
		return (await routeCutoverInventory({
			request: new Request(url, { headers: { "X-Tedix-Admin-Token": TOKEN } }),
			masterKey: TOKEN,
			knownIds: JSON.stringify([rootId]),
			env: local,
			namespace,
		}))!;
	};
	const rootResponse = await send();
	expect(rootResponse.status).toBe(200);
	const inventory = (await rootResponse.json()) as {
		inventory: {
			children: Array<{
				className: string;
				name: string;
				identityVersion: string | null;
				identityName: string;
			}>;
		};
		hash: string;
		inspectionHash: string;
		targetsKnown: boolean;
		inspectionTargets: import("@tedix/api-contract/schemas/tedi").CutoverInspectionHop[];
		admission: unknown;
	};
	expect(inventory.admission).toBeNull();
	const childRow = inventory.inventory.children[0]!;
	const researchRow = {
		class: childRow.className,
		name: childRow.name,
		identity_version: childRow.identityVersion,
		identity_name: childRow.identityName,
	};
	const researchId = namespace.idFromName(researchRow.identity_name).toString();
	const hop = {
		className: researchRow.class,
		name: researchRow.name,
		identityVersion: researchRow.identity_version,
		identityName: researchRow.identity_name,
		objectId: researchId,
		registryHash: inventory.hash,
		parentGeneration: 0,
	};
	expect(inventory.targetsKnown).toBe(true);
	expect(inventory.inspectionTargets).toEqual([hop]);
	const rootPage = await send(undefined, undefined, { limit: "1" });
	const rootPageData = (await rootPage.json()) as {
		inspectionTargets: unknown[];
		targetsKnown: boolean;
		hash: string;
		inspectionHash: string;
	};
	expect(rootPageData.inspectionTargets).toEqual([hop]);
	const rootContinuation = await send(undefined, undefined, {
		limit: "1",
		offset: "1",
		expectedHash: rootPageData.hash,
		expectedInspectionHash: rootPageData.inspectionHash,
	});
	expect(rootContinuation.status).toBe(200);
	expect(
		((await rootContinuation.json()) as { inspectionTargets: unknown[] })
			.inspectionTargets,
	).toEqual([]);

	const forwardedCustody = {
		rootId,
		tediId,
		orgId,
		objectName: name,
		parentPath: [
			{ className: "AgentTediDO", name },
			{ className: "Researcher", name: "research" },
		],
		current: {
			className: "ThinkMessengerStateAgent",
			name: "telegram",
			identityName: "",
			objectId: "",
		},
	};
	const telegramRow = researchBefore.registry.find(
		(row) => (row as { class: string }).class === "ThinkMessengerStateAgent",
	) as { identity_name: string };
	forwardedCustody.current.identityName = telegramRow.identity_name;
	forwardedCustody.current.objectId = namespace
		.idFromName(telegramRow.identity_name)
		.toString();
	const telegram = await root.telegramInspection({
		url: CUTOVER_URL,
		token: TOKEN,
		custody: JSON.stringify(forwardedCustody),
	});
	expect(telegram.status).toBe(200);
	expect(JSON.parse(telegram.body).inventory.storedOwner).toMatchObject({
		tediId: null,
		orgId: null,
		unknown: true,
	});
	expect(telegram.body).not.toContain("PRIVATE-TELEGRAM");
	expect(await root.telegramWitness()).toEqual(telegramBefore);
	const forgedTelegram = await root.telegramInspection({
		url: CUTOVER_URL,
		token: TOKEN,
		custody: JSON.stringify({
			...forwardedCustody,
			parentPath: [{ className: "AgentTediDO", name: "forged" }],
		}),
	});
	expect(forgedTelegram.status).toBe(409);
	expect(await root.telegramWitness()).toEqual(telegramBefore);

	expect((await send([hop])).status).toBe(409);
	expect(JSON.parse(await root.researchSnapshot())).toEqual(researchBefore);
	for (const mutation of [
		{ objectId: "a".repeat(64) },
		{ name: "unregistered" },
		{ identityName: "forged" },
		{ identityVersion: null, identityName: null },
		{ registryHash: "b".repeat(64) },
		{ parentGeneration: 1 },
	])
		expect((await send([{ ...hop, ...mutation }])).status).toBe(409);
	expect(JSON.parse(await root.researchSnapshot())).toEqual(researchBefore);
	await abortAllDurableObjects(); // Fixture eviction only; inspection itself never aborts a facet.
	const cold = await send([hop]);
	expect(cold.status).toBe(200);
	const child = (await cold.json()) as {
		id: string;
		hash: string;
		inspectionHash: string;
		targetsKnown: boolean;
		inspectionTargets: import("@tedix/api-contract/schemas/tedi").CutoverInspectionHop[];
		inventory: {
			children: Array<{
				className: string;
				name: string;
				identityName: string;
				identityVersion: string | null;
			}>;
		};
	};
	expect(child.id).toBe(researchId);
	const firstPage = await send([hop], 0, { limit: "1" });
	expect(firstPage.status).toBe(200);
	const firstPageData = (await firstPage.json()) as {
		hash: string;
		inspectionHash: string;
		counts: { tables: number };
	};
	expect(firstPageData.hash).toBe(child.hash);
	expect(firstPageData.counts.tables).toBeGreaterThan(1);
	expect(
		(
			await send([hop], 0, {
				offset: "1",
				limit: "1",
				expectedHash: child.hash,
				expectedInspectionHash: child.inspectionHash,
			})
		).status,
	).toBe(200);
	expect(
		(
			await send([hop], 0, {
				offset: "1",
				limit: "1",
				expectedHash: "e".repeat(64),
				expectedInspectionHash: child.inspectionHash,
			})
		).status,
	).toBe(409);

	expect(JSON.stringify(child)).not.toContain("PRIVATE-RESEARCH");
	const nested = child.inventory.children[0]!;
	const second = {
		className: nested.className,
		name: nested.name,
		identityVersion: nested.identityVersion,
		identityName: nested.identityName,
		objectId: namespace.idFromName(nested.identityName).toString(),
		registryHash: child.hash,
		parentGeneration: 0,
	};
	expect(child.targetsKnown).toBe(true);
	expect(child.inspectionTargets).toEqual([second]);
	const emittedResponse = await send([
		inventory.inspectionTargets[0],
		child.inspectionTargets[0],
	]);
	expect(emittedResponse.status).toBe(200);
	const response = await send([hop, second]);
	expect(response.status).toBe(200);
	expect(await response.text()).not.toContain("PRIVATE-TELEGRAM");
	expect((await send([hop, second], 1)).status).toBe(409);
	expect((await send([{ ...hop, registryHash: "c".repeat(64) }])).status).toBe(
		409,
	);

	await runInDurableObject(
		namespace.get(namespace.idFromName(name)),
		async (_instance, ctx) => {
			ctx.storage.sql.exec(
				"UPDATE cf_agents_sub_agents SET identity_name='changed-registry' WHERE class='Researcher'",
			);
		},
	);
	expect((await send([hop])).status).toBe(409);
	await runInDurableObject(
		namespace.get(namespace.idFromName(name)),
		async (_instance, ctx) => {
			ctx.storage.sql.exec(
				"UPDATE cf_agents_sub_agents SET identity_version='path-v2',identity_name=NULL WHERE class='Researcher'",
			);
		},
	);
	const invalidPair = await send();
	expect(invalidPair.status).toBe(409);
	expect(await invalidPair.text()).toContain("verification_rejected");
	expect(seeded.id).toBe(rootId);
});

it("passive metadata projects strict admission and bounded SDK statuses without changing SQL KV or alarm", async () => {
	await runInDurableObject(
		ns().PI_CUTOVER_EARLY.get(
			ns().PI_CUTOVER_EARLY.idFromName(crypto.randomUUID()),
		),
		async (_instance, ctx) => {
			const { inspectCutoverParent } =
				await import("../../src/pi-cutover-admin");
			const { RuntimeAdmissionDO } =
				await import("../../src/runtime-admission-do");
			const owner = {
				tediId: crypto.randomUUID(),
				orgId: crypto.randomUUID(),
				objectId: ctx.id.toString(),
			};
			ctx.storage.sql.exec(
				"CREATE TABLE cf_agents_state (id TEXT PRIMARY KEY,state TEXT)",
			);
			ctx.storage.sql.exec(
				"INSERT INTO cf_agents_state VALUES ('cf_state_row_id',?)",
				JSON.stringify(owner),
			);
			const helper = new RuntimeAdmissionDO(ctx.storage, owner),
				admission = helper.gate;
			const evidence = await helper.prepareEvidence("initialize");
			admission.initialize({
				operationId: "inspection-baseline",
				state: "active",
				evidence,
			});
			ctx.storage.sql.exec(
				"CREATE TABLE cf_agents_task_runs (status TEXT,payload TEXT)",
			);
			for (const status of [
				"interrupted",
				"running",
				"completed",
				"private-provider-status",
			])
				ctx.storage.sql.exec(
					"INSERT INTO cf_agents_task_runs VALUES (?,?)",
					status,
					"PRIVATE-PROVIDER",
				);
			await ctx.storage.put("tedix:pi:maintenance:v1:isolate-corpus-audit", {
				nextRunAt: 5000,
				legacyScheduleIds: ["old"],
				legacyCancelled: true,
				nativeScheduleId: "new",
			});
			await ctx.storage.setAlarm(Date.now() + 60000);
			const before = {
				kv: [...(await ctx.storage.list())],
				sql: ctx.storage.sql
					.exec("SELECT * FROM cf_agents_task_runs")
					.toArray(),
				alarm: await ctx.storage.getAlarm(),
			};
			const first = await inspectCutoverParent(ctx.storage, ctx.id.toString());
			expect(first.admission).toEqual({ state: "active", generation: 1 });
			expect(
				first.sdkWork.find((row) => row.table === "cf_agents_task_runs")
					?.counts,
			).toEqual({ interrupted: 1, running: 1, completed: 1, unknown: 1 });
			expect(first.maintenanceJournal.records[0]).toMatchObject({
				taskId: "isolate-corpus-audit",
				legacyCancelled: true,
				nativeScheduleId: "new",
			});
			expect(JSON.stringify(first)).not.toContain("PRIVATE-PROVIDER");
			expect(JSON.stringify(first)).not.toContain("private-provider-status");
			expect({
				kv: [...(await ctx.storage.list())],
				sql: ctx.storage.sql
					.exec("SELECT * FROM cf_agents_task_runs")
					.toArray(),
				alarm: await ctx.storage.getAlarm(),
			}).toEqual(before);
			await expect(helper.prepareEvidence("hold")).rejects.toThrow(
				/nonterminal|unknown/,
			);
			expect(admission.read()?.state).toBe("active");
			admission.quarantine({
				operationId: "inspection-new-generation",
				expectedGeneration: 1,
				reason: "explicit hold",
			});
			expect(
				(await inspectCutoverParent(ctx.storage, ctx.id.toString())).admission,
			).toEqual({ state: "quarantined", generation: 2 });

			ctx.storage.sql.exec(
				"UPDATE runtime_admission SET record='malformed' WHERE id=1",
			);
			await expect(
				inspectCutoverParent(ctx.storage, ctx.id.toString()),
			).rejects.toThrow();
		},
	);
});

it.each(["root-state", "facet-state", "root-admission", "facet-admission"])(
	"known custody rejects contradictory stored identity %s without changing storage",
	async (kind) => {
		const { operateStoredCutover } = await import("../../src/pi-cutover-admin");
		const { RuntimeAdmission } = await import("../../src/runtime-admission");
		const local = env as unknown as Cloudflare.Env;
		const rootName = crypto.randomUUID(),
			childName = crypto.randomUUID(),
			tediId = crypto.randomUUID(),
			orgId = crypto.randomUUID();
		const namespace = ns().PI_CUTOVER_EARLY;
		const rootId = namespace.idFromName(rootName).toString(),
			facet = kind.startsWith("facet");
		await local.DB.exec(
			"CREATE TABLE IF NOT EXISTS tedis (id TEXT PRIMARY KEY,organization_id TEXT,slug TEXT,isolate_agent_id TEXT,runtime_kind TEXT,status TEXT)",
		);
		await local.DB.prepare("INSERT INTO tedis VALUES (?,?,?,?,?,?)")
			.bind(tediId, orgId, rootName, rootName, "agent", "active")
			.run();
		await runInDurableObject(
			namespace.get(namespace.idFromName(facet ? childName : rootName)),
			async (_instance, ctx) => {
				const path = facet
					? [{ className: "AgentTediDO", name: rootName }]
					: [];
				if (facet) {
					ctx.storage.kv.put("cf_agents_is_facet", true);
					ctx.storage.kv.put("cf_agents_facet_name", "child");
					ctx.storage.kv.put("cf_agents_parent_path", path);
				}
				ctx.storage.sql.exec(
					"CREATE TABLE cf_agents_state(id TEXT PRIMARY KEY,state TEXT)",
				);
				const foreign = { tediId: crypto.randomUUID(), orgId };
				const state = kind.endsWith("state")
					? facet
						? { aigMetadata: foreign }
						: foreign
					: {};
				ctx.storage.sql.exec(
					"INSERT INTO cf_agents_state VALUES('cf_state_row_id',?)",
					JSON.stringify(state),
				);
				if (kind.endsWith("admission"))
					new RuntimeAdmission(
						ctx.storage,
						{ ...foreign, objectId: ctx.id.toString() },
						() => {
							throw new Error("No transition proof");
						},
					).initialize({
						operationId: "contradictory-fixture-custody",
						state: "quarantined",
						reason: "fixture",
					});
				const custody = {
					rootId,
					tediId,
					orgId,
					objectName: rootName,
					parentPath: path,
					current: facet
						? {
								className: "Researcher",
								name: "child",
								identityName: childName,
								objectId: ctx.id.toString(),
							}
						: null,
				};
				const snapshot = () => ({
					kv: [...ctx.storage.kv.list()],
					state: ctx.storage.sql
						.exec("SELECT * FROM cf_agents_state")
						.toArray(),
					admission: kind.endsWith("admission")
						? ctx.storage.sql.exec("SELECT * FROM runtime_admission").toArray()
						: [],
				});
				const before = snapshot();
				const response = await operateStoredCutover({
					ctx,
					env: {
						...local,
						TEDI_AGENT: namespace,
						PI_CUTOVER_KNOWN_PARENT_IDS: JSON.stringify([rootId]),
					} as unknown as Cloudflare.Env,
					request: new Request(CUTOVER_URL, {
						headers: {
							"X-Tedix-Admin-Token": TOKEN,
							"X-Tedix-Cutover-Inspection-Custody": JSON.stringify(custody),
						},
					}),
				});
				expect(response.status).toBe(409);
				expect(await response.json()).toEqual({
					ok: false,
					rejection: "inspection_owner_mismatch",
				});
				expect(snapshot()).toEqual(before);
			},
		);
	},
);

it("journal-only pages preserve both complete pins and reject SDK status and journal changes", async () => {
	const { PARENT_MAINTENANCE_TASKS } =
		await import("../../src/pi-parent-services");
	const { inspectCutoverParent } = await import("../../src/pi-cutover-admin");
	await runInDurableObject(
		ns().PI_CUTOVER_EARLY.get(
			ns().PI_CUTOVER_EARLY.idFromName(crypto.randomUUID()),
		),
		async (_instance, ctx) => {
			for (const taskId of Object.keys(PARENT_MAINTENANCE_TASKS))
				ctx.storage.kv.put("tedix:pi:maintenance:v1:" + taskId, {
					nextRunAt: 5000,
					legacyScheduleIds: [],
					legacyCancelled: true,
				});
			ctx.storage.sql.exec(
				"CREATE TABLE cf_agents_workflows(workflow_id TEXT NOT NULL UNIQUE,workflow_name TEXT NOT NULL,status TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,completed_at INTEGER)",
			);
			ctx.storage.sql.exec(
				"INSERT INTO cf_agents_workflows VALUES('sdk-id','CHAT_TURN_WORKFLOW','interrupted',1,1,NULL)",
			);
			const first = await inspectCutoverParent(ctx.storage, ctx.id.toString(), {
				offset: 0,
				limit: 1,
			});
			expect(Object.values(first.counts).every((count) => count === 0)).toBe(
				true,
			);
			expect(first.nextOffset).toBe(1);
			const collected = [...first.maintenanceJournal.records];
			let offset = first.nextOffset;
			while (offset !== null) {
				const next = await inspectCutoverParent(
					ctx.storage,
					ctx.id.toString(),
					{
						offset,
						limit: 1,
						expectedHash: first.hash,
						expectedInspectionHash: first.inspectionHash,
					},
				);
				expect(next.inspectionHash).toBe(first.inspectionHash);
				collected.push(...next.maintenanceJournal.records);
				offset = next.nextOffset;
			}
			expect(collected.map((row) => row.taskId).sort()).toEqual(
				Object.keys(PARENT_MAINTENANCE_TASKS).sort(),
			);
			const continuation = {
				offset: 1,
				limit: 1,
				expectedHash: first.hash,
				expectedInspectionHash: first.inspectionHash,
			};
			ctx.storage.sql.exec("UPDATE cf_agents_workflows SET status='running'");
			const changedSdk = await inspectCutoverParent(
				ctx.storage,
				ctx.id.toString(),
				{ offset: 0, limit: 1 },
			);
			expect(changedSdk.hash).toBe(first.hash);
			expect(changedSdk.inspectionHash).not.toBe(first.inspectionHash);
			await expect(
				inspectCutoverParent(ctx.storage, ctx.id.toString(), continuation),
			).rejects.toThrow(/Inspection metadata changed/);
			ctx.storage.sql.exec(
				"UPDATE cf_agents_workflows SET status='interrupted'",
			);
			ctx.storage.kv.put("tedix:pi:maintenance:v1:isolate-corpus-audit", {
				nextRunAt: 6000,
				legacyScheduleIds: [],
				legacyCancelled: true,
			});
			const changedJournal = await inspectCutoverParent(
				ctx.storage,
				ctx.id.toString(),
				{ offset: 0, limit: 1 },
			);
			expect(changedJournal.hash).toBe(first.hash);
			expect(changedJournal.inspectionHash).not.toBe(first.inspectionHash);
			await expect(
				inspectCutoverParent(ctx.storage, ctx.id.toString(), continuation),
			).rejects.toThrow(/Inspection metadata changed/);
		},
	);
});

it.each(["d1", "registry", "child"])(
	"registered inspection rejects a parent epoch changed during %s await",
	async (stage) => {
		const { getAgentByName } = await import("agents");
		const { inspectRegisteredCutover } =
			await import("../../src/pi-cutover-admin");
		const { pageCutoverInventory } =
			await import("../../src/pi-cutover-operator");
		const { RuntimeAdmissionDO } =
			await import("../../src/runtime-admission-do");
		const local = env as unknown as Cloudflare.Env,
			namespace = local.TEDI_AGENT as unknown as DurableObjectNamespace<
				import("./worker").AgentTediDO
			>;
		const name = "epoch-" + crypto.randomUUID(),
			tediId = crypto.randomUUID(),
			orgId = crypto.randomUUID(),
			id = namespace.idFromName(name);
		await local.DB.exec(
			"CREATE TABLE IF NOT EXISTS tedis (id TEXT PRIMARY KEY,organization_id TEXT,slug TEXT,isolate_agent_id TEXT,runtime_kind TEXT,status TEXT)",
		);
		await local.DB.prepare("INSERT INTO tedis VALUES(?,?,?,?,?,?)")
			.bind(tediId, orgId, name, name, "agent", "active")
			.run();
		const root = await getAgentByName(namespace, name);
		await runInDurableObject(root, async (_instance, ctx) => {
			ctx.storage.sql.exec(
				"INSERT OR REPLACE INTO cf_agents_state(id,state) VALUES('cf_state_row_id',?)",
				JSON.stringify({ tediId, orgId }),
			);
			const admission = new RuntimeAdmissionDO(ctx.storage, {
				tediId,
				orgId,
				objectId: ctx.id.toString(),
			});
			const evidence = await admission.prepareEvidence("initialize");
			admission.gate.initialize({
				operationId: "epoch-fixture",
				state: "active",
				evidence,
			});
		});
		await root.seedInspection();
		await abortAllDurableObjects(); // Preparation establishes a cold stored registered child; never done by inspection.
		await runInDurableObject(namespace.get(id), async (_instance, ctx) => {
			const admission = new RuntimeAdmissionDO(ctx.storage, {
					tediId,
					orgId,
					objectId: ctx.id.toString(),
				}),
				original = await pageCutoverInventory(ctx.storage, {
					offset: 0,
					limit: 200,
				});
			const child = original.inventory.children[0]!;
			const hop = {
				className: child.className,
				name: child.name,
				identityVersion: child.identityVersion,
				identityName: child.identityName,
				objectId: namespace.idFromName(child.identityName!).toString(),
				registryHash: original.hash,
				parentGeneration: 1,
			};
			let changed = false;
			const change = () => {
				if (!changed) {
					changed = true;
					admission.gate.quarantine({
						operationId: "epoch-change",
						expectedGeneration: 1,
						reason: "native test race",
					});
				}
			};
			const db = {
				prepare: (sql: string) => ({
					bind: (...values: unknown[]) => {
						const stmt = local.DB.prepare(sql).bind(...values);
						return {
							first: async () => {
								const row = await stmt.first();
								if (stage === "d1") change();
								return row;
							},
						};
					},
				}),
			};
			const sql = {
				exec: (query: string, ...bindings: SqlStorageValue[]) => {
					const rows = ctx.storage.sql.exec(query, ...bindings);
					if (
						stage === "registry" &&
						query.includes("SELECT COUNT(*) AS count FROM cf_agents_sub_agents")
					)
						change();
					return rows;
				},
			};
			const storage = new Proxy(ctx.storage, {
				get: (target, key) =>
					key === "sql"
						? sql
						: typeof Reflect.get(target, key) === "function"
							? Reflect.get(target, key).bind(target)
							: Reflect.get(target, key),
			});
			const facets = {
				get: (key: string, factory: () => unknown) => {
					const actual = (
						ctx.facets as unknown as {
							get: (key: string, factory: () => unknown) => unknown;
						}
					).get(key, factory) as {
						inspectStoredCutover(input: unknown): Promise<unknown>;
					};
					return new Proxy(actual, {
						get: (target, property) =>
							property === "inspectStoredCutover"
								? async (input: unknown) => {
										const response = await target.inspectStoredCutover(input);
										if (stage === "child") change();
										return response;
									}
								: typeof Reflect.get(target, property) === "function"
									? Reflect.get(target, property).bind(target)
									: Reflect.get(target, property),
					});
				},
			};
			const wrapped = new Proxy(ctx, {
				get: (target, key) =>
					key === "storage"
						? storage
						: key === "facets"
							? facets
							: Reflect.get(target, key),
			});
			const url = new URL(CUTOVER_URL);
			url.searchParams.set("targetPath", JSON.stringify([hop]));
			const custody = {
				rootId: id.toString(),
				tediId,
				orgId,
				objectName: name,
				parentPath: [],
				current: null,
			};
			await expect(
				inspectRegisteredCutover(
					wrapped,
					{
						...local,
						DB: db,
						PI_CUTOVER_KNOWN_PARENT_IDS: JSON.stringify([id.toString()]),
					} as unknown as Cloudflare.Env,
					new Request(url, {
						headers: {
							"X-Tedix-Admin-Token": TOKEN,
							"X-Tedix-Cutover-Inspection-Custody": JSON.stringify(custody),
						},
					}),
					{ offset: 0, limit: 200 },
				),
			).rejects.toThrow(/Admission epoch changed/);
			expect(changed).toBe(true);
			expect(admission.read()?.generation).toBe(2);
		});
	},
);

it("diagnostic workflow counts preserve pinned SDK SQL labels and keep arbitrary future statuses unknown", async () => {
	await runInDurableObject(
		ns().PI_CUTOVER_EARLY.get(
			ns().PI_CUTOVER_EARLY.idFromName(crypto.randomUUID()),
		),
		async (_instance, ctx) => {
			const { inspectSdkWork } = await import("../../src/pi-cutover-admin");
			const statuses = [
				"queued",
				"running",
				"paused",
				"errored",
				"terminated",
				"complete",
				"waiting",
				"waitingForPause",
				"unknown",
			] as const;
			// Matches agents@0.26 cf_agents_workflows CHECK; rollingBack appears in generated types but is not accepted by this SQL schema.
			ctx.storage.sql.exec(
				"CREATE TABLE cf_agents_workflows (workflow_id TEXT NOT NULL UNIQUE,workflow_name TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','running','paused','errored','terminated','complete','waiting','waitingForPause','unknown')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,completed_at INTEGER)",
			);
			for (const status of statuses)
				ctx.storage.sql.exec(
					"INSERT INTO cf_agents_workflows VALUES (?,'CHAT_TURN_WORKFLOW',?,1,1,NULL)",
					`workflow-${status}`,
					status,
				);
			expect(() =>
				ctx.storage.sql.exec(
					"INSERT INTO cf_agents_workflows VALUES ('future','CHAT_TURN_WORKFLOW','rollingBack',1,1,NULL)",
				),
			).toThrow();
			ctx.storage.sql.exec("CREATE TABLE cf_agents_task_runs (status TEXT)");
			ctx.storage.sql.exec(
				"INSERT INTO cf_agents_task_runs VALUES ('future-private-status'),('interrupted')",
			);
			const original = ctx.storage.sql
				.exec("SELECT * FROM cf_agents_workflows")
				.toArray();
			const alarm = await ctx.storage.getAlarm();
			const counts = inspectSdkWork(ctx.storage);
			const { inspectCutoverParent } =
				await import("../../src/pi-cutover-admin");
			const { TediRuntimeCutoverInventoryResponseSchema } =
				await import("@tedix/api-contract/schemas/tedi");
			expect(
				TediRuntimeCutoverInventoryResponseSchema.safeParse(
					await inspectCutoverParent(ctx.storage, ctx.id.toString()),
				).success,
			).toBe(true);

			expect(
				counts.find((row) => row.table === "cf_agents_workflows")?.counts,
			).toEqual(Object.fromEntries(statuses.map((status) => [status, 1])));
			expect(
				counts.find((row) => row.table === "cf_agents_task_runs")?.counts,
			).toEqual({ unknown: 1, interrupted: 1 });
			expect(JSON.stringify(counts)).not.toContain("future-private-status");
			expect(
				ctx.storage.sql.exec("SELECT * FROM cf_agents_workflows").toArray(),
			).toEqual(original);
			expect(await ctx.storage.getAlarm()).toBe(alarm);
		},
	);
});

it("workflow metadata pages retain exact provider IDs, pin off-page rows and never expose private columns", async () => {
	await runInDurableObject(
		ns().PI_CUTOVER_EARLY.get(
			ns().PI_CUTOVER_EARLY.idFromName(crypto.randomUUID()),
		),
		async (_instance, ctx) => {
			const { inspectCutoverParent } =
				await import("../../src/pi-cutover-admin");
			const { TediRuntimeCutoverInventoryResponseSchema } =
				await import("@tedix/api-contract/schemas/tedi");
			ctx.storage.sql.exec(
				"CREATE TABLE cf_agents_workflows(id TEXT PRIMARY KEY NOT NULL,workflow_id TEXT NOT NULL UNIQUE,workflow_name TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','running','paused','errored','terminated','complete','waiting','waitingForPause','unknown')),metadata TEXT,error_name TEXT,error_message TEXT,created_at INTEGER NOT NULL DEFAULT (unixepoch()),updated_at INTEGER NOT NULL DEFAULT (unixepoch()),completed_at INTEGER)",
			);
			for (let i = 0; i < 3; i++)
				ctx.storage.sql.exec(
					"INSERT INTO cf_agents_workflows VALUES(?,?,?, ?,?,?,?, ?,?,?)",
					`local-${i}`,
					`provider-${i}`,
					"CHAT_TURN_WORKFLOW",
					i === 2 ? "complete" : "queued",
					"PRIVATE_PARAMS",
					"PRIVATE_ERROR_NAME",
					"PRIVATE_ERROR_MESSAGE",
					1700000000,
					1700000001,
					i === 2 ? 1700000002 : null,
				);
			const original = ctx.storage.sql
				.exec("SELECT * FROM cf_agents_workflows")
				.toArray();
			const alarm = await ctx.storage.getAlarm();
			const first = await inspectCutoverParent(ctx.storage, ctx.id.toString(), {
				offset: 0,
				limit: 2,
			});
			expect(first.sdkWorkflows).toEqual({
				present: true,
				count: 3,
				offset: 0,
				rows: [0, 1].map((i) => ({
					workflow_id: `provider-${i}`,
					workflow_name: "CHAT_TURN_WORKFLOW",
					status: "queued",
					created_at: 1700000000,
					updated_at: 1700000001,
					completed_at: null,
				})),
			});
			expect(first.nextOffset).toBe(2);
			expect(
				TediRuntimeCutoverInventoryResponseSchema.safeParse(first).success,
			).toBe(true);
			const second = await inspectCutoverParent(
				ctx.storage,
				ctx.id.toString(),
				{
					offset: 2,
					limit: 2,
					expectedHash: first.hash,
					expectedInspectionHash: first.inspectionHash,
				},
			);
			expect(second.sdkWorkflows.rows).toEqual([
				{
					workflow_id: "provider-2",
					workflow_name: "CHAT_TURN_WORKFLOW",
					status: "complete",
					created_at: 1700000000,
					updated_at: 1700000001,
					completed_at: 1700000002,
				},
			]);
			expect(second.nextOffset).toBeNull();
			expect(second.inspectionHash).toBe(first.inspectionHash);
			expect(
				TediRuntimeCutoverInventoryResponseSchema.safeParse(second).success,
			).toBe(true);
			for (const secret of [
				"PRIVATE_PARAMS",
				"PRIVATE_ERROR_NAME",
				"PRIVATE_ERROR_MESSAGE",
				"local-0",
			])
				expect(JSON.stringify(first)).not.toContain(secret);
			expect(
				ctx.storage.sql.exec("SELECT * FROM cf_agents_workflows").toArray(),
			).toEqual(original);
			expect(await ctx.storage.getAlarm()).toBe(alarm);
			ctx.storage.sql.exec(
				"UPDATE cf_agents_workflows SET updated_at=updated_at+1 WHERE workflow_id='provider-2'",
			);
			await expect(
				inspectCutoverParent(ctx.storage, ctx.id.toString(), {
					offset: 2,
					limit: 2,
					expectedHash: first.hash,
					expectedInspectionHash: first.inspectionHash,
				}),
			).rejects.toThrow("Inspection metadata changed");
		},
	);
});

it("workflow metadata rejects unsupported schema and invalid identifiers without returning stored values", async () => {
	await runInDurableObject(
		ns().PI_CUTOVER_EARLY.get(
			ns().PI_CUTOVER_EARLY.idFromName(crypto.randomUUID()),
		),
		async (_instance, ctx) => {
			const { inspectSdkWorkflowRows } =
				await import("../../src/pi-cutover-admin");
			expect(inspectSdkWorkflowRows(ctx.storage)).toEqual({
				present: false,
				rows: [],
			});
			ctx.storage.sql.exec("CREATE TABLE cf_agents_workflows(status TEXT)");
			expect(() => inspectSdkWorkflowRows(ctx.storage)).toThrow(
				"Unsupported SDK workflow metadata schema",
			);
			ctx.storage.sql.exec("DROP TABLE cf_agents_workflows");
			ctx.storage.sql.exec(
				"CREATE TABLE cf_agents_workflows(workflow_id TEXT,workflow_name TEXT,status TEXT,created_at INTEGER,updated_at INTEGER,completed_at INTEGER)",
			);
			ctx.storage.sql.exec(
				"INSERT INTO cf_agents_workflows VALUES('valid','CHAT_TURN_WORKFLOW','PRIVATE_FUTURE_STATUS',1,2,NULL)",
			);
			expect(inspectSdkWorkflowRows(ctx.storage).rows[0]?.status).toBe(
				"unknown",
			);
			ctx.storage.sql.exec(
				"UPDATE cf_agents_workflows SET workflow_id=?",
				"PRIVATE_IDENTIFIER".repeat(100),
			);
			expect(() => inspectSdkWorkflowRows(ctx.storage)).toThrow(
				"Invalid SDK workflow metadata",
			);
		},
	);
});

it("workflow rows are rechecked after hashing yields", async () => {
	await runInDurableObject(
		ns().PI_CUTOVER_EARLY.get(
			ns().PI_CUTOVER_EARLY.idFromName(crypto.randomUUID()),
		),
		async (_instance, ctx) => {
			const { inspectCutoverParent } =
				await import("../../src/pi-cutover-admin");
			ctx.storage.sql.exec(
				"CREATE TABLE cf_agents_workflows(workflow_id TEXT,workflow_name TEXT,status TEXT,created_at INTEGER,updated_at INTEGER,completed_at INTEGER)",
			);
			ctx.storage.sql.exec(
				"INSERT INTO cf_agents_workflows VALUES('provider','CHAT_TURN_WORKFLOW','queued',1,2,NULL)",
			);
			let reads = 0;
			const sql = new Proxy(ctx.storage.sql, {
				get(target, key) {
					if (key === "exec")
						return (query: string, ...args: unknown[]) => {
							if (
								query.startsWith("SELECT workflow_id,workflow_name,status,") &&
								++reads === 2
							)
								target.exec(
									"UPDATE cf_agents_workflows SET workflow_id='replacement'",
								);
							return target.exec(
								query,
								...(args as (string | number | ArrayBuffer | null)[]),
							);
						};
					const value = Reflect.get(target, key);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const storage = new Proxy(ctx.storage, {
				get(target, key) {
					if (key === "sql") return sql;
					const value = Reflect.get(target, key);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			await expect(
				inspectCutoverParent(storage, ctx.id.toString()),
			).rejects.toThrow("Inspection metadata changed");
			expect(reads).toBe(2);
		},
	);
});

it("parent inspection rechecks admission after hashing the workflow metadata", async () => {
	await runInDurableObject(
		ns().PI_CUTOVER_EARLY.get(
			ns().PI_CUTOVER_EARLY.idFromName(crypto.randomUUID()),
		),
		async (_instance, ctx) => {
			const { inspectCutoverParent } =
				await import("../../src/pi-cutover-admin");
			const { RuntimeAdmissionDO } =
				await import("../../src/runtime-admission-do");
			const tediId = crypto.randomUUID(),
				orgId = crypto.randomUUID();
			ctx.storage.sql.exec(
				"CREATE TABLE IF NOT EXISTS cf_agents_state(id TEXT PRIMARY KEY,state TEXT)",
			);
			ctx.storage.sql.exec(
				"INSERT OR REPLACE INTO cf_agents_state(id,state) VALUES('cf_state_row_id',?)",
				JSON.stringify({ tediId, orgId }),
			);
			const admission = new RuntimeAdmissionDO(ctx.storage, {
				tediId,
				orgId,
				objectId: ctx.id.toString(),
			});
			const evidence = await admission.prepareEvidence("initialize");
			admission.gate.initialize({
				operationId: "workflow-epoch-initialize",
				state: "active",
				evidence,
			});
			ctx.storage.sql.exec(
				"CREATE TABLE cf_agents_workflows(workflow_id TEXT,workflow_name TEXT,status TEXT,created_at INTEGER,updated_at INTEGER,completed_at INTEGER)",
			);
			ctx.storage.sql.exec(
				"INSERT INTO cf_agents_workflows VALUES('provider','CHAT_TURN_WORKFLOW','queued',1,2,NULL)",
			);
			let changed = false;
			const sql = new Proxy(ctx.storage.sql, {
				get(target, key) {
					if (key === "exec")
						return (query: string, ...args: unknown[]) => {
							if (
								query.startsWith("SELECT workflow_id,workflow_name,status,") &&
								!changed
							) {
								changed = true;
								admission.gate.quarantine({
									operationId: "workflow-epoch-change",
									expectedGeneration: 1,
									reason: "native metadata inspection race",
								});
							}
							return target.exec(
								query,
								...(args as (string | number | ArrayBuffer | null)[]),
							);
						};
					const value = Reflect.get(target, key);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const storage = new Proxy(ctx.storage, {
				get(target, key) {
					if (key === "sql") return sql;
					const value = Reflect.get(target, key);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			await expect(
				inspectCutoverParent(storage, ctx.id.toString()),
			).rejects.toThrow("Admission epoch changed");
			expect(changed).toBe(true);
		},
	);
});

// These lifecycle domains mirror Agents 0.26 storage, not provider effect receipts.
const sdkLifecycleCases = [
	...[
		"queued",
		"running",
		"paused",
		"errored",
		"terminated",
		"complete",
		"waiting",
		"waitingForPause",
		"unknown",
	].map(
		(status) =>
			[
				"cf_agents_workflows",
				status,
				["complete", "errored", "terminated"].includes(status),
			] as const,
	),
	...[
		"pending",
		"running",
		"completed",
		"aborted",
		"interrupted",
		"error",
		"failed",
		"cancelled",
		"skipped",
	].map(
		(status) =>
			[
				"cf_agents_fibers",
				status,
				["completed", "aborted", "error"].includes(status),
			] as const,
	),
	...["pending", "running", "waiting", "completed", "failed", "cancelled"].map(
		(status) =>
			[
				"cf_agents_task_runs",
				status,
				["completed", "failed", "cancelled"].includes(status),
			] as const,
	),
	...[null, 0, -1, 1.5, 1, Date.now()].map(
		(value) =>
			[
				"cf_agents_runs",
				value,
				typeof value === "number" && Number.isSafeInteger(value) && value > 0,
			] as const,
	),
	["cf_agents_facet_runs", null, false] as const,
];
const lifecycleDDL: Record<string, string> = {
	cf_agents_workflows: `CREATE TABLE cf_agents_workflows (id TEXT PRIMARY KEY NOT NULL, workflow_id TEXT NOT NULL UNIQUE, workflow_name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','paused','errored','terminated','complete','waiting','waitingForPause','unknown')),metadata TEXT,error_name TEXT,error_message TEXT,created_at INTEGER NOT NULL DEFAULT (unixepoch()),updated_at INTEGER NOT NULL DEFAULT (unixepoch()),completed_at INTEGER)`,
	cf_agents_fibers: `CREATE TABLE cf_agents_fibers (fiber_id TEXT PRIMARY KEY,idempotency_key TEXT UNIQUE,name TEXT NOT NULL,status TEXT NOT NULL,snapshot TEXT,metadata_json TEXT,error_message TEXT,created_at INTEGER NOT NULL,started_at INTEGER,completed_at INTEGER)`,
	cf_agents_task_runs: `CREATE TABLE cf_agents_task_runs (
        run_id TEXT PRIMARY KEY,
        definition TEXT NOT NULL,
        input TEXT,
        state TEXT NOT NULL CHECK (state IN (
          'pending', 'running', 'waiting',
          'completed', 'failed', 'cancelled'
        )),
        result TEXT,
        error_name TEXT,
        error_message TEXT,
        status_message TEXT,
        metadata TEXT,
        idempotency_key TEXT UNIQUE,
        retain INTEGER NOT NULL DEFAULT 1,
        attempt INTEGER NOT NULL DEFAULT 0,
        generation TEXT,
        next_at INTEGER,
        wait_reason TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        cancel_reason TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        updated_at INTEGER NOT NULL,
        settled_at INTEGER
      )`,
	cf_agents_runs: `CREATE TABLE cf_agents_runs (id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL,snapshot TEXT,created_at INTEGER NOT NULL,completed_at INTEGER,outcome TEXT,error_message TEXT)`,
	cf_agents_facet_runs: `CREATE TABLE cf_agents_facet_runs (owner_path TEXT NOT NULL,owner_path_key TEXT NOT NULL,run_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(owner_path_key,run_id))`,
};
async function nativeLifecycle(
	table: string,
	value: string | number | null,
	operation: (
		helper: import("../../src/runtime-admission-do").RuntimeAdmissionDO,
		storage: DurableObjectStorage,
	) => Promise<void>,
) {
	const stub = ns().PI_CUTOVER_EARLY.get(
		ns().PI_CUTOVER_EARLY.idFromName(crypto.randomUUID()),
	);
	await runInDurableObject(stub, async (_instance, ctx) => {
		const { RuntimeAdmissionDO } =
			await import("../../src/runtime-admission-do");
		const owner = {
			tediId: "00000000-0000-4000-8000-000000000002",
			orgId: "00000000-0000-4000-8000-000000000003",
			objectId: ctx.id.toString(),
		};
		ctx.storage.sql.exec(
			"CREATE TABLE cf_agents_state(id TEXT PRIMARY KEY,state TEXT)",
		);
		ctx.storage.sql.exec(
			"INSERT INTO cf_agents_state VALUES('cf_state_row_id',?)",
			JSON.stringify(owner),
		);
		ctx.storage.sql.exec(lifecycleDDL[table]!);
		if (table === "cf_agents_workflows")
			ctx.storage.sql.exec(
				"INSERT INTO cf_agents_workflows(id,workflow_id,workflow_name,status,completed_at) VALUES('row','provider-id','CHAT_TURN_WORKFLOW',?,?)",
				value,
				["complete", "errored", "terminated"].includes(String(value))
					? 1
					: null,
			);
		else if (table === "cf_agents_fibers")
			ctx.storage.sql.exec(
				"INSERT INTO cf_agents_fibers(fiber_id,name,status,created_at) VALUES('fiber','think:messenger-reply',?,1)",
				value,
			);
		else if (table === "cf_agents_task_runs")
			ctx.storage.sql.exec(
				"INSERT INTO cf_agents_task_runs(run_id,definition,state,created_at,updated_at) VALUES('task','definition',?,1,1)",
				value,
			);
		else if (table === "cf_agents_runs")
			ctx.storage.sql.exec(
				"INSERT INTO cf_agents_runs(id,name,created_at,completed_at) VALUES('run','fiber',1,?)",
				value,
			);
		else
			ctx.storage.sql.exec(
				"INSERT INTO cf_agents_facet_runs VALUES('[]','[]','run',1)",
			);
		await operation(new RuntimeAdmissionDO(ctx.storage, owner), ctx.storage);
	});
}
it.each(sdkLifecycleCases)(
	"native SDK lifecycle %s %s qualifying=%s",
	async (table, value, qualifies) => {
		await nativeLifecycle(table, value, async (helper) => {
			if (qualifies)
				expect(await helper.prepareEvidence("initialize")).toMatch(
					/^[a-f0-9]{64}$/,
				);
			else
				await expect(helper.prepareEvidence("initialize")).rejects.toThrow(
					"nonterminal or unknown SDK work",
				);
		});
	},
);
it.each(["complete", "errored", "terminated"])(
	"terminal Workflow %s does not qualify unresolved effects",
	async (status) => {
		await nativeLifecycle(
			"cf_agents_workflows",
			status,
			async (helper, storage) => {
				storage.kv.put("wfctx:provider-id", { runId: "original" });
				await expect(helper.prepareEvidence("initialize")).rejects.toThrow(
					"unresolved workflow dispatch",
				);
			},
		);
	},
);
it("terminal Workflow raw metadata remains bound across evidence hashing", async () => {
	await nativeLifecycle(
		"cf_agents_workflows",
		"complete",
		async (helper, storage) => {
			const evidence = await helper.prepareEvidence("initialize");
			storage.sql.exec(
				"UPDATE cf_agents_workflows SET metadata='changed' WHERE id='row'",
			);
			expect(() =>
				helper.gate.initialize({
					operationId: "baseline",
					state: "active",
					evidence,
				}),
			).toThrow("stale baseline evidence");
		},
	);
});

it.each(["completed", "error", "skipped", "rollingBack"])(
	"pinned Workflow CHECK rejects unsupported label %s",
	async (status) => {
		await expect(
			nativeLifecycle("cf_agents_workflows", status, async () => {}),
		).rejects.toThrow("CHECK constraint failed");
	},
);
it.each(["aborted", "error", "skipped", "interrupted"])(
	"pinned Tasks CHECK rejects unsupported label %s",
	async (status) => {
		await expect(
			nativeLifecycle("cf_agents_task_runs", status, async () => {}),
		).rejects.toThrow("CHECK constraint failed");
	},
);

it("quarantines cold original arbitrary nested registered facets without SDK initialization or settling unknown facts", async () => {
	const { getAgentByName } = await import("agents");
	const { routeCutoverInventory } = await import("../../src/pi-cutover-admin");
	const { RuntimeAdmissionDO } = await import("../../src/runtime-admission-do");
	const local = env as unknown as Cloudflare.Env;
	const name = "recursive-quarantine-" + crypto.randomUUID(),
		tediId = crypto.randomUUID(),
		orgId = crypto.randomUUID();
	await local.DB.exec(
		"CREATE TABLE IF NOT EXISTS tedis (id TEXT PRIMARY KEY,organization_id TEXT,slug TEXT,isolate_agent_id TEXT,runtime_kind TEXT,status TEXT)",
	);
	await local.DB.prepare("INSERT INTO tedis VALUES (?,?,?,?,?,?)")
		.bind(tediId, orgId, name, name, "agent", "active")
		.run();
	const namespace = local.TEDI_AGENT as unknown as DurableObjectNamespace<
		import("./worker").AgentTediDO
	>;
	const root = await getAgentByName(namespace, name);
	await root.seedQuarantine({ tediId, orgId });
	const rootId = namespace.idFromName(name).toString();
	await runInDurableObject(root, async (_instance, ctx) => {
		new RuntimeAdmissionDO(ctx.storage, {
			objectId: rootId,
			tediId,
			orgId,
		}).gate.initialize({
			operationId: "fixture-root-quarantine",
			state: "quarantined",
			reason: "fixture writer custody only",
		});
	});
	const custody = { tediId, orgId, objectName: name };
	const inspect = async (path?: unknown[]) => {
		const url = new URL(CUTOVER_URL);
		url.searchParams.set("objectId", rootId);
		url.searchParams.set("custodyTediId", tediId);
		if (path) url.searchParams.set("targetPath", JSON.stringify(path));
		return (await routeCutoverInventory({
			request: new Request(url, { headers: { "X-Tedix-Admin-Token": TOKEN } }),
			masterKey: TOKEN,
			knownIds: JSON.stringify([rootId]),
			env: local,
			namespace,
		}))!;
	};
	const quarantine = async (
		targetPath: unknown[],
		operationId = "original-nested",
		extras: Record<string, unknown> = {},
	) =>
		(await routeCutoverInventory({
			request: new Request(CUTOVER_URL, {
				method: "POST",
				headers: { "X-Tedix-Admin-Token": TOKEN },
				body: JSON.stringify({
					command: "quarantine",
					objectId: rootId,
					operationId,
					expectedGeneration: 0,
					reasonCode: "unresolved_work",
					custody,
					targetPath,
					...extras,
				}),
			}),
			masterKey: TOKEN,
			knownIds: JSON.stringify([rootId]),
			env: local,
			namespace,
		}))!;
	type Inventory = {
		inspectionTargets: import("@tedix/api-contract/schemas/tedi").CutoverInspectionHop[];
		admission: unknown;
	};
	const warmRoot = await inspect();
	const rootHop = ((await warmRoot.json()) as Inventory).inspectionTargets[0]!;
	expect((await quarantine([rootHop])).status).toBe(409);
	await abortAllDurableObjects();
	const coldRoot = await inspect();
	expect(coldRoot.status).toBe(200);
	const first = ((await coldRoot.json()) as Inventory).inspectionTargets[0]!;
	const coldChild = await inspect([first]);
	expect(coldChild.status).toBe(200);
	const second = ((await coldChild.json()) as Inventory).inspectionTargets[0]!;
	expect(first.parentGeneration).toBe(1);
	expect(second.parentGeneration).toBe(0);
	for (const change of [
		{ objectId: "a".repeat(64) },
		{ name: "missing" },
		{ identityName: "forged" },
		{ registryHash: "b".repeat(64) },
		{ parentGeneration: 2 },
	])
		expect((await quarantine([{ ...first, ...change }, second])).status).toBe(
			409,
		);

	let rawRoot = namespace.get(namespace.idFromName(name));

	const startsAfterDeliberateWarm = await rawRoot.warmQuarantineOriginal([
		"research",
		"nested",
	]);
	expect(startsAfterDeliberateWarm).toBe(2);
	expect((await quarantine([first, second])).status).toBe(409);
	await abortAllDurableObjects();
	rawRoot = namespace.get(namespace.idFromName(name));
	const before = JSON.parse(
		await rawRoot.quarantineWitness(["research", "nested"]),
	);
	for (const mutation of [
		{
			kind: "tenant",
			value: { aigMetadata: { tediId, orgId: crypto.randomUUID() } },
		},
		{ kind: "cf_agents_facet_name", value: "forged" },
		{
			kind: "cf_agents_parent_path",
			value: [{ className: "AgentTediDO", name: "forged" }],
		},
		{ kind: "cf_agents_is_facet", value: false },
	]) {
		await rawRoot.quarantineWitness(["research", "nested"], mutation);
		expect((await quarantine([first, second])).status).toBe(409);
		const refused = JSON.parse(
			await rawRoot.quarantineWitness(["research", "nested"]),
		);
		expect(refused.admission).toBeNull();
		expect(refused.fact).toEqual(before.fact);
		expect(refused.starts).toBe(before.starts);
		await rawRoot.quarantineWitness(["research", "nested"], {
			kind: "tenant",
			value: JSON.parse(before.state[0].state),
		});
		await rawRoot.quarantineWitness(["research", "nested"], {
			kind: "cf_agents_facet_name",
			value: before.facetName,
		});
		await rawRoot.quarantineWitness(["research", "nested"], {
			kind: "cf_agents_parent_path",
			value: before.parentPath,
		});
		await rawRoot.quarantineWitness(["research", "nested"], {
			kind: "cf_agents_is_facet",
			value: true,
		});
	}
	for (const race of ["local", "canonical", "tenant"]) {
		await rawRoot.quarantineWitness(["research", "nested"], {
			kind: "fixture:quarantine-race",
			value: race,
		});
		expect((await quarantine([first, second])).status).toBe(409);
		const refused = JSON.parse(
			await rawRoot.quarantineWitness(["research", "nested"]),
		);
		expect(refused.admission).toBeNull();
		expect(refused.sql).toEqual(before.sql);
		expect(refused.starts).toBe(before.starts);
		await local.DB.prepare(
			"UPDATE tedis SET isolate_agent_id=?,organization_id=? WHERE id=?",
		)
			.bind(name, orgId, tediId)
			.run();
		await rawRoot.quarantineWitness(["research", "nested"], {
			kind: "cf_agents_facet_name",
			value: before.facetName,
		});
	}
	await rawRoot.quarantineWitness([], {
		kind: "registry",
		value:
			"INSERT INTO cf_agents_sub_agents(class,name,identity_version,identity_name,created_at) VALUES('Researcher','missing-original',NULL,NULL,0)",
	});
	const missingRoot = await inspect();
	const missing = (
		(await missingRoot.json()) as Inventory
	).inspectionTargets.find((hop) => hop.name === "missing-original")!;
	expect((await quarantine([missing])).status).toBe(409);
	await rawRoot.quarantineWitness([], {
		kind: "registry",
		value: "DELETE FROM cf_agents_sub_agents WHERE name='missing-original'",
	});
	const response = await quarantine([first, second]);
	expect(response.status).toBe(200);
	const receipt = await response.json();
	expect(receipt).toMatchObject({
		ok: true,
		id: rootId,
		targetObjectId: second.objectId,
		generation: 1,
		state: "quarantined",
		command: "quarantine",
	});
	expect((await quarantine([first, second])).status).toBe(200);
	expect(
		(await quarantine([first, second], "different-operation")).status,
	).toBe(409);
	expect(
		(
			await quarantine([first, second], "original-nested", {
				reasonCode: "unresolved_effects",
			})
		).status,
	).toBe(409);
	await abortAllDurableObjects();
	const retry = await quarantine([first, second]);
	expect(retry.status).toBe(200);
	expect(await retry.json()).toEqual(receipt);
	const final = await inspect([first, second]);
	expect(final.status).toBe(200);
	const finalMetadata = (await final.json()) as {
		admission: { state: string; generation: number };
	};
	expect(finalMetadata.admission).toMatchObject({
		state: "quarantined",
		generation: 1,
	});
	expect(JSON.stringify(finalMetadata)).not.toContain(
		"PRIVATE-ORIGINAL-RESEARCH",
	);
	const witness = JSON.parse(
		await namespace
			.get(namespace.idFromName(name))
			.quarantineWitness(["research", "nested"]),
	);
	expect(witness.fact).toEqual({
		status: "UNKNOWN",
		private: "PRIVATE-ORIGINAL-RESEARCH",
	});
	expect(witness.sql).toEqual([
		{ status: "running", content: "PRIVATE-ORIGINAL-RESEARCH" },
	]);
	expect(witness.starts).toBe(startsAfterDeliberateWarm);
	rawRoot = namespace.get(namespace.idFromName(name));
	await rawRoot.quarantineWitness([], {
		kind: "admission_state",
		value: "active",
	});
	expect((await quarantine([first, second])).status).toBe(409);
	await rawRoot.quarantineWitness([], {
		kind: "admission_state",
		value: "quarantined",
	});
	await rawRoot.quarantineWitness([], {
		kind: "fixture:quarantine-race",
		value: "registry",
	});
	expect((await quarantine([first, second])).status).toBe(409);
	await rawRoot.quarantineWitness([], {
		kind: "registry_restore",
		value: first,
	});
	await rawRoot.quarantineWitness(["research"], {
		kind: "epoch",
		value: { objectId: first.objectId, tediId, orgId },
	});
	await rawRoot.quarantineWitness(["research"], {
		kind: "admission_state",
		value: "active",
	});
	expect(
		(
			await quarantine(
				[first, { ...second, parentGeneration: 1 }],
				"active-ancestor",
			)
		).status,
	).toBe(409);
	await rawRoot.quarantineWitness(["research"], {
		kind: "admission_state",
		value: "quarantined",
	});
	// Fixture-only independent epoch write occurs after an actual D1 await; routing must notice it before dispatch.
	await rawRoot.quarantineWitness([], {
		kind: "fixture:quarantine-race",
		value: "epoch",
	});
	expect((await quarantine([first, second])).status).toBe(409);
	const afterRefusals = JSON.parse(
		await rawRoot.quarantineWitness(["research", "nested"]),
	);
	expect(afterRefusals.admission).toEqual(witness.admission);
	expect(afterRefusals.fact).toEqual(witness.fact);
	expect(afterRefusals.starts).toBe(witness.starts);
});

it("archives exact cold original descendants after quarantine, with frozen audit and custody-race refusals", async () => {
	const { getAgentByName } = await import("agents");
	const { routeCutoverInventory } = await import("../../src/pi-cutover-admin");
	const { RuntimeAdmissionDO } = await import("../../src/runtime-admission-do");
	const local = env as unknown as Cloudflare.Env;
	const name = "descendant-archive-" + crypto.randomUUID(),
		tediId = crypto.randomUUID(),
		orgId = crypto.randomUUID();
	await local.DB.exec(
		"CREATE TABLE IF NOT EXISTS tedis (id TEXT PRIMARY KEY,organization_id TEXT,slug TEXT,isolate_agent_id TEXT,runtime_kind TEXT,status TEXT)",
	);
	await local.DB.prepare("INSERT INTO tedis VALUES (?,?,?,?,?,?)")
		.bind(tediId, orgId, name, name, "agent", "active")
		.run();
	const namespace = local.TEDI_AGENT as unknown as DurableObjectNamespace<
		import("./worker").AgentTediDO
	>;
	const root = await getAgentByName(namespace, name);
	await root.seedQuarantine({ tediId, orgId });
	const rootId = namespace.idFromName(name).toString();
	await runInDurableObject(root, async (_instance, ctx) => {
		new RuntimeAdmissionDO(ctx.storage, {
			objectId: rootId,
			tediId,
			orgId,
		}).gate.initialize({
			operationId: "root-hold",
			state: "quarantined",
			reason: "fixture",
		});
	});
	const custody = { tediId, orgId, objectName: name };
	const invoke = async (body: Record<string, unknown>) =>
		(await routeCutoverInventory({
			request: new Request(CUTOVER_URL, {
				method: "POST",
				headers: { "X-Tedix-Admin-Token": TOKEN },
				body: JSON.stringify({
					objectId: rootId,
					custody,
					operationId: "original-archive",
					...body,
				}),
			}),
			masterKey: TOKEN,
			knownIds: JSON.stringify([rootId]),
			env: local,
			namespace,
		}))!;
	type Hop = import("@tedix/api-contract/schemas/tedi").CutoverInspectionHop;
	const inspect = async (path?: Hop[]) => {
		const url = new URL(CUTOVER_URL);
		url.searchParams.set("objectId", rootId);
		url.searchParams.set("custodyTediId", tediId);
		if (path) url.searchParams.set("targetPath", JSON.stringify(path));
		const response = (await routeCutoverInventory({
			request: new Request(url, { headers: { "X-Tedix-Admin-Token": TOKEN } }),
			masterKey: TOKEN,
			knownIds: JSON.stringify([rootId]),
			env: local,
			namespace,
		}))!;
		expect(response.status).toBe(200);
		return (await response.json()) as { inspectionTargets: Hop[] };
	};
	await abortAllDurableObjects();
	const first = (await inspect()).inspectionTargets[0]!;
	let raw = namespace.get(namespace.idFromName(name));
	const witness = async (path: string[]) =>
		JSON.parse(await raw.quarantineWitness(path));
	const before = await witness(["research"]);
	expect(
		(
			await invoke({
				command: "inspect_historical_custody",
				expectedGeneration: 1,
				targetPath: [first],
			})
		).status,
	).toBe(409);
	expect(
		(
			await invoke({
				command: "quarantine",
				expectedGeneration: 0,
				targetPath: [first],
				reasonCode: "unresolved_work",
			})
		).status,
	).toBe(200);
	const second = (await inspect([first])).inspectionTargets[0]!;
	const path = [first, second];
	expect(
		(
			await invoke({
				command: "inspect_historical_custody",
				expectedGeneration: 1,
				targetPath: path,
			})
		).status,
	).toBe(409);
	expect(
		(
			await invoke({
				command: "quarantine",
				expectedGeneration: 0,
				targetPath: path,
				reasonCode: "unresolved_work",
			})
		).status,
	).toBe(200);
	const childBefore = await witness(["research", "nested"]);
	const query = { expectedGeneration: 1, targetPath: path };
	const observed = await invoke({
		...query,
		command: "inspect_historical_custody",
	});
	expect(observed.status).toBe(200);
	const summary = (await observed.json()) as {
		sourceHash: string;
		snapshotId: string;
		workflowCount: number;
		fiberCount: number;
		targetObjectId: string;
		id: string;
	};
	expect(summary).toMatchObject({
		id: rootId,
		targetObjectId: second.objectId,
		workflowCount: 1,
		fiberCount: 1,
	});
	expect(JSON.stringify(summary)).not.toContain("PRIVATE");
	expect(
		(
			await invoke({
				...query,
				command: "audit_historical_custody",
				expectedSourceHash: summary.sourceHash,
			})
		).status,
	).toBe(409);
	for (const body of [
		{ ...query, expectedGeneration: 2 },
		{
			...query,
			targetPath: [first, { ...second, registryHash: "f".repeat(64) }],
		},
		{ ...query, targetPath: [first, { ...second, objectId: "a".repeat(64) }] },
	])
		expect(
			(
				await invoke({
					...body,
					command: "capture_historical_custody",
					expectedSourceHash: summary.sourceHash,
				})
			).status,
		).toBe(409);
	expect(
		(
			await invoke({
				...query,
				command: "capture_historical_custody",
				expectedSourceHash: "f".repeat(64),
			})
		).status,
	).toBe(409);
	// Genuine stored leaf custody, not request metadata, is rechecked before archive writes.
	for (const [mutation, restore] of [
		[
			{
				kind: "tenant",
				value: { aigMetadata: { tediId: crypto.randomUUID(), orgId } },
			},
			{ kind: "tenant", value: JSON.parse(childBefore.state[0].state) },
		],
		[
			{ kind: "cf_agents_parent_path", value: [] },
			{ kind: "cf_agents_parent_path", value: childBefore.parentPath },
		],
		[
			{ kind: "cf_agents_facet_name", value: "forged" },
			{ kind: "cf_agents_facet_name", value: childBefore.facetName },
		],
	]) {
		await raw.quarantineWitness(["research", "nested"], mutation!);
		expect(
			(
				await invoke({
					...query,
					command: "capture_historical_custody",
					expectedSourceHash: summary.sourceHash,
				})
			).status,
		).toBe(409);
		await raw.quarantineWitness(["research", "nested"], restore!);
		expect(
			(await witness(["research", "nested"])).archive.every(
				(entry: { count: number }) => entry.count === 0,
			),
		).toBe(true);
	}
	for (const race of ["canonical", "tenant"]) {
		await raw.quarantineWitness(["research", "nested"], {
			kind: "fixture:quarantine-race",
			value: race,
		});
		expect(
			(
				await invoke({
					...query,
					command: "capture_historical_custody",
					expectedSourceHash: summary.sourceHash,
				})
			).status,
		).toBe(409);
		await local.DB.prepare(
			"UPDATE tedis SET isolate_agent_id=?,organization_id=? WHERE id=?",
		)
			.bind(name, orgId, tediId)
			.run();
		expect(
			(await witness(["research", "nested"])).archive.every(
				(entry: { count: number }) => entry.count === 0,
			),
		).toBe(true);
	}
	const captureBody = {
		...query,
		command: "capture_historical_custody",
		expectedSourceHash: summary.sourceHash,
	};
	const captured = await invoke(captureBody);
	expect(captured.status).toBe(200);
	const receipt = await captured.json();
	expect(await (await invoke(captureBody)).json()).toEqual(receipt);
	const auditBody = {
		...query,
		command: "audit_historical_custody",
		expectedSourceHash: summary.sourceHash,
	};
	expect((await invoke(auditBody)).status).toBe(200);
	await abortAllDurableObjects();
	raw = namespace.get(namespace.idFromName(name));
	expect(await (await invoke(captureBody)).json()).toEqual(receipt);
	const after = await witness(["research", "nested"]);
	expect(after.selected).toEqual(childBefore.selected);
	expect(after.accounting).toEqual(childBefore.accounting);
	expect(after.starts).toBe(childBefore.starts);
	expect(after.admission).toEqual(childBefore.admission);
	expect(
		after.archive.every((entry: { count: number }) => entry.count > 0),
	).toBe(true);
	// The intermediate original registry is selected archival evidence, not removed/recreated.
	const parentQuery = {
		command: "inspect_historical_custody",
		expectedGeneration: 1,
		targetPath: [first],
	};
	const parentSummary = (await (await invoke(parentQuery)).json()) as {
		sourceHash: string;
	};
	expect(
		(
			await invoke({
				...parentQuery,
				command: "capture_historical_custody",
				expectedSourceHash: parentSummary.sourceHash,
			})
		).status,
	).toBe(200);
	expect((await witness(["research"])).selected).toEqual(before.selected);
	await raw.quarantineWitness(["research", "nested"], {
		kind: "runtime-workflow-observation:late-original",
		value: { status: "UNKNOWN", providerId: "original-provider-id" },
	});
	expect((await invoke(captureBody)).status).toBe(409);
	expect((await invoke(auditBody)).status).toBe(200);
	await raw.quarantineWitness(["research", "nested"], {
		kind: "archive_corrupt",
		value: null,
	});
	expect((await invoke(auditBody)).status).toBe(409);
	expect((await witness(["research", "nested"])).selected).toEqual(
		childBefore.selected,
	);
});

describe("strict v2 native state observations", () => {
	it("observes pinned Pi tables and incomplete states without store initialization or content disclosure", async () => {
		await runInDurableObject(
			ns().PI_CUTOVER_EARLY.get(
				ns().PI_CUTOVER_EARLY.idFromName(crypto.randomUUID()),
			),
			async (_instance, ctx) => {
				const { openPiSessionStore } = await import("agents/harness/pi");
				await openPiSessionStore(ctx.storage);
				for (const [i, status] of [
					"pending",
					"running",
					"waiting",
					"completing",
					"terminal",
				].entries())
					ctx.storage.sql.exec(
						"INSERT INTO pi_tasks VALUES (?,1,'PRIVATE_KIND',?,0,0,?)",
						100 + i,
						status,
						'{"private":"PRIVATE_NATIVE"}',
					);
				for (const [i, status] of [
					"queued",
					"placed",
					"done",
					"unanswered",
				].entries())
					ctx.storage.sql.exec(
						"INSERT INTO pi_submissions VALUES (?,1,'PRIVATE_REQUEST',?,?)",
						200 + i,
						status,
						'{"private":"PRIVATE_SUBMISSION"}',
					);
				ctx.storage.sql.exec(
					"CREATE TABLE chat_sdk_state_locks(thread_id TEXT PRIMARY KEY,token TEXT NOT NULL,expires_at INTEGER NOT NULL)",
				);
				ctx.storage.sql.exec(
					"INSERT INTO chat_sdk_state_locks VALUES ('PRIVATE_THREAD','PRIVATE_TOKEN',1)",
				);
				ctx.storage.kv.put("cf:chat-recovery:incident:PRIVATE_KEY", {
					status: "exhausted",
					text: "PRIVATE_RECOVERY",
				});
				const before = ctx.storage.sql.exec("SELECT * FROM pi_tasks").toArray(),
					locks = ctx.storage.sql
						.exec("SELECT * FROM chat_sdk_state_locks")
						.toArray(),
					alarm = await ctx.storage.getAlarm();
				const { inspectCutoverParent } =
					await import("../../src/pi-cutover-admin");
				const { TediRuntimeCutoverInventoryResponseSchema } =
					await import("@tedix/api-contract/schemas/tedi");
				const result = await inspectCutoverParent(
					ctx.storage,
					ctx.id.toString(),
				);
				expect(
					TediRuntimeCutoverInventoryResponseSchema.safeParse(result).success,
				).toBe(true);
				expect(result.version).toBe("pi-cutover-inspection-v2");
				expect(result.qualification.nativeSchemaState).toBe("supported");
				expect(result.qualification.nativeSchemaVersion).toBe(1);
				expect(
					result.qualification.tables.find((t) => t.table === "pi_tasks")
						?.statusCounts,
				).toEqual({
					pending: 1,
					running: 1,
					waiting: 1,
					completing: 1,
					terminal: 1,
				});
				expect(
					result.qualification.tables.find((t) => t.table === "pi_submissions")
						?.statusCounts,
				).toEqual({ queued: 1, placed: 1, done: 1, unanswered: 1 });
				expect(JSON.stringify(result.qualification)).not.toContain("PRIVATE_");
				expect(
					ctx.storage.sql.exec("SELECT * FROM pi_tasks").toArray(),
				).toEqual(before);
				expect(
					ctx.storage.sql.exec("SELECT * FROM chat_sdk_state_locks").toArray(),
				).toEqual(locks);
				expect(await ctx.storage.getAlarm()).toBe(alarm);
			},
		);
	});
	it("preserves inventory hashes and pages all unknown observations with unique ordinals", async () => {
		await runInDurableObject(
			ns().PI_CUTOVER_EARLY.get(
				ns().PI_CUTOVER_EARLY.idFromName(crypto.randomUUID()),
			),
			async (_instance, ctx) => {
				const { inspectCutoverParent } =
					await import("../../src/pi-cutover-admin");
				const before = await inspectCutoverParent(
					ctx.storage,
					ctx.id.toString(),
				);
				for (let i = 0; i < 205; i++)
					ctx.storage.kv.put(`pi-ui-entry:${String(i).padStart(6, "0")}`, {
						future: "PRIVATE",
					});
				const first = await inspectCutoverParent(
					ctx.storage,
					ctx.id.toString(),
					{ offset: 0, limit: 200 },
				);
				expect(first.hash).toBe(before.hash);
				expect(first.inspectionHash).not.toBe(before.inspectionHash);
				expect(first.nextOffset).toBe(200);
				const second = await inspectCutoverParent(
					ctx.storage,
					ctx.id.toString(),
					{
						offset: 200,
						limit: 200,
						expectedHash: first.hash,
						expectedInspectionHash: first.inspectionHash,
					},
				);
				expect(second.nextOffset).toBe(null);
				expect(second.qualification.rows.map((r) => r.ordinal)).toEqual([
					200, 201, 202, 203, 204,
				]);
				expect(
					[...first.qualification.rows, ...second.qualification.rows].every(
						(r) =>
							r.identityHash === null &&
							r.projectionHash === null &&
							r.structuralState === "unsupported",
					),
				).toBe(true);
				ctx.storage.kv.put("pi-ui-entry:000204", {
					id: "message",
					role: "user",
					parts: [],
				});
				await expect(
					inspectCutoverParent(ctx.storage, ctx.id.toString(), {
						offset: 200,
						limit: 200,
						expectedHash: first.hash,
						expectedInspectionHash: first.inspectionHash,
					}),
				).rejects.toThrow("Inspection metadata changed");
			},
		);
	});
	for (const mutate of [
		"lock_token",
		"unknown_column",
		"physical_name",
		"facet_path",
		"schema_default",
		"index_definition",
		"trigger_definition",
	] as const)
		it(`rejects ${mutate} mutation after final hash await`, async () => {
			await runInDurableObject(
				ns().PI_CUTOVER_EARLY.get(
					ns().PI_CUTOVER_EARLY.idFromName(crypto.randomUUID()),
				),
				async (_instance, ctx) => {
					const { inspectCutoverParent, captureCutoverQualification } =
						await import("../../src/pi-cutover-admin");
					ctx.storage.sql.exec(
						"CREATE TABLE chat_sdk_state_locks(thread_id TEXT PRIMARY KEY,token TEXT NOT NULL,expires_at INTEGER NOT NULL)",
					);
					ctx.storage.sql.exec(
						"INSERT INTO chat_sdk_state_locks VALUES ('thread','TOKEN_A',1)",
					);
					ctx.storage.sql.exec(
						'CREATE TABLE pi_entries(id INTEGER,record TEXT,"future""column" TEXT)',
					);
					ctx.storage.sql.exec(
						"INSERT INTO pi_entries VALUES(1,?,?)",
						'{"private":"A"}',
						"PRIVATE_A",
					);
					ctx.storage.sql.exec(
						"CREATE INDEX observed_entries_index ON pi_entries(id)",
					);
					ctx.storage.sql.exec(
						"CREATE TRIGGER observed_entries_trigger AFTER INSERT ON pi_entries BEGIN SELECT 1; END",
					);
					const before = captureCutoverQualification(ctx.storage).projection;
					const original = crypto.subtle.digest,
						digest = original.bind(crypto.subtle);
					let changed = false;
					crypto.subtle.digest = (async (
						algorithm: Parameters<typeof crypto.subtle.digest>[0],
						data: BufferSource,
					) => {
						const result = await digest(algorithm, data);
						const bytes =
							data instanceof ArrayBuffer
								? new Uint8Array(data)
								: new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
						if (
							!changed &&
							new TextDecoder().decode(bytes).includes('"qualification"')
						) {
							changed = true;
							if (mutate === "lock_token")
								ctx.storage.sql.exec(
									"UPDATE chat_sdk_state_locks SET token='TOKEN_B'",
								);
							else if (mutate === "unknown_column")
								ctx.storage.sql.exec(
									'UPDATE pi_entries SET "future""column"=?',
									"PRIVATE_B",
								);
							else if (mutate === "physical_name")
								ctx.storage.kv.put("__ps_name", "changed");
							else if (mutate === "facet_path")
								ctx.storage.kv.put("cf_agents_parent_path", [
									{ className: "Changed", name: "changed" },
								]);
							else if (mutate === "index_definition") {
								ctx.storage.sql.exec("DROP INDEX observed_entries_index");
								ctx.storage.sql.exec(
									"CREATE INDEX observed_entries_index ON pi_entries(record)",
								);
							} else if (mutate === "trigger_definition") {
								ctx.storage.sql.exec("DROP TRIGGER observed_entries_trigger");
								ctx.storage.sql.exec(
									"CREATE TRIGGER observed_entries_trigger AFTER INSERT ON pi_entries BEGIN SELECT 2; END",
								);
							} else {
								ctx.storage.sql.exec(
									"ALTER TABLE pi_entries ADD COLUMN schema_future TEXT DEFAULT 'PRIVATE'",
								);
							}
						}
						return result;
					}) as typeof crypto.subtle.digest;
					try {
						await expect(
							inspectCutoverParent(ctx.storage, ctx.id.toString()),
						).rejects.toThrow("Inspection metadata changed");
						expect(changed).toBe(true);
					} finally {
						crypto.subtle.digest = original;
					}
					expect(captureCutoverQualification(ctx.storage).projection).toEqual(
						before,
					);
				},
			);
		});
	it("preflights excess SQL rows before loading payload and leaves storage/alarm unchanged", async () => {
		await runInDurableObject(
			ns().PI_CUTOVER_EARLY.get(
				ns().PI_CUTOVER_EARLY.idFromName(crypto.randomUUID()),
			),
			async (_instance, ctx) => {
				ctx.storage.sql.exec("CREATE TABLE pi_entries(id INTEGER,record TEXT)");
				ctx.storage.sql.exec(
					"WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<20001) INSERT INTO pi_entries SELECT x,'{}' FROM n",
				);
				const { captureCutoverQualification } =
					await import("../../src/pi-cutover-admin");
				let payloadReads = 0;
				const sql = new Proxy(ctx.storage.sql, {
					get(target, key) {
						if (key === "exec")
							return (query: string, ...args: SqlStorageValue[]) => {
								if (query.startsWith('SELECT "id","record" FROM'))
									payloadReads++;
								return target.exec(query, ...args);
							};
						const v = Reflect.get(target, key);
						return typeof v === "function" ? v.bind(target) : v;
					},
				});
				const storage = new Proxy(ctx.storage, {
					get(target, key) {
						if (key === "sql") return sql;
						const v = Reflect.get(target, key);
						return typeof v === "function" ? v.bind(target) : v;
					},
				});
				const alarm = await ctx.storage.getAlarm();
				expect(() => captureCutoverQualification(storage)).toThrow(
					"Qualification capture unavailable",
				);
				expect(payloadReads).toBe(0);
				expect(
					ctx.storage.sql
						.exec<{ n: number }>("SELECT count(*) AS n FROM pi_entries")
						.one().n,
				).toBe(20001);
				expect(await ctx.storage.getAlarm()).toBe(alarm);
			},
		);
	});
});

it("bounds aggregate native KV capture one entry at a time without changing storage", async () => {
	await runInDurableObject(
		ns().PI_CUTOVER_EARLY.get(
			ns().PI_CUTOVER_EARLY.idFromName(crypto.randomUUID()),
		),
		async (_instance, ctx) => {
			for (let i = 0; i < 5; i++)
				ctx.storage.kv.put(`pi-ui-entry:${i}`, "x".repeat(2 * 1024 * 1024));
			const { captureCutoverQualification } =
				await import("../../src/pi-cutover-admin");
			const tables = ctx.storage.sql
					.exec("SELECT name,sql FROM sqlite_master ORDER BY name")
					.toArray(),
				alarm = await ctx.storage.getAlarm();
			let entryReads = 0;
			const kv = new Proxy(ctx.storage.kv, {
				get(target, key) {
					if (key === "list")
						return (options: SyncKvListOptions) => {
							if (options.prefix === "pi-ui-entry:") {
								expect(options.limit).toBe(1);
								entryReads++;
							}
							return target.list(options);
						};
					const value = Reflect.get(target, key);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const storage = new Proxy(ctx.storage, {
				get(target, key) {
					if (key === "kv") return kv;
					const value = Reflect.get(target, key);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			expect(() => captureCutoverQualification(storage)).toThrow(
				"Qualification capture unavailable",
			);
			expect(entryReads).toBe(4);
			expect(
				Array.from(ctx.storage.kv.list({ prefix: "pi-ui-entry:" })).length,
			).toBe(5);
			expect(
				ctx.storage.sql
					.exec("SELECT name,sql FROM sqlite_master ORDER BY name")
					.toArray(),
			).toEqual(tables);
			expect(await ctx.storage.getAlarm()).toBe(alarm);
		},
	);
});

it("preserves native UTF-8/codepoint key order across supplementary characters", async () => {
	await runInDurableObject(
		ns().PI_CUTOVER_EARLY.get(
			ns().PI_CUTOVER_EARLY.idFromName(crypto.randomUUID()),
		),
		async (_instance, ctx) => {
			ctx.storage.kv.put("pi-ui-entry:\uE000", null);
			ctx.storage.kv.put("pi-ui-entry:\u{10000}", null);
			const { captureCutoverQualification } =
				await import("../../src/pi-cutover-admin");
			const q = captureCutoverQualification(ctx.storage).projection;
			expect(q.journalCount).toBe(2);
			expect(q.rows.map((row) => row.ordinal)).toEqual([0, 1]);
			expect(q.rows.every((row) => row.projectionHash === null)).toBe(true);
		},
	);
});

const passiveCases = [
	"rpc-known",
	"rpc-boundary",
	"rpc-too-large",
	"rpc-utf8-budget",
	"rpc-private",
	"rpc-unknown",
	"rpc-1xx",
	"rpc-invalid-status",
	"rpc-fractional-status",
	"stream-known",
	"stream-too-large",
	"stream-invalid-utf8",
	"stream-empty-budget",
	"stream-read-error",
	"stream-cancel-error",
	"body-owner-race",
	"body-private-race",
	"body-registry-race",
	"body-registry-cancel-epoch-race",
	"cancel-owner-race",
	"cancel-private-race",
] as const;
it.each(passiveCases)(
	"bounded passive child refusal preserves original custody (%s)",
	async (mode) => {
		const local = env as unknown as Cloudflare.Env;
		const namespace = ns().PI_CUTOVER_EARLY,
			name = "refusal-" + crypto.randomUUID(),
			tediId = crypto.randomUUID(),
			orgId = crypto.randomUUID();
		await local.DB.exec(
			"CREATE TABLE IF NOT EXISTS tedis (id TEXT PRIMARY KEY,organization_id TEXT,slug TEXT,isolate_agent_id TEXT,runtime_kind TEXT,status TEXT)",
		);
		await local.DB.prepare("INSERT INTO tedis VALUES(?,?,?,?,?,?)")
			.bind(tediId, orgId, name, name, "agent", "active")
			.run();
		const stub = namespace.get(namespace.idFromName(name));
		await runInDurableObject(stub, async (_instance, ctx) => {
			const { operateStoredCutover, captureCutoverQualification } =
				await import("../../src/pi-cutover-admin");
			const { pageCutoverInventory } =
				await import("../../src/pi-cutover-operator");
			const runtimeEnv = {
				...local,
				TEDI_AGENT: namespace,
				PI_CUTOVER_KNOWN_PARENT_IDS: JSON.stringify([ctx.id.toString()]),
			} as unknown as Cloudflare.Env;
			ctx.storage.sql.exec(
				"CREATE TABLE IF NOT EXISTS cf_agents_state(id TEXT PRIMARY KEY,state TEXT)",
			);
			ctx.storage.sql.exec(
				"INSERT OR REPLACE INTO cf_agents_state VALUES('cf_state_row_id',?)",
				JSON.stringify({ tediId, orgId, token: "PRIVATE-original" }),
			);
			ctx.storage.sql.exec(
				"CREATE TABLE IF NOT EXISTS cf_agents_sub_agents(class TEXT,name TEXT,identity_version TEXT,identity_name TEXT)",
			);
			const stream = !mode.startsWith("rpc-"),
				className = stream ? "ConversationFacet" : "Researcher";
			ctx.storage.sql.exec(
				"INSERT INTO cf_agents_sub_agents VALUES(?,?,NULL,NULL)",
				className,
				"child",
			);
			ctx.storage.kv.put("__ps_name", name);
			const inventory = await pageCutoverInventory(ctx.storage, {
				offset: 0,
				limit: 200,
			});
			const hop = {
				className,
				name: "child",
				identityVersion: null,
				identityName: null,
				objectId: namespace.idFromName("child").toString(),
				registryHash: inventory.hash,
				parentGeneration: 0,
			};
			const { RuntimeAdmissionDO } =
				await import("../../src/runtime-admission-do");
			const admission = new RuntimeAdmissionDO(ctx.storage, {
				tediId,
				orgId,
				objectId: ctx.id.toString(),
			});
			const evidence = await admission.prepareEvidence("initialize");
			const before = captureCutoverQualification(ctx.storage).privateSnapshot,
				alarm = await ctx.storage.getAlarm();
			const known = JSON.stringify({
				ok: false,
				rejection: "inspection_owner_unavailable",
			});
			const mutate = (stage: "body" | "cancel") => {
				if (mode === `${stage}-owner-race`)
					ctx.storage.kv.put("__ps_name", "changed-original");
				if (mode === `${stage}-private-race`)
					ctx.storage.sql.exec(
						"UPDATE cf_agents_state SET state=?",
						JSON.stringify({ tediId, orgId, token: "PRIVATE-changed" }),
					);
				if (
					(mode === "body-registry-race" ||
						mode === "body-registry-cancel-epoch-race") &&
					stage === "body"
				)
					ctx.storage.sql.exec(
						"UPDATE cf_agents_sub_agents SET name='changed-child'",
					);
				if (mode === "body-registry-cancel-epoch-race" && stage === "cancel")
					admission.gate.initialize({
						operationId: "cancel-epoch",
						state: "active",
						evidence,
					});
			};
			let reads = 0,
				canceled = 0;
			const child = {
				async inspectStoredCutover() {
					let body = known,
						status = 409;
					if (mode === "rpc-boundary") body += " ".repeat(1024 - body.length);
					if (mode === "rpc-too-large") body += " ".repeat(1025 - body.length);
					if (mode === "rpc-utf8-budget") body = '"' + "é".repeat(600) + '"';
					if (mode === "rpc-private")
						body = JSON.stringify({
							ok: false,
							rejection: "inspection_owner_unavailable",
							token: "PRIVATE",
						});
					if (mode === "rpc-unknown")
						body = JSON.stringify({ ok: false, rejection: "PRIVATE-token" });
					if (mode === "rpc-1xx") status = 101;
					if (mode === "rpc-invalid-status") status = 600;
					if (mode === "rpc-fractional-status") status = 409.5;
					return { status, body };
				},
				async fetch() {
					return new Response(
						new ReadableStream<Uint8Array>(
							{
								async pull(controller) {
									reads++;
									await Promise.resolve();
									mutate("body");
									if (mode === "stream-read-error") {
										controller.error(new Error("PRIVATE read exception"));
										return;
									}
									if (mode === "stream-empty-budget") {
										controller.enqueue(new Uint8Array());
										return;
									}
									if (reads > 1) {
										controller.close();
										return;
									}
									if (
										mode === "stream-too-large" ||
										mode === "stream-cancel-error" ||
										mode.startsWith("cancel-")
									)
										controller.enqueue(new Uint8Array(1025));
									else if (mode === "stream-invalid-utf8")
										controller.enqueue(new Uint8Array([0xc3, 0x28]));
									else controller.enqueue(new TextEncoder().encode(known));
									// Leave open so the owning reader must read again or cancel.
									if (reads > 1) controller.close();
								},
								async cancel() {
									canceled++;
									await Promise.resolve();
									mutate("cancel");
									if (mode === "stream-cancel-error")
										throw new Error("PRIVATE cancellation exception");
								},
							},
							{ highWaterMark: 0 },
						),
						{ status: 403 },
					);
				},
			};
			const wrapped = new Proxy(ctx, {
				get(target, key) {
					if (key === "facets") return { get: () => child };
					const value = Reflect.get(target, key);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const url = new URL(CUTOVER_URL);
			url.searchParams.set("targetPath", JSON.stringify([hop]));
			const response = await operateStoredCutover({
				ctx: wrapped,
				env: runtimeEnv,
				receiver: "raw-cutover-v1",
				request: new Request(url, {
					headers: {
						"X-Tedix-Admin-Token": TOKEN,
						"X-Tedix-Cutover-Inspection-Custody": JSON.stringify({
							rootId: ctx.id.toString(),
							tediId,
							orgId,
							objectName: name,
							parentPath: [],
							current: null,
						}),
					},
				}),
			});
			const body = await response.json();
			expect(JSON.stringify(body)).not.toContain("PRIVATE");
			const race = mode.endsWith("-race");
			const good = ["rpc-known", "rpc-boundary", "stream-known"].includes(mode);
			expect(body).toEqual({
				ok: false,
				rejection: race
					? "inspection_metadata_changed"
					: good
						? "inspection_owner_unavailable"
						: "passive_inspection_unavailable",
			});
			expect(response.status).toBe(race || mode.startsWith("rpc-") ? 409 : 403);
			if (!race)
				expect(captureCutoverQualification(ctx.storage).privateSnapshot).toBe(
					before,
				);
			expect(await ctx.storage.getAlarm()).toBe(alarm);
			if (mode === "body-registry-cancel-epoch-race") {
				expect(canceled).toBe(1);
				expect(admission.gate.read()).toMatchObject({
					state: "active",
					generation: 1,
				});
			}
			if (mode === "stream-empty-budget") {
				expect(reads).toBe(16);
				expect(canceled).toBe(1);
			}
		});
	},
);

it("native preservation streams actual pinned Pi state above observer budget and audits private immutable parts", async () => {
	await runInDurableObject(
		ns().PI_CUTOVER_EARLY.get(
			ns().PI_CUTOVER_EARLY.idFromName(crypto.randomUUID()),
		),
		async (_instance, ctx) => {
			const { openPiSessionStore } = await import("agents/harness/pi");
			await openPiSessionStore(ctx.storage);
			const { NativeStatePreservation } =
				await import("../../src/native-state-preservation");
			const tediId = crypto.randomUUID(),
				orgId = crypto.randomUUID(),
				key = Buffer.alloc(32, 7).toString("base64"),
				id = ctx.id.toString();
			for (let i = 0; i < 300; i++)
				ctx.storage.sql.exec(
					"INSERT INTO pi_tasks VALUES (?,1,'private', 'running',0,0,?)",
					100 + i,
					JSON.stringify({ token: "PRIVATE_NATIVE" + "x".repeat(32000) }),
				);
			ctx.storage.sql.exec("ALTER TABLE pi_tasks ADD COLUMN future_blob BLOB");
			ctx.storage.sql.exec(
				"UPDATE pi_tasks SET future_blob=? WHERE id=100",
				new Uint8Array([0, 1, 255]),
			);
			ctx.storage.sql.exec(
				"CREATE TRIGGER pi_private_trigger AFTER UPDATE ON pi_tasks BEGIN SELECT 1; END",
			);
			ctx.storage.kv.put("tedix:pi:maintenance:effect:uncertain", {
				status: "uncertain",
				private: "PRIVATE_EFFECT",
			});
			// Run the pinned Chat SDK migration without its Agent lifecycle.
			const { ChatSdkStateAgent } = await import("agents/chat-sdk");
			(
				ChatSdkStateAgent.prototype as unknown as {
					migrate(this: {
						sql: (s: TemplateStringsArray, ...v: SqlStorageValue[]) => unknown;
					}): void;
				}
			).migrate.call({
				sql: (strings, ...values) =>
					ctx.storage.sql.exec(strings.join("?"), ...values),
			});
			ctx.storage.sql.exec(
				"INSERT INTO chat_sdk_state_locks VALUES ('private-thread','PRIVATE_LOCK',1)",
			);
			const before = ctx.storage.sql.exec("SELECT * FROM pi_tasks").toArray(),
				alarm = await ctx.storage.getAlarm();
			const engine = new NativeStatePreservation(
				ctx.storage,
				{
					kind: "native-preservation-capture-v1",
					operationId: "native",
					rootId: id,
					objectId: id,
					tediId,
					orgId,
					objectName: "native",
					physicalName: "native",
					className: "AgentTediDO",
					targetPath: [],
					generation: 1,
				},
				() => {},
				async () => {},
			);
			const plan = await engine.inspect(key);
			expect(plan.metadata.sourceBytes).toBeGreaterThan(8 * 1024 * 1024);
			expect(
				plan.metadata.tables.filter(
					(t) => t.table.startsWith("chat_sdk_") && t.present,
				),
			).toHaveLength(6);
			expect(
				ctx.storage.sql
					.exec(
						"SELECT name FROM sqlite_master WHERE name='native_preservation_snapshot'",
					)
					.toArray(),
			).toEqual([]);
			const archive = await engine.capture(key, plan.archiveId, plan.proof);
			expect(await engine.audit(key, plan.archiveId)).toEqual(archive);
			const parts = ctx.storage.sql
				.exec<{ n: number }>(
					"SELECT length(chunk) AS n FROM native_preservation_parts",
				)
				.toArray();
			expect(parts.length).toBeGreaterThan(8);
			expect(parts.every((p) => p.n <= 1_000_000)).toBe(true);
			expect(ctx.storage.sql.exec("SELECT * FROM pi_tasks").toArray()).toEqual(
				before,
			);
			expect(await ctx.storage.getAlarm()).toEqual(alarm);
			expect(JSON.stringify(archive)).not.toContain("PRIVATE_NATIVE");
			expect(JSON.stringify(archive)).not.toContain("PRIVATE_EFFECT");
			expect(archive.projectionDigest).toBe(null);
		},
	);
});

it("native preservation refuses SQL integer cells that native JS numbers cannot distinguish", async () => {
	await runInDurableObject(
		ns().PI_CUTOVER_EARLY.get(
			ns().PI_CUTOVER_EARLY.idFromName(crypto.randomUUID()),
		),
		async (_instance, ctx) => {
			const { NativeStatePreservation } =
				await import("../../src/native-state-preservation");
			const values = ctx.storage.sql
				.exec<{ a: number; b: number }>(
					"SELECT 9007199254740992 AS a,9007199254740993 AS b",
				)
				.one();
			expect(values.a).toBe(values.b);
			expect(Number.isSafeInteger(values.a)).toBe(false);
			ctx.storage.sql.exec("CREATE TABLE pi_documents(value INTEGER)");
			ctx.storage.sql.exec(
				"INSERT INTO pi_documents VALUES (9007199254740993)",
			);
			const id = ctx.id.toString(),
				key = Buffer.alloc(32, 7).toString("base64");
			const engine = new NativeStatePreservation(
				ctx.storage,
				{
					kind: "native-preservation-capture-v1",
					operationId: "unsafe-integer",
					rootId: id,
					objectId: id,
					tediId: crypto.randomUUID(),
					orgId: crypto.randomUUID(),
					objectName: "original",
					physicalName: "original",
					className: "AgentTediDO",
					targetPath: [],
					generation: 1,
				},
				() => {},
				async () => {},
			);
			await expect(engine.inspect(key)).rejects.toThrow(
				"verification rejected",
			);
			expect(
				ctx.storage.sql
					.exec(
						"SELECT name FROM sqlite_master WHERE name LIKE 'native_preservation_%'",
					)
					.toArray(),
			).toEqual([]);
			expect(
				ctx.storage.sql
					.exec<{ value: number }>("SELECT value FROM pi_documents")
					.one().value,
			).toBe(values.a);
		},
	);
});

it("session archive preserves actual repo and pinned Session7 branches, large cells and exact integers", async () => {
	const namespace = (
		env as unknown as {
			PI_CONVERSATION: DurableObjectNamespace<
				import("./worker").PiConversationFixture
			>;
		}
	).PI_CONVERSATION;
	const stub = namespace.get(namespace.idFromName(crypto.randomUUID()));
	const seeded = await stub.seedSessionPreservation();
	expect(seeded.rootEntries).toBeGreaterThanOrEqual(2);
	expect(seeded.branches).toContain("inactive");
	await runInDurableObject(stub, async (_instance, ctx) => {
		const { SessionStatePreservation } =
			await import("../../src/session-state-preservation");
		const { createHash } = await import("node:crypto");
		const id = ctx.id.toString(),
			key = Buffer.alloc(32, 7).toString("base64");
		ctx.storage.sql.exec(
			"ALTER TABLE session_entries ADD COLUMN future_text TEXT",
		);
		ctx.storage.sql.exec(
			"ALTER TABLE session_entries ADD COLUMN future_blob BLOB",
		);
		ctx.storage.sql.exec(
			"ALTER TABLE session_entries ADD COLUMN future_integer INTEGER",
		);
		const text = "😀é\0終".repeat(150000),
			blob = new Uint8Array(1200000).fill(251);
		ctx.storage.sql.exec(
			"UPDATE session_entries SET future_text=?,future_blob=?,future_integer=9007199254740993 WHERE id='retained:original:1'",
			text,
			blob,
		);
		ctx.storage.sql.exec(
			"CREATE TRIGGER session_future_trigger AFTER UPDATE ON session_entries BEGIN SELECT 1; END",
		);
		const source = ctx.storage.sql
			.exec(
				"SELECT id,parent_id,type,first_kept_entry_id,tokens_before,model_provider,model_id FROM session_entries ORDER BY id",
			)
			.toArray();
		const alarm = await ctx.storage.getAlarm();
		expect(source.some((row) => row.type === "compaction")).toBe(true);
		let maxCell = 0;
		const sql = new Proxy(ctx.storage.sql, {
			get(target, k) {
				if (k === "exec")
					return (query: string, ...values: SqlStorageValue[]) => {
						const result = target.exec(query, ...values);
						if (query.startsWith("SELECT substr(CAST(")) {
							const iterator = result[Symbol.iterator]();
							return {
								[Symbol.iterator]: () => ({
									next() {
										const next = iterator.next();
										if (!next.done) {
											const value = (next.value as { chunk: ArrayBuffer })
												.chunk;
											maxCell = Math.max(maxCell, value.byteLength);
											expect(value.byteLength).toBeLessThanOrEqual(65536);
										}
										return next;
									},
								}),
							};
						}
						return result;
					};
				const v = Reflect.get(target, k);
				return typeof v === "function" ? v.bind(target) : v;
			},
		});
		const storage = new Proxy(ctx.storage, {
			get(target, k) {
				if (k === "sql") return sql;
				const v = Reflect.get(target, k);
				return typeof v === "function" ? v.bind(target) : v;
			},
		});
		const engine = new SessionStatePreservation(
			storage,
			{
				kind: "session-preservation-capture-v1",
				operationId: "original",
				rootId: id,
				objectId: id,
				tediId: crypto.randomUUID(),
				orgId: crypto.randomUUID(),
				objectName: "local",
				physicalName: "local",
				className: "AgentTediDO",
				targetPath: [],
				generation: 1,
			},
			() => {},
			async () => {},
		);
		const plan = await engine.inspect(key);
		expect(plan.metadata.sourceBytes).toBeGreaterThan(8 * 1024 * 1024);
		expect(plan.metadata.tables.every((t) => t.present)).toBe(true);
		expect(
			ctx.storage.sql
				.exec(
					"SELECT name FROM sqlite_master WHERE name='session_preservation_snapshot'",
				)
				.toArray(),
		).toEqual([]);
		const archive = await engine.capture(key, plan.archiveId, plan.proof);
		expect(await engine.audit(key, plan.archiveId)).toEqual(archive);
		const overBudget = await engine.prepareQualification(key, plan.archiveId)
			.result;
		expect(overBudget!.qualification.parentLocal.reason).toBe(
			"budget_unavailable",
		);
		expect(overBudget!.qualification.sdk7.reason).toBe("budget_unavailable");
		expect(overBudget!.qualification.archiveAuthenticated).toBe(true);
		const hash = createHash("sha256"),
			parts: Uint8Array[] = [];
		for (const row of ctx.storage.sql.exec<{ chunk: ArrayBuffer }>(
			"SELECT chunk FROM session_preservation_parts ORDER BY part",
		)) {
			const b = new Uint8Array(row.chunk);
			expect(b.length).toBeLessThanOrEqual(1000000);
			parts.push(b);
			hash.update(b);
		}
		// Test-only reconstruction verifies complete cells spanning archive parts, not a hash-only mock.
		const bytes = Buffer.concat(parts);
		expect(bytes.includes(Buffer.from(text))).toBe(true);
		expect(bytes.includes(Buffer.from(blob))).toBe(true);
		expect(bytes.includes("9007199254740993")).toBe(true);
		expect(bytes.includes("PRIVATE_INACTIVE_BRANCH")).toBe(true);
		expect(bytes.includes("session_future_trigger")).toBe(true);
		expect(maxCell).toBe(65536);
		const header = JSON.parse(
			ctx.storage.sql
				.exec<{ header: string }>(
					"SELECT header FROM session_preservation_snapshot",
				)
				.one().header,
		);
		expect(hash.digest("hex")).toBe(header.sourceHash);
		expect(
			ctx.storage.sql
				.exec(
					"SELECT id,parent_id,type,first_kept_entry_id,tokens_before,model_provider,model_id FROM session_entries ORDER BY id",
				)
				.toArray(),
		).toEqual(source);
		expect(await ctx.storage.getAlarm()).toBe(alarm);
		expect(JSON.stringify(archive)).not.toContain("PRIVATE_");
		expect(JSON.stringify(archive)).not.toContain(header.sourceHash);
	});
});

it("session-only admin dispatch requires original positive nonactive custody and preserves schema before capture", async () => {
	const local = env as unknown as Cloudflare.Env,
		namespace = ns().PI_CUTOVER_EARLY,
		name = "session-root-" + crypto.randomUUID(),
		tediId = crypto.randomUUID(),
		orgId = crypto.randomUUID();
	await local.DB.exec(
		"CREATE TABLE IF NOT EXISTS tedis(id TEXT PRIMARY KEY,organization_id TEXT,slug TEXT,isolate_agent_id TEXT,runtime_kind TEXT,status TEXT)",
	);
	await local.DB.prepare("INSERT INTO tedis VALUES(?,?,?,?,?,?)")
		.bind(tediId, orgId, name, name, "agent", "active")
		.run();
	await runInDurableObject(
		namespace.get(namespace.idFromName(name)),
		async (_instance, ctx) => {
			const { operateStoredCutover } =
					await import("../../src/pi-cutover-admin"),
				{ RuntimeAdmissionDO } = await import("../../src/runtime-admission-do");
			const key = Buffer.alloc(32, 7).toString("base64"),
				id = ctx.id.toString();
			ctx.storage.kv.put("__ps_name", name);
			ctx.storage.sql.exec(
				"CREATE TABLE cf_agents_state(id TEXT PRIMARY KEY,state TEXT)",
			);
			ctx.storage.sql.exec(
				"INSERT INTO cf_agents_state VALUES('cf_state_row_id',?)",
				JSON.stringify({ tediId, orgId }),
			);
			ctx.storage.sql.exec(
				"CREATE TABLE session_entries(id TEXT PRIMARY KEY,content TEXT)",
			);
			ctx.storage.sql.exec(
				"INSERT INTO session_entries VALUES ('source','PRIVATE_SOURCE')",
			);
			const admission = new RuntimeAdmissionDO(ctx.storage, {
				objectId: id,
				tediId,
				orgId,
			});
			admission.gate.initialize({
				operationId: "held",
				state: "quarantined",
				reason: "fixture",
			});
			const runtimeEnv = {
				...local,
				TEDI_AGENT: namespace,
				PI_CUTOVER_KNOWN_PARENT_IDS: JSON.stringify([id]),
				SECRETS_MASTER_KEY: key,
			} as unknown as Cloudflare.Env;
			const invoke = (command: string, extra: Record<string, unknown> = {}) =>
				operateStoredCutover({
					ctx,
					env: runtimeEnv,
					receiver: "raw-cutover-v1",
					request: new Request(CUTOVER_URL, {
						method: "POST",
						headers: { "X-Tedix-Admin-Token": key },
						body: JSON.stringify({
							command,
							objectId: id,
							operationId: "original",
							expectedGeneration: 1,
							custody: { tediId, orgId, objectName: name },
							...extra,
						}),
					}),
				});
			const before = ctx.storage.sql
				.exec("SELECT name,sql FROM sqlite_master ORDER BY name")
				.toArray();
			const absent = await invoke("inspect_session_rehydration", {
				archiveId: crypto.randomUUID(),
			});
			expect(absent?.status).toBe(200);
			expect(await absent!.json()).toMatchObject({
				command: "inspect_session_rehydration",
				archive: null,
				qualification: null,
			});
			const {
				TediRuntimeSessionRehydrationResponseSchema: qualificationSchema,
			} = await import("@tedix/api-contract/schemas/tedi");
			const qualificationParse = qualificationSchema.parse;
			for (const rejected of [false, true]) {
				let fired = false,
					recaptured = false,
					changed = false;
				const sql = ctx.storage.sql,
					exec = sql.exec,
					ownExec = Object.getOwnPropertyDescriptor(sql, "exec");
				Object.defineProperty(sql, "exec", {
					configurable: true,
					value: (query: string, ...args: SqlStorageValue[]) => {
						if (
							changed &&
							/^SELECT/i.test(query) &&
							query.includes("session_entries")
						)
							recaptured = true;
						return Reflect.apply(exec, sql, [query, ...args]);
					},
				});
				qualificationSchema.parse = (
					...args: Parameters<typeof qualificationParse>
				) => {
					const value = rejected
						? undefined
						: Reflect.apply(qualificationParse, qualificationSchema, args);
					if (!fired) {
						fired = true;
						queueMicrotask(() => {
							changed = true;
							sql.exec(
								"UPDATE session_entries SET content='PRIVATE_PUBLISHER_RACE'",
							);
						});
					}
					if (rejected)
						throw new Error("original qualification parser refusal");
					return value!;
				};
				try {
					expect(
						(
							await invoke("inspect_session_rehydration", {
								archiveId: crypto.randomUUID(),
							})
						).status,
					).toBe(409);
					expect(fired).toBe(true);
					expect(recaptured).toBe(true);
				} finally {
					qualificationSchema.parse = qualificationParse;
					if (ownExec) Object.defineProperty(sql, "exec", ownExec);
					else Reflect.deleteProperty(sql, "exec");
					sql.exec("UPDATE session_entries SET content='PRIVATE_SOURCE'");
				}
			}

			const response = await invoke("inspect_session_preservation");
			expect(response?.status).toBe(200);
			const plan = (await response!.json()) as {
				archive: { archiveId: string };
				proof: string;
			};
			expect(
				ctx.storage.sql
					.exec("SELECT name,sql FROM sqlite_master ORDER BY name")
					.toArray(),
			).toEqual(before);
			expect(
				(
					await invoke("capture_session_preservation", {
						archiveId: plan.archive.archiveId,
						proof: plan.proof,
					})
				)?.status,
			).toBe(200);
			expect(
				(
					await invoke("audit_session_preservation", {
						archiveId: plan.archive.archiveId,
					})
				)?.status,
			).toBe(200);
			const qualified = await invoke("inspect_session_rehydration", {
				archiveId: plan.archive.archiveId,
			});
			expect(qualified?.status).toBe(200);
			expect(await qualified!.json()).toMatchObject({
				qualification: {
					archiveAuthenticated: true,
					parentLocal: { status: "unavailable", reason: "unsupported_schema" },
					executionEligible: false,
					adoptionReady: false,
				},
			});

			const retirementEvidence = await admission.prepareEvidence("retire");
			for (const mutation of ["name", "owner", "generation"]) {
				const own = Object.getOwnPropertyDescriptor(crypto.subtle, "encrypt"),
					encrypt = crypto.subtle.encrypt;
				let fired = false;
				Object.defineProperty(crypto.subtle, "encrypt", {
					configurable: true,
					value: async (...args: unknown[]) => {
						const result = await Reflect.apply(encrypt, crypto.subtle, args);
						if (!fired) {
							fired = true;
							queueMicrotask(() => {
								if (mutation === "name")
									ctx.storage.kv.put("__ps_name", "changed-during-encrypt");
								if (mutation === "owner")
									ctx.storage.sql.exec(
										"UPDATE cf_agents_state SET state=?",
										JSON.stringify({ tediId, orgId: "contradictory" }),
									);
								if (mutation === "generation")
									admission.gate.retire({
										operationId: "changed-during-encrypt",
										expectedGeneration: 1,
										evidence: retirementEvidence,
									});
							});
						}
						return result;
					},
				});
				try {
					expect((await invoke("inspect_session_preservation"))?.status).toBe(
						409,
					);
					expect(fired).toBe(true);
				} finally {
					if (own) Object.defineProperty(crypto.subtle, "encrypt", own);
					else Reflect.deleteProperty(crypto.subtle, "encrypt");
					ctx.storage.kv.put("__ps_name", name);
					ctx.storage.sql.exec(
						"UPDATE cf_agents_state SET state=?",
						JSON.stringify({ tediId, orgId }),
					);
				}
				// The genuine generation transition intentionally persists, so its test is last.
			}
			ctx.storage.kv.put("__ps_name", "contradictory");
			expect((await invoke("inspect_session_preservation"))?.status).toBe(409);
			ctx.storage.kv.put("__ps_name", name);
			expect(
				(
					await invoke("inspect_session_preservation", {
						expectedGeneration: 0,
					})
				)?.status,
			).toBe(400);
			expect(
				(
					await invoke("inspect_session_preservation", {
						sourceHash: "a".repeat(64),
					})
				)?.status,
			).toBe(400);
		},
	);
});

it("session streaming supports future wide columns and native SQL result-column boundary", async () => {
	await runInDurableObject(
		ns().PI_CUTOVER_EARLY.get(
			ns().PI_CUTOVER_EARLY.idFromName(crypto.randomUUID()),
		),
		async (_instance, ctx) => {
			const { SessionStatePreservation } =
				await import("../../src/session-state-preservation");
			const id = ctx.id.toString(),
				key = Buffer.alloc(32, 7).toString("base64"),
				intent = {
					kind: "session-preservation-capture-v1" as const,
					operationId: "future",
					rootId: id,
					objectId: id,
					tediId: crypto.randomUUID(),
					orgId: crypto.randomUUID(),
					objectName: "future",
					physicalName: "future",
					className: "AgentTediDO",
					targetPath: [],
					generation: 1,
				};
			ctx.storage.sql.exec(
				`CREATE TABLE session_entries(${Array.from({ length: 100 }, (_, i) => "c" + i + " TEXT").join(",")})`,
			);
			ctx.storage.sql.exec(
				"INSERT INTO session_entries(c99) VALUES('PRIVATE_FUTURE')",
			);
			const keys = Array.from({ length: 50 }, (_, i) => "k" + i);
			ctx.storage.sql.exec(
				`CREATE TABLE cf_agents_session_config(${keys.map((k) => k + " TEXT").join(",")},value BLOB,PRIMARY KEY(${keys.join(",")})) WITHOUT ROWID`,
			);
			// The locator cursor carries two bounded output columns per key: the provider permits 100 here.
			ctx.storage.sql.exec(
				`INSERT INTO cf_agents_session_config VALUES (${keys.map(() => "'key'").join(",")},X'00FF')`,
			);
			const engine = new SessionStatePreservation(
				ctx.storage,
				intent,
				() => {},
				async () => {},
			);
			const p = await engine.inspect(key);
			expect(p.metadata.tables[0]?.rows).toBe(1);
			const a = await engine.capture(key, p.archiveId, p.proof);
			expect(await engine.audit(key, p.archiveId)).toEqual(a);
			ctx.storage.sql.exec("DROP TABLE session_preservation_parts");
			ctx.storage.sql.exec("DROP TABLE session_preservation_snapshot");
			ctx.storage.sql.exec("DROP TABLE cf_agents_session_config");
			keys.push("k50");
			ctx.storage.sql.exec(
				`CREATE TABLE cf_agents_session_config(${keys.map((k) => k + " TEXT").join(",")},value BLOB,PRIMARY KEY(${keys.join(",")})) WITHOUT ROWID`,
			);
			ctx.storage.sql.exec(
				`INSERT INTO cf_agents_session_config VALUES (${keys.map(() => "'key'").join(",")},X'00FF')`,
			);
			await expect(engine.inspect(key)).rejects.toThrow();
			expect(
				ctx.storage.sql
					.exec(
						"SELECT name FROM sqlite_master WHERE name='session_preservation_snapshot'",
					)
					.toArray(),
			).toEqual([]);
			expect(
				ctx.storage.sql
					.exec("SELECT count(*) AS n FROM cf_agents_session_config")
					.one().n,
			).toBe(1);
		},
	);
});

it("session native transaction rolls back expiry inside a real part insertion", async () => {
	await runInDurableObject(
		ns().PI_CUTOVER_EARLY.get(
			ns().PI_CUTOVER_EARLY.idFromName(crypto.randomUUID()),
		),
		async (_instance, ctx) => {
			const { SessionStatePreservation } =
				await import("../../src/session-state-preservation");
			const id = ctx.id.toString(),
				key = Buffer.alloc(32, 7).toString("base64");
			ctx.storage.sql.exec(
				"CREATE TABLE session_entries(id INTEGER PRIMARY KEY,content TEXT)",
			);
			ctx.storage.sql.exec(
				"INSERT INTO session_entries VALUES(1,?)",
				"private".repeat(200000),
			);
			let clock = Date.now(),
				advance = false;
			const original = Date.now,
				sql = new Proxy(ctx.storage.sql, {
					get(target, k) {
						if (k === "exec")
							return (query: string, ...values: SqlStorageValue[]) => {
								const result = target.exec(query, ...values);
								if (
									advance &&
									query.startsWith("INSERT INTO session_preservation_parts")
								)
									clock += 300001;
								return result;
							};
						const v = Reflect.get(target, k);
						return typeof v === "function" ? v.bind(target) : v;
					},
				}),
				storage = new Proxy(ctx.storage, {
					get(target, k) {
						if (k === "sql") return sql;
						const v = Reflect.get(target, k);
						return typeof v === "function" ? v.bind(target) : v;
					},
				});
			const engine = new SessionStatePreservation(
				storage,
				{
					kind: "session-preservation-capture-v1",
					operationId: "expiry",
					rootId: id,
					objectId: id,
					tediId: crypto.randomUUID(),
					orgId: crypto.randomUUID(),
					objectName: "expiry",
					physicalName: "expiry",
					className: "AgentTediDO",
					targetPath: [],
					generation: 1,
				},
				() => {},
				async () => {},
			);
			const p = await engine.inspect(key);
			try {
				Date.now = () => clock;
				advance = true;
				await expect(
					engine.capture(key, p.archiveId, p.proof),
				).rejects.toThrow();
				expect(
					ctx.storage.sql
						.exec(
							"SELECT name FROM sqlite_master WHERE name LIKE 'session_preservation_%'",
						)
						.toArray(),
				).toEqual([]);
				expect(
					ctx.storage.sql
						.exec("SELECT length(content) AS n FROM session_entries")
						.one().n,
				).toBe(1400000);
			} finally {
				Date.now = original;
			}
		},
	);
});

it("session registered-leaf endpoint retains UNKNOWN owner and refuses original forwarded path races", async () => {
	const local = env as unknown as Cloudflare.Env,
		namespace = ns().PI_CUTOVER_EARLY,
		rootName = "session-parent-" + crypto.randomUUID(),
		leafName = "session-leaf-" + crypto.randomUUID(),
		tediId = crypto.randomUUID(),
		orgId = crypto.randomUUID(),
		rootId = namespace.idFromName(rootName).toString();
	await local.DB.exec(
		"CREATE TABLE IF NOT EXISTS tedis(id TEXT PRIMARY KEY,organization_id TEXT,slug TEXT,isolate_agent_id TEXT,runtime_kind TEXT,status TEXT)",
	);
	await local.DB.prepare("INSERT INTO tedis VALUES(?,?,?,?,?,?)")
		.bind(tediId, orgId, rootName, rootName, "agent", "active")
		.run();
	await runInDurableObject(
		namespace.get(namespace.idFromName(leafName)),
		async (_instance, ctx) => {
			const { passiveRegisteredCutover } =
					await import("../../src/pi-cutover-admin"),
				{ RuntimeAdmissionDO } = await import("../../src/runtime-admission-do");
			const key = Buffer.alloc(32, 7).toString("base64"),
				id = ctx.id.toString(),
				parentPath = [{ className: "AgentTediDO", name: rootName }];
			// This proves the authenticated registered-leaf receiver with real native ID/storage.
			// The supplied parent envelope is a fixture; this is not a cross-object facet startup or registry-attestation proof.
			ctx.storage.kv.put("__ps_name", leafName);
			ctx.storage.kv.put("cf_agents_is_facet", true);
			ctx.storage.kv.put("cf_agents_facet_name", "retained");
			ctx.storage.kv.put("cf_agents_parent_path", parentPath);
			new RuntimeAdmissionDO(ctx.storage, {
				objectId: id,
				tediId: null,
				orgId: null,
			}).gate.initialize({
				operationId: "leaf-hold",
				state: "quarantined",
				reason: "fixture",
			});
			ctx.storage.sql.exec(
				"CREATE TABLE session_entries(id INTEGER PRIMARY KEY,content TEXT)",
			);
			ctx.storage.sql.exec(
				"INSERT INTO session_entries VALUES(1,'PRIVATE_LEAF')",
			);
			const path = [
				{
					className: "ConversationFacet",
					name: "retained",
					identityVersion: "path-v2",
					identityName: leafName,
					objectId: id,
					registryHash: "a".repeat(64),
					parentGeneration: 1,
				},
			];
			const custody = {
				rootId,
				tediId,
				orgId,
				objectName: rootName,
				parentPath,
				current: {
					className: "ConversationFacet",
					name: "retained",
					identityName: leafName,
					objectId: id,
				},
			};
			const runtimeEnv = {
				...local,
				TEDI_AGENT: namespace,
				PI_CUTOVER_KNOWN_PARENT_IDS: JSON.stringify([rootId]),
				SECRETS_MASTER_KEY: key,
			} as unknown as Cloudflare.Env;
			const invoke = (command: string, extra: Record<string, unknown> = {}) =>
				passiveRegisteredCutover(ctx, runtimeEnv, {
					token: key,
					index: 1,
					custody: JSON.stringify(custody),
					body: JSON.stringify({
						command,
						objectId: rootId,
						operationId: "leaf-original",
						expectedGeneration: 1,
						custody: { tediId, orgId, objectName: rootName },
						targetPath: path,
						...extra,
					}),
				});
			const result = await invoke("inspect_session_preservation");
			expect(result.status).toBe(200);
			const plan = JSON.parse(result.body);
			expect(plan.targetObjectId).toBe(id);
			expect(plan.archive.metadata.localOwnerUnknown).toBe(true);
			const captured = await invoke("capture_session_preservation", {
				archiveId: plan.archive.archiveId,
				proof: plan.proof,
			});
			expect(captured.status).toBe(200);
			expect(
				(
					await invoke("audit_session_preservation", {
						archiveId: plan.archive.archiveId,
					})
				).status,
			).toBe(200);
			const semantic = await invoke("inspect_session_rehydration", {
				archiveId: plan.archive.archiveId,
			});
			expect(semantic.status).toBe(200);
			const observed = JSON.parse(semantic.body);
			expect(observed.archive.metadata.localOwnerUnknown).toBe(true);
			expect(observed.qualification.parentLocal.reason).toBe(
				"unsupported_schema",
			);
			expect(observed.qualification.executionEligible).toBe(false);
			ctx.storage.kv.put("cf_agents_parent_path", [
				{ className: "AgentTediDO", name: "contradictory" },
			]);
			expect((await invoke("inspect_session_preservation")).status).toBe(409);
			expect(
				(
					await invoke("inspect_session_rehydration", {
						archiveId: plan.archive.archiveId,
					})
				).status,
			).toBe(409);
			expect(
				ctx.storage.sql.exec("SELECT content FROM session_entries").one()
					.content,
			).toBe("PRIVATE_LEAF");
			const admission = ctx.storage.sql
				.exec<{ record: string }>(
					"SELECT record FROM runtime_admission WHERE id=1",
				)
				.one();
			expect(JSON.parse(admission.record).owner.tediId).toBe(null);
		},
	);
});

it("qualifies actual pinned SDK7 and root records without storage or SDK effects", async () => {
	const namespace = (
		env as unknown as {
			PI_CONVERSATION: DurableObjectNamespace<
				import("./worker").PiConversationFixture
			>;
		}
	).PI_CONVERSATION;
	const stub = namespace.get(namespace.idFromName(crypto.randomUUID()));
	const seeded = await stub.seedSessionPreservation(false);
	await runInDurableObject(stub, async (_instance, ctx) => {
		const { SessionStatePreservation } =
			await import("../../src/session-state-preservation");
		const id = ctx.id.toString(),
			key = Buffer.alloc(32, 7).toString("base64");
		const engine = new SessionStatePreservation(
			ctx.storage,
			{
				kind: "session-preservation-capture-v1",
				operationId: "qualification",
				rootId: id,
				objectId: id,
				tediId: crypto.randomUUID(),
				orgId: crypto.randomUUID(),
				objectName: "local",
				physicalName: "local",
				className: "AgentTediDO",
				targetPath: [],
				generation: 1,
			},
			() => {},
			async () => {},
		);
		const plan = await engine.inspect(key);
		expect(plan.metadata.sourceBytes).toBeLessThan(8388608);
		await engine.capture(key, plan.archiveId, plan.proof);
		const original = [
			...ctx.storage.sql.exec(
				"SELECT header,header_hash FROM session_preservation_snapshot",
			),
		];
		const alarm = await ctx.storage.getAlarm();
		const kv = [...ctx.storage.kv.list()];
		let writes = 0;
		const sql = new Proxy(ctx.storage.sql, {
			get(t, k) {
				if (k === "exec")
					return (q: string, ...args: SqlStorageValue[]) => {
						if (/^(CREATE|INSERT|UPDATE|DELETE|ALTER|DROP)/i.test(q)) writes++;
						return t.exec(q, ...args);
					};
				const v = Reflect.get(t, k);
				return typeof v === "function" ? v.bind(t) : v;
			},
		});
		const storage = new Proxy(ctx.storage, {
			get(t, k) {
				if (k === "sql") return sql;
				const v = Reflect.get(t, k);
				return typeof v === "function" ? v.bind(t) : v;
			},
		});
		const reader = new SessionStatePreservation(
			storage,
			{
				kind: "session-preservation-capture-v1",
				operationId: "qualification-read",
				rootId: id,
				objectId: id,
				tediId: JSON.parse(original[0]!.header as string).intent.tediId,
				orgId: JSON.parse(original[0]!.header as string).intent.orgId,
				objectName: "local",
				physicalName: "local",
				className: "AgentTediDO",
				targetPath: [],
				generation: 1,
			},
			() => {},
			async () => {},
		);
		const result = await reader.prepareQualification(key, plan.archiveId)
			.result;
		expect(result!.qualification.parentLocal.status).toBe("supported");
		expect(result!.qualification.sdk7.status).toBe("supported");
		expect(result!.qualification.sdk7.branches).toBe(2);
		expect(result!.qualification.sdk7.attachments).toBe(1);
		expect(result!.qualification.sdk7.compactions).toBe(2);
		expect(result!.qualification.adoptionReady).toBe(false);
		expect(result!.qualification.canonicalLedgerCorrespondence).toBe(
			"not_queried",
		);
		expect(JSON.stringify(result)).not.toContain("PRIVATE_");
		const { reduceSessionArchive } =
			await import("../../src/session-state-rehydration");
		const header = JSON.parse(original[0]!.header as string);
		const archived = (function* () {
			for (const row of ctx.storage.sql.exec(
				"SELECT chunk FROM session_preservation_parts WHERE archive_id=? ORDER BY part",
				plan.archiveId,
			))
				yield new Uint8Array(row.chunk as ArrayBuffer);
		})();
		const reduced = reduceSessionArchive(
			archived,
			header.metadata,
			header.selectorVersion,
			header.intent,
		);
		expect(reduced.privateSdk.map((p) => p.leafId).sort()).toEqual([
			"inactive",
			"large",
		]);
		expect(seeded.branches.sort()).toEqual(["active", "inactive"]);
		expect(seeded.latestVisibleId).toBe("root");
		// Compare semantic payload identity without production hydration or base64 allocation.
		const comparable = (messages: unknown[]) => {
			const normalize = (value: unknown): unknown => {
				if (typeof value === "string" && value.startsWith("data:")) {
					const match = /^data:[^,]*;base64,(.*)$/s.exec(value);
					if (!match) throw new Error("Unsupported golden data URI");
					const bytes = Buffer.from(match[1]!, "base64"),
						hash = createHash("sha256").update(bytes).digest("hex");
					const meta = [
						...ctx.storage.sql.exec(
							"SELECT bytes FROM cf_agents_session_attachment_meta WHERE hash=?",
							hash,
						),
					];
					expect(meta).toHaveLength(1);
					expect(bytes.byteLength).toBe(meta[0]!.bytes);
					return "attachment:sha256:" + hash;
				}
				if (Array.isArray(value)) return value.map(normalize);
				if (value && typeof value === "object")
					return Object.fromEntries(
						Object.entries(value).map(([k, v]) => [k, normalize(v)]),
					);
				return value;
			};
			return messages.map((m) => {
				const x = m as { id: string; role: string; parts: unknown };
				return { id: x.id, role: x.role, parts: normalize(x.parts) };
			});
		};
		for (const leafId of ["inactive", "large"])
			expect(
				comparable(
					reduced.privateSdk.find((p) => p.leafId === leafId)!.messages,
				),
			).toEqual(
				comparable(
					(JSON.parse(seeded.golden) as Record<string, unknown[]>)[leafId]!,
				),
			);
		expect(
			(JSON.parse(seeded.golden) as Record<string, unknown[]>).inactive!.some(
				(m: unknown) => (m as { id: string }).id === "inactive",
			),
		).toBe(true);
		expect(writes).toBe(0);
		expect([
			...ctx.storage.sql.exec(
				"SELECT header,header_hash FROM session_preservation_snapshot",
			),
		]).toEqual(original);
		expect([...ctx.storage.kv.list()]).toEqual(kv);
		expect(await ctx.storage.getAlarm()).toBe(alarm);
	});
});

it("refuses malformed real SDK records and original parent graphs without repair", async () => {
	const namespace = (
		env as unknown as {
			PI_CONVERSATION: DurableObjectNamespace<
				import("./worker").PiConversationFixture
			>;
		}
	).PI_CONVERSATION;
	for (const mutation of [
		{
			sql: `UPDATE cf_agents_session_messages SET content='{"id":"inactive","role":"assistant","parts":[{"type":"dynamic-tool","toolCallId":"original-owned-tool","input":{},"state":"input-available"}]}',content_hash=NULL WHERE id='inactive'`,
			domain: "sdk7",
		},
		{
			sql: "INSERT INTO cf_agents_session_config VALUES('preservation','unknown','PRIVATE')",
			domain: "sdk7",
		},
		{
			sql: "CREATE TRIGGER unsupported_session_schema AFTER UPDATE ON cf_agents_session_messages BEGIN SELECT 1;END",
			domain: "sdk7",
			reason: "unsupported_schema",
		},
		{
			sql: "DELETE FROM cf_agents_session_message_chunks WHERE idx=1",
			domain: "sdk7",
		},
		{
			sql: "UPDATE cf_agents_session_messages SET content_hash='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE id='inactive'",
			domain: "sdk7",
		},
		{
			sql: "UPDATE cf_agents_session_compactions SET from_message_id='inactive'",
			domain: "sdk7",
		},
		{
			sql: "UPDATE cf_agents_session_attachment_chunks SET data='PRIVATE_WRONG_STORAGE_CLASS' WHERE idx=0",
			domain: "sdk7",
			refused: true,
		},
		{ sql: "DELETE FROM cf_agents_session_attachment_refs", domain: "sdk7" },
		{
			sql: "UPDATE cf_agents_session_messages SET seq=9007199254740993 WHERE id='inactive'",
			domain: "sdk7",
		},
		{
			sql: "UPDATE session_entries SET parent_id=id WHERE type='message'",
			domain: "parentLocal",
		},
		{
			sql: "UPDATE session_entries SET first_kept_entry_id=id WHERE type='compaction'",
			domain: "parentLocal",
		},
	] as const) {
		const stub = namespace.get(namespace.idFromName(crypto.randomUUID()));
		await stub.seedSessionPreservation(false);
		await runInDurableObject(stub, async (_instance, ctx) => {
			ctx.storage.sql.exec(mutation.sql);
			const { SessionStatePreservation } =
				await import("../../src/session-state-preservation");
			const id = ctx.id.toString(),
				key = Buffer.alloc(32, 7).toString("base64");
			const engine = new SessionStatePreservation(
				ctx.storage,
				{
					kind: "session-preservation-capture-v1",
					operationId: "invalid-observation",
					rootId: id,
					objectId: id,
					tediId: crypto.randomUUID(),
					orgId: crypto.randomUUID(),
					objectName: "local",
					physicalName: "local",
					className: "AgentTediDO",
					targetPath: [],
					generation: 1,
				},
				() => {},
				async () => {},
			);
			const p = await engine.inspect(key);
			await engine.capture(key, p.archiveId, p.proof);
			const original = [
				...ctx.storage.sql.exec(
					"SELECT header,header_hash FROM session_preservation_snapshot",
				),
			];
			if ("refused" in mutation) {
				await expect(
					engine.prepareQualification(key, p.archiveId).result,
				).rejects.toThrow("verification rejected");
				expect([
					...ctx.storage.sql.exec(
						"SELECT header,header_hash FROM session_preservation_snapshot",
					),
				]).toEqual(original);
				return;
			}
			const result = await engine.prepareQualification(key, p.archiveId).result;
			expect(result!.qualification[mutation.domain].status, mutation.sql).toBe(
				"unavailable",
			);
			expect(result!.qualification[mutation.domain].reason).toBe(
				"reason" in mutation ? mutation.reason : "invalid_semantics",
			);
			expect(result!.qualification.adoptionReady).toBe(false);
			expect([
				...ctx.storage.sql.exec(
					"SELECT header,header_hash FROM session_preservation_snapshot",
				),
			]).toEqual(original);
		});
	}
});

it("SDK-only admin dispatch requires original positive nonactive custody and preserves schema before capture", async () => {
	const local = env as unknown as Cloudflare.Env,
		namespace = ns().PI_CUTOVER_EARLY,
		name = "sdk-root-" + crypto.randomUUID(),
		tediId = crypto.randomUUID(),
		orgId = crypto.randomUUID();
	await local.DB.exec(
		"CREATE TABLE IF NOT EXISTS tedis(id TEXT PRIMARY KEY,organization_id TEXT,slug TEXT,isolate_agent_id TEXT,runtime_kind TEXT,status TEXT)",
	);
	await local.DB.prepare("INSERT INTO tedis VALUES(?,?,?,?,?,?)")
		.bind(tediId, orgId, name, name, "agent", "active")
		.run();
	await runInDurableObject(
		namespace.get(namespace.idFromName(name)),
		async (_instance, ctx) => {
			const { operateStoredCutover } =
					await import("../../src/pi-cutover-admin"),
				{ RuntimeAdmissionDO } = await import("../../src/runtime-admission-do");
			const key = Buffer.alloc(32, 7).toString("base64"),
				id = ctx.id.toString();
			ctx.storage.kv.put("__ps_name", name);
			ctx.storage.sql.exec(
				"CREATE TABLE cf_agents_state(id TEXT PRIMARY KEY,state TEXT)",
			);
			ctx.storage.sql.exec(
				"INSERT INTO cf_agents_state VALUES('cf_state_row_id',?)",
				JSON.stringify({ tediId, orgId }),
			);
			ctx.storage.sql.exec(
				"CREATE TABLE session_entries(id TEXT PRIMARY KEY,content TEXT)",
			);
			ctx.storage.sql.exec(
				"INSERT INTO session_entries VALUES ('source','PRIVATE_SOURCE')",
			);
			const admission = new RuntimeAdmissionDO(ctx.storage, {
				objectId: id,
				tediId,
				orgId,
			});
			admission.gate.initialize({
				operationId: "held",
				state: "quarantined",
				reason: "fixture",
			});
			const runtimeEnv = {
				...local,
				TEDI_AGENT: namespace,
				PI_CUTOVER_KNOWN_PARENT_IDS: JSON.stringify([id]),
				SECRETS_MASTER_KEY: key,
			} as unknown as Cloudflare.Env;
			const invoke = (command: string, extra: Record<string, unknown> = {}) =>
				operateStoredCutover({
					ctx,
					env: runtimeEnv,
					receiver: "raw-cutover-v1",
					request: new Request(CUTOVER_URL, {
						method: "POST",
						headers: { "X-Tedix-Admin-Token": key },
						body: JSON.stringify({
							command,
							objectId: id,
							operationId: "original",
							expectedGeneration: 1,
							custody: { tediId, orgId, objectName: name },
							...extra,
						}),
					}),
				});
			const before = ctx.storage.sql
				.exec("SELECT name,sql FROM sqlite_master ORDER BY name")
				.toArray();
			const response = await invoke("inspect_sdk_preservation");
			expect(response?.status).toBe(200);
			const plan = (await response!.json()) as {
				archive: { archiveId: string };
				proof: string;
			};
			expect(
				ctx.storage.sql
					.exec("SELECT name,sql FROM sqlite_master ORDER BY name")
					.toArray(),
			).toEqual(before);
			expect(
				(
					await invoke("capture_sdk_preservation", {
						archiveId: plan.archive.archiveId,
						proof: plan.proof,
					})
				)?.status,
			).toBe(200);
			expect(
				(
					await invoke("audit_sdk_preservation", {
						archiveId: plan.archive.archiveId,
					})
				)?.status,
			).toBe(200);

			// Fresh unarchived source for each inspection race; full-KV archives intentionally bind admission evidence.
			ctx.storage.sql.exec("DROP TABLE sdk_work_preservation_parts");
			ctx.storage.sql.exec("DROP TABLE sdk_work_preservation_snapshot");
			// Mutation queued by the actual strict result parser lands after the engine's
			// final check, across runNativePreservation's yield, before Response.json.
			const { TediRuntimeSdkPreservationResponseSchema: schema } =
				await import("@tedix/api-contract/schemas/tedi");
			const parse = schema.parse;
			for (const command of [
				"inspect_sdk_preservation",
				"audit_sdk_preservation",
			]) {
				let fired = false;
				schema.parse = (...args: Parameters<typeof parse>) => {
					const value = Reflect.apply(parse, schema, args);
					if (!fired) {
						fired = true;
						queueMicrotask(() =>
							ctx.storage.kv.put("publisher-yield", "PRIVATE"),
						);
					}
					return value;
				};
				try {
					expect(
						(
							await invoke(
								command,
								command === "audit_sdk_preservation"
									? { archiveId: crypto.randomUUID() }
									: {},
							)
						)?.status,
					).toBe(409);
					expect(fired).toBe(true);
					expect([
						...ctx.storage.sql.exec(
							"SELECT name FROM sqlite_master WHERE name LIKE 'sdk_work_preservation_%'",
						),
					]).toEqual([]);
				} finally {
					schema.parse = parse;
					ctx.storage.kv.delete("publisher-yield");
				}
			}

			// A successful commit is not undone by a final publication refusal.
			const capturePlanResponse = await invoke("inspect_sdk_preservation");
			const capturePlan = (await capturePlanResponse!.json()) as {
				archive: { archiveId: string };
				proof: string;
			};
			schema.parse = (...args: Parameters<typeof parse>) => {
				const value = Reflect.apply(parse, schema, args);
				queueMicrotask(() =>
					ctx.storage.kv.put("capture-publisher-yield", "PRIVATE"),
				);
				return value;
			};
			try {
				expect(
					(
						await invoke("capture_sdk_preservation", {
							archiveId: capturePlan.archive.archiveId,
							proof: capturePlan.proof,
						})
					)?.status,
				).toBe(409);
				expect([
					...ctx.storage.sql.exec(
						"SELECT id FROM sdk_work_preservation_snapshot",
					),
				]).toHaveLength(1);
			} finally {
				schema.parse = parse;
				ctx.storage.kv.delete("capture-publisher-yield");
			}
			expect(
				(
					await invoke("audit_sdk_preservation", {
						archiveId: capturePlan.archive.archiveId,
					})
				)?.status,
			).toBe(200);
			ctx.storage.sql.exec("DROP TABLE sdk_work_preservation_parts");
			ctx.storage.sql.exec("DROP TABLE sdk_work_preservation_snapshot");
			// A parser rejection carries its exact operation guard through the rejected
			// async return too. Measure a full KV scan after the queued mutation.
			const kv = ctx.storage.kv,
				list = kv.list;
			const descriptor = Object.getOwnPropertyDescriptor(kv, "list");
			let rejectedYieldChecked = false;
			Object.defineProperty(kv, "list", {
				configurable: true,
				value: (...args: unknown[]) => {
					if (kv.get("rejected-publisher-yield") !== undefined)
						rejectedYieldChecked = true;
					return Reflect.apply(list, kv, args);
				},
			});
			schema.parse = () => {
				queueMicrotask(() => kv.put("rejected-publisher-yield", "PRIVATE"));
				throw Error("original strict parser refusal");
			};
			try {
				expect(
					(
						await invoke("audit_sdk_preservation", {
							archiveId: crypto.randomUUID(),
						})
					)?.status,
				).toBe(409);
				expect(rejectedYieldChecked).toBe(true);
			} finally {
				schema.parse = parse;
				if (descriptor) Object.defineProperty(kv, "list", descriptor);
				else Reflect.deleteProperty(kv, "list");
				kv.delete("rejected-publisher-yield");
			}

			const retirementEvidence = await admission.prepareEvidence("retire");
			for (const mutation of ["name", "owner", "generation"]) {
				const own = Object.getOwnPropertyDescriptor(crypto.subtle, "encrypt"),
					encrypt = crypto.subtle.encrypt;
				let fired = false;
				Object.defineProperty(crypto.subtle, "encrypt", {
					configurable: true,
					value: async (...args: unknown[]) => {
						const result = await Reflect.apply(encrypt, crypto.subtle, args);
						if (!fired) {
							fired = true;
							queueMicrotask(() => {
								if (mutation === "name")
									ctx.storage.kv.put("__ps_name", "changed-during-encrypt");
								if (mutation === "owner")
									ctx.storage.sql.exec(
										"UPDATE cf_agents_state SET state=?",
										JSON.stringify({ tediId, orgId: "contradictory" }),
									);
								if (mutation === "generation")
									admission.gate.retire({
										operationId: "changed-during-encrypt",
										expectedGeneration: 1,
										evidence: retirementEvidence,
									});
							});
						}
						return result;
					},
				});
				try {
					expect((await invoke("inspect_sdk_preservation"))?.status).toBe(409);
					expect(fired).toBe(true);
				} finally {
					if (own) Object.defineProperty(crypto.subtle, "encrypt", own);
					else Reflect.deleteProperty(crypto.subtle, "encrypt");
					ctx.storage.kv.put("__ps_name", name);
					ctx.storage.sql.exec(
						"UPDATE cf_agents_state SET state=?",
						JSON.stringify({ tediId, orgId }),
					);
				}
				// The genuine generation transition intentionally persists, so its test is last.
			}
			ctx.storage.kv.put("__ps_name", "contradictory");
			expect((await invoke("inspect_sdk_preservation"))?.status).toBe(409);
			ctx.storage.kv.put("__ps_name", name);
			expect(
				(
					await invoke("inspect_sdk_preservation", {
						expectedGeneration: 0,
					})
				)?.status,
			).toBe(400);
			expect(
				(
					await invoke("inspect_sdk_preservation", {
						sourceHash: "a".repeat(64),
					})
				)?.status,
			).toBe(400);
		},
	);
});

it("SDK registered-leaf endpoint retains UNKNOWN owner and refuses original forwarded path races", async () => {
	const local = env as unknown as Cloudflare.Env,
		namespace = ns().PI_CUTOVER_EARLY,
		rootName = "session-parent-" + crypto.randomUUID(),
		leafName = "session-leaf-" + crypto.randomUUID(),
		tediId = crypto.randomUUID(),
		orgId = crypto.randomUUID(),
		rootId = namespace.idFromName(rootName).toString();
	await local.DB.exec(
		"CREATE TABLE IF NOT EXISTS tedis(id TEXT PRIMARY KEY,organization_id TEXT,slug TEXT,isolate_agent_id TEXT,runtime_kind TEXT,status TEXT)",
	);
	await local.DB.prepare("INSERT INTO tedis VALUES(?,?,?,?,?,?)")
		.bind(tediId, orgId, rootName, rootName, "agent", "active")
		.run();
	await runInDurableObject(
		namespace.get(namespace.idFromName(leafName)),
		async (_instance, ctx) => {
			const { passiveRegisteredCutover } =
					await import("../../src/pi-cutover-admin"),
				{ RuntimeAdmissionDO } = await import("../../src/runtime-admission-do");
			const key = Buffer.alloc(32, 7).toString("base64"),
				id = ctx.id.toString(),
				parentPath = [{ className: "AgentTediDO", name: rootName }];
			// This proves the authenticated registered-leaf receiver with real native ID/storage.
			// The supplied parent envelope is a fixture; this is not a cross-object facet startup or registry-attestation proof.
			ctx.storage.kv.put("__ps_name", leafName);
			ctx.storage.kv.put("cf_agents_is_facet", true);
			ctx.storage.kv.put("cf_agents_facet_name", "retained");
			ctx.storage.kv.put("cf_agents_parent_path", parentPath);
			new RuntimeAdmissionDO(ctx.storage, {
				objectId: id,
				tediId: null,
				orgId: null,
			}).gate.initialize({
				operationId: "leaf-hold",
				state: "quarantined",
				reason: "fixture",
			});
			ctx.storage.sql.exec(
				"CREATE TABLE session_entries(id INTEGER PRIMARY KEY,content TEXT)",
			);
			ctx.storage.sql.exec(
				"INSERT INTO session_entries VALUES(1,'PRIVATE_LEAF')",
			);
			const path = [
				{
					className: "ConversationFacet",
					name: "retained",
					identityVersion: "path-v2",
					identityName: leafName,
					objectId: id,
					registryHash: "a".repeat(64),
					parentGeneration: 1,
				},
			];
			const custody = {
				rootId,
				tediId,
				orgId,
				objectName: rootName,
				parentPath,
				current: {
					className: "ConversationFacet",
					name: "retained",
					identityName: leafName,
					objectId: id,
				},
			};
			const runtimeEnv = {
				...local,
				TEDI_AGENT: namespace,
				PI_CUTOVER_KNOWN_PARENT_IDS: JSON.stringify([rootId]),
				SECRETS_MASTER_KEY: key,
			} as unknown as Cloudflare.Env;
			const invoke = (command: string, extra: Record<string, unknown> = {}) =>
				passiveRegisteredCutover(ctx, runtimeEnv, {
					token: key,
					index: 1,
					custody: JSON.stringify(custody),
					body: JSON.stringify({
						command,
						objectId: rootId,
						operationId: "leaf-original",
						expectedGeneration: 1,
						custody: { tediId, orgId, objectName: rootName },
						targetPath: path,
						...extra,
					}),
				});
			const result = await invoke("inspect_sdk_preservation");
			expect(result.status).toBe(200);
			const plan = JSON.parse(result.body);
			expect(plan.targetObjectId).toBe(id);
			expect(plan.archive.metadata.localOwnerUnknown).toBe(true);
			const captured = await invoke("capture_sdk_preservation", {
				archiveId: plan.archive.archiveId,
				proof: plan.proof,
			});
			expect(captured.status).toBe(200);
			expect(
				(
					await invoke("audit_sdk_preservation", {
						archiveId: plan.archive.archiveId,
					})
				).status,
			).toBe(200);
			const {
				TediRuntimeSessionRehydrationResponseSchema: qualificationSchema,
			} = await import("@tedix/api-contract/schemas/tedi");
			const qualificationParse = qualificationSchema.parse;
			let publisherRace = false;
			qualificationSchema.parse = (
				...args: Parameters<typeof qualificationParse>
			) => {
				const value = Reflect.apply(
					qualificationParse,
					qualificationSchema,
					args,
				);
				if (!publisherRace) {
					publisherRace = true;
					queueMicrotask(() =>
						ctx.storage.kv.put("cf_agents_parent_path", [
							{ className: "AgentTediDO", name: "changed-after-qualification" },
						]),
					);
				}
				return value;
			};
			try {
				expect(
					(
						await invoke("inspect_session_rehydration", {
							archiveId: plan.archive.archiveId,
						})
					).status,
				).toBe(409);
				expect(publisherRace).toBe(true);
			} finally {
				qualificationSchema.parse = qualificationParse;
				ctx.storage.kv.put("cf_agents_parent_path", parentPath);
			}

			const ownEncrypt = Object.getOwnPropertyDescriptor(
					crypto.subtle,
					"encrypt",
				),
				originalEncrypt = crypto.subtle.encrypt;
			let pathChanged = false;
			Object.defineProperty(crypto.subtle, "encrypt", {
				configurable: true,
				value: async (...args: unknown[]) => {
					const result = await Reflect.apply(
						originalEncrypt,
						crypto.subtle,
						args,
					);
					queueMicrotask(() => {
						pathChanged = true;
						ctx.storage.kv.put("cf_agents_parent_path", [
							{ className: "AgentTediDO", name: "changed-during-encrypt" },
						]);
					});
					return result;
				},
			});
			try {
				expect((await invoke("inspect_sdk_preservation")).status).toBe(409);
				expect(pathChanged).toBe(true);
			} finally {
				if (ownEncrypt)
					Object.defineProperty(crypto.subtle, "encrypt", ownEncrypt);
				else Reflect.deleteProperty(crypto.subtle, "encrypt");
				ctx.storage.kv.put("cf_agents_parent_path", parentPath);
			}

			ctx.storage.kv.put("cf_agents_parent_path", [
				{ className: "AgentTediDO", name: "contradictory" },
			]);
			expect((await invoke("inspect_sdk_preservation")).status).toBe(409);
			expect(
				ctx.storage.sql.exec("SELECT content FROM session_entries").one()
					.content,
			).toBe("PRIVATE_LEAF");
			const admission = ctx.storage.sql
				.exec<{ record: string }>(
					"SELECT record FROM runtime_admission WHERE id=1",
				)
				.one();
			expect(JSON.parse(admission.record).owner.tediId).toBe(null);
		},
	);
});

it("SDK selected capture streams pinned jobs/tasks/streams/MCP and complete native KV without lifecycle or alarm reads", async () => {
	const namespace = (
		env as unknown as {
			PI_CONVERSATION: DurableObjectNamespace<
				import("./worker").PiConversationFixture
			>;
		}
	).PI_CONVERSATION;
	const stub = namespace.get(namespace.idFromName(crypto.randomUUID()));
	await stub.seedSdkPreservation();
	const wallStarted = performance.now();
	const timing = await runInDurableObject(stub, async (_instance, ctx) => {
		const { SdkStatePreservation } =
			await import("../../src/sdk-state-preservation");
		const id = ctx.id.toString(),
			key = Buffer.alloc(32, 7).toString("base64");
		for (let i = 1; i < 8; i++)
			ctx.storage.sql.exec(
				"INSERT INTO cf_agents_stream_blocks VALUES('retained',?,0,1,?,1,1)",
				i,
				"PRIVATE_STREAM" + "🌒".repeat(350000),
			);
		ctx.storage.sql.exec(
			"ALTER TABLE cf_agents_task_steps ADD COLUMN exact_integer INTEGER",
		);
		ctx.storage.sql.exec(
			"UPDATE cf_agents_task_steps SET exact_integer=9223372036854775807",
		);
		const before = [
			...ctx.storage.sql.exec(
				"SELECT run_id,step_name,state,CAST(exact_integer AS TEXT) AS exact_integer FROM cf_agents_task_steps",
			),
		];
		let alarmReads = 0,
			maxCell = 0;
		const sql = new Proxy(ctx.storage.sql, {
			get(target, k) {
				if (k === "exec")
					return (q: string, ...v: SqlStorageValue[]) => {
						const r = target.exec(q, ...v);
						if (q.startsWith("SELECT substr(CAST(")) {
							const it = r[Symbol.iterator]();
							return {
								[Symbol.iterator]: () => ({
									next() {
										const n = it.next();
										if (!n.done) {
											const b = (n.value as { chunk: ArrayBuffer }).chunk;
											maxCell = Math.max(maxCell, b.byteLength);
											expect(b.byteLength).toBeLessThanOrEqual(65536);
										}
										return n;
									},
								}),
							};
						}
						return r;
					};
				const v = Reflect.get(target, k);
				return typeof v === "function" ? v.bind(target) : v;
			},
		});
		const storage = new Proxy(ctx.storage, {
			get(target, k) {
				if (k === "sql") return sql;
				if (k === "getAlarm")
					return () => {
						alarmReads++;
						throw Error("alarm must not be observed");
					};
				const v = Reflect.get(target, k);
				return typeof v === "function" ? v.bind(target) : v;
			},
		});
		const engine = new SdkStatePreservation(
			storage,
			{
				kind: "sdk-work-preservation-capture-v1",
				operationId: "original",
				rootId: id,
				objectId: id,
				tediId: crypto.randomUUID(),
				orgId: crypto.randomUUID(),
				objectName: "original",
				physicalName: "original",
				className: "AgentTediDO",
				targetPath: [],
				generation: 1,
			},
			() => {},
			async () => {},
		);
		const started = performance.now();
		const p = await consumeSdk(() => engine.inspect(key));
		const inspected = performance.now();
		expect(p.metadata.sourceBytes).toBeGreaterThan(8 * 1024 * 1024);
		expect(p.metadata.kvEntries).toBeGreaterThanOrEqual(5);
		expect(p.alarmCovered).toBe(false);
		expect(p.alarmConsistency).toBe("UNKNOWN");
		const archive = await consumeSdk(() =>
			engine.capture(key, p.archiveId, p.proof),
		);
		const captured = performance.now();
		expect(await consumeSdk(() => engine.audit(key, p.archiveId))).toEqual(
			archive,
		);
		const audited = performance.now();

		expect(maxCell).toBe(65536);
		expect(alarmReads).toBe(0);
		const parts = [
			...ctx.storage.sql.exec<{ chunk: ArrayBuffer }>(
				"SELECT chunk FROM sdk_work_preservation_parts ORDER BY part",
			),
		];
		expect(parts.length).toBeGreaterThan(8);
		const bytes = Buffer.concat(parts.map((r) => Buffer.from(r.chunk)));
		expect(bytes.includes("9223372036854775807")).toBe(true);
		expect(bytes.includes("PRIVATE_JOB")).toBe(true);
		expect(bytes.includes("PRIVATE_OAUTH")).toBe(true);
		expect(bytes.includes("original-idempotency")).toBe(true);
		expect(bytes.includes("server_options")).toBe(true);
		for (const value of [
			"PRIVATE_FIBER",
			"PRIVATE_WORKFLOW",
			"PRIVATE_CONTEXT",
			"PRIVATE_ROUTE",
			"PRIVATE_QUEUE",
		])
			expect(bytes.includes(value)).toBe(true);
		expect(JSON.stringify(archive)).not.toContain("PRIVATE");
		expect([
			...ctx.storage.sql.exec(
				"SELECT run_id,step_name,state,CAST(exact_integer AS TEXT) AS exact_integer FROM cf_agents_task_steps",
			),
		]).toEqual(before);
		return {
			inspect: inspected - started,
			capture: captured - inspected,
			audit: audited - captured,
		};
	});
	console.info("SDK selected local timings ms", {
		...timing,
		totalObserved: performance.now() - wallStarted,
	});
}, 60000);

it("SDK selected whole-capture refuses actual native FTS and unsupported KV before archive DDL", async () => {
	for (const mode of ["fts", "date", "binary", "case-view"] as const)
		await runInDurableObject(
			ns().PI_CUTOVER_EARLY.get(
				ns().PI_CUTOVER_EARLY.idFromName(crypto.randomUUID()),
			),
			async (_instance, ctx) => {
				const { SdkStatePreservation } =
					await import("../../src/sdk-state-preservation");
				const id = ctx.id.toString();
				if (mode === "fts")
					ctx.storage.sql.exec(
						"CREATE VIRTUAL TABLE cf_agents_session_fts USING fts5(text)",
					);
				if (mode === "case-view")
					ctx.storage.sql.exec("CREATE VIEW CF_AGENTS_JOBS AS SELECT 1 AS id");
				if (mode === "date") ctx.storage.kv.put("future", new Date());
				if (mode === "binary")
					ctx.storage.kv.put("future", new Uint8Array(800000));
				const engine = new SdkStatePreservation(
					ctx.storage,
					{
						kind: "sdk-work-preservation-capture-v1",
						operationId: "original",
						rootId: id,
						objectId: id,
						tediId: crypto.randomUUID(),
						orgId: crypto.randomUUID(),
						objectName: "original",
						physicalName: "original",
						className: "AgentTediDO",
						targetPath: [],
						generation: 1,
					},
					() => {},
					async () => {},
				);
				await expect(
					consumeSdk(() =>
						engine.inspect(Buffer.alloc(32, 7).toString("base64")),
					),
				).rejects.toThrow("verification rejected");
				expect([
					...ctx.storage.sql.exec(
						"SELECT name FROM sqlite_master WHERE name LIKE 'sdk_work_preservation_%'",
					),
				]).toEqual([]);
			},
		);
});

async function consumeSdk<T>(
	prepare: () => {
		result: Promise<T>;
		assertContinuity: () => void;
		assertReady: () => void;
	},
) {
	const operation = prepare();
	let value;
	try {
		value = await operation.result;
	} finally {
		operation.assertContinuity();
	}
	operation.assertReady();
	return value;
}

it("qualifier forwarding retains parent registry after successful and rejected gate yields", async () => {
	const local = env as unknown as Cloudflare.Env,
		namespace = ns().PI_CUTOVER_EARLY,
		name = "qualification-parent-" + crypto.randomUUID(),
		tediId = crypto.randomUUID(),
		orgId = crypto.randomUUID();
	await local.DB.exec(
		"CREATE TABLE IF NOT EXISTS tedis(id TEXT PRIMARY KEY,organization_id TEXT,slug TEXT,isolate_agent_id TEXT,runtime_kind TEXT,status TEXT)",
	);
	await local.DB.prepare("INSERT INTO tedis VALUES(?,?,?,?,?,?)")
		.bind(tediId, orgId, name, name, "agent", "active")
		.run();
	await runInDurableObject(
		namespace.get(namespace.idFromName(name)),
		async (_instance, ctx) => {
			const { operateStoredCutover, inspectCutoverParent } =
					await import("../../src/pi-cutover-admin"),
				{ RuntimeAdmissionDO } = await import("../../src/runtime-admission-do");
			const id = ctx.id.toString(),
				key = Buffer.alloc(32, 7).toString("base64");
			ctx.storage.kv.put("__ps_name", name);
			ctx.storage.sql.exec(
				"CREATE TABLE cf_agents_state(id TEXT PRIMARY KEY,state TEXT)",
			);
			ctx.storage.sql.exec(
				"INSERT INTO cf_agents_state VALUES('cf_state_row_id',?)",
				JSON.stringify({ tediId, orgId }),
			);
			ctx.storage.sql.exec(
				"CREATE TABLE cf_agents_sub_agents(class TEXT,name TEXT)",
			);
			ctx.storage.sql.exec(
				"INSERT INTO cf_agents_sub_agents VALUES('ConversationFacet','original')",
			);
			new RuntimeAdmissionDO(ctx.storage, {
				objectId: id,
				tediId,
				orgId,
			}).gate.initialize({
				operationId: "hold",
				state: "quarantined",
				reason: "fixture",
			});
			const inventory = await inspectCutoverParent(
				ctx.storage,
				id,
				{ offset: 0, limit: 200 },
				namespace,
			);
			const hop = inventory.inspectionTargets[0]!;
			const runtimeEnv = {
				...local,
				TEDI_AGENT: namespace,
				PI_CUTOVER_KNOWN_PARENT_IDS: JSON.stringify([id]),
				SECRETS_MASTER_KEY: key,
			} as unknown as Cloudflare.Env;
			for (const rejected of [false, true]) {
				let changed = false,
					recaptured = false,
					dispatches = 0;
				const sql = ctx.storage.sql,
					exec = sql.exec,
					ownExec = Object.getOwnPropertyDescriptor(sql, "exec");
				Object.defineProperty(sql, "exec", {
					configurable: true,
					value: (query: string, ...args: SqlStorageValue[]) => {
						if (
							changed &&
							/^SELECT/i.test(query) &&
							query.includes("cf_agents_sub_agents")
						)
							recaptured = true;
						return Reflect.apply(exec, sql, [query, ...args]);
					},
				});
				const operationId = "parent-publish-" + String(rejected),
					archiveId = crypto.randomUUID();
				// Child is a typed stub: this characterizes genuine parent storage/custody, not native cross-object startup or an archive capture.
				const child = {
					async operateRegisteredStoredCutover() {
						dispatches++;
						if (rejected) throw new Error("original child refusal");
						return {
							status: 200,
							body: JSON.stringify({
								ok: true,
								id,
								targetObjectId: hop.objectId,
								operationId,
								generation: 1,
								state: "quarantined",
								receiver: "raw-cutover-v1",
								command: "inspect_session_rehydration",
								archive: null,
								qualification: null,
							}),
						};
					},
					[Symbol.dispose]() {},
				};
				const wrapped = new Proxy(ctx, {
					get(target, k) {
						if (k === "facets") return { get: () => child };
						if (k === "blockConcurrencyWhile")
							return (callback: () => Promise<Response>) =>
								target.blockConcurrencyWhile(callback).then((value) => {
									queueMicrotask(() => {
										changed = true;
										sql.exec(
											"UPDATE cf_agents_sub_agents SET name='changed' WHERE name='original'",
										);
									});
									return value;
								});
						const value = Reflect.get(target, k);
						return typeof value === "function" ? value.bind(target) : value;
					},
				});
				try {
					const response = await operateStoredCutover({
						ctx: wrapped,
						env: runtimeEnv,
						receiver: "raw-cutover-v1",
						request: new Request(CUTOVER_URL, {
							method: "POST",
							headers: { "X-Tedix-Admin-Token": key },
							body: JSON.stringify({
								command: "inspect_session_rehydration",
								objectId: id,
								operationId,
								expectedGeneration: 1,
								custody: { tediId, orgId, objectName: name },
								targetPath: [hop],
								archiveId,
							}),
						}),
					});
					expect(response.status).toBe(409);
					expect(dispatches).toBe(1);
					expect(changed).toBe(true);
					expect(recaptured).toBe(true);
				} finally {
					if (ownExec) Object.defineProperty(sql, "exec", ownExec);
					else Reflect.deleteProperty(sql, "exec");
					sql.exec("UPDATE cf_agents_sub_agents SET name='original'");
				}
			}
		},
	);
});

it("bounded descriptors preserve both prior archives during authentic Raw SDK inspection", async ({
	task,
}) => {
	const local = env as unknown as Cloudflare.Env,
		namespace = ns().PI_CUTOVER_EARLY;
	const name = "descriptor-priors-" + crypto.randomUUID(),
		tediId = crypto.randomUUID(),
		orgId = crypto.randomUUID();
	await local.DB.exec(
		"CREATE TABLE IF NOT EXISTS tedis(id TEXT PRIMARY KEY,organization_id TEXT,slug TEXT,isolate_agent_id TEXT,runtime_kind TEXT,status TEXT)",
	);
	await local.DB.prepare("INSERT INTO tedis VALUES(?,?,?,?,?,?)")
		.bind(tediId, orgId, name, name, "agent", "active")
		.run();
	const diagnostics = await runInDurableObject(
		namespace.get(namespace.idFromName(name)),
		async (_instance, ctx) => {
			const { NativeStatePreservation } =
				await import("../../src/native-state-preservation");
			const { SessionStatePreservation } =
				await import("../../src/session-state-preservation");
			const { RuntimeAdmissionDO } =
				await import("../../src/runtime-admission-do");
			const { operateStoredCutover } =
				await import("../../src/pi-cutover-admin");
			const id = ctx.id.toString(),
				key = Buffer.alloc(32, 7).toString("base64");
			ctx.storage.kv.put("__ps_name", name);
			ctx.storage.sql.exec(
				"CREATE TABLE cf_agents_state(id TEXT PRIMARY KEY,state TEXT)",
			);
			ctx.storage.sql.exec(
				"INSERT INTO cf_agents_state VALUES('cf_state_row_id',?)",
				JSON.stringify({ tediId, orgId }),
			);
			new RuntimeAdmissionDO(ctx.storage, {
				objectId: id,
				tediId,
				orgId,
			}).gate.initialize({
				operationId: "original-hold",
				state: "quarantined",
				reason: "fixture",
			});
			// Literal current SDK job schema; no callback, job runner or SDK initialization is invoked.
			ctx.storage.sql.exec(
				"CREATE TABLE cf_agents_jobs(id TEXT PRIMARY KEY NOT NULL,capability TEXT NOT NULL,fn TEXT NOT NULL,time INTEGER NOT NULL,payload TEXT,retry_options TEXT,singleflight INTEGER NOT NULL DEFAULT 0,hung_timeout_seconds INTEGER,exclusive INTEGER NOT NULL DEFAULT 0,recovery_loop INTEGER NOT NULL DEFAULT 0,running INTEGER NOT NULL DEFAULT 0,execution_started_at INTEGER,created_at INTEGER NOT NULL DEFAULT (unixepoch())) WITHOUT ROWID",
			);
			ctx.storage.sql.exec(
				"CREATE TABLE session_entries(id TEXT PRIMARY KEY,content TEXT)",
			);
			for (let i = 0; i < 256; i++) {
				ctx.storage.sql.exec(
					"INSERT INTO cf_agents_jobs(id,capability,fn,time,payload,retry_options,running) VALUES(?,?,?,?,?,?,?)",
					`job-${String(i).padStart(4, "0")}`,
					"retained",
					"never-dispatch",
					i,
					JSON.stringify({ original: i, private: "x".repeat(128) }),
					JSON.stringify({ maxAttempts: 3 }),
					i % 2,
				);
				ctx.storage.sql.exec(
					"INSERT INTO session_entries VALUES(?,?)",
					`turn-${i}`,
					`PRIVATE_ORIGINAL_${i}`,
				);
			}
			for (let i = 0; i < 32; i++)
				ctx.storage.kv.put(`original-${i}`, {
					value: i,
					bytes: new Uint8Array([0, 255, i]),
				});
			const identity = {
				rootId: id,
				objectId: id,
				tediId,
				orgId,
				objectName: name,
				physicalName: name,
				className: "AgentTediDO",
				targetPath: [],
				generation: 1,
			};
			const native = new NativeStatePreservation(
				ctx.storage,
				{
					...identity,
					kind: "native-preservation-capture-v1",
					operationId: "native-original",
				},
				() => {},
				async () => {},
			);
			const np = await native.inspect(key);
			await native.capture(key, np.archiveId, np.proof);
			const session = new SessionStatePreservation(
				ctx.storage,
				{
					...identity,
					kind: "session-preservation-capture-v1",
					operationId: "session-original",
				},
				() => {},
				async () => {},
			);
			const sp = await session.inspect(key);
			await session.capture(key, sp.archiveId, sp.proof);
			const priorBytes = () =>
				JSON.stringify(
					[
						"native_preservation_snapshot",
						"native_preservation_parts",
						"session_preservation_snapshot",
						"session_preservation_parts",
					].map((t) => [
						t,
						[...ctx.storage.sql.exec(`SELECT * FROM ${t}`)].map((r) =>
							Object.fromEntries(
								Object.entries(r).map(([k, v]) => [
									k,
									v instanceof ArrayBuffer ? [...new Uint8Array(v)] : v,
								]),
							),
						),
					]),
				);
			const before = priorBytes(),
				kvBefore = [...ctx.storage.kv.list()];
			const runtimeEnv = {
				...local,
				TEDI_AGENT: namespace,
				PI_CUTOVER_KNOWN_PARENT_IDS: JSON.stringify([id]),
				SECRETS_MASTER_KEY: key,
			} as unknown as Cloudflare.Env;
			const request = () =>
				new Request(CUTOVER_URL, {
					method: "POST",
					headers: { "X-Tedix-Admin-Token": key },
					body: JSON.stringify({
						command: "inspect_sdk_preservation",
						objectId: id,
						operationId: "sdk-original",
						expectedGeneration: 1,
						custody: { tediId, orgId, objectName: name },
					}),
				});
			const started = performance.now();
			const response = await operateStoredCutover({
				ctx,
				env: runtimeEnv,
				receiver: "raw-cutover-v1",
				request: request(),
			});
			const inspectMs = performance.now() - started;
			expect(response?.status).toBe(200);
			const result = (await response!.json()) as {
				archive: {
					metadata: {
						sourceBytes: number;
						recordCount: number;
						kvEntries: number;
						tables: { table: string; rows: number }[];
					};
					priorArchives: { native: string; session: string };
				};
			};
			expect(result.archive.priorArchives).toEqual({
				historical: "absent",
				native: "present",
				session: "present",
			});
			expect(
				result.archive.metadata.tables.find(
					(t) => t.table === "cf_agents_jobs",
				)!.rows,
			).toBe(256);
			expect(result.archive.metadata.kvEntries).toBe(kvBefore.length);
			expect(priorBytes()).toBe(before);
			expect([...ctx.storage.kv.list()]).toEqual(kvBefore);
			expect([
				...ctx.storage.sql.exec(
					"SELECT name FROM sqlite_master WHERE name LIKE 'sdk_work_preservation_%'",
				),
			]).toEqual([]);
			const ownEncrypt = Object.getOwnPropertyDescriptor(
					crypto.subtle,
					"encrypt",
				),
				encrypt = crypto.subtle.encrypt;
			let changed = false;
			Object.defineProperty(crypto.subtle, "encrypt", {
				configurable: true,
				value: async (...args: Parameters<typeof encrypt>) => {
					const result = await Reflect.apply(encrypt, crypto.subtle, args);
					queueMicrotask(() => {
						changed = true;
						ctx.storage.sql.exec(
							"UPDATE cf_agents_jobs SET payload='CHANGED' WHERE id='job-0000'",
						);
					});
					return result;
				},
			});
			try {
				expect(
					(
						await operateStoredCutover({
							ctx,
							env: runtimeEnv,
							receiver: "raw-cutover-v1",
							request: request(),
						})
					)?.status,
				).toBe(409);
				expect(changed).toBe(true);
				expect(priorBytes()).toBe(before);
			} finally {
				if (ownEncrypt)
					Object.defineProperty(crypto.subtle, "encrypt", ownEncrypt);
				else Reflect.deleteProperty(crypto.subtle, "encrypt");
			}
			return {
				inspectMs,
				jobRows: 256,
				parentRows: 256,
				sourceBytes: result.archive.metadata.sourceBytes,
				framingRecords: result.archive.metadata.recordCount,
				kvEntries: result.archive.metadata.kvEntries,
				priorNativePresent: true,
				priorSessionPresent: true,
			};
		},
	);
	// Local timing only; this sets no performance ceiling.
	Object.assign(task.meta, { boundedDescriptorDiagnostics: diagnostics });
	console.info(
		"bounded-descriptor-prior-archive-inspection",
		JSON.stringify(diagnostics),
	);
}, 60_000);

it("custody coverage Raw root inventories metadata without KV values and refuses final-yield mutation", async () => {
	const local = env as unknown as Cloudflare.Env,
		namespace = ns().PI_CUTOVER_EARLY,
		name = "coverage-" + crypto.randomUUID(),
		tediId = crypto.randomUUID(),
		orgId = crypto.randomUUID();
	await local.DB.exec(
		"CREATE TABLE IF NOT EXISTS tedis(id TEXT PRIMARY KEY,organization_id TEXT,slug TEXT,isolate_agent_id TEXT,runtime_kind TEXT,status TEXT)",
	);
	await local.DB.prepare("INSERT INTO tedis VALUES(?,?,?,?,?,?)")
		.bind(tediId, orgId, name, name, "agent", "active")
		.run();
	await runInDurableObject(
		namespace.get(namespace.idFromName(name)),
		async (_instance, ctx) => {
			const { operateStoredCutover } =
					await import("../../src/pi-cutover-admin"),
				{ RuntimeAdmissionDO } = await import("../../src/runtime-admission-do"),
				{ TediRuntimeCustodyCoverageResponseSchema } =
					await import("@tedix/api-contract/schemas/tedi");
			const key = Buffer.alloc(32, 7).toString("base64"),
				id = ctx.id.toString();
			ctx.storage.kv.put("__ps_name", name);
			new RuntimeAdmissionDO(ctx.storage, {
				objectId: id,
				tediId,
				orgId,
			}).gate.initialize({
				operationId: "hold",
				state: "quarantined",
				reason: "fixture",
			});
			ctx.storage.sql.exec(
				"CREATE TABLE session_entries(id TEXT PRIMARY KEY,content TEXT)",
			);
			ctx.storage.sql.exec(
				"INSERT INTO session_entries VALUES('one','PRIVATE_CONTENT')",
			);
			ctx.storage.sql.exec(
				"CREATE TABLE cf_agents_sub_agents(class TEXT,name TEXT,identity_version TEXT,identity_name TEXT)",
			);
			ctx.storage.sql.exec(
				"INSERT INTO cf_agents_sub_agents VALUES(?,?,?,?)",
				"ConversationFacet",
				"registered",
				"path-v2",
				"fictional-child",
			);
			for (let i = 0; i < 202; i++)
				ctx.storage.sql.exec(
					`CREATE VIEW coverage_view_${i} AS SELECT 1 AS number`,
				);
			const runtimeEnv = {
				...local,
				TEDI_AGENT: namespace,
				PI_CUTOVER_KNOWN_PARENT_IDS: JSON.stringify([id]),
				SECRETS_MASTER_KEY: key,
			} as unknown as Cloudflare.Env;
			const invoke = (extra: Record<string, unknown> = {}) =>
				operateStoredCutover({
					ctx,
					env: runtimeEnv,
					receiver: "raw-cutover-v1",
					request: new Request(CUTOVER_URL, {
						method: "POST",
						headers: { "X-Tedix-Admin-Token": key },
						body: JSON.stringify({
							command: "inspect_custody_coverage",
							objectId: id,
							operationId: "coverage",
							expectedGeneration: 1,
							custody: { tediId, orgId, objectName: name },
							...extra,
						}),
					}),
				});
			const before = ctx.storage.sql
					.exec("SELECT name,sql FROM sqlite_master ORDER BY name")
					.toArray(),
				oldList = ctx.storage.kv.list;
			let lists = 0;
			ctx.storage.kv.list = (() => {
				lists++;
				throw Error("Unexpected KV list");
			}) as typeof oldList;
			try {
				const { prepareCustodyCoverage } =
					await import("../../src/custody-coverage-inventory");
				await prepareCustodyCoverage({
					storage: ctx.storage,
					namespace,
					masterKey: key,
					deadline: performance.now() + 30000,
					recheck: () => {},
					verifyCanonical: async () => {},
					identity: {
						rootPhysicalId: id,
						targetPhysicalId: id,
						organizationId: orgId,
						tediId,
						operationId: "direct",
						namespaceClass: "AgentTediDO",
						targetName: name,
						targetPath: [],
						generation: 1,
						receiver: "raw-cutover-v1",
					},
				}).result;
				const first = await invoke();
				expect(first.status).toBe(200);
				const page = TediRuntimeCustodyCoverageResponseSchema.parse(
					await first.json(),
				);
				expect(page.items).toHaveLength(200);
				expect(page.continuation).not.toBeNull();
				expect(page.kv.complete).toBe(false);
				expect(page.wholePreservationReady).toBe(false);
				expect(
					page.items.some(
						(x) =>
							x.domain === "sql" &&
							x.name === "_cf_KV" &&
							x.shape === "provider_private" &&
							x.classification === "unsupported" &&
							x.columnsHash === null,
					),
				).toBe(true);
				expect(JSON.stringify(page)).not.toContain("PRIVATE_CONTENT");
				const next = await invoke({
					coverageHash: page.coverageHash,
					continuation: page.continuation,
				});
				expect(next.status).toBe(200);
				const last = TediRuntimeCustodyCoverageResponseSchema.parse(
					await next.json(),
				);
				expect(last.offset).toBe(200);
				expect(last.expiresAt).toBe(page.expiresAt);
				expect(last.metadataEnumerationComplete).toBe(true);
				expect(
					last.items.some(
						(x) => x.domain === "registry" && x.localOwner === "UNKNOWN",
					),
				).toBe(true);
				expect(
					ctx.storage.sql
						.exec("SELECT name,sql FROM sqlite_master ORDER BY name")
						.toArray(),
				).toEqual(before);
				expect(lists).toBe(0);
				const originalParse = TediRuntimeCustodyCoverageResponseSchema.parse;
				let changed = false,
					readsAfterMutation = 0;
				const exec = ctx.storage.sql.exec;
				ctx.storage.sql.exec = ((sql: string, ...args: SqlStorageValue[]) => {
					if (changed && sql.includes("sqlite_master")) readsAfterMutation++;
					return exec.call(ctx.storage.sql, sql, ...args);
				}) as typeof exec;
				TediRuntimeCustodyCoverageResponseSchema.parse = ((
					...args: Parameters<typeof originalParse>
				) => {
					const result = originalParse(...args);
					queueMicrotask(() => {
						if (!changed) {
							changed = true;
							exec.call(ctx.storage.sql, "DROP VIEW coverage_view_0");
						}
					});
					return result;
				}) as typeof originalParse;
				try {
					expect((await invoke()).status).toBe(409);
					expect(readsAfterMutation).toBeGreaterThan(0);
				} finally {
					TediRuntimeCustodyCoverageResponseSchema.parse = originalParse;
					ctx.storage.sql.exec = exec;
				}

				// The rejection must also recapture after its queued publisher yield.
				let rejectedMutation = false,
					rejectedReads = 0;
				const rejectExec = ctx.storage.sql.exec;
				ctx.storage.sql.exec = ((sql: string, ...args: SqlStorageValue[]) => {
					if (rejectedMutation && sql.includes("sqlite_master"))
						rejectedReads++;
					return rejectExec.call(ctx.storage.sql, sql, ...args);
				}) as typeof rejectExec;
				TediRuntimeCustodyCoverageResponseSchema.parse = ((
					...args: Parameters<typeof originalParse>
				) => {
					originalParse(...args);
					queueMicrotask(() => {
						rejectedMutation = true;
						rejectExec.call(
							ctx.storage.sql,
							"CREATE VIEW rejected_publisher AS SELECT 2 AS number",
						);
					});
					throw Error("PRIVATE_REJECTION");
				}) as typeof originalParse;
				try {
					expect((await invoke()).status).toBe(409);
					expect(rejectedReads).toBeGreaterThan(0);
				} finally {
					TediRuntimeCustodyCoverageResponseSchema.parse = originalParse;
					ctx.storage.sql.exec = rejectExec;
				}
			} finally {
				ctx.storage.kv.list = oldList;
			}
			expect((await invoke({ expectedGeneration: 2 })).status).toBe(409);
		},
	);
}, 60_000);

it("custody coverage registered Raw leaf validates native name and exact path without adoption", async () => {
	const local = env as unknown as Cloudflare.Env,
		namespace = ns().PI_CUTOVER_EARLY,
		rootName = "coverage-root-" + crypto.randomUUID(),
		leafName = "coverage-leaf-" + crypto.randomUUID(),
		tediId = crypto.randomUUID(),
		orgId = crypto.randomUUID(),
		rootId = namespace.idFromName(rootName).toString();
	await local.DB.exec(
		"CREATE TABLE IF NOT EXISTS tedis(id TEXT PRIMARY KEY,organization_id TEXT,slug TEXT,isolate_agent_id TEXT,runtime_kind TEXT,status TEXT)",
	);
	await local.DB.prepare("INSERT INTO tedis VALUES(?,?,?,?,?,?)")
		.bind(tediId, orgId, rootName, rootName, "agent", "active")
		.run();
	await runInDurableObject(
		namespace.get(namespace.idFromName(leafName)),
		async (_instance, ctx) => {
			const { passiveRegisteredCutover } =
					await import("../../src/pi-cutover-admin"),
				{ RuntimeAdmissionDO } = await import("../../src/runtime-admission-do");
			const key = Buffer.alloc(32, 7).toString("base64"),
				id = ctx.id.toString(),
				parentPath = [{ className: "AgentTediDO", name: rootName }];
			ctx.storage.kv.put("__ps_name", leafName);
			ctx.storage.kv.put("cf_agents_is_facet", true);
			ctx.storage.kv.put("cf_agents_facet_name", "registered");
			ctx.storage.kv.put("cf_agents_parent_path", parentPath);
			new RuntimeAdmissionDO(ctx.storage, {
				objectId: id,
				tediId: null,
				orgId: null,
			}).gate.initialize({
				operationId: "hold",
				state: "quarantined",
				reason: "fixture",
			});
			ctx.storage.sql.exec(
				"CREATE TABLE session_entries(id TEXT PRIMARY KEY,content TEXT)",
			);
			ctx.storage.sql.exec(
				"INSERT INTO session_entries VALUES('one','PRIVATE_LEAF')",
			);
			const path = [
				{
					className: "ConversationFacet",
					name: "registered",
					identityVersion: "path-v2",
					identityName: leafName,
					objectId: id,
					registryHash: "a".repeat(64),
					parentGeneration: 1,
				},
			];
			// Real native receiver/storage/ID; the parent envelope is synthetic, not a cross-object attestation.
			const custody = {
				rootId,
				tediId,
				orgId,
				objectName: rootName,
				parentPath,
				current: {
					className: "ConversationFacet",
					name: "registered",
					identityName: leafName,
					objectId: id,
				},
			};
			const runtimeEnv = {
				...local,
				TEDI_AGENT: namespace,
				PI_CUTOVER_KNOWN_PARENT_IDS: JSON.stringify([rootId]),
				SECRETS_MASTER_KEY: key,
			} as unknown as Cloudflare.Env;
			const invoke = () =>
				passiveRegisteredCutover(ctx, runtimeEnv, {
					token: key,
					index: 1,
					custody: JSON.stringify(custody),
					body: JSON.stringify({
						command: "inspect_custody_coverage",
						objectId: rootId,
						operationId: "coverage-leaf",
						expectedGeneration: 1,
						custody: { tediId, orgId, objectName: rootName },
						targetPath: path,
					}),
				});
			const r = await invoke();
			expect(r.status).toBe(200);
			const value = JSON.parse(r.body);
			expect(value.targetObjectId).toBe(id);
			expect(value.adoptionReady).toBe(false);
			expect(value.kv.enumeration).toBe("not_queried");
			expect(r.body).not.toContain("PRIVATE_LEAF");

			const { TediRuntimeCustodyCoverageResponseSchema } =
				await import("@tedix/api-contract/schemas/tedi");
			const parse = TediRuntimeCustodyCoverageResponseSchema.parse,
				get = ctx.storage.kv.get;
			let changed = false,
				parentReads = 0;
			ctx.storage.kv.get = ((key: string) => {
				if (changed && key === "cf_agents_parent_path") parentReads++;
				return get.call(ctx.storage.kv, key);
			}) as typeof get;
			TediRuntimeCustodyCoverageResponseSchema.parse = ((
				...args: Parameters<typeof parse>
			) => {
				parse(...args);
				queueMicrotask(() => {
					changed = true;
					ctx.storage.kv.put("cf_agents_parent_path", [
						{ className: "AgentTediDO", name: "queued-contradiction" },
					]);
				});
				throw Error("PRIVATE_LEAF_REJECTION");
			}) as typeof parse;
			try {
				expect((await invoke()).status).toBe(409);
				expect(parentReads).toBeGreaterThan(0);
			} finally {
				TediRuntimeCustodyCoverageResponseSchema.parse = parse;
				ctx.storage.kv.get = get;
				ctx.storage.kv.put("cf_agents_parent_path", parentPath);
			}
			ctx.storage.kv.put("cf_agents_parent_path", [
				{ className: "AgentTediDO", name: "contradiction" },
			]);
			expect((await invoke()).status).toBe(409);
			expect(
				ctx.storage.sql.exec("SELECT content FROM session_entries").one()
					.content,
			).toBe("PRIVATE_LEAF");
		},
	);
});
