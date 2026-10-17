import assert from "node:assert/strict";
import { tediDo } from "../test/tedi-do";

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

console.log("runtime memory wiring characterization passed");
