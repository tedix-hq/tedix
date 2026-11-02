import { describe, expect, it } from "vite-plus/test";
import { deriveSkillAnatomy, recordedStepsByName } from "./skill-anatomy";

const SOURCE = `
const EFFECT = { retries: { limit: 2, delay: "1 second" }, timeout: "2 minutes" };

export default {
	async run(event, step, env) {
		const orders = await step.do(
			"fetch-orders",
			{ retries: { limit: 3, delay: "1 second" }, timeout: "30 seconds" },
			async () => env.MCP.storefront.list_orders({ period: "week" }),
		);
		for (let i = 0; i < orders.items.length; i++) {
			await step.do(\`enrich-\${i}\`, async () => enrich(i));
			await step.sleep(\`settle-\${i}\`, "10 seconds");
		}
		if (orders.flagged) {
			await step.waitForEvent("approval", {
				type: "approve-publish",
				timeout: "1 hour",
			});
		}
		const [left, right] = await Promise.all([
			step.do("tally-left", async () => tally("left")),
			step.do("tally-right", async () => tally("right")),
		]);
		await step.do(
			"publish",
			{ timeout: "1 minute" },
			async () => publish(left + right),
			{ rollback: async () => unpublish() },
		);
		await step.sleepUntil("quiet-hours", new Date(event.payload.until));
		return { published: true };
	},
};
`;

describe("deriveSkillAnatomy — workflow mode", () => {
	const anatomy = deriveSkillAnatomy({
		content: "# doc",
		files: { "scripts/workflow.ts": SOURCE },
		inputSchema: {
			type: "object",
			properties: {
				period: { type: "string", description: "Reporting period" },
				until: { type: "string" },
			},
			required: ["period"],
		},
	});

	it("reads declared inputs from the input schema", () => {
		expect(anatomy.mode).toBe("workflow");
		expect(anatomy.inputs).toEqual([
			{
				name: "period",
				required: true,
				type: "string",
				description: "Reporting period",
			},
			{ name: "until", required: false, type: "string", description: null },
		]);
	});

	it("lists literal step names with config and tool calls", () => {
		const fetch = anatomy.steps.find((step) => step.name === "fetch-orders")!;
		expect(fetch.kind).toBe("action");
		expect(fetch.dynamicName).toBe(false);
		expect(fetch.repeated).toBe(false);
		expect(fetch.conditional).toBe(false);
		expect(fetch.timeout).toBe("30 seconds");
		expect(fetch.retryLimit).toBe(3);
		expect(fetch.toolCalls).toEqual(["storefront.list_orders"]);
		expect(fetch.line).toBeGreaterThan(1);
	});

	it("flags loop steps named at run time instead of inventing names", () => {
		const enrich = anatomy.steps.find((step) => step.label === "enrich-…")!;
		expect(enrich.name).toBeNull();
		expect(enrich.dynamicName).toBe(true);
		expect(enrich.repeated).toBe(true);
		const settle = anatomy.steps.find((step) => step.label === "settle-…")!;
		expect(settle.kind).toBe("sleep");
		expect(settle.sleepDuration).toBe("10 seconds");
		expect(anatomy.notes.join(" ")).toContain("named when the run executes");
	});

	it("flags branch steps and reads wait-for-event details", () => {
		const gate = anatomy.steps.find((step) => step.name === "approval")!;
		expect(gate.kind).toBe("wait");
		expect(gate.conditional).toBe(true);
		expect(gate.eventType).toBe("approve-publish");
		expect(gate.timeout).toBe("1 hour");
	});

	it("flags Promise.all siblings as parallel", () => {
		for (const name of ["tally-left", "tally-right"]) {
			const step = anatomy.steps.find((item) => item.name === name)!;
			expect(step.parallel).toBe(true);
		}
		const fetch = anatomy.steps.find((item) => item.name === "fetch-orders")!;
		expect(fetch.parallel).toBe(false);
	});

	it("recognises the rollback handler form", () => {
		const publish = anatomy.steps.find((step) => step.name === "publish")!;
		expect(publish.hasRollback).toBe(true);
		expect(publish.timeout).toBe("1 minute");
	});

	it("reads sleep-until and keeps source positions", () => {
		const quiet = anatomy.steps.find((step) => step.name === "quiet-hours")!;
		expect(quiet.kind).toBe("sleep_until");
		expect(quiet.sourcePath).toBe("scripts/workflow.ts");
		const fetch = anatomy.steps.find((step) => step.name === "fetch-orders")!;
		expect(quiet.line).toBeGreaterThan(fetch.line);
	});

	it("honest notes cover helpers and ordering", () => {
		expect(anatomy.notes.join(" ")).toContain("order the code reaches them");
		expect(anatomy.notes.join(" ")).toContain("helper");
	});
});

describe("deriveSkillAnatomy — edge cases", () => {
	it("reports a workflow with no step calls instead of fabricating", () => {
		const anatomy = deriveSkillAnatomy({
			content: "# doc",
			files: {
				"scripts/workflow.ts": "export default { async run() { return 1; } };",
			},
			inputSchema: null,
		});
		expect(anatomy.mode).toBe("workflow");
		expect(anatomy.steps).toEqual([]);
		expect(anatomy.notes.join(" ")).toContain("No step calls");
	});

	it("ignores step calls inside comments and strings", () => {
		const anatomy = deriveSkillAnatomy({
			content: "# doc",
			files: {
				"scripts/workflow.ts": [
					"// step.do('commented', async () => 1)",
					"const s = 'step.do(\"inside-string\", async () => 1)';",
					"export default { async run(event, step) {",
					"  return step.do('real', async () => 1);",
					"} };",
				].join("\n"),
			},
			inputSchema: null,
		});
		expect(anatomy.steps.map((step) => step.name)).toEqual(["real"]);
	});

	it("reads the three-argument name/callback/rollback form", () => {
		const anatomy = deriveSkillAnatomy({
			content: "# doc",
			files: {
				"scripts/workflow.ts":
					"export default { async run(e, step) { await step.do('r', async () => 1, { rollback: async () => 2 }); } };",
			},
			inputSchema: null,
		});
		expect(anatomy.steps[0]!.hasRollback).toBe(true);
	});

	it("handles unknown step methods as operations", () => {
		const anatomy = deriveSkillAnatomy({
			content: "# doc",
			files: {
				"scripts/workflow.ts":
					"export default { async run(e, step) { await step.call('storefront.list_orders', {}); } };",
			},
			inputSchema: null,
		});
		expect(anatomy.steps[0]!.kind).toBe("operation");
		expect(anatomy.steps[0]!.name).toBe("storefront.list_orders");
	});
});

describe("deriveSkillAnatomy — instructions mode", () => {
	it("derives numbered steps from the saved instructions", () => {
		const anatomy = deriveSkillAnatomy({
			content:
				"# Weekly report\n\nIntro.\n\n## Steps\n1. Gather orders\n2. Build the sheet\n3. Record evidence",
			files: null,
			inputSchema: null,
		});
		expect(anatomy.mode).toBe("instructions");
		expect(anatomy.steps.map((step) => step.label)).toEqual([
			"Gather orders",
			"Build the sheet",
			"Record evidence",
		]);
		expect(anatomy.steps[0]!.kind).toBe("instruction");
		expect(anatomy.steps[0]!.sourcePath).toBe("SKILL.md");
		expect(anatomy.notes.join(" ")).toContain("no executable workflow");
	});

	it("falls back to section headings when there is no ordered list", () => {
		const anatomy = deriveSkillAnatomy({
			content: "# Title\n\n## Collect\n\n## Write up",
			files: null,
			inputSchema: null,
		});
		expect(anatomy.steps.map((step) => step.label)).toEqual([
			"Collect",
			"Write up",
		]);
	});

	it("says the sequence is open when nothing is declared", () => {
		const anatomy = deriveSkillAnatomy({
			content: "Just prose, no list.",
			files: null,
			inputSchema: null,
		});
		expect(anatomy.steps).toEqual([]);
		expect(anatomy.notes.join(" ")).toContain("no numbered steps");
	});
});

describe("recordedStepsByName", () => {
	it("aggregates same-name records with outcomes and duration", () => {
		const map = recordedStepsByName([
			{ name: "fetch", outcome: "success", durationMs: 100 },
			{ name: "fetch", outcome: "failure", durationMs: 60 },
			{ name: "gate", outcome: "pending", durationMs: null },
		]);
		expect(map.get("fetch")).toEqual({
			records: 2,
			outcome: "mixed",
			durationMs: 160,
		});
		expect(map.get("gate")).toEqual({
			records: 1,
			outcome: "pending",
			durationMs: null,
		});
		expect(map.has("other")).toBe(false);
	});
});
