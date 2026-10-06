import { describe, expect, it, spyOn } from "bun:test";
import { runWorkflowCommand, type WorkflowContext } from "./workflow";

function harness(reply: unknown) {
	const calls: string[] = [];
	const ctx: WorkflowContext = {
		client: {
			runCode: async (source: string) => {
				calls.push(source);
				return reply;
			},
		},
		color: { enabled: false },
		json: true,
		limit: 7,
	};
	return { calls, ctx };
}

describe("workflow commands", () => {
	it("lists canonical definitions", async () => {
		const { calls, ctx } = harness({ definitions: [] });
		expect(await runWorkflowCommand("list", ctx)).toBe(0);
		expect(calls[0]).toContain("workflows.list_workflow_definitions");
		expect(calls[0]).toContain('"limit":7');
	});

	it("reads canonical definition health", async () => {
		const stdout = spyOn(console, "log").mockImplementation(() => {});
		const { calls, ctx } = harness({
			health: [{ definitionId: "static:test", healthStatus: "healthy" }],
		});
		ctx.json = false;
		expect(await runWorkflowCommand("health", ctx)).toBe(0);
		expect(calls[0]).toContain("workflows.list_workflow_definition_health");
		expect(stdout.mock.calls[0]?.[0]).toContain("static:test");
		expect(stdout.mock.calls[0]?.[0]).toContain("healthy");
		stdout.mockRestore();
	});

	it("reads runs and a single engine status without aliases", async () => {
		const runs = harness({ runs: [] });
		expect(await runWorkflowCommand("runs", runs.ctx)).toBe(0);
		expect(runs.calls[0]).toContain("workflows.list_workflow_runs");

		const status = harness({ status: "running" });
		expect(await runWorkflowCommand("status workflow-1", status.ctx)).toBe(0);
		expect(status.calls[0]).toContain("workflows.get_workflow_status");
		expect(status.calls[0]).toContain('"workflowId":"workflow-1"');
	});

	it("rejects unknown verbs before a gateway call", async () => {
		const stderr = spyOn(console, "error").mockImplementation(() => {});
		const { calls, ctx } = harness({});
		expect(await runWorkflowCommand("run", ctx)).toBe(2);
		expect(stderr.mock.calls[0]?.[0]).toContain("unknown workflow verb");
		expect(calls).toHaveLength(0);
		stderr.mockRestore();
	});
});
