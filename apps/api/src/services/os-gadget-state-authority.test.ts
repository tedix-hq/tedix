import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";
const mocks = vi.hoisted(() => ({
	workspace: vi.fn(),
	gadget: vi.fn(),
	execution: vi.fn(),
	revision: vi.fn(),
	live: vi.fn(),
	sources: vi.fn(),
}));
vi.mock("../rpc/routers/os-workspaces-shared", () => ({
	requireWorkspace: mocks.workspace,
	requireGadget: mocks.gadget,
}));
vi.mock("@tedix/db/query-client", () => ({ createDbQueryClient: () => ({}) }));
vi.mock("@tedix/db/queries/os-workspaces/executions", () => ({
	getOsGadgetExecutionByRunId: mocks.execution,
}));
vi.mock("@tedix/db/queries/os-workspaces/gadgets", () => ({
	getOsGadgetRevision: mocks.revision,
}));
vi.mock("@tedix/db/queries/os-workspaces/gadget-state", () => ({
	hasLiveGadgetStateFence: mocks.live,
}));
vi.mock("./os-derived-resource-access", async (importOriginal) => ({
	...(await importOriginal<typeof import("./os-derived-resource-access")>()),
	authorizeDerivedOutputSources: mocks.sources,
}));
import {
	authorizeGadgetState,
	authorizeGadgetStateSources,
	mergeGadgetStateSources,
} from "./os-gadget-state-authority";
const input = {
	workspaceId: "ws",
	gadgetId: "gadget",
	execution: { executionId: "execution", executionEpoch: 0 },
};
const context = {
	authType: "service-binding",
	tediId: "tedi",
	tediScopes: ["apps:write", "apps:read"],
	organizationId: "org",
	headers: new Headers({
		"X-Tedix-Mcp-Tool-Id": "osGadgetState.put",
		"X-Tedix-Skill-Run-Id": "run",
		"X-Tedix-Workflow-Execution-Epoch": "0",
	}),
	env: { DB: {}, ENVIRONMENT: "production" },
	db: {},
} as unknown as BaseContext;
beforeEach(() => {
	vi.clearAllMocks();
	mocks.workspace.mockResolvedValue({ id: "ws", status: "active" });
	mocks.gadget.mockResolvedValue({
		id: "gadget",
		status: "active",
		currentRevisionId: "revision",
	});
	mocks.execution.mockResolvedValue({
		id: "execution",
		workspaceId: "ws",
		gadgetId: "gadget",
		revisionId: "revision",
		executionEpoch: 0,
		tediId: "tedi",
		resourceAccessEnvelope: '{"version":1,"sources":[]}',
	});
	mocks.revision.mockResolvedValue({
		gadgetId: "gadget",
		manifest:
			'{"entry":"coordinator","capabilities":["os.gadget.state.write","os.gadget.state.read"]}',
	});
	mocks.live.mockResolvedValue(true);
	mocks.sources.mockResolvedValue(true);
});
describe("Gadget state authority", () => {
	it("admits only live pinned authenticated execution and uses trusted actor", async () => {
		const result = await authorizeGadgetState(context, input, true);
		expect(result.fence).toMatchObject({
			tediId: "tedi",
			executionEpoch: 0,
			revisionId: "revision",
		});
	});
	it.each([
		{ authType: "user", user: { sub: "human" } },
		{ authType: "apikey" },
		{ tediId: "other" },
		{ headers: new Headers() },
	])("denies ambient write authority %j", async (patch) => {
		await expect(
			authorizeGadgetState(
				{ ...context, ...patch } as BaseContext,
				input,
				true,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("denies stale epoch and undeclared operation", async () => {
		await expect(
			authorizeGadgetState(
				context,
				{ ...input, execution: { ...input.execution, executionEpoch: 1 } },
				true,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		mocks.revision.mockResolvedValue({
			gadgetId: "gadget",
			manifest: '{"entry":"coordinator","capabilities":[]}',
		});
		await expect(
			authorizeGadgetState(context, input, true),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("denies revoked live source rights before state access", async () => {
		mocks.sources.mockResolvedValue(false);
		await expect(
			authorizeGadgetState(context, input, true),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			authorizeGadgetStateSources(context, "org", '{"version":1,"sources":[]}'),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("preserves source envelope and rejects corrupt persisted provenance", () => {
		const source = {
			workspaceResourceId: "11111111-1111-4111-8111-111111111111",
			workspaceId: "22222222-2222-4222-8222-222222222222",
			providerId: "example",
			resourceType: "calendar",
			providerResourceId: "calendar@example.test",
			connectionScope: "tenant" as const,
			requiredScopes: ["read"],
			operations: ["get"],
		};
		const previous = JSON.stringify({ version: 1, sources: [source] });
		expect(
			mergeGadgetStateSources(previous, { version: 1, sources: [] }),
		).toEqual(JSON.parse(previous));
		expect(
			mergeGadgetStateSources(previous, { version: 1, sources: [source] })
				.sources,
		).toHaveLength(1);
		expect(() =>
			mergeGadgetStateSources("invalid", { version: 1, sources: [] }),
		).toThrow();
	});
});
