import { QueryClient } from "@tanstack/react-query";
import * as localInference from "@/lib/local-inference";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const api = vi.hoisted(() => ({
	listWorkspaces: vi.fn(),
	listGadgets: vi.fn(),
	listOutputs: vi.fn(),
	getOutput: vi.fn(),
	inspectRun: vi.fn(),
	listPreferences: vi.fn(),
	listLibrary: vi.fn(),
	listTedis: vi.fn(),
	listTediSummaries: vi.fn(),
	listBlueprints: vi.fn(),
	listGallery: vi.fn(),
	listSkills: vi.fn(),
	getSkill: vi.fn(),
	getSkillReliability: vi.fn(),
	listSkillRevisions: vi.fn(),
	listDefinitionHealth: vi.fn(),
	listSchedules: vi.fn(),
	listCatalog: vi.fn(),
	listCatalogCategories: vi.fn(),
	getCatalogStats: vi.fn(),
	getCatalogHealth: vi.fn(),
	getCatalogApp: vi.fn(),
	listModels: vi.fn(),
	getOperationalContext: vi.fn(),
	listApprovals: vi.fn(),
	listWorkItems: vi.fn(),
	listReadinessProjection: vi.fn(),
	getControlTower: vi.fn(),
	getReadiness: vi.fn(),
	listAttempts: vi.fn(),
	listEvidence: vi.fn(),
	listAttemptProjection: vi.fn(),
	listEvidenceProjection: vi.fn(),
	listRecoveryProjection: vi.fn(),
	listEvents: vi.fn(),
	listRelations: vi.fn(),
	listProjects: vi.fn(),
	getProjectRollup: vi.fn(),
	listSkillRuns: vi.fn(),
	getWorkItem: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: {
			workspaces: { list: api.listWorkspaces },
			gadgets: { list: api.listGadgets },
			outputs: {
				get: api.getOutput,
				list: api.listOutputs,
				library: api.listLibrary,
			},
			workspacePreferences: { list: api.listPreferences },
			blueprints: { list: api.listBlueprints, gallery: api.listGallery },
		},
		tedis: {
			list: api.listTedis,
			listOperationsSummaries: api.listTediSummaries,
		},
		skills: {
			inspectWorkflowRun: api.inspectRun,
			listByOrg: api.listSkills,
			get: api.getSkill,
			getWorkflowReliability: api.getSkillReliability,
			listWorkflowRevisions: api.listSkillRevisions,
			listWorkflowSchedules: api.listSchedules,
			runWorkflowHistory: api.listSkillRuns,
		},
		tediApprovals: { list: api.listApprovals },
		workItems: {
			list: api.listWorkItems,
			listReadinessProjection: api.listReadinessProjection,
			getById: api.getWorkItem,
			getReadiness: api.getReadiness,
			listAttempts: api.listAttempts,
			listEvidence: api.listEvidence,
			listAttemptProjection: api.listAttemptProjection,
			listEvidenceProjection: api.listEvidenceProjection,
			listRecoveryProjection: api.listRecoveryProjection,
			listEvents: api.listEvents,
			listRelations: api.listRelations,
		},
		workFleet: { getControlTower: api.getControlTower },
		projects: { list: api.listProjects, getRollup: api.getProjectRollup },
		workflows: { listDefinitionHealth: api.listDefinitionHealth },
		catalog: {
			list: api.listCatalog,
			getCategories: api.listCatalogCategories,
			getStats: api.getCatalogStats,
			getHealthSummary: api.getCatalogHealth,
			getBySlug: api.getCatalogApp,
		},
		modelCatalog: { list: api.listModels },
		userSettings: { getContext: api.getOperationalContext },
	},
}));

import {
	OS_LOADER_FIRST_PAINT_DEADLINE_MS,
	optionalUuidSearchParam,
	prefetchBlueprintsRoute,
	prefetchWorkQueueRoute,
	prefetchWorkPortfolioRoute,
	prefetchWorkAttemptsRoute,
	prefetchWorkRecoveryRoute,
	prefetchCatalogRoute,
	prefetchAdminBillingRoute,
	prefetchCanvasRoute,
	prefetchCreateTediRoute,
	prefetchOutputRoute,
	prefetchOutputsRoute,
	prefetchSkillsRoute,
	prefetchSkillDetailRoute,
	prefetchSkillOverviewRoute,
	prefetchSkillRunsRoute,
	prefetchSkillScheduleRoute,
	prefetchSkillVersionsRoute,
	prefetchTeamRoute,
	prefetchWorkspacesRoute,
} from "@/lib/os-route-loaders";
import {
	activeOutputLibraryQueryOptions,
	activeWorkspacesQueryOptions,
	BLUEPRINT_GALLERY_LIMIT,
	BLUEPRINTS_LIST_LIMIT,
	blueprintGalleryQueryOptions,
	blueprintListQueryOptions,
	catalogCategoriesQueryOptions,
	catalogHealthSummaryQueryOptions,
	catalogListQueryOptions,
	catalogStatsQueryOptions,
	modelCatalogQueryOptions,
	operationalContextQueryOptions,
	outputDetailQueryOptions,
	SKILL_CATALOG_LIMIT,
	SKILL_SCHEDULES_LIMIT,
	skillCatalogQueryOptions,
	skillDetailQueryOptions,
	skillReliabilityQueryOptions,
	skillRevisionsQueryOptions,
	skillRunsQueryOptions,
	skillSchedulesQueryOptions,
	skillSpecificSchedulesQueryOptions,
	TEDI_ROSTER_LIMIT,
	tediOperationsSummariesQueryOptions,
	tediRosterQueryOptions,
	WORKFLOW_DEFINITIONS_LIMIT,
	workflowDefinitionHealthQueryOptions,
	workflowRunInspectQueryOptions,
	workFleetQueryOptions,
	projectListQueryOptions,
	projectRollupQueryOptions,
	workReadinessProjectionQueryOptions,
	workAttemptProjectionQueryOptions,
	workRecoveryProjectionQueryOptions,
	workspacePreferencesQueryOptions,
} from "@/lib/os-query-options";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const OUTPUT_ID = "00000000-0000-4000-8000-000000000002";

function client() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	api.listWorkspaces.mockResolvedValue({ items: [], truncated: false });
	api.listGadgets.mockResolvedValue({ items: [], truncated: false });
	api.listOutputs.mockResolvedValue({ items: [], truncated: false });
	api.getOutput.mockResolvedValue({ id: OUTPUT_ID });
	api.inspectRun.mockResolvedValue({ run: { id: "run-123" } });
	const empty = { items: [], truncated: false };
	api.listPreferences.mockResolvedValue(empty);
	api.listLibrary.mockResolvedValue(empty);
	api.listTedis.mockResolvedValue(empty);
	api.listTediSummaries.mockResolvedValue(empty);
	api.listBlueprints.mockResolvedValue(empty);
	api.listGallery.mockResolvedValue(empty);
	api.listSkills.mockResolvedValue(empty);
	api.getSkill.mockResolvedValue({ entry: { id: OUTPUT_ID } });
	api.getSkillReliability.mockResolvedValue({ runs: [] });
	api.listSkillRevisions.mockResolvedValue({ revisions: [] });
	api.listDefinitionHealth.mockResolvedValue(empty);
	api.listSchedules.mockResolvedValue(empty);
	api.listCatalog.mockResolvedValue({
		apps: [],
		total: 0,
		pagination: { limit: 30, offset: 0, hasMore: false },
	});
	api.listCatalogCategories.mockResolvedValue([]);
	api.getCatalogStats.mockResolvedValue({
		total: 0,
		mcp: 0,
		withInteractive: 0,
		withWrites: 0,
	});
	api.getCatalogHealth.mockResolvedValue({});
	api.getCatalogApp.mockResolvedValue({ id: "catalog-app" });
	api.listModels.mockResolvedValue({ models: [] });
	api.getOperationalContext.mockResolvedValue({
		organization: { id: "00000000-0000-4000-8000-000000000003" },
		permissions: ["tedis:create"],
	});
	api.listApprovals.mockResolvedValue({ data: [] });
	api.listWorkItems.mockResolvedValue({
		data: [],
		pagination: { total: 0, limit: 50, offset: 0, hasMore: false },
	});
	api.listReadinessProjection.mockResolvedValue({
		data: [],
		nextCursor: null,
		hasMore: false,
		observedAt: "2026-08-20T00:00:00.000Z",
	});
	api.getControlTower.mockResolvedValue({
		observedAt: "2026-10-03T09:30:00.000Z",
		attention: { actions: [] },
	});
	api.listRelations.mockResolvedValue({ relations: [], truncated: false });
	api.listProjects.mockResolvedValue({ data: [] });
	api.getProjectRollup.mockResolvedValue({});
	api.listSkillRuns.mockResolvedValue({ runs: [] });
	api.getWorkItem.mockResolvedValue({
		workItem: {},
		comments: [],
		projections: [],
	});
	api.getReadiness.mockResolvedValue({
		workItemId: OUTPUT_ID,
		state: "ready",
		ready: true,
		reasons: [],
		derivedAt: "2026-08-20T00:00:00.000Z",
	});
	api.listAttempts.mockResolvedValue({ data: [], nextCursor: null });
	api.listEvidence.mockResolvedValue({ data: [], nextCursor: null });
	api.listAttemptProjection.mockResolvedValue({
		data: [],
		nextCursor: null,
		hasMore: false,
	});
	api.listEvidenceProjection.mockResolvedValue({
		data: [],
		nextCursor: null,
		hasMore: false,
	});
	api.listRecoveryProjection.mockResolvedValue({
		data: [],
		nextCursor: null,
		hasMore: false,
		observedAt: "2026-08-20T00:00:00.000Z",
	});
	api.listEvents.mockResolvedValue({ events: [], nextSequence: null });
});

describe("OS route loaders", () => {
	it("does not warm unavailable fleet capabilities locally", async () => {
		const local = vi
			.spyOn(localInference, "isLocalSession")
			.mockReturnValue(true);
		const queryClient = client();
		const ensure = vi.spyOn(queryClient, "ensureQueryData");
		try {
			await prefetchCatalogRoute(queryClient, { offset: 0 });
			await prefetchAdminBillingRoute(queryClient);
			expect(ensure).not.toHaveBeenCalled();
		} finally {
			local.mockRestore();
		}
	});
	it("warms the Portfolio component's first page and deduplicates its following read", async () => {
		const queryClient = client();
		const projects = Array.from({ length: 20 }, (_, index) => ({
			id: `project-${index}`,
		}));
		api.listProjects.mockResolvedValue({
			data: projects,
			pagination: { limit: 20, offset: 0, total: 72, hasMore: true },
		});
		await prefetchWorkPortfolioRoute(queryClient);
		expect(api.listProjects).toHaveBeenCalledWith(
			{ limit: 20, offset: 0 },
			expect.anything(),
		);
		expect(
			queryClient.getQueryData(
				projectListQueryOptions(20, { offset: 0 }).queryKey,
			),
		).toMatchObject({ data: projects });
		expect(
			queryClient.getQueryData(projectListQueryOptions(100).queryKey),
		).toBeUndefined();
		await queryClient.ensureQueryData(
			projectListQueryOptions(20, { offset: 0 }),
		);
		expect(api.listProjects).toHaveBeenCalledTimes(1);
		expect(api.getProjectRollup).toHaveBeenCalledTimes(20);
		for (const project of projects)
			expect(
				queryClient.getQueryData(
					projectRollupQueryOptions(project.id).queryKey,
				),
			).toBeDefined();
	});
	it("bounds Portfolio rollups even if a server returns beyond the requested page", async () => {
		api.listProjects.mockResolvedValue({
			data: Array.from({ length: 72 }, (_, index) => ({
				id: `project-${index}`,
			})),
		});
		await prefetchWorkPortfolioRoute(client());
		expect(api.getProjectRollup).toHaveBeenCalledTimes(20);
		expect(api.getProjectRollup).not.toHaveBeenCalledWith(
			{ id: "project-20" },
			expect.anything(),
		);
	});
	it("lands Portfolio after a list failure without starting rollups", async () => {
		api.listProjects.mockRejectedValue(new Error("List unavailable"));
		await expect(prefetchWorkPortfolioRoute(client())).resolves.toBeUndefined();
		expect(api.getProjectRollup).not.toHaveBeenCalled();
	});
	it("retains Portfolio projects and other rollups when one rollup fails", async () => {
		const queryClient = client();
		api.listProjects.mockResolvedValue({
			data: [{ id: "failed" }, { id: "healthy" }],
		});
		api.getProjectRollup.mockImplementation(({ id }) =>
			id === "failed"
				? Promise.reject(new Error("Rollup unavailable"))
				: Promise.resolve({ percentDone: 0.5 }),
		);
		await expect(
			prefetchWorkPortfolioRoute(queryClient),
		).resolves.toBeUndefined();
		expect(
			queryClient.getQueryData(
				projectListQueryOptions(20, { offset: 0 }).queryKey,
			),
		).toBeDefined();
		expect(
			queryClient.getQueryData(projectRollupQueryOptions("healthy").queryKey),
		).toEqual({ percentDone: 0.5 });
	});
	it.each(["list", "rollup"] as const)(
		"releases Portfolio by its first-paint deadline when %s stalls",
		async (stage) => {
			vi.useFakeTimers();
			try {
				const queryClient = client();
				let rejectRead!: (error: Error) => void;
				api.listProjects.mockResolvedValue({ data: [{ id: "project-1" }] });
				const stalled =
					stage === "list" ? api.listProjects : api.getProjectRollup;
				stalled.mockImplementation(
					() =>
						new Promise((_, reject) => {
							rejectRead = reject;
						}),
				);
				const routeLoad = prefetchWorkPortfolioRoute(queryClient);
				const resolved = expect(routeLoad).resolves.toBeUndefined();
				await vi.advanceTimersByTimeAsync(OS_LOADER_FIRST_PAINT_DEADLINE_MS);
				await resolved;
				rejectRead(new Error("Late failure"));
				await vi.advanceTimersByTimeAsync(0);
				expect(api.listProjects).toHaveBeenCalledTimes(1);
			} finally {
				vi.useRealTimers();
			}
		},
	);
	it("prefetches the bounded queue projection without per-item readiness fanout", async () => {
		const queryClient = client();
		await prefetchWorkQueueRoute(queryClient);
		expect(
			queryClient.getQueryData(workFleetQueryOptions().queryKey),
		).toBeDefined();
		expect(api.getControlTower).toHaveBeenCalledWith({}, expect.anything());
		expect(api.listReadinessProjection).toHaveBeenCalledWith(
			{ limit: 25 },
			expect.anything(),
		);
		expect(api.listWorkItems).not.toHaveBeenCalled();
		expect(api.getReadiness).not.toHaveBeenCalled();
	});
	it("starts queue and attention reads concurrently", async () => {
		let resolveQueue!: (value: unknown) => void;
		let resolveAttention!: (value: unknown) => void;
		api.listReadinessProjection.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveQueue = resolve;
				}),
		);
		api.getControlTower.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveAttention = resolve;
				}),
		);
		const routeLoad = prefetchWorkQueueRoute(client());
		expect(api.listReadinessProjection).toHaveBeenCalledTimes(1);
		expect(api.getControlTower).toHaveBeenCalledTimes(1);
		resolveQueue({ data: [] });
		resolveAttention({ attention: { actions: [] } });
		await expect(routeLoad).resolves.toBeUndefined();
	});
	it.each(["queue", "attention"] as const)(
		"releases the route by its deadline when %s stalls and handles late rejection",
		async (projection) => {
			vi.useFakeTimers();
			try {
				let rejectRead!: (reason: Error) => void;
				const stalledRead =
					projection === "queue"
						? api.listReadinessProjection
						: api.getControlTower;
				stalledRead.mockImplementation(
					() =>
						new Promise((_, reject) => {
							rejectRead = reject;
						}),
				);
				const routeLoad = prefetchWorkQueueRoute(client());
				const resolved = expect(routeLoad).resolves.toBeUndefined();
				await vi.advanceTimersByTimeAsync(OS_LOADER_FIRST_PAINT_DEADLINE_MS);
				await resolved;
				expect(api.listReadinessProjection).toHaveBeenCalledTimes(1);
				expect(api.getControlTower).toHaveBeenCalledTimes(1);
				rejectRead(new Error("Late projection failure"));
				await vi.advanceTimersByTimeAsync(0);
			} finally {
				vi.useRealTimers();
			}
		},
	);
	it.each(["queue", "attention"] as const)(
		"lands when %s fails and preserves the other projection cache",
		async (projection) => {
			const queryClient = client();
			const failingRead =
				projection === "queue"
					? api.listReadinessProjection
					: api.getControlTower;
			failingRead.mockRejectedValue(new Error("Projection unavailable"));
			await expect(
				prefetchWorkQueueRoute(queryClient),
			).resolves.toBeUndefined();
			const successfulOptions =
				projection === "queue"
					? workFleetQueryOptions()
					: workReadinessProjectionQueryOptions();
			expect(
				queryClient.getQueryData(successfulOptions.queryKey),
			).toBeDefined();
		},
	);
	it("validates Canvas workspace search and prefetches its shared query once", async () => {
		const queryClient = client();

		expect(optionalUuidSearchParam(WORKSPACE_ID)).toBe(WORKSPACE_ID);
		expect(optionalUuidSearchParam("not-a-uuid")).toBeUndefined();
		await prefetchCanvasRoute(queryClient);
		await queryClient.fetchQuery(activeWorkspacesQueryOptions());

		expect(api.listWorkspaces).toHaveBeenCalledTimes(1);
		expect(api.listWorkspaces).toHaveBeenCalledWith(
			{ status: "active", limit: 100 },
			expect.anything(),
		);
	});

	it("pipelines a validated Canvas reopen with deterministic latency evidence", async () => {
		vi.useFakeTimers();
		try {
			const workspaceMs = 80;
			const gadgetMs = 40;
			const outputMs = 60;
			api.listWorkspaces.mockImplementation(
				() =>
					new Promise((resolve) =>
						setTimeout(
							() =>
								resolve({ items: [{ id: WORKSPACE_ID }], truncated: false }),
							workspaceMs,
						),
					),
			);
			api.listGadgets.mockImplementation(
				() =>
					new Promise((resolve) =>
						setTimeout(
							() => resolve({ items: [], truncated: false }),
							gadgetMs,
						),
					),
			);
			api.listOutputs.mockImplementation(
				() =>
					new Promise((resolve) =>
						setTimeout(
							() => resolve({ items: [], truncated: false }),
							outputMs,
						),
					),
			);

			let settled = false;
			const startedAt = Date.now();
			const prefetch = prefetchCanvasRoute(client(), WORKSPACE_ID).then(() => {
				settled = true;
				return Date.now() - startedAt;
			});
			// All independent calls start in the same turn. The former waterfall did
			// not start resource reads until the 80 ms workspace read had finished.
			expect(api.listWorkspaces).toHaveBeenCalledOnce();
			expect(api.listGadgets).toHaveBeenCalledOnce();
			expect(api.listOutputs).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(workspaceMs - 1);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			const elapsed = await prefetch;
			const priorSerialCriticalPathMs =
				workspaceMs + Math.max(gadgetMs, outputMs);
			expect(elapsed).toBe(workspaceMs);
			expect(priorSerialCriticalPathMs - elapsed).toBe(60);
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects an invalid output identity before issuing a request", async () => {
		await expect(
			prefetchOutputRoute(client(), "not-an-output"),
		).rejects.toMatchObject({ isNotFound: true });
		expect(api.getOutput).not.toHaveBeenCalled();
	});

	it("prefetches output detail into a reusable Query cache entry", async () => {
		const queryClient = client();

		await prefetchOutputRoute(queryClient, OUTPUT_ID);
		await queryClient.fetchQuery(outputDetailQueryOptions(OUTPUT_ID));

		expect(api.getOutput).toHaveBeenCalledTimes(1);
	});
});

describe("list-route prefetchers", () => {
	/*
	 * The property that decides whether a loader is worth anything: it must warm
	 * the EXACT cache entry its surface reads. A generated key encodes the whole
	 * input, so a loader that passed a different limit would populate a
	 * neighbouring entry, the surface would still fetch on mount, and nothing
	 * would look wrong — the prefetch would just silently do nothing. Each case
	 * below asserts against the same option object the component calls.
	 */

	it("warms the exact entries the workspaces surface reads", async () => {
		const queryClient = client();
		await prefetchWorkspacesRoute(queryClient);

		expect(
			queryClient.getQueryData(activeWorkspacesQueryOptions().queryKey),
		).toBeDefined();
		expect(
			queryClient.getQueryData(workspacePreferencesQueryOptions().queryKey),
		).toBeDefined();
	});

	it("warms each org-wide Work factory projection without Work Item fanout", async () => {
		const queryClient = client();

		await Promise.all([
			prefetchWorkAttemptsRoute(queryClient),
			prefetchWorkRecoveryRoute(queryClient),
		]);

		expect(
			queryClient.getQueryData(workAttemptProjectionQueryOptions().queryKey),
		).toBeDefined();
		expect(
			queryClient.getQueryData(workRecoveryProjectionQueryOptions().queryKey),
		).toBeDefined();
		expect(api.listAttemptProjection).toHaveBeenCalledWith(
			{ limit: 100 },
			expect.anything(),
		);
		expect(api.listRecoveryProjection).toHaveBeenCalledWith(
			{ limit: 100 },
			expect.anything(),
		);
		expect(api.listWorkItems).not.toHaveBeenCalled();
		expect(api.listAttempts).not.toHaveBeenCalled();
		expect(api.listEvidence).not.toHaveBeenCalled();
		expect(api.getReadiness).not.toHaveBeenCalled();
	});

	it("warms the exact entry the outputs library reads", async () => {
		const queryClient = client();
		await prefetchOutputsRoute(queryClient);

		expect(
			queryClient.getQueryData(activeOutputLibraryQueryOptions().queryKey),
		).toBeDefined();
	});

	it("warms the exact entries the team surface reads", async () => {
		const queryClient = client();
		await prefetchTeamRoute(queryClient);

		expect(
			queryClient.getQueryData(
				tediRosterQueryOptions(TEDI_ROSTER_LIMIT).queryKey,
			),
		).toBeDefined();
		expect(api.listTediSummaries).not.toHaveBeenCalled();
	});

	it("warms the creation wizard's model and authority entries", async () => {
		const queryClient = client();
		await prefetchCreateTediRoute(queryClient);

		expect(
			queryClient.getQueryData(modelCatalogQueryOptions().queryKey),
		).toBeDefined();
		expect(
			queryClient.getQueryData(operationalContextQueryOptions().queryKey),
		).toBeDefined();
	});

	it("warms the exact entries the blueprints surface reads", async () => {
		const queryClient = client();
		await prefetchBlueprintsRoute(queryClient);

		expect(
			queryClient.getQueryData(
				blueprintListQueryOptions(BLUEPRINTS_LIST_LIMIT).queryKey,
			),
		).toBeDefined();
		expect(
			queryClient.getQueryData(
				blueprintGalleryQueryOptions(BLUEPRINT_GALLERY_LIMIT).queryKey,
			),
		).toBeDefined();
	});

	it("warms the exact entries the skills surface reads", async () => {
		const queryClient = client();
		await prefetchSkillsRoute(queryClient);

		expect(
			queryClient.getQueryData(
				skillCatalogQueryOptions(SKILL_CATALOG_LIMIT).queryKey,
			),
		).toBeDefined();
		expect(
			queryClient.getQueryData(
				workflowDefinitionHealthQueryOptions(WORKFLOW_DEFINITIONS_LIMIT)
					.queryKey,
			),
		).toBeDefined();
		expect(
			queryClient.getQueryData(
				skillSchedulesQueryOptions(SKILL_SCHEDULES_LIMIT).queryKey,
			),
		).toBeDefined();
	});

	it("prefetches only the active URL-backed Skills section and page", async () => {
		const queryClient = client();
		await prefetchSkillsRoute(queryClient, {
			section: "triggers",
			q: "weekly",
			page: 2,
		});

		expect(api.listSchedules).toHaveBeenCalledWith(
			{ limit: 20, offset: 20, query: "weekly" },
			expect.anything(),
		);
		expect(api.listSkills).not.toHaveBeenCalled();
		expect(api.listDefinitionHealth).not.toHaveBeenCalled();
	});

	it("requires an authoritative UUID skill detail before warming its lazy siblings", async () => {
		const queryClient = client();
		await expect(
			prefetchSkillDetailRoute(queryClient, "not-a-uuid"),
		).rejects.toMatchObject({ isNotFound: true });
		expect(api.getSkill).not.toHaveBeenCalled();

		await expect(
			prefetchSkillDetailRoute(queryClient, OUTPUT_ID),
		).resolves.toEqual({ skillId: OUTPUT_ID });
		expect(api.getSkill).toHaveBeenCalledWith(
			{ id: OUTPUT_ID },
			expect.anything(),
		);
		expect(
			queryClient.getQueryData(skillDetailQueryOptions(OUTPUT_ID).queryKey),
		).toBeDefined();

		await Promise.all([
			prefetchSkillOverviewRoute(queryClient, OUTPUT_ID),
			prefetchSkillRunsRoute(queryClient, OUTPUT_ID, "queued"),
			prefetchSkillVersionsRoute(queryClient, OUTPUT_ID),
			prefetchSkillScheduleRoute(queryClient, OUTPUT_ID),
		]);
		expect(
			queryClient.getQueryData(
				skillReliabilityQueryOptions(OUTPUT_ID).queryKey,
			),
		).toBeDefined();
		expect(
			queryClient.getQueryData(
				skillRunsQueryOptions(OUTPUT_ID, "queued").queryKey,
			),
		).toBeDefined();
		expect(
			queryClient.getQueryData(skillRevisionsQueryOptions(OUTPUT_ID).queryKey),
		).toBeDefined();
		expect(
			queryClient.getQueryData(
				skillSpecificSchedulesQueryOptions(OUTPUT_ID).queryKey,
			),
		).toBeDefined();
		expect(api.listSchedules).toHaveBeenCalledWith(
			{ skillId: OUTPUT_ID, limit: SKILL_SCHEDULES_LIMIT },
			expect.anything(),
		);
	});

	it("treats a missing authoritative skill entry as not found", async () => {
		api.getSkill.mockResolvedValueOnce({ entry: null });
		await expect(
			prefetchSkillDetailRoute(client(), OUTPUT_ID),
		).rejects.toMatchObject({ isNotFound: true });
	});

	it("warms discovery without fetching optional catalog diagnostics", async () => {
		const queryClient = client();
		const search = {
			search: "mail",
			category: "PRODUCTIVITY",
			connectorType: "MCP" as const,
			sortBy: "name" as const,
			healthStatus: "healthy" as const,
			offset: 30,
		};
		await prefetchCatalogRoute(queryClient, search);
		const input = { ...search, limit: 30 };

		expect(
			queryClient.getQueryData(catalogListQueryOptions(input).queryKey),
		).toBeDefined();
		expect(
			queryClient.getQueryData(catalogCategoriesQueryOptions().queryKey),
		).toBeDefined();
		expect(
			queryClient.getQueryData(catalogStatsQueryOptions().queryKey),
		).toBeUndefined();
		expect(
			queryClient.getQueryData(catalogHealthSummaryQueryOptions().queryKey),
		).toBeUndefined();
		expect(api.listCatalog).toHaveBeenCalledWith(input, expect.anything());
	});

	it("a wrong limit warms a DIFFERENT entry — why the input constants are shared", async () => {
		// The failure this whole design guards against, made visible: passing a
		// limit the surface does not use leaves the surface's own entry cold, so
		// the prefetch is silently dead weight.
		const queryClient = client();
		await queryClient.ensureQueryData(blueprintListQueryOptions(7));

		expect(
			queryClient.getQueryData(blueprintListQueryOptions(7).queryKey),
		).toBeDefined();
		expect(
			queryClient.getQueryData(
				blueprintListQueryOptions(BLUEPRINTS_LIST_LIMIT).queryKey,
			),
		).toBeUndefined();
	});

	it("does not reject when a list read fails, so navigation still lands", async () => {
		// A rejected loader blocks the transition and shows the route error
		// boundary. For a list route the honest outcome is to land on the page and
		// let the surface render its own error state.
		api.listTedis.mockRejectedValue(new Error("roster unavailable"));
		const queryClient = client();

		await expect(prefetchTeamRoute(queryClient)).resolves.toBeUndefined();
		expect(api.listTediSummaries).not.toHaveBeenCalled();
	});
});
