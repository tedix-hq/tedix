import assert from "node:assert/strict";
import { explicitPromptCacheConfig, promptCacheKey } from "./prompt-cache";

const identity = {
	orgId: "org-secret",
	tediId: "tedi-secret",
	surface: "mcp",
	stableSystemPrefix: "stable persona",
};
const key = await promptCacheKey(identity);
assert.equal(key, await promptCacheKey(identity));
assert.match(key, /^[a-f0-9]{64}$/);
assert.equal(key.includes(identity.orgId), false);
assert.equal(key.includes(identity.tediId), false);
for (const field of [
	"orgId",
	"tediId",
	"surface",
	"stableSystemPrefix",
] as const) {
	assert.notEqual(
		key,
		await promptCacheKey({ ...identity, [field]: `${identity[field]}-other` }),
	);
}

const config = explicitPromptCacheConfig({
	provider: "azure-openai",
	model: "gpt-5.6-sol",
	system: "stable persona\n\ndynamic tools",
	stableSystemPrefix: "stable persona",
	cacheKey: key,
});
assert.ok(config);
assert.equal(
	config.instructions.map((message) => message.content).join(""),
	"stable persona\n\ndynamic tools",
);
assert.deepEqual(config.instructions[0]?.providerOptions, {
	azure: { promptCacheBreakpoint: { mode: "explicit" } },
});
assert.deepEqual(config.providerOptions, {
	azure: {
		promptCacheKey: key,
		promptCacheOptions: { mode: "explicit", ttl: "30m" },
	},
});

for (const override of [
	{ provider: "workers-ai" as const },
	{ model: "gpt-5.5" },
	{ stableSystemPrefix: "not a prefix" },
	{ cacheKey: null },
]) {
	assert.equal(
		explicitPromptCacheConfig({
			provider: "azure-openai",
			model: "gpt-5.6-sol",
			system: "stable persona\n\ndynamic tools",
			stableSystemPrefix: "stable persona",
			cacheKey: key,
			...override,
		}),
		null,
	);
}
