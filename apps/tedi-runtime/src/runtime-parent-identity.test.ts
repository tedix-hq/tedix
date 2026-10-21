import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import {
	captureRuntimeParentIdentity,
	resolveRuntimeParentIdentity,
} from "./runtime-parent-identity";

const identity = {
	tediId: "11111111-1111-4111-8111-111111111111",
	orgId: "22222222-2222-4222-8222-222222222222",
	slug: "test-parent",
};
type CaptureInput = Parameters<typeof captureRuntimeParentIdentity>[0];
type ResolveInput = Parameters<typeof resolveRuntimeParentIdentity>[0];

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function fixture() {
	const sqlite = new Database(":memory:");
	sqlite.run(`CREATE TABLE tedis (
		id TEXT, organization_id TEXT, slug TEXT, isolate_agent_id TEXT,
		runtime_kind TEXT, status TEXT
	)`);
	sqlite.run("INSERT INTO tedis VALUES (?, ?, ?, NULL, 'agent', 'active')", [
		identity.tediId,
		identity.orgId,
		identity.slug,
	]);
	const kv = new Map<string, unknown>();
	const physical = {
		name: identity.slug as string | undefined,
		value: "root-object",
	};
	const agent = {
		name: identity.slug,
		parentPath: [] as unknown,
		selfPath: [{ className: "AgentTediDO", name: identity.slug }] as unknown,
	};
	const local = {
		tediId: "",
		orgId: "",
		slug: "",
		identityLoaded: false,
	};
	const config = { generation: 0 };
	const ctx = {
		id: {
			get name() {
				return physical.name;
			},
			toString: () => physical.value,
		},
		storage: {
			kv: {
				list({
					start,
					end,
					limit,
				}: {
					start: string;
					end: string;
					limit: number;
				}) {
					return new Map(
						[...kv]
							.filter(([key]) => key >= start && key < end)
							.sort(([a], [b]) => a.localeCompare(b))
							.slice(0, limit),
					);
				},
			},
		},
	} as unknown as CaptureInput["ctx"];
	const capture = () =>
		captureRuntimeParentIdentity({
			ctx,
			agent,
			state: local,
			configGeneration: config.generation,
		});
	const entered = deferred();
	const release = deferred();
	let pending = false;
	let reads = 0;
	let dbError: Error | undefined;
	const db: ResolveInput["db"] = {
		prepare(query) {
			return {
				bind(...values) {
					return {
						async first<T>() {
							reads++;
							if (dbError) throw dbError;
							// Snapshot before pausing: local changes must fence an already-read row.
							const row = sqlite.query(query).all(...values)[0] ?? null;
							entered.resolve();
							if (pending) await release.promise;
							return row as T | null;
						},
					};
				},
			};
		},
	};
	const input: ResolveInput = {
		db,
		capture,
		physicalIdForName: (name) =>
			name === agent.name ? "root-object" : "other-object",
	};
	return {
		sqlite,
		kv,
		physical,
		agent,
		local,
		config,
		capture,
		input,
		entered,
		release,
		pause() {
			pending = true;
		},
		failRead(error: Error) {
			dbError = error;
		},
		get reads() {
			return reads;
		},
	};
}
type Fixture = ReturnType<typeof fixture>;

async function check(label: string, run: (f: Fixture) => Promise<void>) {
	const f = fixture();
	try {
		await run(f);
		console.log(`✓ ${label}`);
	} finally {
		(f.sqlite as Database & { close(): void }).close();
	}
}

await check(
	"cold root resolves without writing local identity or KV",
	async (f) => {
		const before = f.capture();
		assert.deepEqual(await resolveRuntimeParentIdentity(f.input), identity);
		assert.deepEqual(f.capture(), before);
		assert.equal(f.kv.size, 0);
		assert.equal(f.reads, 1);
		f.physical.name = undefined;
		assert.deepEqual(await resolveRuntimeParentIdentity(f.input), identity);
	},
);

const storedFacts = [
	["__ps_name", "storedName", identity.slug],
	["cf_agents_is_facet", "isFacet", false],
	["cf_agents_facet_name", "facetName", null],
	["cf_agents_parent_path", "storedParentPath", []],
] as const;
for (const [key, fact, rootValue] of storedFacts) {
	await check(
		`${key}: absent, present undefined, and explicit root value`,
		async (f) => {
			// Nearby keys must not be mistaken for the exact stored fact.
			f.kv.set(`${key}-neighbor`, "unrelated");
			assert.deepEqual(f.capture()[fact], { present: false, value: undefined });
			assert.deepEqual(await resolveRuntimeParentIdentity(f.input), identity);
			f.kv.set(key, undefined);
			assert.deepEqual(f.capture()[fact], { present: true, value: undefined });
			assert.equal(await resolveRuntimeParentIdentity(f.input), null);
			assert.equal(f.reads, 1, "invalid root facts must not query D1");
			f.kv.set(key, rootValue);
			assert.deepEqual(f.capture()[fact], { present: true, value: rootValue });
			assert.deepEqual(await resolveRuntimeParentIdentity(f.input), identity);
		},
	);
}

const invalidRoots: [string, (f: Fixture) => void][] = [
	[
		"empty name",
		(f) => {
			f.agent.name = "";
		},
	],
	[
		"native name mismatch",
		(f) => {
			f.physical.name = "other-parent";
		},
	],
	[
		"stored name mismatch",
		(f) => {
			f.kv.set("__ps_name", "other-parent");
		},
	],
	[
		"facet marker",
		(f) => {
			f.kv.set("cf_agents_is_facet", true);
		},
	],
	[
		"nonboolean facet marker",
		(f) => {
			f.kv.set("cf_agents_is_facet", 0);
		},
	],
	[
		"facet name",
		(f) => {
			f.kv.set("cf_agents_facet_name", "conversation");
		},
	],
	[
		"empty facet name",
		(f) => {
			f.kv.set("cf_agents_facet_name", "");
		},
	],
	[
		"stored parent path",
		(f) => {
			f.kv.set("cf_agents_parent_path", ["parent"]);
		},
	],
	[
		"null stored parent path",
		(f) => {
			f.kv.set("cf_agents_parent_path", null);
		},
	],
	[
		"native parent path",
		(f) => {
			f.agent.parentPath = ["parent"];
		},
	],
	[
		"null native parent path",
		(f) => {
			f.agent.parentPath = null;
		},
	],
	[
		"wrong self class",
		(f) => {
			f.agent.selfPath = [{ className: "PiAgent", name: identity.slug }];
		},
	],
	[
		"wrong self name",
		(f) => {
			f.agent.selfPath = [{ className: "AgentTediDO", name: "other" }];
		},
	],
	[
		"nested self path",
		(f) => {
			f.agent.selfPath = [
				{ className: "AgentTediDO", name: identity.slug },
				{ className: "PiAgent", name: "facet" },
			];
		},
	],
	[
		"missing self path",
		(f) => {
			f.agent.selfPath = [];
		},
	],
	[
		"negative generation",
		(f) => {
			f.config.generation = -1;
		},
	],
	[
		"fractional generation",
		(f) => {
			f.config.generation = 0.5;
		},
	],
	[
		"unsafe generation",
		(f) => {
			f.config.generation = Number.MAX_SAFE_INTEGER + 1;
		},
	],
];
for (const [label, mutate] of invalidRoots) {
	await check(`reject ${label} before canonical read`, async (f) => {
		mutate(f);
		assert.equal(await resolveRuntimeParentIdentity(f.input), null);
		assert.equal(f.reads, 0);
	});
}

for (const [label, sql, value] of [
	["invalid tedi UUID", "UPDATE tedis SET id = ?", "invalid"],
	["invalid org UUID", "UPDATE tedis SET organization_id = ?", "invalid"],
	["null org UUID", "UPDATE tedis SET organization_id = ?", null],
	["non-agent runtime", "UPDATE tedis SET runtime_kind = ?", "pi"],
	["null runtime", "UPDATE tedis SET runtime_kind = ?", null],
	["empty slug", "UPDATE tedis SET isolate_agent_id = slug, slug = ?", ""],
	["missing canonical name", "UPDATE tedis SET slug = ?", "other-parent"],
	[
		"isolate id overrides slug",
		"UPDATE tedis SET isolate_agent_id = ?",
		"other-parent",
	],
] as const) {
	await check(`reject ${label}`, async (f) => {
		f.sqlite.run(sql, [value]);
		assert.equal(await resolveRuntimeParentIdentity(f.input), null);
		assert.equal(f.reads, 1);
	});
}

await check("isolate name resolves to a distinct canonical slug", async (f) => {
	f.sqlite.run(
		"UPDATE tedis SET isolate_agent_id = slug, slug = 'canonical-slug'",
	);
	assert.deepEqual(await resolveRuntimeParentIdentity(f.input), {
		...identity,
		slug: "canonical-slug",
	});
});
await check("reject ambiguous canonical physical mapping", async (f) => {
	f.sqlite.run("INSERT INTO tedis SELECT * FROM tedis");
	assert.equal(await resolveRuntimeParentIdentity(f.input), null);
});
await check("reject physical object mismatch", async (f) => {
	f.input.physicalIdForName = () => "different-object";
	assert.equal(await resolveRuntimeParentIdentity(f.input), null);
});

for (const key of ["tediId", "orgId", "slug"] as const) {
	await check(`matching and conflicting pre-existing ${key} pin`, async (f) => {
		f.local[key] = identity[key];
		assert.deepEqual(await resolveRuntimeParentIdentity(f.input), identity);
		f.local[key] = "conflicting-pin";
		assert.equal(await resolveRuntimeParentIdentity(f.input), null);
	});
}
await check("matching loaded identity remains valid", async (f) => {
	Object.assign(f.local, identity, { identityLoaded: true });
	assert.deepEqual(await resolveRuntimeParentIdentity(f.input), identity);
});

const changingFacts: [string, (f: Fixture) => void][] = [
	...(["tediId", "orgId", "slug"] as const).map(
		(key): [string, (f: Fixture) => void] => [
			key,
			(f) => {
				f.local[key] = identity[key];
			},
		],
	),
	[
		"identityLoaded",
		(f) => {
			f.local.identityLoaded = true;
		},
	],
	[
		"configGeneration",
		(f) => {
			f.config.generation++;
		},
	],
	[
		"object id",
		(f) => {
			f.physical.value = "other-object";
		},
	],
	[
		"native name presence",
		(f) => {
			f.physical.name = undefined;
		},
	],
	[
		"name",
		(f) => {
			f.agent.name = "other-parent";
		},
	],
	[
		"parent path",
		(f) => {
			(f.agent.parentPath as unknown[]).push("parent");
		},
	],
	[
		"self path",
		(f) => {
			(f.agent.selfPath as { name: string }[])[0]!.name = "facet";
		},
	],
	...storedFacts.map(([key, , value]): [string, (f: Fixture) => void] => [
		`${key} presence`,
		(f) => {
			f.kv.set(key, value);
		},
	]),
];
for (const [label, mutate] of changingFacts) {
	await check(
		`pending canonical row is fenced by changed ${label}`,
		async (f) => {
			f.pause();
			const result = resolveRuntimeParentIdentity(f.input);
			await f.entered.promise;
			mutate(f);
			f.release.resolve();
			assert.equal(await result, null);
			assert.equal(f.reads, 1);
		},
	);
}
await check("unchanged facts accept a pending canonical row", async (f) => {
	f.pause();
	const result = resolveRuntimeParentIdentity(f.input);
	await f.entered.promise;
	f.release.resolve();
	assert.deepEqual(await result, identity);
});

await check("capture failure before D1 fails closed", async (f) => {
	f.input.capture = () => {
		throw new Error("KV unavailable");
	};
	assert.equal(await resolveRuntimeParentIdentity(f.input), null);
	assert.equal(f.reads, 0);
});
await check("capture failure after D1 fails closed", async (f) => {
	let captures = 0;
	f.input.capture = () => {
		if (++captures === 2) throw new Error("KV unavailable");
		return f.capture();
	};
	assert.equal(await resolveRuntimeParentIdentity(f.input), null);
	assert.equal(captures, 2);
});
await check("physical-id lookup failure fails closed", async (f) => {
	f.input.physicalIdForName = () => {
		throw new Error("namespace unavailable");
	};
	assert.equal(await resolveRuntimeParentIdentity(f.input), null);
});
await check("canonical DB error propagates unchanged", async (f) => {
	const error = new Error("D1 unavailable");
	f.failRead(error);
	await assert.rejects(
		resolveRuntimeParentIdentity(f.input),
		(actual) => actual === error,
	);
});

// Exercise the post-query name check independently of SQL's matching predicate.
await check(
	"reject a query-boundary row with a mismatched effective name",
	async (f) => {
		f.input.db = {
			prepare: () => ({
				bind: () => ({
					first: async <T>() =>
						({
							id: identity.tediId,
							orgId: identity.orgId,
							slug: identity.slug,
							isolateAgentId: "other-parent",
							runtimeKind: "agent",
						}) as T,
				}),
			}),
		};
		assert.equal(await resolveRuntimeParentIdentity(f.input), null);
	},
);
