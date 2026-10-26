import { describe, expect, it } from "vite-plus/test";
import {
	lintFactoryWorkflow,
	readFactoryConstants,
	stepTimeoutMs,
} from "./skill-factory-validation";

const OWNER = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";

function skillMd(name: string, body = "Daily lane for Northwind Labs.") {
	return `---\nname: ${name}\ndescription: "Daily factory lane"\ncapabilities:\n  mcp:\n    tedi: [run_tedi_turn, messages_read]\n---\n\n${body}\n`;
}

function workflow(input: {
	slug?: string;
	owner?: string;
	turnTimeout?: string;
	turnText?: string;
}) {
	return `const FACTORY = {
	"slug": "${input.slug ?? "northwind-daily"}",
	"ownerTediId": "${input.owner ?? OWNER}",
};
const TURN_STEP = { retries: { limit: 1, delay: "10 seconds" }, timeout: "${input.turnTimeout ?? "240 seconds"}" };
export default {
	async run(event, step, env) {
		const turn = await step.do("owner-turn", TURN_STEP, async () =>
			env.MCP.tedi.run_tedi_turn({ session_key: FACTORY.slug, client_request_id: "x", text: "${input.turnText ?? "Summarize the queue."}" }),
		);
		return { factory: FACTORY.slug, turn };
	},
};
`;
}

const codes = (issues: Array<{ code: string }>) => issues.map((i) => i.code);

describe("lintFactoryWorkflow", () => {
	it("passes a factory whose header, owner and turn budget match", () => {
		const result = lintFactoryWorkflow({
			source: workflow({}),
			content: skillMd("northwind-daily"),
			skillSlug: "northwind-daily",
			ownerTediId: OWNER,
		});
		expect(result).toEqual({ errors: [], warnings: [] });
	});

	it("fails when FACTORY.slug is not the skill's slug, with a fix hint", () => {
		const result = lintFactoryWorkflow({
			source: workflow({ slug: "northwind-weekly" }),
			content: skillMd("northwind-daily"),
		});
		expect(codes(result.errors)).toEqual(["SKILL_FACTORY_SLUG_MISMATCH"]);
		expect(result.errors[0]?.message).toContain(
			'set FACTORY.slug to "northwind-daily"',
		);
	});

	it("uses the stored slug over the frontmatter name", () => {
		const result = lintFactoryWorkflow({
			source: workflow({ slug: "northwind-daily" }),
			content: skillMd("northwind-renamed"),
			skillSlug: "northwind-daily",
		});
		expect(result.errors).toEqual([]);
	});

	it("fails when FACTORY.ownerTediId is not the skill's owner", () => {
		const result = lintFactoryWorkflow({
			source: workflow({ owner: OTHER }),
			content: skillMd("northwind-daily"),
			ownerTediId: OWNER,
		});
		expect(codes(result.errors)).toEqual(["SKILL_FACTORY_OWNER_MISMATCH"]);
		expect(result.errors[0]?.message).toContain("Fix:");
	});

	it("warns when a tedi-turn step outlasts the bridge cap", () => {
		const result = lintFactoryWorkflow({
			source: workflow({ turnTimeout: "5 minutes" }),
			content: skillMd("northwind-daily"),
		});
		expect(codes(result.warnings)).toEqual([
			"SKILL_TURN_BUDGET_OVER_BRIDGE_CAP",
		]);
		expect(result.warnings[0]?.message).toContain("300 s");
	});

	it("warns when a workflow turn is asked to do GitHub work", () => {
		const result = lintFactoryWorkflow({
			source: workflow({ turnText: "Open a GitHub issue for each failure." }),
			content: skillMd("northwind-daily"),
		});
		expect(codes(result.warnings)).toEqual(["SKILL_TURN_NEEDS_WORK_SCOPE"]);
		expect(result.warnings[0]?.message).toContain("workItemId");
	});

	it("ignores GitHub mentions in a workflow that starts no tedi turn", () => {
		const source = `export default { async run(event, step, env) {
			return step.do("runs", { timeout: "10 minutes" }, async () => env.MCP.github.list_workflow_runs({}));
		} };`;
		expect(
			lintFactoryWorkflow({ source, content: skillMd("northwind-ci") }),
		).toEqual({ errors: [], warnings: [] });
	});
});

describe("factory helpers", () => {
	it("reads the create_factory header", () => {
		expect(readFactoryConstants(workflow({}))).toEqual({
			slug: "northwind-daily",
			ownerTediId: OWNER,
		});
		expect(readFactoryConstants("export default {}")).toBeNull();
	});

	it("parses Workflows step timeouts", () => {
		expect(stepTimeoutMs("240 seconds")).toBe(240_000);
		expect(stepTimeoutMs("2 minutes")).toBe(120_000);
		expect(stepTimeoutMs(90_000)).toBe(90_000);
		expect(stepTimeoutMs("soon")).toBeNull();
	});
});
