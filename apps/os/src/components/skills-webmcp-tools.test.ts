// @vitest-environment node
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import type { ModelContextLike } from "@tedix/webmcp-core/model-context";
import {
	registerWebMcpScope,
	setModelContextResolverForTests,
	webMcpRegisteredToolNames,
} from "@tedix/webmcp-core/registry";

const listByOrg = vi.fn();
const get = vi.fn();
const runWorkflow = vi.fn();
const runWorkflowStatus = vi.fn();
const listTedis = vi.fn();
const invalidateQueries = vi.fn();

vi.mock("@/lib/api", () => ({
	osApi: {
		skills: {
			listByOrg: (...args: unknown[]) => listByOrg(...args),
			get: (...args: unknown[]) => get(...args),
			runWorkflow: (...args: unknown[]) => runWorkflow(...args),
			runWorkflowStatus: (...args: unknown[]) => runWorkflowStatus(...args),
		},
		tedis: { list: (...args: unknown[]) => listTedis(...args) },
	},
}));

vi.mock("@/router", () => ({
	osQueryClient: {
		invalidateQueries: (...args: unknown[]) => invalidateQueries(...args),
	},
}));

vi.mock("@/lib/os-query-options", () => ({
	osQueryKeys: {
		skillRuns: () => ["skill-runs-key"],
	},
}));

import { buildSkillsWebMcpTools } from "@/components/skills-webmcp-tools";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const BOUND_SKILL_ID = "33333333-3333-4333-8333-333333333333";

const TEDIS = {
	data: [
		{
			id: "11111111-1111-4111-8111-111111111111",
			slug: "cto",
			name: "CTO",
			status: "active",
		},
		{
			id: "22222222-2222-4222-8222-222222222222",
			slug: "cmo",
			name: "CMO",
			status: "active",
		},
	],
	pagination: { page: 1, limit: 50, total: 2 },
};

function skillEntry(overrides: Record<string, unknown> = {}) {
	return {
		id: BOUND_SKILL_ID,
		organizationId: "org",
		title: "Weekly digest",
		slug: "weekly-digest",
		description: "Send the weekly digest",
		summary: null,
		content: "# SKILL",
		files: { "SKILL.md": "# SKILL", "scripts/workflow.ts": "export {}" },
		successCount: 4,
		failureCount: 1,
		lastUsedAt: "2026-08-20T00:00:00Z",
		revision: 3,
		visibility: "org",
		lifecycleState: "active",
		...overrides,
	};
}

function runWorkflowOutput() {
	return {
		runId: "run-1",
		workflowInstanceId: "wf-1",
		status: "queued",
		workItemId: null,
		deduplicated: false,
	};
}

function tool(name: string, currentSkillId?: string) {
	const def = buildSkillsWebMcpTools(currentSkillId).find(
		(t) => t.name === name,
	);
	if (!def) throw new Error(`missing tool ${name}`);
	return def;
}

beforeEach(() => {
	listByOrg.mockReset();
	get.mockReset();
	runWorkflow.mockReset();
	runWorkflowStatus.mockReset();
	listTedis.mockReset();
	invalidateQueries.mockReset();
});

afterEach(() => {
	setModelContextResolverForTests(null);
});

describe("buildSkillsWebMcpTools", () => {
	it("marks skill definitions untrusted and workflow dispatch as a write", () => {
		expect(tool("get_skill").annotations).toEqual({
			readOnlyHint: true,
			untrustedContentHint: true,
		});
		expect(tool("run_skill_workflow").annotations).toEqual({
			readOnlyHint: false,
			untrustedContentHint: false,
		});
	});

	it("registers the four skills tools under the unbound skills scope", () => {
		const context: ModelContextLike = { provideContext: () => {} };
		setModelContextResolverForTests(() => context);
		const dispose = registerWebMcpScope("skills", buildSkillsWebMcpTools());
		expect(webMcpRegisteredToolNames()).toEqual([
			"list_skills",
			"get_skill",
			"run_skill_workflow",
			"get_skill_run_status",
		]);
		dispose();
	});

	it("registers the same tool names under a bound skill scope", () => {
		const context: ModelContextLike = { provideContext: () => {} };
		setModelContextResolverForTests(() => context);
		const dispose = registerWebMcpScope(
			`skills:${BOUND_SKILL_ID}`,
			buildSkillsWebMcpTools(BOUND_SKILL_ID),
		);
		expect(webMcpRegisteredToolNames()).toEqual([
			"list_skills",
			"get_skill",
			"run_skill_workflow",
			"get_skill_run_status",
		]);
		dispose();
	});

	it("requires skillId in the schemas only when no skill is bound", () => {
		expect(tool("get_skill").inputSchema["required"]).toEqual(["skillId"]);
		expect(
			tool("get_skill", BOUND_SKILL_ID).inputSchema["required"],
		).toBeUndefined();
		// Derived schema order: picked contract fields first, extras after.
		expect(tool("run_skill_workflow").inputSchema["required"]).toEqual([
			"skillId",
			"reason",
			"tediSlug",
		]);
		expect(
			tool("run_skill_workflow", BOUND_SKILL_ID).inputSchema["required"],
		).toEqual(["reason", "tediSlug"]);
	});
});

describe("list_skills", () => {
	it("passes filters through with the summary projection and maps compact rows", async () => {
		listByOrg.mockResolvedValue({
			entries: [skillEntry({ files: null })],
			total: 1,
		});

		const result = await tool("list_skills").execute({
			limit: 10,
			domain: "marketing",
			tediId: TEDIS.data[0]!.id,
		});

		expect(listByOrg).toHaveBeenCalledWith({
			limit: 10,
			domain: "marketing",
			tediId: TEDIS.data[0]!.id,
			summary: true,
		});
		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({
			skills: [
				{
					id: BOUND_SKILL_ID,
					slug: "weekly-digest",
					title: "Weekly digest",
					description: "Send the weekly digest",
					lifecycleState: "active",
					deepLink: `/skills/${BOUND_SKILL_ID}`,
					// no `executable`: the summary projection nulls `files`.
				},
			],
			total: 1,
		});
	});

	it("defaults limit to 25 and maps a rejection to isError", async () => {
		listByOrg.mockResolvedValue({ entries: [], total: 0 });
		await tool("list_skills").execute({});
		expect(listByOrg.mock.calls[0]![0]).toMatchObject({ limit: 25 });

		listByOrg.mockRejectedValue(new Error("timeout"));
		const result = await tool("list_skills").execute({});
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("timeout");
	});
});

describe("get_skill", () => {
	it("requires skillId when no skill is bound", async () => {
		const result = await tool("get_skill").execute({});
		expect(result.isError).toBe(true);
		expect(get).not.toHaveBeenCalled();
	});

	it("defaults to the bound skill id and reports executability", async () => {
		get.mockResolvedValue({ entry: skillEntry() });

		const result = await tool("get_skill", BOUND_SKILL_ID).execute({});

		expect(get).toHaveBeenCalledWith({ id: BOUND_SKILL_ID });
		expect(result.structuredContent).toMatchObject({
			id: BOUND_SKILL_ID,
			title: "Weekly digest",
			lifecycleState: "active",
			executable: true,
			successCount: 4,
			failureCount: 1,
			deepLink: `/skills/${BOUND_SKILL_ID}`,
		});
	});

	it("prefers an explicit skillId over the bound one and errors on a miss", async () => {
		get.mockResolvedValue({ entry: null });
		const result = await tool("get_skill", BOUND_SKILL_ID).execute({
			skillId: "other-id",
		});
		expect(get).toHaveBeenCalledWith({ id: "other-id" });
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("other-id");
	});
});

describe("run_skill_workflow", () => {
	it("resolves tediSlug to the tedi id, mints an idempotency key, and omits confirmDestructive by default", async () => {
		listTedis.mockResolvedValue(TEDIS);
		runWorkflow.mockResolvedValue(runWorkflowOutput());

		const result = await tool("run_skill_workflow", BOUND_SKILL_ID).execute({
			tediSlug: "cmo",
			reason: "Agent-dispatched weekly digest",
			params: { week: 35 },
		});

		expect(runWorkflow).toHaveBeenCalledTimes(1);
		const input = runWorkflow.mock.calls[0]![0] as Record<string, unknown>;
		expect(input["skillId"]).toBe(BOUND_SKILL_ID);
		expect(input["tediId"]).toBe(TEDIS.data[1]!.id);
		expect(input["reason"]).toBe("Agent-dispatched weekly digest");
		expect(input["params"]).toEqual({ week: 35 });
		expect(input["idempotencyKey"]).toMatch(UUID_RE);
		expect(input["confirmDestructive"]).toBeUndefined();

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({
			runId: "run-1",
			status: "queued",
			deduplicated: false,
			deepLink: "/work/runs/run-1",
		});
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: ["skill-runs-key"],
		});
	});

	it("maps confirm: true to confirmDestructive: true", async () => {
		listTedis.mockResolvedValue(TEDIS);
		runWorkflow.mockResolvedValue(runWorkflowOutput());

		await tool("run_skill_workflow").execute({
			skillId: BOUND_SKILL_ID,
			tediSlug: "cto",
			reason: "Confirmed destructive run",
			confirm: true,
		});

		expect(runWorkflow.mock.calls[0]![0]).toMatchObject({
			skillId: BOUND_SKILL_ID,
			tediId: TEDIS.data[0]!.id,
			confirmDestructive: true,
		});
	});

	it("errors when neither skillId nor a bound skill is available", async () => {
		const result = await tool("run_skill_workflow").execute({
			tediSlug: "cto",
			reason: "x",
		});
		expect(result.isError).toBe(true);
		expect(runWorkflow).not.toHaveBeenCalled();
	});

	it("rejects an unknown tedi slug with the valid slugs listed", async () => {
		listTedis.mockResolvedValue(TEDIS);

		const result = await tool("run_skill_workflow", BOUND_SKILL_ID).execute({
			tediSlug: "nope",
			reason: "x",
		});

		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain('"nope"');
		expect(result.content[0]!.text).toContain("cto");
		expect(result.content[0]!.text).toContain("cmo");
		expect(runWorkflow).not.toHaveBeenCalled();
		expect(invalidateQueries).not.toHaveBeenCalled();
	});

	it("maps a dispatch rejection to isError without invalidating", async () => {
		listTedis.mockResolvedValue(TEDIS);
		runWorkflow.mockRejectedValue(new Error("budget exhausted"));

		const result = await tool("run_skill_workflow", BOUND_SKILL_ID).execute({
			tediSlug: "cto",
			reason: "x",
		});

		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("budget exhausted");
		expect(invalidateQueries).not.toHaveBeenCalled();
	});
});

describe("get_skill_run_status", () => {
	it("returns a compact run snapshot with the run deep link", async () => {
		runWorkflowStatus.mockResolvedValue({
			id: "run-1",
			organizationId: "org",
			skillId: BOUND_SKILL_ID,
			tediId: TEDIS.data[0]!.id,
			workflowInstanceId: "wf-1",
			runtimeEnvironment: "production",
			executionEpoch: 0,
			status: "running",
			startedAt: "2026-08-26T00:00:00Z",
			completedAt: null,
			error: null,
		});

		const result = await tool("get_skill_run_status").execute({
			runId: "run-1",
		});

		expect(runWorkflowStatus).toHaveBeenCalledWith({ runId: "run-1" });
		expect(result.structuredContent).toEqual({
			runId: "run-1",
			status: "running",
			skillId: BOUND_SKILL_ID,
			tediId: TEDIS.data[0]!.id,
			startedAt: "2026-08-26T00:00:00Z",
			completedAt: null,
			error: null,
			deepLink: "/work/runs/run-1",
		});
	});

	it("maps a rejection to isError", async () => {
		runWorkflowStatus.mockRejectedValue(new Error("not found"));
		const result = await tool("get_skill_run_status").execute({
			runId: "run-x",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("not found");
	});
});

describe("WebMCP execution cancellation", () => {
	it("forwards the browser AbortSignal to skill reads", async () => {
		const controller = new AbortController();
		await tool("list_skills").execute({}, { signal: controller.signal });
		expect(listByOrg).toHaveBeenCalledWith(
			expect.objectContaining({ summary: true }),
			{ signal: controller.signal },
		);
	});
});
