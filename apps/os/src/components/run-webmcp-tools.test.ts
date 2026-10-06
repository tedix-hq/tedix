import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { buildRunWebMcpTools } from "@/components/run-webmcp-tools";
import { osApi } from "@/lib/api";
import { RUN_RATIONALE_LIMIT } from "@/lib/os-query-options";
import type { ModelContextLike } from "@tedix/webmcp-core/model-context";
import {
	registerWebMcpScope,
	setModelContextResolverForTests,
	webMcpRegisteredToolNames,
} from "@tedix/webmcp-core/registry";

vi.mock("@/lib/api", () => ({
	osApi: {
		skills: {
			inspectWorkflowRun: vi.fn(),
			listRunArtifacts: vi.fn(),
		},
		rationaleRecords: {
			list: vi.fn(),
		},
	},
}));

const skillsApi = osApi.skills as unknown as {
	inspectWorkflowRun: ReturnType<typeof vi.fn>;
	listRunArtifacts: ReturnType<typeof vi.fn>;
};
const rationaleApi = osApi.rationaleRecords as unknown as {
	list: ReturnType<typeof vi.fn>;
};

const RUN_ID = "9c1e5b7a-3d2f-4e6a-8b1c-0d9e8f7a6b5c";
const TEDI_ID = "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d";
const DEEP_LINK = `/work/runs/${RUN_ID}`;

function inspection(overrides?: Record<string, unknown>) {
	return {
		run: {
			id: RUN_ID,
			organizationId: "org1",
			skillId: "skill1",
			tediId: TEDI_ID,
			workflowInstanceId: "wf1",
			runtimeEnvironment: "production",
			executionEpoch: 2,
			status: "completed",
			error: null,
			startedAt: "2026-08-27T00:00:00Z",
			completedAt: "2026-08-27T00:05:00Z",
			pausedAt: null,
			createdBy: "user_1",
			workItemId: "wi_1",
			costSummary: {
				schemaVersion: 1,
				steps: 4,
				attempts: 5,
				retries: 1,
				toolCalls: 2,
				toolCallsByNamespace: { control: 2 },
				stepDurationMs: 1200,
				wallMs: 300000,
			},
		},
		revision: {
			runId: RUN_ID,
			skillId: "skill1",
			tediId: TEDI_ID,
			skillSlug: "daily-brief",
			revision: 7,
			status: "completed",
		},
		artifacts: [],
		steps: [
			{
				path: "steps/fetch",
				name: "fetch data",
				count: 1,
				executionEpoch: 2,
				kind: "attempt",
				attempt: 1,
				outcome: "success",
				status: "succeeded",
				durationMs: 800,
				provenance: "step_artifact",
				legacy: false,
				mimeType: "application/json",
				sizeBytes: 10,
			},
			{
				path: "calls/send",
				name: "send report",
				count: 1,
				executionEpoch: 2,
				kind: "tool_call",
				attempt: 2,
				outcome: "failure",
				status: "failed",
				durationMs: null,
				namespace: "gmail",
				method: "gmail_send",
				provenance: "step_artifact",
				legacy: false,
				mimeType: "application/json",
				sizeBytes: 20,
			},
		],
		toolCalls: [{ kind: "tool_call" }],
		warnings: ["engine state drifted"],
		...overrides,
	};
}

const RUN_SUMMARY = {
	runId: RUN_ID,
	status: "completed",
	skillId: "skill1",
	skillSlug: "daily-brief",
	skillRevision: 7,
	tediId: TEDI_ID,
	createdBy: "user_1",
	workItemId: "wi_1",
	executionEpoch: 2,
	startedAt: "2026-08-27T00:00:00Z",
	completedAt: "2026-08-27T00:05:00Z",
	pausedAt: null,
	error: null,
	costSummary: { steps: 4, toolCalls: 2, retries: 1, wallMs: 300000 },
	warnings: ["engine state drifted"],
};

function tools() {
	const built = buildRunWebMcpTools(RUN_ID);
	return { built, byName: new Map(built.map((tool) => [tool.name, tool])) };
}

afterEach(() => {
	setModelContextResolverForTests(null);
	vi.clearAllMocks();
});

describe("buildRunWebMcpTools", () => {
	it("marks every tool as a read of untrusted content with no arguments", () => {
		const { built } = tools();
		expect(built).toHaveLength(3);
		for (const tool of built) {
			expect(tool.annotations, tool.name).toEqual({
				readOnlyHint: true,
				untrustedContentHint: true,
			});
			expect(
				(tool.inputSchema as { properties?: object }).properties,
				tool.name,
			).toEqual({});
		}
	});

	it("registers the three run-scoped tools under an id-keyed scope", () => {
		const context: ModelContextLike = {
			provideContext: () => {},
		};
		setModelContextResolverForTests(() => context);
		const dispose = registerWebMcpScope(
			`run:${RUN_ID}`,
			buildRunWebMcpTools(RUN_ID),
		);
		expect(webMcpRegisteredToolNames()).toEqual([
			"get_current_run",
			"list_current_run_steps",
			"explain_current_run",
		]);
		dispose();
	});

	it("get_current_run projects the run, revision identity, and warnings", async () => {
		skillsApi.inspectWorkflowRun.mockResolvedValue(inspection());
		const { byName } = tools();
		const result = await byName.get("get_current_run")!.execute({});
		expect(skillsApi.inspectWorkflowRun).toHaveBeenCalledWith({
			runId: RUN_ID,
		});
		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({
			...RUN_SUMMARY,
			deepLink: DEEP_LINK,
		});
	});

	it("list_current_run_steps maps compact step rows with tool-call identity", async () => {
		skillsApi.inspectWorkflowRun.mockResolvedValue(inspection());
		const { byName } = tools();
		const result = await byName.get("list_current_run_steps")!.execute({});
		expect(result.structuredContent).toEqual({
			steps: [
				{
					name: "fetch data",
					kind: "attempt",
					outcome: "success",
					status: "succeeded",
					attempt: 1,
					durationMs: 800,
					executionEpoch: 2,
					toolCall: null,
				},
				{
					name: "send report",
					kind: "tool_call",
					outcome: "failure",
					status: "failed",
					attempt: 2,
					durationMs: null,
					executionEpoch: 2,
					toolCall: "gmail.gmail_send",
				},
			],
			toolCallsCount: 1,
			deepLink: DEEP_LINK,
		});
	});

	it("explain_current_run composes the summary with run-linked rationale and artifacts", async () => {
		skillsApi.inspectWorkflowRun.mockResolvedValue(inspection());
		rationaleApi.list.mockResolvedValue({
			data: [
				{
					id: "r1",
					runId: RUN_ID,
					action: "Sent the brief",
					rationale: "x".repeat(500),
					category: "execution",
					confidence: 0.9,
					outcomeStatus: "success",
					outcome: "delivered",
					createdAt: "2026-08-27T00:04:00Z",
				},
				{
					id: "r2",
					runId: "some-other-run",
					action: "Unrelated",
					rationale: "not this run",
					category: "execution",
					confidence: 0.5,
					outcomeStatus: "pending",
					outcome: null,
					createdAt: "2026-08-27T00:00:00Z",
				},
			],
			pagination: {},
		});
		skillsApi.listRunArtifacts.mockResolvedValue({
			artifacts: [
				{
					path: "out/report.md",
					mimeType: "text/markdown",
					sizeBytes: 2048,
					outcome: "success",
					attempt: 1,
					storage: "r2",
					sha256: "ab".repeat(32),
				},
			],
			truncated: false,
			nextOffset: null,
		});
		const { byName } = tools();
		const result = await byName.get("explain_current_run")!.execute({});
		// Rationale is fetched by the run's tedi with the page's own limit; the
		// contract has no runId filter, so matching is client-side like the page.
		expect(rationaleApi.list).toHaveBeenCalledWith({
			tediId: TEDI_ID,
			limit: RUN_RATIONALE_LIMIT,
		});
		expect(skillsApi.listRunArtifacts).toHaveBeenCalledWith({ runId: RUN_ID });
		const structured = result.structuredContent as {
			run: Record<string, unknown>;
			rationale: Array<Record<string, unknown>>;
			artifacts: Array<Record<string, unknown>>;
			deepLink: string;
		};
		expect(structured.run).toEqual(RUN_SUMMARY);
		expect(structured.deepLink).toBe(DEEP_LINK);
		expect(structured.rationale).toHaveLength(1);
		expect(structured.rationale[0]).toMatchObject({
			action: "Sent the brief",
			category: "execution",
			confidence: 0.9,
			outcomeStatus: "success",
			outcome: "delivered",
			createdAt: "2026-08-27T00:04:00Z",
		});
		const text = structured.rationale[0]?.["rationale"] as string;
		expect(text.length).toBeLessThanOrEqual(401);
		expect(text.endsWith("…")).toBe(true);
		expect(structured.artifacts).toEqual([
			{
				path: "out/report.md",
				mimeType: "text/markdown",
				sizeBytes: 2048,
				outcome: "success",
				storage: "r2",
			},
		]);
	});

	it("surfaces an osApi rejection as an isError result, not a throw", async () => {
		skillsApi.inspectWorkflowRun.mockRejectedValue(
			new Error("boom: run not found"),
		);
		const { byName } = tools();
		const result = await byName.get("get_current_run")!.execute({});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("boom");
	});

	it("forwards the browser AbortSignal to the bound run reads", async () => {
		skillsApi.inspectWorkflowRun.mockResolvedValue(inspection());
		const controller = new AbortController();
		const { byName } = tools();
		await byName
			.get("list_current_run_steps")!
			.execute({}, { signal: controller.signal });
		expect(skillsApi.inspectWorkflowRun).toHaveBeenCalledWith(
			{ runId: RUN_ID },
			{ signal: controller.signal },
		);
	});
});
