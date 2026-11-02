import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { SkillEntry } from "@tedix/api-contract/schemas/cognitive";
import { describe, expect, it } from "vite-plus/test";
import {
	skillRunsQueryOptions,
	workflowRunInspectQueryOptions,
} from "@/lib/os-query-options";
import { SkillAnatomySection } from "./skill-anatomy-section";

const WORKFLOW = `
export default {
	async run(event, step, env) {
		const orders = await step.do(
			"fetch-orders",
			{ retries: { limit: 2, delay: "1 second" }, timeout: "30 seconds" },
			async () => env.MCP.storefront.list_orders({}),
		);
		if (orders.flagged) {
			await step.waitForEvent("publish-approval", { type: "approval" });
		}
		for (let i = 0; i < orders.items.length; i++) {
			await step.do(\`line-\${i}\`, async () => line(i));
		}
		return { published: true };
	},
};
`;

const entry = (overrides: Partial<SkillEntry>): SkillEntry => ({
	id: "skill-1",
	organizationId: "org",
	tediId: null,
	proposedByTediId: null,
	domainId: null,
	title: "Weekly revenue report",
	slug: "weekly-revenue-report",
	folderPath: null,
	description: null,
	content: "# Doc\n\n1. Gather\n2. Report",
	files: null,
	inputSchema: null,
	successCount: 0,
	failureCount: 0,
	lastUsedAt: null,
	avgDurationMs: null,
	revision: 3,
	revisionReasoning: null,
	supersedesId: null,
	sourceSkillId: null,
	sourceRevision: null,
	improvementAdoption: null,
	visibility: "org",
	agentSkillsFormat: null,
	r2Path: null,
	appId: null,
	toolIds: null,
	mcpAppBindings: null,
	summary: null,
	tags: null,
	audience: null,
	preconditions: null,
	lifecycleState: "active",
	reviewFlaggedAt: null,
	reviewFlagReason: null,
	paceLayer: "differentiation",
	createdAt: null,
	updatedAt: null,
	...overrides,
});

const runSummary = (overrides: Record<string, unknown> = {}) => ({
	id: "run-1",
	organizationId: "org",
	skillId: "skill-1",
	tediId: "tedi-1",
	workflowInstanceId: "wf-1",
	runtimeEnvironment: "production" as const,
	lastReconciledAt: null,
	executionEpoch: 0,
	restartRequestedAt: null,
	workflowRetiredAt: null,
	status: "completed" as const,
	skillSlug: null,
	skillRevision: 3,
	startedAt: "2026-01-01T00:00:00Z",
	completedAt: "2026-01-01T00:01:00Z",
	pausedAt: null,
	createdBy: null,
	hasResult: true,
	hasError: false,
	outcome: "delivered" as const,
	workItemId: null,
	...overrides,
});

const render = (element: React.ReactElement, client?: QueryClient) =>
	renderToStaticMarkup(
		<QueryClientProvider
			client={
				client ??
				new QueryClient({
					defaultOptions: { queries: { retry: false } },
				})
			}
		>
			{element}
		</QueryClientProvider>,
	);

describe("SkillAnatomySection", () => {
	it("renders declared workflow steps with honest dynamic flags", () => {
		const html = render(
			<SkillAnatomySection
				skill={entry({
					files: { "scripts/workflow.ts": WORKFLOW },
				})}
				runs={[]}
			/>,
		);
		expect(html).toContain("Workflow anatomy");
		expect(html).toContain("Executable workflow");
		expect(html).toContain("fetch-orders");
		expect(html).toContain("publish-approval");
		expect(html).toContain("line-…");
		expect(html).toContain("named at run time");
		expect(html).toContain("in a loop");
		expect(html).toContain("in a branch");
		expect(html).toContain("scripts/workflow.ts:");
		expect(html).toContain("storefront.list_orders");
		expect(html).toContain("No runs recorded yet");
	});

	it("links matched steps to the recorded run", () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		client.setQueryData(skillRunsQueryOptions("skill-1").queryKey, {
			runs: [runSummary()],
		});
		client.setQueryData(workflowRunInspectQueryOptions("run-1").queryKey, {
			run: { id: "run-1", status: "completed" },
			revision: {},
			artifacts: [],
			steps: [
				{
					name: "fetch-orders",
					outcome: "success",
					durationMs: 900,
					kind: "attempt",
				},
				{
					name: "fetch-orders",
					outcome: "success",
					durationMs: 400,
					kind: "tool_call",
				},
			],
			toolCalls: [],
			warnings: [],
		} as never);
		const html = render(
			<SkillAnatomySection
				skill={entry({
					files: { "scripts/workflow.ts": WORKFLOW },
				})}
				runs={[runSummary() as never]}
			/>,
			client,
		);
		expect(html).toContain("Recorded");
		expect(html).toContain("in the latest run");
		expect(html).toContain("/work/runs/run-1");
		expect(html).toContain("Not recorded in the latest run");
		// The tool_call record is filtered out of the step counter.
		expect(html).not.toContain("Recorded 2×");
	});

	it("reads instruction-only skills from SKILL.md instead", () => {
		const html = render(
			<SkillAnatomySection
				skill={entry({
					content:
						"# Inbox triage\n\n## Steps\n1. Read new mail\n2. Classify urgency\n3. Draft replies",
				})}
				runs={[]}
			/>,
		);
		expect(html).toContain("Instructions only");
		expect(html).toContain("Read new mail");
		expect(html).toContain("Draft replies");
		expect(html).toContain("no executable workflow");
		expect(html).not.toContain("named at run time");
	});

	it("keeps the section honest when the instructions declare nothing", () => {
		const html = render(
			<SkillAnatomySection
				skill={entry({ content: "Just a note." })}
				runs={[]}
			/>,
		);
		expect(html).toContain("No steps are declared");
	});
});
