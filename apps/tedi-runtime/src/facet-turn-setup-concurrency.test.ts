import assert from "node:assert/strict";
import { MCP_FACET_TURN_INPUT, mcpFacetTurnProbe } from "../test/tedi-do";

/**
 * Child start-up runs its independent steps together: the platform client
 * resolves while the MCP runtime syncs, and memory/skill recall runs beside
 * the delegation preflight. Each step here takes STEP_MS; serial start-up
 * would take four steps, concurrent start-up about two.
 */
const STEP_MS = 90;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const marks: Array<{ step: string; at: number }> = [];
const started = Date.now();
const mark = (step: string) => marks.push({ step, at: Date.now() - started });

const agent = mcpFacetTurnProbe({
	fields: {
		// No tediId: the supervised path reuses the injected runtime below.
		state: { slug: "reader", systemPrompt: "SYSTEM" },
		async getMcpRuntime() {
			return {
				async ensureSynced() {
					mark("sync:start");
					await sleep(STEP_MS);
					mark("sync:end");
				},
				async executeTool() {
					mark("preflight:start");
					await sleep(STEP_MS);
					mark("preflight:end");
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
			mark("platform:start");
			await sleep(STEP_MS);
			mark("platform:end");
			return { setEpisodeTrace() {} };
		},
		async cognitiveAddenda() {
			mark("addenda:start");
			await sleep(STEP_MS);
			mark("addenda:end");
			return "ADDENDA";
		},
	},
});

const setupStarted = Date.now();
const prepared = await agent.prepareMcpFacetTurn({
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
const setupMs = Date.now() - setupStarted;

const at = (step: string) => marks.find((entry) => entry.step === step)!.at;
assert.match(prepared.system, /ADDENDA/, "recall still reaches the prompt");
assert.ok(
	at("platform:start") < at("sync:end"),
	`platform client starts before the MCP sync ends: ${JSON.stringify(marks)}`,
);
assert.ok(
	at("addenda:start") < at("preflight:end"),
	`recall starts before the preflight ends: ${JSON.stringify(marks)}`,
);
assert.ok(
	at("preflight:start") >= at("sync:end"),
	`preflight waits for the sync it uses: ${JSON.stringify(marks)}`,
);
assert.ok(
	setupMs < STEP_MS * 3.5,
	`concurrent start-up stays under three and a half steps: ${setupMs}ms ${JSON.stringify(marks)}`,
);
assert.ok(
	setupMs >= STEP_MS * 2,
	`the two dependent pairs still run in order: ${setupMs}ms`,
);
console.log("[setup-concurrency] ok", { setupMs, marks });
