import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import type { ProductionRootEntryProbe } from "./worker";
const probe = (named = false) => {
	const ns = (
		env as unknown as {
			PRODUCTION_ROOT_ENTRY: DurableObjectNamespace<ProductionRootEntryProbe>;
		}
	).PRODUCTION_ROOT_ENTRY;
	const id = ns.idFromName("original-" + crypto.randomUUID());
	return ns.get(named ? id : ns.idFromString(id.toString()));
};
it("actual selected constructor preserves original seeded unnamed storage across passive GET", async () => {
	const r = await probe().construct({ selected: true, request: {} });
	expect(r.nativeName).toBeNull();
	expect(r.raw).toBe(true);
	expect(r.agent).toBe(false);
	expect(r.afterConstructor).toBe(r.before);
	expect(r.after).toBe(r.before);
	expect(r.providerReads).toBe(0);
	expect(r.fetchError).toBeNull();
	expect(r.status).toBe(200);
	expect(r.result).toMatchObject({
		version: "pi-cutover-inspection-v2",
		id: r.id,
		receiver: "raw-cutover-v1",
		admission: null,
		qualification: { nativeSchemaState: "absent" },
		inventory: { storedOwner: { unknown: true, tediId: null } },
	});
	expect(JSON.stringify(r.result)).not.toContain("PRIVATE");
});
it("actual unnamed unselected constructor reaches pinned SDK name refusal", async () => {
	const r = await probe().construct({ selected: false, request: {} });
	expect(r.nativeName).toBeNull();
	expect(r.raw).toBe(false);
	expect(r.agent).toBe(true);
	expect(r.nameError).toContain("could not determine its Durable Object name");
	expect(r.status).toBe(500);
});
it("unrelated named unselected production constructor remains an Agent", async () => {
	const r = await probe(true).construct({ selected: false });
	expect(r.nativeName).toMatch(/^original-/);
	expect(r.raw).toBe(false);
	expect(r.agent).toBe(true);
});
it("actual legacy pending-run fence refuses before Agent startup with original state unchanged", async () => {
	const r = await probe().construct({ selected: false, legacyPending: true });
	expect(r.constructorError).toContain(
		"requires reconciliation before Pi activation",
	);
	expect(r.after).toBe(r.before);
	expect(r.providerReads).toBe(0);
});
it.each([
	{ token: "wrong", status: 403 },
	{ query: { expectedGeneration: "1" }, status: 409 },
	{ query: { expectedHash: "a".repeat(64) }, status: 409 },
	{
		query: {
			targetPath: JSON.stringify([
				{
					className: "ConversationFacet",
					name: "wrong",
					identityVersion: null,
					identityName: null,
					objectId: "a".repeat(64),
					registryHash: "b".repeat(64),
					parentGeneration: 0,
				},
			]),
		},
		status: 409,
	},
])(
	"selected actual constructor keeps rejected read passive %#",
	async ({ status, ...request }) => {
		const r = await probe().construct({ selected: true, request });
		expect(r.raw).toBe(true);
		expect(r.status).toBe(status);
		expect(r.after).toBe(r.before);
		expect(r.providerReads).toBe(0);
	},
);
it.each(["private", "name"] as const)(
	"selected constructor refuses original %s mutation across await",
	async (mutation) => {
		const r = await probe().construct({
			selected: true,
			request: {},
			mutation,
		});
		expect(r.digestMutations).toBeGreaterThan(0);
		expect(r.status).toBe(409);
		expect(r.result).toEqual({
			ok: false,
			rejection: "inspection_metadata_changed",
		});
		expect(r.afterConstructor).toBe(r.before);
		expect(r.providerReads).toBe(0);
	},
);

it("existing positive quarantined admission returns Raw before super even when selector excludes it", async () => {
	const r = await probe().construct({
		selected: false,
		admissionState: "quarantined",
		request: {},
	});
	expect(r.raw).toBe(true);
	expect(r.agent).toBe(false);
	expect(r.afterConstructor).toBe(r.before);
	expect(r.after).toBe(r.before);
	expect(r.providerReads).toBe(0);
	expect(r.status).toBe(200);
});
it("existing positive active admission preserves unselected named Agent construction", async () => {
	const r = await probe(true).construct({
		selected: false,
		admissionState: "active",
	});
	expect(r.raw).toBe(false);
	expect(r.agent).toBe(true);
	expect(r.nameError).toBeNull();
});

it.each(["valid", "physical", "canonical", "owner"] as const)(
	"actual selected named constructor verifies original %s custody",
	async (custody) => {
		const r = await probe(true).construct({
			selected: true,
			custody,
			request: {},
		});
		expect(r.raw).toBe(true);
		expect(r.status).toBe(custody === "valid" ? 200 : 409);
		expect(r.afterConstructor).toBe(r.before);
		expect(r.after).toBe(r.before);
		expect(r.providerReads).toBe(0);
		expect(JSON.stringify(r.result)).not.toContain("PRIVATE");
	},
);

it("wrong original command object ID is refused without storage changes", async () => {
	const r = await probe(true).construct({
		selected: true,
		custody: "valid",
		request: {},
		postWrongPhysical: true,
	});
	expect(r.raw).toBe(true);
	expect(r.status).toBe(404);
	expect(r.result).toBe("Unknown stored object");
	expect(r.afterConstructor).toBe(r.before);
	expect(r.after).toBe(r.before);
	expect(r.providerReads).toBe(0);
});
it("existing incomplete historical custody keeps original unnamed root on Raw before super", async () => {
	const r = await probe().construct({
		selected: false,
		historicalPartial: true,
		request: {},
	});
	expect(r.raw).toBe(true);
	expect(r.agent).toBe(false);
	expect(r.status).toBe(200);
	expect(r.afterConstructor).toBe(r.before);
	expect(r.after).toBe(r.before);
	expect(r.providerReads).toBe(0);
});

type PristineResult = {
	id: string;
	namespaceId: string;
	nativeName: string;
	owner: { id: string; orgId: string };
	empty: string;
	before: string;
	afterConstructor: string;
	afterStart: string;
	persistedBeforeRestart: string;
	restarted: { agent: boolean; afterConstructor: string } | null;
	trace: Array<{ event: string; facts: string }>;
	providerReads: number;
	queryCount: number;
	firstRow: Record<string, unknown> | null;
	resolvedIdentity: unknown;
	directIdentity: unknown;
	helperBefore: string;
	helperAfter: string;
	canonicalAfter: unknown;
	mutated: boolean;
	startupError: string | null;
	wrappedStartupRejected: boolean;
	wrappedStartupErrorType: string | null;
	exactD1Error: boolean;
	exactBarrierError: boolean;
	originalQueryErrorRetained: boolean;
	admission: unknown;
	agent: boolean;
};
const qualify = async (
	input: Parameters<ProductionRootEntryProbe["qualifyPristine"]>[0],
): Promise<PristineResult> =>
	JSON.parse(await probe(true).qualifyPristine(input));
const facts = (snapshot: string) =>
	JSON.parse(snapshot) as {
		schema: Array<{ name: string; type: string }>;
		tables: Array<{ name: string; rows: unknown[] }>;
		kv: Array<[string, unknown]>;
		alarm: number | null;
		admission: unknown;
	};
const expectEmptyOriginal = (r: {
	empty: string;
	id: string;
	namespaceId: string;
	nativeName: string;
}) => {
	const empty = facts(r.empty);
	expect(empty.schema.filter((row) => !row.name.startsWith("_cf_"))).toEqual(
		[],
	);
	expect(empty.tables).toEqual([]);
	expect(empty.kv).toEqual([]);
	expect(empty.alarm).toBeNull();
	expect(empty.admission).toBeNull();
	expect(r.nativeName).toMatch(/^original-/);
	expect(r.namespaceId).toBe(r.id);
};
const expectRealStartup = (r: {
	trace: Array<{ event: string; facts: string }>;
}) => {
	const events = r.trace.map((row) => row.event);
	for (const check of ["sdk:workflows", "sdk:fibers"]) {
		expect(events.indexOf(`${check}:enter`)).toBeGreaterThanOrEqual(0);
		expect(events.indexOf(`${check}:exit`)).toBeGreaterThan(
			events.indexOf(`${check}:enter`),
		);
		expect(events.indexOf(`${check}:exit`)).toBeLessThan(
			events.indexOf("user:start:enter"),
		);
	}
	expect(events.indexOf("user:start:enter")).toBeLessThan(
		events.indexOf("d1:first:enter"),
	);
};
it("genuinely empty named actual production parent performs real pre-user startup checks without manufacturing admission", async () => {
	const r = await qualify({ identity: "missing" });
	expectEmptyOriginal(r);
	expect(r.before).toBe(r.empty);
	expect(r.agent).toBe(true);
	expectRealStartup(r);
	expect(r.startupError).toContain("Unable to resolve isolate tedi identity");
	expect(r.providerReads).toBe(0);
	expect(r.queryCount).toBe(1);
	expect(r.firstRow).toBeNull();
	expect(
		facts(r.afterStart).schema.some((row) => row.name === "cf_agents_state"),
	).toBe(true);
	expect(r.afterStart).not.toBe(r.empty);
	expect(r.admission).toBeNull();
});
it("actual D1 failure preserves the original exception and SDK-created state on same-object persisted restart", async () => {
	const r = await qualify({
		failure: "d1",
		restart: true,
	});
	expectEmptyOriginal(r);
	expectRealStartup(r);
	expect(r.startupError).toBe("qualification-owned-D1-failure");
	expect(r.exactD1Error).toBe(true);
	expect(r.originalQueryErrorRetained).toBe(true);
	expect(r.wrappedStartupRejected).toBe(true);
	expect(r.wrappedStartupErrorType).toBe("undefined");
	expect(r.afterStart).not.toBe(r.empty);
	expect(r.restarted?.agent).toBe(true);
	expect(r.restarted?.afterConstructor).toBe(r.persistedBeforeRestart);
	expect(r.admission).toBeNull();
	expect(r.providerReads).toBe(0);
});
it.each(["canonical", "alias", "wrong-runtime", "wrong-org"] as const)(
	"real local D1 %s result is validated by the cold production identity caller",
	async (identity) => {
		const r = await qualify({
			identity,
			failure: "after-query",
		});
		expectEmptyOriginal(r);
		expectRealStartup(r);
		expect(r.exactBarrierError).toBe(true);
		expect(r.originalQueryErrorRetained).toBe(true);
		if (identity === "alias") expect(r.firstRow).toBeNull();
		else
			expect(r.firstRow).toMatchObject({
				id: r.owner.id,
				orgId: identity === "wrong-org" ? "not-an-org-uuid" : r.owner.orgId,
				isolateAgentId: r.nativeName,
				runtimeKind: identity === "wrong-runtime" ? "removed-runtime" : "agent",
			});
		expect(r.resolvedIdentity).toEqual(
			identity === "canonical"
				? { tediId: r.owner.id, orgId: r.owner.orgId, slug: r.nativeName }
				: null,
		);
		expect(r.providerReads).toBe(0);
		expect(r.admission).toBeNull();
	},
);
it.each(["kv", "schema", "name", "alarm", "canonical"] as const)(
	"actual D1 await %s race remains observable without automatic initialization or repair",
	async (mutation) => {
		const r = await qualify({
			identity: "canonical",
			failure: "after-query",
			mutation,
			restart: true,
		});
		expectEmptyOriginal(r);
		expectRealStartup(r);
		expect(r.mutated).toBe(true);
		expect(r.exactBarrierError).toBe(true);
		expect(r.trace.map((row) => row.event)).toContain("d1:first:mutated");
		if (mutation === "canonical")
			expect(r.canonicalAfter).toMatchObject({
				isolate_agent_id: "changed-canonical",
			});
		if (mutation === "kv")
			expect(facts(r.afterStart).kv).toContainEqual([
				"await-private",
				{ token: "PRIVATE-race" },
			]);
		if (mutation === "schema")
			expect(
				facts(r.afterStart).schema.some(
					(row) => row.name === "await_private_view",
				),
			).toBe(true);
		if (mutation === "name")
			expect(facts(r.afterStart).kv).toContainEqual([
				"__ps_name",
				"changed-original-name",
			]);
		if (mutation === "alarm") expect(facts(r.afterStart).alarm).not.toBeNull();
		expect(r.restarted?.agent).toBe(true);
		expect(r.admission).toBeNull();
		expect(r.providerReads).toBe(0);
	},
);
it.each(["kv", "undefined", "table", "view", "trigger", "alarm"] as const)(
	"pre-existing %s storage is explicitly nonpristine and retained by current generation-zero startup",
	async (impurity) => {
		const r = await qualify({
			impurity,
			identity: "missing",
		});
		expectEmptyOriginal(r);
		expect(r.before).not.toBe(r.empty);
		expectRealStartup(r);
		const before = facts(r.before),
			after = facts(r.afterStart);
		for (const row of before.schema.filter(
			(row) => !row.name.startsWith("_cf_"),
		))
			expect(after.schema).toContainEqual(row);
		for (const row of before.tables) expect(after.tables).toContainEqual(row);
		for (const row of before.kv) expect(after.kv).toContainEqual(row);
		if (impurity === "alarm") expect(after.alarm).toBe(before.alarm);
		expect(r.admission).toBeNull();
		expect(r.providerReads).toBe(0);
	},
);

it.each(["canonical", "null-name", "rebound"] as const)(
	"actual named parent preserves %s canonical discovery without helper writes",
	async (identity) => {
		const r = await qualify({
			identity,
			measureBeforeStart: true,
			failure: "after-query",
		});
		expectEmptyOriginal(r);
		expect(r.agent).toBe(true);
		expect(r.directIdentity).toEqual({
			tediId: r.owner.id,
			orgId: r.owner.orgId,
			slug: identity === "rebound" ? "logical-slug" : r.nativeName,
		});
		expect(r.helperAfter).toBe(r.helperBefore);
		expect(r.admission).toBeNull();
		expect(r.providerReads).toBe(0);
	},
);
it.each([
	"alias",
	"wrong-runtime",
	"wrong-org",
	"duplicate",
	"malformed-id",
	"wrong-namespace",
	"missing",
] as const)(
	"actual named parent refuses %s canonical mapping without helper writes",
	async (identity) => {
		const r = await qualify({
			identity,
			measureBeforeStart: true,
			failure: "after-query",
		});
		expectEmptyOriginal(r);
		expect(r.directIdentity).toBeNull();
		expect(r.helperAfter).toBe(r.helperBefore);
		expect(r.admission).toBeNull();
		expect(r.providerReads).toBe(0);
	},
);
it.each([
	"name",
	"undefined-name",
	"tenant",
	"config",
	"path",
	"facet",
] as const)(
	"actual D1 await %s identity pin mutation refuses the original discovery",
	async (mutation) => {
		const r = await qualify({
			identity: "canonical",
			measureBeforeStart: true,
			failure: "after-query",
			mutation,
		});
		expectEmptyOriginal(r);
		expect(r.mutated).toBe(true);
		expect(r.directIdentity).toBeNull();
		expect(r.admission).toBeNull();
		expect(r.providerReads).toBe(0);
		if (mutation !== "config") expect(r.helperAfter).not.toBe(r.helperBefore);
	},
);
it("canonical mutation after the actual SQL snapshot remains an explicit bounded read-window limitation", async () => {
	const r = await qualify({
		identity: "canonical",
		measureBeforeStart: true,
		failure: "after-query",
		mutation: "canonical",
	});
	expect(r.directIdentity).toEqual({
		tediId: r.owner.id,
		orgId: r.owner.orgId,
		slug: r.nativeName,
	});
	expect(r.canonicalAfter).toMatchObject({
		isolate_agent_id: "changed-canonical",
	});
	expect(r.helperAfter).toBe(r.helperBefore);
	expect(r.admission).toBeNull();
	expect(r.providerReads).toBe(0);
});
