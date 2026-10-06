import { describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	collectParams,
	DEFAULT_WATCH_SECONDS,
	FLOW_EXIT_FAIL,
	FLOW_EXIT_WATCH_TIMEOUT,
	type FlowContext,
	flowUsage,
	parsePlan,
	renderSkillMd,
	runFlowCommand,
} from "./flow";

/**
 * A fake gateway. Records every Code Mode snippet the verb builds and replies
 * from a scripted queue keyed by the callable name, so a test asserts on the
 * exact call sequence rather than on transport details.
 */
function harness(replies: Record<string, unknown[]>) {
	const calls: string[] = [];
	const approvals: string[] = [];
	const queues = new Map<string, unknown[]>(
		Object.entries(replies).map(([k, v]) => [k, [...v]]),
	);
	const respond = (source: string) => {
		calls.push(source);
		for (const [callable, queue] of queues) {
			if (source.includes(callable)) {
				if (queue.length === 0) {
					throw new Error(`no scripted reply left for ${callable}`);
				}
				return queue.shift();
			}
		}
		throw new Error(`unscripted call: ${source}`);
	};
	const ctx = (flow: FlowContext["flow"] = {}): FlowContext => ({
		client: {
			runCode: async (source: string) => respond(source),
			runCodeWithDestructiveApproval: async (
				source: string,
				reason: string,
			) => {
				approvals.push(reason);
				return respond(source);
			},
		} as FlowContext["client"],
		color: { enabled: false },
		json: true,
		workspace: "tedix",
		flow,
		sleep: async () => {},
	});
	return { calls, approvals, ctx };
}

const PLAN = `/* tedix
name: audit-annotations
description: Check tool annotations.
capabilities:
  mcp:
    app_config: [list_app_tools]
*/
export default { async run(event, step, env) { return { ok: true }; } };
`;

/** Plan fixtures go to a temp dir — never into the package source tree. */
function writePlan(text = PLAN): string {
	const file = join(mkdtempSync(join(tmpdir(), "tedix-flow-")), "plan.ts");
	writeFileSync(file, text);
	return file;
}

describe("parsePlan", () => {
	it("splits identity scalars from the manifest body", () => {
		const plan = parsePlan(PLAN);
		expect(plan.manifest.name).toBe("audit-annotations");
		expect(plan.manifest.description).toBe("Check tool annotations.");
		expect(plan.manifest.yaml).toContain("capabilities:");
		expect(plan.manifest.yaml).toContain("app_config: [list_app_tools]");
		// name/description are lifted out so renderSkillMd controls their placement.
		expect(plan.manifest.yaml).not.toContain("name: audit-annotations");
	});

	it("keeps the manifest comment in the stored source", () => {
		// Stripping it would make the pinned revision differ from the file the
		// agent wrote, defeating revision comparison.
		expect(parsePlan(PLAN).source).toBe(PLAN);
	});

	it("leaves indented name: keys inside nested manifest structures alone", () => {
		const plan = parsePlan(
			`/* tedix\nname: top\ncapabilities:\n  grounding:\n    name: strict\n*/\nexport default {};\n`,
		);
		expect(plan.manifest.name).toBe("top");
		expect(plan.manifest.yaml).toContain("    name: strict");
	});

	it("rejects a plan with no manifest block", () => {
		expect(() => parsePlan("export default {};")).toThrow(/manifest block/);
	});

	it("ignores a tedix block that is not the leading one", () => {
		expect(() =>
			parsePlan(`export default {};\n/* tedix\nname: late\n*/\n`),
		).toThrow(/manifest block/);
	});
});

describe("renderSkillMd", () => {
	it("emits frontmatter carrying the capabilities block verbatim", () => {
		const md = renderSkillMd(
			parsePlan(PLAN).manifest,
			"audit-annotations",
			"Check tool annotations.",
		);
		const [, frontmatter] = md.split("---");
		expect(frontmatter).toContain("name: audit-annotations");
		// The manifest is what the runtime enforces env.MCP against — it must
		// survive into stored content unchanged.
		expect(frontmatter).toContain("app_config: [list_app_tools]");
	});
});

describe("collectParams", () => {
	it("merges --params JSON with repeated --param pairs", () => {
		expect(
			collectParams({ params: '{"a":1}', param: ["b=two", "c=true", "d=3"] }),
		).toEqual({ a: 1, b: "two", c: true, d: 3 });
	});

	it("rejects malformed input rather than guessing", () => {
		expect(() => collectParams({ param: ["novalue"] })).toThrow(/k=v/);
		expect(() => collectParams({ params: "{" })).toThrow(/valid JSON/);
		expect(() => collectParams({ params: "[1]" })).toThrow(/JSON object/);
	});
});

describe("flow run", () => {
	it("authors a draft, starts it, and returns the run id", async () => {
		const { calls, approvals, ctx } = harness({
			"flow.run": [{ skillId: "skill-1", runId: "run-1" }],
		});
		const file = writePlan();
		const code = await runFlowCommand("run", ctx({ file }));
		expect(code).toBe(0);
		expect(calls).toHaveLength(1);
		const run = calls[0]!;
		expect(run).toContain("flow.run");
		expect(run).toContain('"source":"/* tedix');
		expect(run).toContain('"skillDoc":"---\\nname: audit-annotations');
		expect(run).toContain("app_config: [list_app_tools]");
		expect(run).not.toContain("discover.search");
		expect(run).not.toContain("skills.record_skills");
		expect(run).not.toContain("run_skill_workflow");
		// Destructive authorization rides the existing approval helper.
		expect(approvals).toHaveLength(1);
	});

	it("routes through the tedi named by --as", async () => {
		const { calls, ctx } = harness({
			"flow.run": [{ skillId: "skill-1", runId: "run-1" }],
		});
		const file = writePlan();
		await runFlowCommand("run", ctx({ file, as: "cro" }));
		expect(calls[0]).toContain('"tediSlug":"cro"');
	});

	it("runs an existing skill without authoring a replacement draft", async () => {
		const skillId = "5eed0005-0000-4000-8000-000000000005";
		const { calls, ctx } = harness({
			"flow.run": [{ skillId, runId: "run-1" }],
		});
		expect(await runFlowCommand("run", ctx({ skill: skillId }))).toBe(0);
		expect(calls[0]).toContain(`"skillId":"${skillId}"`);
		expect(calls[0]).not.toContain('"source"');
		expect(calls[0]).not.toContain('"skillDoc"');
	});

	it("rejects a non-UUID existing skill reference", async () => {
		const { calls, ctx } = harness({});
		expect(await runFlowCommand("run", ctx({ skill: "some-slug" }))).toBe(
			FLOW_EXIT_FAIL,
		);
		expect(calls).toHaveLength(0);
	});

	it("fails when the draft is rejected by validation", async () => {
		const { ctx } = harness({
			"flow.run": [
				{
					defined: true,
					code: "BAD_REQUEST",
					status: 400,
					message: "no manifest",
				},
			],
		});
		const file = writePlan();
		expect(await runFlowCommand("run", ctx({ file }))).toBe(FLOW_EXIT_FAIL);
	});

	it("treats a truncated gateway result as an error, not as data", async () => {
		// A clipped page is unparseable; reading it as a value is the silent-empty
		// bug class this rule exists to prevent.
		const { ctx } = harness({
			"flow.run": [
				{
					__tedix_truncated: true,
					approxTokens: 14_735,
					preview: '{"id":"skill-1"',
				},
			],
		});
		const file = writePlan();
		expect(await runFlowCommand("run", ctx({ file }))).toBe(FLOW_EXIT_FAIL);
	});
});

describe("status projection", () => {
	it("uses the gateway's bounded flow status projection", async () => {
		// The gateway envelope is `{ executionId, result }`; the status projection
		// lives under `result`, and a workflow's nested `result` remains inside
		// `output` without requiring a second normalization path.
		const { calls, ctx } = harness({
			"flow.status": [
				{
					executionId: "exec-1",
					result: { status: "completed", output: { count: 3 } },
				},
			],
		});
		expect(await runFlowCommand("status run-1", ctx())).toBe(0);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("flow.status");
		expect(calls[0]).not.toContain("get_skill_workflow_status");
	});

	it("preserves a failed status diagnostic and nested result in JSON without inspecting or mutating", async () => {
		const stdout = spyOn(console, "log").mockImplementation(() => {});
		const { calls, approvals, ctx } = harness({
			"flow.status": [
				{
					executionId: "exec-1",
					result: {
						status: "failed",
						output: { result: "workflow-result", count: 2 },
						error: { code: "GATEWAY_FAILED", message: "bounded diagnostic" },
					},
				},
			],
		});
		expect(await runFlowCommand("status run-1", ctx())).toBe(FLOW_EXIT_FAIL);
		expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({
			runId: "run-1",
			status: "failed",
			result: { result: "workflow-result", count: 2 },
			error: { code: "GATEWAY_FAILED", message: "bounded diagnostic" },
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("flow.status");
		expect(calls[0]).not.toMatch(/flow\.(inspect|retry)|delegat|mutat/);
		expect(approvals).toHaveLength(0);
		stdout.mockRestore();
	});

	it("prints the exact failed status diagnostic for humans", async () => {
		const stdout = spyOn(console, "log").mockImplementation(() => {});
		const stderr = spyOn(console, "error").mockImplementation(() => {});
		const { calls, ctx } = harness({
			"flow.status": [
				{
					executionId: "exec-1",
					result: { status: "failed", error: "bounded gateway diagnostic" },
				},
			],
		});
		const human = ctx();
		human.json = false;
		expect(await runFlowCommand("status run-1", human)).toBe(FLOW_EXIT_FAIL);
		expect(stdout.mock.calls[0]?.[0]).toContain("failed run-1");
		expect(stderr.mock.calls[0]?.[0]).toContain("bounded gateway diagnostic");
		expect(calls).toHaveLength(1);
		stdout.mockRestore();
		stderr.mockRestore();
	});
});

describe("flow watch", () => {
	it("polls to terminal and exits 0 on completion", async () => {
		const { calls, ctx } = harness({
			"flow.run": [{ skillId: "skill-1", runId: "run-1" }],
			// Scripted in the PROJECTED shape the sandbox now returns.
			"flow.status": [
				{ executionId: "exec-1", result: { status: "running" } },
				{ executionId: "exec-1", result: { status: "running" } },
				{
					executionId: "exec-1",
					result: { status: "completed", output: { count: 3 } },
				},
			],
		});
		const file = writePlan();
		const code = await runFlowCommand(
			"run",
			ctx({ file, watch: DEFAULT_WATCH_SECONDS }),
		);
		expect(code).toBe(0);
		// The watch loop stays on the COMPACT status call — pulling the full
		// inspection every poll would reintroduce the context growth this avoids.
		expect(calls.filter((call) => call.includes("flow.inspect"))).toHaveLength(
			0,
		);
		expect(calls.filter((call) => call.includes("flow.status"))).toHaveLength(
			3,
		);
	});

	it("exits non-zero when the run fails", async () => {
		const { ctx } = harness({
			"flow.run": [{ skillId: "skill-1", runId: "run-1" }],
			"flow.status": [
				{ executionId: "exec-1", result: { status: "failed", error: "boom" } },
			],
		});
		const file = writePlan();
		expect(
			await runFlowCommand("run", ctx({ file, watch: DEFAULT_WATCH_SECONDS })),
		).toBe(FLOW_EXIT_FAIL);
	});

	it("separates an expired horizon from a failure", async () => {
		let clock = 0;
		const { ctx } = harness({
			"flow.status": [
				{ executionId: "exec-1", result: { status: "running" } },
				{ executionId: "exec-1", result: { status: "running" } },
			],
		});
		const base = ctx({ watch: 8 });
		// Advance past the horizon so the loop gives up while the run is healthy.
		const timed: FlowContext = { ...base, now: () => (clock += 5_000) };
		expect(await runFlowCommand("status run-1", timed)).toBe(
			FLOW_EXIT_WATCH_TIMEOUT,
		);
	});
});

describe("flow inspect and list", () => {
	it("calls the gateway-native evidence view", async () => {
		const { calls, ctx } = harness({
			"flow.inspect": [{ runId: "run-1", steps: [{ id: "step-1" }] }],
		});
		expect(await runFlowCommand("inspect run-1", ctx())).toBe(0);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("flow.inspect");
		expect(calls[0]).toContain('"runId":"run-1"');
	});

	it("renders the canonical flow.list runs envelope", async () => {
		const { calls, ctx } = harness({
			"flow.list": [{ runs: [{ runId: "run-1", status: "completed" }] }],
		});
		expect(await runFlowCommand("list", ctx())).toBe(0);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("flow.list");
		expect(calls[0]).toContain('"limit":15');
	});

	it("passes --as to every native read as tediSlug", async () => {
		const { calls, ctx } = harness({
			"flow.status": [{ executionId: "exec-1", result: { status: "running" } }],
		});
		await runFlowCommand("status run-1", ctx({ as: "operator" }));
		expect(calls[0]).toContain('"tediSlug":"operator"');
	});

	it("lists the exact workflow-visible tedi methods", async () => {
		const { calls, ctx } = harness({
			"flow.tools": [
				{
					tediSlug: "cto",
					namespace: "tedi",
					methods: ["run_tedi_turn", "run_skill_workflow"],
					manifest: {
						mcp: { tedi: ["run_tedi_turn", "run_skill_workflow"] },
					},
				},
			],
		});
		expect(await runFlowCommand("tools", ctx({ as: "cto" }))).toBe(0);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("flow.tools");
		expect(calls[0]).toContain('"tediSlug":"cto"');
	});
});

describe("flow usage", () => {
	it("documents the bounded-return contract", () => {
		const text = flowUsage();
		// The single most important thing an agent must internalize.
		expect(text).toContain("The return value is what enters your context");
		expect(text).toContain("record_artifact");
		expect(text).toContain("/* tedix");
		expect(text).toContain("tedix flow tools");
		expect(text).toContain("normalized tool value");
		expect(text).toContain("Do not read .content/.structuredContent");
	});

	it("rejects an unknown verb", async () => {
		const { ctx } = harness({});
		expect(await runFlowCommand("frobnicate", ctx())).toBe(FLOW_EXIT_FAIL);
	});
});
