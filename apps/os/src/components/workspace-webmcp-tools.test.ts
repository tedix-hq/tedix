import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { buildWorkspaceWebMcpTools } from "@/components/workspace-webmcp-tools";
import { osApi } from "@/lib/api";
import { CANVAS_RESOURCE_LIST_LIMIT } from "@/lib/os-query-options";
import type { CanvasDocSelection } from "@/lib/canvas-search";
import type { ModelContextLike } from "@tedix/webmcp-core/model-context";
import {
	registerWebMcpScope,
	setModelContextResolverForTests,
	webMcpRegisteredToolNames,
} from "@tedix/webmcp-core/registry";

vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: {
			workspaces: { get: vi.fn() },
			gadgets: { list: vi.fn(), get: vi.fn() },
			outputs: { list: vi.fn() },
			resources: { list: vi.fn() },
			executions: { list: vi.fn() },
		},
	},
}));

const workspacesApi = osApi.osWorkspaces as unknown as {
	workspaces: { get: ReturnType<typeof vi.fn> };
	gadgets: { list: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
	outputs: { list: ReturnType<typeof vi.fn> };
	resources: { list: ReturnType<typeof vi.fn> };
	executions: { list: ReturnType<typeof vi.fn> };
};

const WORKSPACE_ID = "3f2c1d0e-9a8b-4c7d-8e6f-5a4b3c2d1e0f";
const GADGET_ID = "7a6b5c4d-3e2f-4a1b-9c8d-0e1f2a3b4c5d";
const OUTPUT_ID = "1e2f3a4b-5c6d-4e8f-9a0b-1c2d3e4f5a6b";
const DEEP_LINK = `/workspace/${WORKSPACE_ID}`;

function workspaceDetail() {
	return {
		workspace: {
			id: WORKSPACE_ID,
			organizationId: "org1",
			name: "Growth Ops",
			description: "Weekly growth automations",
			status: "active",
			sourceBlueprintId: "bp1",
			sourceBlueprintRevisionId: "bpr1",
			sourceBlueprintRevisionNumber: 3,
			instantiationPreflight: null,
			rollbackReference: null,
			blueprintDecision: null,
			createdByKind: "user",
			createdById: "user_1",
			createdAt: "2026-08-01T00:00:00Z",
			updatedAt: "2026-08-20T00:00:00Z",
		},
	};
}

function gadgetRow(overrides?: Record<string, unknown>) {
	return {
		id: GADGET_ID,
		organizationId: "org1",
		workspaceId: WORKSPACE_ID,
		name: "Daily digest",
		description: "Sends the daily digest",
		status: "active",
		currentRevisionId: "rev1",
		sourceBlueprintRevisionId: null,
		createdByKind: "user",
		createdById: "user_1",
		createdAt: "2026-08-02T00:00:00Z",
		updatedAt: "2026-08-21T00:00:00Z",
		...overrides,
	};
}

function outputRow() {
	return {
		id: OUTPUT_ID,
		organizationId: "org1",
		workspaceId: WORKSPACE_ID,
		kind: "document",
		title: "Growth report",
		status: "active",
		currentRevisionId: "orev1",
		createdByKind: "tedi",
		createdById: "tedi_1",
		createdAt: "2026-08-03T00:00:00Z",
		updatedAt: "2026-08-22T00:00:00Z",
	};
}

function mockOverviewReads(counts: {
	gadgets: number;
	outputs: number;
	resources: number;
	truncated?: boolean;
}) {
	workspacesApi.workspaces.get.mockResolvedValue(workspaceDetail());
	workspacesApi.gadgets.list.mockResolvedValue({
		items: Array.from({ length: counts.gadgets }, () => gadgetRow()),
		truncated: counts.truncated ?? false,
	});
	workspacesApi.outputs.list.mockResolvedValue({
		items: Array.from({ length: counts.outputs }, () => outputRow()),
		truncated: false,
	});
	workspacesApi.resources.list.mockResolvedValue({
		items: Array.from({ length: counts.resources }, () => ({ id: "res1" })),
		truncated: false,
	});
}

function tools(selection: CanvasDocSelection | null = null) {
	const built = buildWorkspaceWebMcpTools(WORKSPACE_ID, () => selection);
	return { built, byName: new Map(built.map((tool) => [tool.name, tool])) };
}

afterEach(() => {
	setModelContextResolverForTests(null);
	vi.clearAllMocks();
});

describe("buildWorkspaceWebMcpTools", () => {
	it("marks every tool as a read of untrusted content", () => {
		const { built } = tools();
		expect(built).toHaveLength(4);
		for (const tool of built) {
			expect(tool.annotations, tool.name).toEqual({
				readOnlyHint: true,
				untrustedContentHint: true,
			});
		}
	});

	it("registers the four workspace-scoped tools under an id-keyed scope", () => {
		const context: ModelContextLike = {
			provideContext: () => {},
		};
		setModelContextResolverForTests(() => context);
		const dispose = registerWebMcpScope(
			`workspace:${WORKSPACE_ID}`,
			buildWorkspaceWebMcpTools(WORKSPACE_ID, () => null),
		);
		expect(webMcpRegisteredToolNames()).toEqual([
			"get_workspace_overview",
			"get_selected_gadget",
			"list_gadget_executions",
			"list_workspace_outputs",
		]);
		dispose();
	});

	it("get_workspace_overview composes the page's own reads into identity, counts, and selection", async () => {
		mockOverviewReads({ gadgets: 2, outputs: 3, resources: 1 });
		const { byName } = tools({ type: "gadget", id: GADGET_ID });
		const result = await byName.get("get_workspace_overview")!.execute({});
		expect(workspacesApi.workspaces.get).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
		});
		// The three list reads use the page's own canonical inputs.
		expect(workspacesApi.gadgets.list).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
			status: "active",
			limit: CANVAS_RESOURCE_LIST_LIMIT,
		});
		expect(workspacesApi.outputs.list).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
			limit: CANVAS_RESOURCE_LIST_LIMIT,
		});
		expect(workspacesApi.resources.list).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
			status: "active",
			limit: CANVAS_RESOURCE_LIST_LIMIT,
		});
		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({
			workspace: {
				id: WORKSPACE_ID,
				name: "Growth Ops",
				description: "Weekly growth automations",
				status: "active",
				sourceBlueprintId: "bp1",
				createdAt: "2026-08-01T00:00:00Z",
				updatedAt: "2026-08-20T00:00:00Z",
			},
			counts: { gadgets: 2, outputs: 3, resources: 1 },
			truncated: false,
			selectedWorkpiece: { type: "gadget", id: GADGET_ID },
			deepLink: DEEP_LINK,
		});
	});

	it("get_workspace_overview surfaces truncation when any list is truncated", async () => {
		mockOverviewReads({
			gadgets: 1,
			outputs: 0,
			resources: 0,
			truncated: true,
		});
		const { byName } = tools();
		const result = await byName.get("get_workspace_overview")!.execute({});
		expect(result.structuredContent).toMatchObject({
			truncated: true,
			selectedWorkpiece: null,
		});
	});

	it("get_selected_gadget projects the selected gadget with its revision manifest facts", async () => {
		workspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetRow(),
			currentRevision: {
				id: "rev1",
				organizationId: "org1",
				gadgetId: GADGET_ID,
				revision: 4,
				manifest: {
					capabilities: ["gmail_send"],
					entry: "daily-digest",
					skillSlug: "daily-digest",
					notes: "internal",
				},
				sourceArtifactRef: null,
				createdByKind: "user",
				createdById: "user_1",
				createdAt: "2026-08-21T00:00:00Z",
			},
		});
		const { byName } = tools({ type: "gadget", id: GADGET_ID });
		const result = await byName.get("get_selected_gadget")!.execute({});
		expect(workspacesApi.gadgets.get).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
			gadgetId: GADGET_ID,
		});
		expect(result.structuredContent).toEqual({
			selectedWorkpiece: { type: "gadget", id: GADGET_ID },
			gadget: {
				id: GADGET_ID,
				name: "Daily digest",
				description: "Sends the daily digest",
				status: "active",
				createdAt: "2026-08-02T00:00:00Z",
				updatedAt: "2026-08-21T00:00:00Z",
			},
			currentRevision: {
				revision: 4,
				createdAt: "2026-08-21T00:00:00Z",
				capabilities: ["gmail_send"],
				entry: "daily-digest",
				skillSlug: "daily-digest",
			},
			deepLink: `/workspace/${WORKSPACE_ID}?workpiece=gadget:${GADGET_ID}`,
		});
	});

	it("get_selected_gadget reads the selection live through the getter, not at build time", async () => {
		workspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetRow(),
			currentRevision: null,
		});
		let selection: CanvasDocSelection | null = null;
		const built = buildWorkspaceWebMcpTools(WORKSPACE_ID, () => selection);
		const byName = new Map(built.map((tool) => [tool.name, tool]));
		selection = { type: "gadget", id: GADGET_ID };
		const result = await byName.get("get_selected_gadget")!.execute({});
		expect(result.structuredContent).toMatchObject({
			selectedWorkpiece: { type: "gadget", id: GADGET_ID },
			currentRevision: null,
		});
	});

	it("get_selected_gadget with no selection is a non-error null result", async () => {
		const { byName } = tools(null);
		const result = await byName.get("get_selected_gadget")!.execute({});
		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toMatchObject({
			selectedWorkpiece: null,
			gadget: null,
			deepLink: DEEP_LINK,
		});
		expect(workspacesApi.gadgets.get).not.toHaveBeenCalled();
	});

	it("get_selected_gadget with an output selection points at the output without duplicating read_output", async () => {
		const { byName } = tools({ type: "output", id: OUTPUT_ID });
		const result = await byName.get("get_selected_gadget")!.execute({});
		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toMatchObject({
			selectedWorkpiece: { type: "output", id: OUTPUT_ID },
			gadget: null,
			deepLink: `/workspace/${WORKSPACE_ID}?workpiece=output:${OUTPUT_ID}`,
		});
		expect(workspacesApi.gadgets.get).not.toHaveBeenCalled();
	});

	it("list_gadget_executions defaults to the selected gadget and projects compact receipts", async () => {
		workspacesApi.executions.list.mockResolvedValue({
			items: [
				{
					id: "exec1",
					organizationId: "org1",
					workspaceId: WORKSPACE_ID,
					gadgetId: GADGET_ID,
					revisionId: "rev1",
					revision: 4,
					status: "completed",
					grantedCapabilities: ["gmail_send"],
					policyDecision: { mode: "policy" },
					input: null,
					output: { ok: true },
					error: null,
					costs: null,
					evidenceRefs: null,
					lineage: null,
					createdByKind: "user",
					createdById: "user_1",
					createdAt: "2026-08-25T00:00:00Z",
					completedAt: "2026-08-25T00:01:00Z",
				},
			],
			truncated: true,
		});
		const { byName } = tools({ type: "gadget", id: GADGET_ID });
		const result = await byName.get("list_gadget_executions")!.execute({});
		expect(workspacesApi.executions.list).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
			gadgetId: GADGET_ID,
			limit: 20,
		});
		expect(result.structuredContent).toEqual({
			gadgetId: GADGET_ID,
			executions: [
				{
					id: "exec1",
					status: "completed",
					revision: 4,
					createdByKind: "user",
					createdAt: "2026-08-25T00:00:00Z",
					completedAt: "2026-08-25T00:01:00Z",
					error: null,
				},
			],
			truncated: true,
			deepLink: `/workspace/${WORKSPACE_ID}?workpiece=gadget:${GADGET_ID}&view=activity`,
		});
	});

	it("list_gadget_executions accepts an explicit gadgetId and clamps limit to its cap", async () => {
		workspacesApi.executions.list.mockResolvedValue({
			items: [],
			truncated: false,
		});
		const { byName } = tools(null);
		await byName
			.get("list_gadget_executions")!
			.execute({ gadgetId: GADGET_ID, limit: 500 });
		expect(workspacesApi.executions.list).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
			gadgetId: GADGET_ID,
			limit: 50,
		});
	});

	it("list_gadget_executions with no gadget resolvable is an isError result, not a throw", async () => {
		const { byName } = tools(null);
		const result = await byName.get("list_gadget_executions")!.execute({});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("gadgetId is required");
		expect(workspacesApi.executions.list).not.toHaveBeenCalled();
	});

	it("list_workspace_outputs projects compact rows with workbench deep links", async () => {
		workspacesApi.outputs.list.mockResolvedValue({
			items: [outputRow()],
			truncated: false,
		});
		const { byName } = tools();
		const result = await byName.get("list_workspace_outputs")!.execute({});
		expect(workspacesApi.outputs.list).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
			limit: 25,
		});
		expect(result.structuredContent).toEqual({
			items: [
				{
					id: OUTPUT_ID,
					title: "Growth report",
					kind: "document",
					status: "active",
					updatedAt: "2026-08-22T00:00:00Z",
					deepLink: `/workspace/${WORKSPACE_ID}?workpiece=output:${OUTPUT_ID}`,
				},
			],
			truncated: false,
			deepLink: DEEP_LINK,
		});
	});

	it("surfaces an osApi rejection as an isError result, not a throw", async () => {
		workspacesApi.workspaces.get.mockRejectedValue(
			new Error("boom: workspace not found"),
		);
		workspacesApi.gadgets.list.mockResolvedValue({
			items: [],
			truncated: false,
		});
		workspacesApi.outputs.list.mockResolvedValue({
			items: [],
			truncated: false,
		});
		workspacesApi.resources.list.mockResolvedValue({
			items: [],
			truncated: false,
		});
		const { byName } = tools();
		const result = await byName.get("get_workspace_overview")!.execute({});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("boom");
	});

	it("forwards the browser AbortSignal to the bound workspace reads", async () => {
		workspacesApi.executions.list.mockResolvedValue({
			items: [],
			truncated: false,
		});
		const controller = new AbortController();
		const { byName } = tools({ type: "gadget", id: GADGET_ID });
		await byName
			.get("list_gadget_executions")!
			.execute({}, { signal: controller.signal });
		expect(workspacesApi.executions.list).toHaveBeenCalledWith(
			{ workspaceId: WORKSPACE_ID, gadgetId: GADGET_ID, limit: 20 },
			{ signal: controller.signal },
		);
	});
});
