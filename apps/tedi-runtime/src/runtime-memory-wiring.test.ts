import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { tediDo } from "../test/tedi-do";
import { DoSkillGuidanceStore } from "./skill-guidance-store-do";

// A failed cold load is cached, so unavailable storage is not retried per turn.
{
	let loads = 0;
	const agent = tediDo({
		getDirectiveStore: () => ({
			async load() {
				loads++;
				throw new Error("storage unavailable");
			},
		}),
	});
	await agent.ensureDirectivesLoaded();
	await agent.ensureDirectivesLoaded();
	assert.equal(loads, 1);
	assert.deepEqual(agent.compiledDirectives, []);
	assert.equal(agent.directivesLoaded, true);
}

// Compilation refuses a missing accepted operation before touching identity or API.
{
	const agent = tediDo({
		async ensureIdentity() {
			assert.fail("identity must not be resolved");
		},
		async getPlatformClient() {
			assert.fail("platform must not be fetched");
		},
	});
	for (const method of ["onCompileDirectives", "onCompileBrainDigest"]) {
		await assert.rejects(agent[method](" "), /original run ID/);
	}
}

// A catalog refresh resumes against the current owner and updates the current cache.
{
	let resume!: (value: unknown) => void;
	const catalog = new Promise((resolve) => {
		resume = resolve;
	});
	const writes: string[] = [];
	const agent = tediDo({
		state: { tediId: "tedi-before" },
		async getPlatformClient() {
			return { listSkillsForTedi: () => catalog };
		},
		cacheRetrievalCorpus() {},
		getSkillGuidanceStore: () => ({
			load: () => null,
			save: (text: string) => writes.push(text),
		}),
	});
	const refresh = agent.buildAndCacheSkillGuidance();
	await Promise.resolve();
	agent.state = { tediId: "tedi-after" };
	resume({
		entries: [
			{
				id: "skill-before",
				slug: "before",
				tediId: "tedi-before",
				summary: "Before",
				lifecycleState: "active",
			},
			{
				id: "skill-after",
				slug: "after",
				tediId: "tedi-after",
				summary: "After",
				lifecycleState: "active",
			},
		],
	});
	const text = await refresh;
	assert.match(text, /skill after:/);
	assert.doesNotMatch(text, /skill before:/);
	assert.deepEqual(writes, [text]);
	assert.equal(agent.skillGuidanceText, text);
	assert.equal(agent.skillGuidanceLoaded, true);
}

// Successful refreshes retire removed and archived skills on warm turns and reload.
for (const emptyCatalog of [
	[],
	[
		{
			id: "removed-skill",
			slug: "removed-skill",
			tediId: "tedi-guidance",
			lifecycleState: "archived",
		},
	],
]) {
	const db = new Database(":memory:");
	const runner = {
		sql<T>(
			strings: TemplateStringsArray,
			...values: (string | number | boolean | null)[]
		): T[] {
			return db.query(strings.join("?")).all(...values) as T[];
		},
	};
	const store = new DoSkillGuidanceStore(runner);
	let entries = [
		{
			id: "removed-skill",
			slug: "removed-skill",
			tediId: "tedi-guidance",
			lifecycleState: "active",
		},
	];
	let unavailable = false;
	const background: Promise<unknown>[] = [];
	const agent = tediDo({
		state: { tediId: "tedi-guidance" },
		ctx: { waitUntil: (task: Promise<unknown>) => background.push(task) },
		async getPlatformClient() {
			return {
				async listSkillsForTedi() {
					if (unavailable) throw new Error("catalog unavailable");
					return { entries };
				},
			};
		},
		cacheRetrievalCorpus() {},
		getSkillGuidanceStore: () => store,
	});
	const original = await agent.skillGuidanceAddendum();
	assert.match(original, /skill removed-skill:/);
	assert.equal(store.load()?.text, original);

	unavailable = true;
	assert.equal(await agent.skillGuidanceAddendum(), original);
	await Promise.all(background.splice(0));
	assert.equal(agent.skillGuidanceText, original);
	assert.equal(store.load()?.text, original);

	unavailable = false;
	entries = emptyCatalog;
	assert.equal(await agent.skillGuidanceAddendum(), original);
	await Promise.all(background.splice(0));
	assert.equal(agent.skillGuidanceText, "");
	assert.equal(agent.skillGuidanceLoaded, true);
	assert.equal(store.load()?.text, "");
	assert.equal(await agent.skillGuidanceAddendum(), "");

	const reloaded = tediDo({
		getSkillGuidanceStore: () => new DoSkillGuidanceStore(runner),
	});
	reloaded.ensureSkillGuidanceLoaded();
	assert.equal(reloaded.skillGuidanceText, "");
	assert.equal(reloaded.skillGuidanceLoaded, true);
}

// Exercise the real builder through the turn gate, including client lookup failures.
for (const failure of [
	"client-missing",
	"client-rejected",
	"read-rejected",
	"empty",
] as const) {
	let clients = 0;
	let reads = 0;
	const writes: string[] = [];
	const agent = tediDo({
		state: { tediId: "tedi-owner" },
		skillGuidanceLoaded: true,
		skillGuidanceText: null,
		skillGuidanceGate: null,
		async getPlatformClient() {
			clients++;
			if (clients === 1 && failure === "client-missing") return null;
			if (clients === 1 && failure === "client-rejected")
				throw new Error("client down");
			return {
				async listSkillsForTedi() {
					reads++;
					if (reads === 1 && failure === "read-rejected")
						throw new Error("catalog down");
					return {
						entries:
							failure === "empty"
								? []
								: [
										{
											id: "recovered-skill",
											slug: "recovered",
											tediId: "tedi-owner",
											summary: "Recovered catalog",
											lifecycleState: "active",
										},
									],
					};
				},
			};
		},
		cacheRetrievalCorpus() {},
		getSkillGuidanceStore: () => ({
			load: () => null,
			save: (text: string) => writes.push(text),
		}),
	});
	if (failure !== "empty") {
		assert.equal(await agent.skillGuidanceAddendum(), "");
		assert.deepEqual(
			writes,
			[],
			"a failed read must not persist empty guidance",
		);
	}
	const text = await agent.skillGuidanceAddendum();
	if (failure === "empty") {
		assert.equal(text, "");
		assert.equal(await agent.skillGuidanceAddendum(), "");
		assert.equal(
			clients,
			1,
			"successful empty catalogs keep the negative cache",
		);
		assert.equal(reads, 1);
		assert.deepEqual(writes, [""], "a successful empty catalog persists");
	} else {
		assert.match(text, /skill recovered:/, failure);
		assert.equal(clients, 2, "the next turn retries the client and catalog");
		assert.equal(reads, failure === "read-rejected" ? 2 : 1);
		assert.deepEqual(writes, [text]);
	}
}

console.log("runtime memory wiring characterization passed");
