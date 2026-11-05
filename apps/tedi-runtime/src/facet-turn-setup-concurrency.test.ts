import assert from "node:assert/strict";
import { MCP_FACET_TURN_INPUT, mcpFacetTurnProbe } from "../test/tedi-do";

/**
 * Child start-up runs its independent steps together: the platform client
 * resolves while the MCP runtime syncs, and memory/skill recall runs beside
 * the delegation preflight. Each step here announces its start to the test
 * and holds its end on a test-controlled release, so a serialized start-up
 * deadlocks against the bounded waits below instead of merely reading
 * slower on a busy lane.
 */
const order: string[] = [];
const startedResolvers = new Map<string, () => void>();
const releases = new Map<string, () => void>();

const step = async (name: string) => {
	order.push(`${name}:start`);
	startedResolvers.get(name)?.();
	await new Promise<void>((resolve) => releases.set(name, resolve));
	order.push(`${name}:end`);
};
const seen = (name: string) => {
	if (order.includes(`${name}:start`)) return Promise.resolve();
	return Promise.race([
		new Promise<void>((resolve) => startedResolvers.set(name, resolve)),
		// Detection bound, not a timing assertion: it only fails when a step
		// that must start never does — a serialized or wedged start-up.
		new Promise<never>((_, reject) =>
			setTimeout(
				() =>
					reject(new Error(`${name} never started: ${JSON.stringify(order)}`)),
				15_000,
			),
		),
	]);
};
const release = (name: string) => {
	const resolve = releases.get(name);
	assert.ok(resolve, `${name} gate missing: ${JSON.stringify(order)}`);
	resolve();
};

const agent = mcpFacetTurnProbe({
	fields: {
		// No tediId: the supervised path reuses the injected runtime below.
		state: { slug: "reader", systemPrompt: "SYSTEM" },
		async getMcpRuntime() {
			return {
				async ensureSynced() {
					await step("sync");
				},
				async executeTool() {
					await step("preflight");
					return [
						{
							callable: "globex.list_invoices",
							authorized: true,
							missingScopes: [],
							parameters: { type: "object" },
						},
					];
				},
				bindTurn() {},
				getSystemInstructions() {
					return "";
				},
			};
		},
		async getPlatformClient() {
			await step("platform");
			return { setEpisodeTrace() {} };
		},
		async cognitiveAddenda() {
			await step("addenda");
			return "ADDENDA";
		},
	},
});

const prepared = agent.prepareMcpFacetTurn({
	...MCP_FACET_TURN_INPUT,
	workItemId: "work-1",
	homeRunId: "home-1",
	capabilityPlan: {
		version: "delegation-capabilities.v1",
		requiredCapabilities: ["globex.list_invoices"],
		allowedToolIds: ["globex.list_invoices"],
		missingCapabilities: [],
		urls: [],
		outputIds: [],
	},
});

// The platform client and the MCP sync are independent: both must start
// while the other is still held open.
await Promise.all([seen("platform"), seen("sync")]);
assert.deepEqual(
	order,
	["platform:start", "sync:start"],
	"platform client and MCP sync start together",
);
// The preflight reads through the synced connection, so it cannot start
// until the sync it depends on has ended.
assert.ok(
	!order.includes("preflight:start"),
	`preflight waits for the sync it uses: ${JSON.stringify(order)}`,
);
release("platform");
release("sync");

// Recall and the delegation preflight are independent of each other.
await Promise.all([seen("addenda"), seen("preflight")]);
release("addenda");
release("preflight");

const result = await prepared;

assert.match(result.system, /ADDENDA/, "recall still reaches the prompt");
assert.deepEqual(
	order,
	[
		"platform:start",
		"sync:start",
		"platform:end",
		"sync:end",
		"addenda:start",
		"preflight:start",
		"addenda:end",
		"preflight:end",
	],
	"the two independent pairs overlap and the dependent steps run in order",
);
console.log("[setup-concurrency] ok", { order });
