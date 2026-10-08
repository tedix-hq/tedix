import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { osApi } from "@/lib/api";
import type { ListCatalogAppsInput } from "@tedix/api-contract/schemas/catalog";

/**
 * Canonical TanStack Query definitions for every contract-backed OS request.
 * Endpoint identity and the complete validated input are encoded in generated
 * keys. Local-only projections remain explicitly documented beside their
 * projection stores instead of masquerading as API requests.
 */
export const osQuery = createTanstackQueryUtils(osApi);

/**
 * The validated input a contract procedure accepts, mirrored from the client
 * so a factory forwards a call site's exact input without restating an enum
 * the contract already owns. A generated key encodes the complete input, so
 * this type is the cache identity — widening it silently splits or merges
 * cache entries.
 */
type ClientInput<TProcedure extends (...args: never[]) => unknown> =
	NonNullable<Parameters<TProcedure>[0]>;

/** Stable inputs shared by route loaders, components, and realtime invalidation. */
export const ACTIVE_WORKSPACES_INPUT = {
	status: "active" as const,
	limit: 100,
};

export const ARCHIVED_WORKSPACES_INPUT = {
	status: "archived" as const,
	limit: 100,
};

export const ACTIVE_OUTPUT_LIBRARY_INPUT = {
	status: "active" as const,
	limit: 200,
};

export const CANVAS_RESOURCE_LIST_LIMIT = 100;

/**
 * List limits that are part of a generated key's INPUT, so a route loader and
 * its surface must pass the identical number or they warm and read two
 * different cache entries — a loader that silently prefetches the wrong entry
 * is worse than no loader. They live here, beside the other shared inputs,
 * precisely so there is one source of truth to change.
 */
export const BLUEPRINTS_LIST_LIMIT = 100;
export const BLUEPRINT_GALLERY_LIMIT = 100;
export const SKILL_CATALOG_LIMIT = 50;
export const TEDI_ROSTER_LIMIT = 50;
export const SKILL_SCHEDULES_LIMIT = 200;
export const WORKFLOW_DEFINITIONS_LIMIT = 50;
export const MEMBERS_PAGE_SIZE = 25;
export const API_KEYS_PAGE_SIZE = 25;
export const WORK_FACTORY_PROJECTION_LIMIT = 100;
/** One month of runway to rotate a credential before it expires or goes overdue. */
export const EXPIRING_API_KEYS_WINDOW_DAYS = 30;

export const activeWorkspacesQueryOptions = () =>
	osQuery.osWorkspaces.workspaces.list.queryOptions({
		input: ACTIVE_WORKSPACES_INPUT,
	});

export const archivedWorkspacesQueryOptions = () =>
	osQuery.osWorkspaces.workspaces.list.queryOptions({
		input: ARCHIVED_WORKSPACES_INPUT,
	});

export const workspaceDetailQueryOptions = (workspaceId: string) =>
	osQuery.osWorkspaces.workspaces.get.queryOptions({ input: { workspaceId } });

export const workspacePreferencesQueryOptions = () =>
	osQuery.osWorkspaces.workspacePreferences.list.queryOptions({ input: {} });

export const blueprintListQueryOptions = (limit: number) =>
	osQuery.osWorkspaces.blueprints.list.queryOptions({ input: { limit } });

export const activeOutputLibraryQueryOptions = () =>
	osQuery.osWorkspaces.outputs.library.queryOptions({
		input: ACTIVE_OUTPUT_LIBRARY_INPUT,
	});

export const canvasOutputLibraryQueryOptions = (workspaceId: string) =>
	osQuery.osWorkspaces.outputs.library.queryOptions({
		input: { workspaceId, limit: CANVAS_RESOURCE_LIST_LIMIT },
	});

export const outputDetailQueryOptions = (outputId: string) =>
	osQuery.osWorkspaces.outputs.get.queryOptions({ input: { outputId } });

/** Canonical Canvas requests shared by the route loader and mounted surface. */
export const canvasGadgetsQueryOptions = (workspaceId: string) =>
	osQuery.osWorkspaces.gadgets.list.queryOptions({
		input: {
			workspaceId,
			status: "active",
			limit: CANVAS_RESOURCE_LIST_LIMIT,
		},
	});

export const canvasOutputsQueryOptions = (workspaceId: string) =>
	osQuery.osWorkspaces.outputs.list.queryOptions({
		input: {
			workspaceId,
			limit: CANVAS_RESOURCE_LIST_LIMIT,
		},
	});

export const workspaceResourcesQueryOptions = (workspaceId: string) =>
	osQuery.osWorkspaces.resources.list.queryOptions({
		input: { workspaceId, status: "active", limit: 100 },
	});

export const workspaceWorkProjectsQueryOptions = (workspaceId: string) =>
	osQuery.osWorkspaces.work.listProjects.queryOptions({
		input: { workspaceId, status: "active", limit: 100 },
	});

export const workflowRunInspectQueryOptions = (runId: string) =>
	osQuery.skills.inspectWorkflowRun.queryOptions({ input: { runId } });

/** One Home/kernel execution. Home ids are not skill-workflow run ids. */
export const homeRunQueryOptions = (runId: string) =>
	osQuery.kernelRuntime.readRun.queryOptions({ input: { runId } });

export const artifactReleaseTargetQueryOptions = (
	tediId: string,
	artifactId: string,
) =>
	osQuery.cognitiveRuntime.getArtifactReleaseReview.queryOptions({
		input: { tediId, sourceArtifactId: artifactId },
	});

/** Converged parent + delegated-branch evidence for one Home execution. */
export const homeRunTraceQueryOptions = (runId: string) =>
	osQuery.kernelRuntime.readRunTrace.queryOptions({ input: { runId } });

/** Canonical event/artifact evidence for one delegated tedi branch. */
export const homeChildRunEvidenceQueryOptions = (
	delegatedTediId: string,
	childRunId: string,
) =>
	osQuery.kernelRuntime.readChildRunEvidence.queryOptions({
		input: { delegatedTediId, childRunId, limit: 500, artifactLimit: 100 },
	});

/**
 * The caller's own connections. Two surfaces read this — the Apps page panel
 * and Workspace context in Settings — and they previously cached the identical
 * request under two hand-written keys (`os-connections`, `os-user-connections`),
 * so each mount refetched the other's data and an invalidation of one left the
 * other stale. One generated key makes them the same cache entry.
 */
export const connectionsOverviewQueryOptions = (
	input: ClientInput<typeof osApi.connections.getConnectionsOverview>,
) =>
	osQuery.connections.getConnectionsOverview.queryOptions({
		input,
		retry: false,
	});

export const userConnectionsQueryOptions = () =>
	osQuery.connections.getUserConnections.queryOptions({ input: {} });

/** Governed share links for one exact resource. */
export const osSharesQueryOptions = (
	input: ClientInput<typeof osApi.osShares.shares.list>,
) => osQuery.osShares.shares.list.queryOptions({ input });

/** The caller's durable OS presentation preferences and CAS revision. */
export const userPreferencesQueryOptions = () =>
	osQuery.userSettings.getPreferences.queryOptions({
		input: {},
		staleTime: 60_000,
	});

/** Canonical account-wide profile for the authenticated human. */
export const userProfileQueryOptions = () =>
	osQuery.userProfile.getMine.queryOptions({
		input: {},
		staleTime: 60_000,
	});

/** Exact cache key for an infinite Home/Workspace conversation list. */
export const homeConversationsQueryKey = (
	workspaceId?: string,
	includeArchived = false,
	search?: string,
) =>
	search
		? ([
				...osQuery.kernelRuntime.listConversations.key({ type: "query" }),
				{ workspaceId: workspaceId ?? null, includeArchived, search },
			] as const)
		: ([
				...osQuery.kernelRuntime.listConversations.key({ type: "query" }),
				{ workspaceId: workspaceId ?? null, includeArchived },
			] as const);

/**
 * The provider catalog behind connect affordances, read by /admin/connections
 * and the Apps page panel. One generated key so both surfaces share the fetch
 * and a connect/disconnect invalidation reaches each of them.
 */
export const connectionProvidersQueryOptions = () =>
	osQuery.connections.listProviders.queryOptions({ input: {} });

/** A single gadget document, the twin of `outputDetailQueryOptions`. */
export const canvasGadgetDetailQueryOptions = (
	workspaceId: string,
	gadgetId: string,
) =>
	osQuery.osWorkspaces.gadgets.get.queryOptions({
		input: { workspaceId, gadgetId },
	});

export const gadgetExecutionsQueryOptions = (
	workspaceId: string,
	gadgetId: string,
	limit: number,
) =>
	osQuery.osWorkspaces.executions.list.queryOptions({
		input: { workspaceId, gadgetId, limit },
	});

export const collaborationProposalsQueryOptions = (
	input: ClientInput<typeof osApi.osWorkspaces.collaboration.list>,
) => osQuery.osWorkspaces.collaboration.list.queryOptions({ input });

export const blueprintDetailQueryOptions = (blueprintId: string) =>
	osQuery.osWorkspaces.blueprints.get.queryOptions({ input: { blueprintId } });

export const blueprintGalleryQueryOptions = (limit: number) =>
	osQuery.osWorkspaces.blueprints.gallery.queryOptions({ input: { limit } });

/**
 * The command palette's own bounded slices of the workspace and output lists.
 * Deliberately not the surface factories above: the palette renders every row
 * it receives, so its smaller limit is part of the request and therefore part
 * of the key. Both still sit under the workspaces/outputs domain prefixes, so
 * realtime and mutation invalidation reach them.
 */
export const commandPaletteWorkspacesQueryOptions = (limit: number) =>
	osQuery.osWorkspaces.workspaces.list.queryOptions({
		input: { status: "active", limit },
	});

export const commandPaletteOutputLibraryQueryOptions = (limit: number) =>
	osQuery.osWorkspaces.outputs.library.queryOptions({
		input: { status: "active", limit },
	});

/**
 * Home's run set and transcript. The realtime lane patches both entries by
 * exact key, so the reads, the focus-convergence invalidations, and the realtime
 * projections have to address the same generated key or streaming writes land
 * in a namespace nothing renders.
 */
export const HOME_MESSAGES_PAGE_LIMIT = 50;

export const homeRunSetQueryOptions = (conversationId: string) =>
	osQuery.kernelRuntime.readRunSet.queryOptions({ input: { conversationId } });

/** Active context-only capability references for one exact Home conversation. */
export const conversationCapabilitiesQueryOptions = (conversationId: string) =>
	osQuery.kernelRuntime.listConversationCapabilities.queryOptions({
		input: { conversationId },
	});

/** Immutable, context-only artifact revision pins for one Home conversation. */
export const conversationArtifactPinsQueryOptions = (conversationId: string) =>
	osQuery.kernelRuntime.listConversationArtifactPins.queryOptions({
		input: { conversationId },
	});

/** Organization capability catalog offered by the conversation palette. */
export const activeCapabilitiesQueryOptions = () =>
	osQuery.capabilities.list.queryOptions({
		input: { status: "active", limit: 100, offset: 0 },
	});

export const homeRunSetQueryKey = (conversationId: string | null) =>
	homeRunSetQueryOptions(conversationId ?? "").queryKey;

export const homeMessagesQueryOptions = (
	conversationId: string,
	limit: number = HOME_MESSAGES_PAGE_LIMIT,
) =>
	osQuery.kernelRuntime.readMessages.queryOptions({
		input: { conversationId, limit },
	});

export const homeMessagesQueryKey = (
	conversationId: string | null,
	limit: number = HOME_MESSAGES_PAGE_LIMIT,
) => homeMessagesQueryOptions(conversationId ?? "", limit).queryKey;

export const runArtifactsQueryOptions = (runId: string) =>
	osQuery.skills.listRunArtifacts.queryOptions({ input: { runId } });

/** The engine-verified retry inbox — restartId is epoch-bound, never inferred. */
export const workflowRetryCandidatesQueryOptions = () =>
	osQuery.skills.listWorkflowRetryCandidates.queryOptions({ input: {} });

export const skillRunHistoryQueryOptions = (limit: number) =>
	osQuery.skills.runWorkflowHistory.queryOptions({ input: { limit } });

/**
 * `summary: true` keeps the catalog light, and the explicit limit/offset are
 * load-bearing: the handler defaults to 20 when the input is omitted.
 */
type PagedSearchInput = { limit: number; offset?: number; query?: string };

function normalizePagedSearch(input: number | PagedSearchInput) {
	return typeof input === "number" ? { limit: input, offset: 0 } : input;
}

export const skillCatalogQueryOptions = (input: number | PagedSearchInput) =>
	osQuery.skills.listByOrg.queryOptions({
		input: { ...normalizePagedSearch(input), summary: true },
	});

export const skillDetailQueryOptions = (skillId: string) =>
	osQuery.skills.get.queryOptions({ input: { id: skillId } });

export const skillRunsQueryOptions = (
	skillId: string,
	status?: ClientInput<typeof osApi.skills.runWorkflowHistory>["status"],
	limit = 50,
) =>
	osQuery.skills.runWorkflowHistory.queryOptions({
		input: { skillId, ...(status ? { status } : {}), limit },
	});

export const skillReliabilityQueryOptions = (skillId: string) =>
	osQuery.skills.getWorkflowReliability.queryOptions({
		input: { skillId, limit: 100 },
	});

export const skillRevisionsQueryOptions = (skillId: string) =>
	osQuery.skills.listWorkflowRevisions.queryOptions({
		input: { skillId, limit: 100 },
	});

export const skillSpecificSchedulesQueryOptions = (skillId: string) =>
	osQuery.skills.listWorkflowSchedules.queryOptions({
		input: { skillId, limit: SKILL_SCHEDULES_LIMIT },
	});

export const skillSchedulesQueryOptions = (input: number | PagedSearchInput) =>
	osQuery.skills.listWorkflowSchedules.queryOptions({
		input: normalizePagedSearch(input),
	});

export const workflowDefinitionsQueryOptions = (
	input: number | PagedSearchInput,
) =>
	osQuery.workflows.listDefinitions.queryOptions({
		input: normalizePagedSearch(input),
	});

/**
 * Definition health is read by Skills, Triggers, and a run's detail with the
 * same limit. One generated key keeps that a single fetch and keeps Triggers'
 * post-run invalidation reaching all three.
 */
export const workflowDefinitionHealthQueryOptions = (
	input: number | PagedSearchInput,
) =>
	osQuery.workflows.listDefinitionHealth.queryOptions({
		input: normalizePagedSearch(input),
	});

/**
 * Rationale reads carry no runId: the contract exposes no such filter, so a
 * run's detail lists the tedi's recent records and matches client-side. The
 * generated key therefore encodes tedi + page size only, and two runs of one
 * tedi correctly share the entry.
 */
export const RUN_RATIONALE_LIMIT = 100;

export const rationaleListQueryOptions = (
	input: ClientInput<typeof osApi.rationaleRecords.list>,
) => osQuery.rationaleRecords.list.queryOptions({ input });

export const tediRationaleQueryOptions = (tediId: string, limit: number) =>
	rationaleListQueryOptions({ tediId, limit });

/** Per-run USD comes from `tedi_call_costs` rows, grouped by runId client-side. */
export const tediCallCostsQueryOptions = (
	tediId: string,
	period: NonNullable<
		ClientInput<typeof osApi.tediUsage.getCallCosts>["period"]
	>,
) => osQuery.tediUsage.getCallCosts.queryOptions({ input: { tediId, period } });

/** Canvas' compute chip and the Compute surface share one posture fetch. */
export const computePostureQueryOptions = (
	window: NonNullable<ClientInput<typeof osApi.osCompute.posture>["window"]>,
) => osQuery.osCompute.posture.queryOptions({ input: { window } });

export const pendingApprovalsQueryOptions = () =>
	osQuery.tediApprovals.list.queryOptions({ input: { status: "pending" } });

export const workItemListQueryOptions = (
	input: ClientInput<typeof osApi.workItems.list>,
) => osQuery.workItems.list.queryOptions({ input });

export const workItemDetailQueryOptions = (id: string) =>
	osQuery.workItems.getById.queryOptions({ input: { id } });

export const workItemReadinessQueryOptions = (id: string) =>
	osQuery.workItems.getReadiness.queryOptions({ input: { id } });

export type WorkFactoryCursor = { at: string; id: string };
export const WORK_QUEUE_LIMIT = 25;
export const WORK_ITEM_LEDGER_LIMIT = 50;

export const workReadinessProjectionQueryOptions = (
	cursor?: WorkFactoryCursor,
) =>
	osQuery.workItems.listReadinessProjection.queryOptions({
		input: {
			limit: WORK_QUEUE_LIMIT,
			...(cursor ? { cursor } : {}),
		},
	});

export const workItemAttemptsQueryOptions = (
	id: string,
	cursor?: WorkFactoryCursor,
) =>
	osQuery.workItems.listAttempts.queryOptions({
		input: {
			id,
			limit: WORK_ITEM_LEDGER_LIMIT,
			...(cursor ? { cursor } : {}),
		},
	});

export const workstationInspectionStatusQueryOptions = (
	id: string,
	attemptId: string,
) =>
	osQuery.workItems.inspectAttemptRepository.queryOptions({
		input: { id, attemptId, operation: "status" },
	});

export const workItemEvidenceQueryOptions = (
	id: string,
	cursor?: WorkFactoryCursor,
) =>
	osQuery.workItems.listEvidence.queryOptions({
		input: {
			id,
			limit: WORK_ITEM_LEDGER_LIMIT,
			...(cursor ? { cursor } : {}),
		},
	});

export const workEvidencePreviewQueryOptions = (
	id: string,
	evidenceId: string,
) =>
	osQuery.workItems.previewEvidence.queryOptions({ input: { id, evidenceId } });

export type WorkActivityView = "active" | "history";

export const workAttemptProjectionQueryOptions = (
	cursor?: WorkFactoryCursor,
	view?: WorkActivityView,
) =>
	osQuery.workItems.listAttemptProjection.queryOptions({
		input: {
			limit: WORK_FACTORY_PROJECTION_LIMIT,
			...(view
				? {
						runtimeStates:
							view === "history"
								? ["finished", "failed", "expired", "cancelled"]
								: ["queued", "running", "waiting", "retrying"],
					}
				: {}),
			...(cursor ? { cursor } : {}),
		},
	});

export const projectActiveAttemptsQueryOptions = (projectId: string) =>
	osQuery.workItems.listAttemptProjection.queryOptions({
		input: {
			projectId,
			runtimeStates: ["queued", "running", "waiting", "retrying"],
			limit: 100,
		},
		refetchInterval: 30_000,
	});

export const workRecoveryProjectionQueryOptions = (
	cursor?: WorkFactoryCursor,
) =>
	osQuery.workItems.listRecoveryProjection.queryOptions({
		input: {
			limit: WORK_FACTORY_PROJECTION_LIMIT,
			...(cursor ? { cursor } : {}),
		},
	});

export const workItemEventsQueryOptions = (id: string) =>
	osQuery.workItems.listEvents.queryOptions({ input: { id, limit: 100 } });

/** The dependency graph's scoped slice of the same list procedure. */
export const workGraphItemsQueryOptions = (
	scope: { projectId?: string },
	limit: number,
) => workItemListQueryOptions({ ...scope, limit });

export const workItemRelationsQueryOptions = (
	scope: { projectId?: string },
	limit: number,
) =>
	osQuery.workItems.listRelations.queryOptions({ input: { ...scope, limit } });

export const WORK_CASES_LIMIT = 50;
export const WORK_APPROVALS_LIMIT = 50;
export const WORK_INTERACTIONS_LIMIT = 50;
export const WORK_CAPACITY_LIMIT = 50;

export const workCaseListQueryOptions = (
	input: ClientInput<typeof osApi.workItems.listCases> = {
		limit: WORK_CASES_LIMIT,
	},
) => osQuery.workItems.listCases.queryOptions({ input });

export const workCaseDetailQueryOptions = (
	caseId: string,
	itemCursor?: string,
	dependencyCursor?: string,
) =>
	osQuery.workItems.getCase.queryOptions({
		input: {
			caseId,
			itemLimit: 50,
			dependencyLimit: 50,
			...(itemCursor ? { itemCursor } : {}),
			...(dependencyCursor ? { dependencyCursor } : {}),
		},
	});

export const projectMilestonesQueryOptions = (
	projectId: string,
	cursor?: string,
) =>
	osQuery.projects.listMilestones.queryOptions({
		input: { id: projectId, limit: 50, ...(cursor ? { cursor } : {}) },
	});

export const projectSprintsQueryOptions = (projectId: string) =>
	osQuery.projects.listSprints.queryOptions({ input: { id: projectId } });

export const projectHealthJudgmentsQueryOptions = (
	projectId: string,
	limit = 20,
) =>
	osQuery.projects.listHealthJudgments.queryOptions({
		input: { id: projectId, limit },
	});

export const workApprovalsQueryOptions = (cursor?: {
	at: string;
	id: string;
}) =>
	osQuery.workApprovals.listInbox.queryOptions({
		input: { limit: WORK_APPROVALS_LIMIT, ...(cursor ? { cursor } : {}) },
	});

export type WorkInteractionListView = "inbox" | "outbox" | "audit";

export const workInteractionsQueryOptions = (
	cursor?: { at: string; id: string },
	view: WorkInteractionListView = "inbox",
	states?: Array<"open" | "resolved" | "cancelled" | "expired">,
) => {
	const input = {
		limit: WORK_INTERACTIONS_LIMIT,
		...(cursor ? { cursor } : {}),
		...(states ? { states } : {}),
	};
	if (view === "outbox")
		return osQuery.workInteractions.listOutbox.queryOptions({ input });
	if (view === "audit")
		return osQuery.workInteractions.listAudit.queryOptions({ input });
	return osQuery.workInteractions.listInbox.queryOptions({ input });
};

export const WORK_URGENT_INTERACTIONS_LIMIT = 20;

/** Open requests addressed to the caller that triage marked as needing them now. */
export const workUrgentInteractionsQueryOptions = () =>
	osQuery.workInteractions.listInbox.queryOptions({
		input: {
			limit: WORK_URGENT_INTERACTIONS_LIMIT,
			states: ["open"],
			urgency: "now",
		},
	});

/** Polled so a new knock shows up in the office within half a minute. */
export const WORK_OFFICE_REFETCH_MS = 30_000;

/** The caller's newest inbox page: the office counts today's knocks from it. */
export const workOfficeKnocksQueryOptions = () =>
	osQuery.workInteractions.listInbox.queryOptions({
		input: { limit: 100 },
		refetchInterval: WORK_OFFICE_REFETCH_MS,
		refetchOnWindowFocus: true,
	});

/** Reply-draft outcomes for the caller's questions since `since` (ISO). */
export const replyDraftAcceptanceQueryOptions = (since: string) =>
	osQuery.agentTurnTriage.getReplyDraftAcceptance.queryOptions({
		input: { since },
		refetchInterval: WORK_OFFICE_REFETCH_MS,
	});

/** The caller's drafting tedis this week and today, ranked by replies that stood. */
export const replyDraftLeaderboardQueryOptions = (
	since: string,
	todaySince: string,
) =>
	osQuery.agentTurnTriage.getReplyDraftLeaderboard.queryOptions({
		input: { since, todaySince },
		refetchInterval: WORK_OFFICE_REFETCH_MS,
	});

/** The lessons the caller's sessions receive, newest first. */
export const notebookLessonsQueryOptions = () =>
	osQuery.agentTurnTriage.listLessons.queryOptions({
		input: { limit: 50 },
		refetchInterval: WORK_OFFICE_REFETCH_MS,
	});

export const workInteractionDetailQueryOptions = (
	requestId: string,
	responseCursor?: { at: string; id: string },
) =>
	osQuery.workInteractions.get.queryOptions({
		input: {
			requestId,
			responseLimit: WORK_INTERACTIONS_LIMIT,
			...(responseCursor ? { responseCursor } : {}),
		},
	});

export const workFleetQueryOptions = () =>
	osQuery.workFleet.getControlTower.queryOptions({ input: {} });

/** Polled every 10s: the board is a glance surface for live local sessions. */
export const WORK_AGENT_SESSIONS_REFETCH_MS = 10_000;

export const workAgentSessionsQueryOptions = () =>
	osQuery.workAgentSessions.list.queryOptions({
		input: {},
		refetchInterval: WORK_AGENT_SESSIONS_REFETCH_MS,
		refetchOnWindowFocus: true,
	});

export const workSchedulerQueryOptions = () =>
	osQuery.workScheduler.listReady.queryOptions({
		input: { limit: 50, candidateLimit: 200 },
	});

export const workExecutionClustersQueryOptions = (tediId: string) =>
	osQuery.workScheduler.planClusters.queryOptions({
		input: {
			limit: 100,
			candidateLimit: 10,
			maxParallelism: 8,
			executor: { type: "tedi", id: tediId },
		},
	});

export const workAdmissionSpecificationQueryOptions = (id: string) =>
	osQuery.workItems.getAdmissionSpecification.queryOptions({ input: { id } });

export const workResourcePoolsQueryOptions = (
	cursor?: string,
	resourceKey?: string,
	saturatedOnly = false,
) =>
	osQuery.workItems.listResourcePools.queryOptions({
		input: {
			limit: WORK_CAPACITY_LIMIT,
			...(cursor ? { cursor } : {}),
			...(resourceKey ? { resourceKey } : {}),
			...(saturatedOnly ? { saturatedOnly: true } : {}),
		},
	});

export const workBudgetEnvelopesQueryOptions = (cursor?: string) =>
	osQuery.workItems.listBudgetEnvelopes.queryOptions({
		input: { limit: WORK_CAPACITY_LIMIT, ...(cursor ? { cursor } : {}) },
	});

/** `memoryGraph.health` declares no `.input()`. */
export const memoryHealthQueryOptions = () =>
	osQuery.memoryGraph.health.queryOptions({});

export const knowledgeListQueryOptions = (limit: number) =>
	osQuery.knowledge.list.queryOptions({ input: { limit } });

export const tediKnowledgeMapQueryOptions = (
	tediId: string,
	depth: number,
	maxNodes: number,
) =>
	osQuery.memoryGraph.graph.visualization.queryOptions({
		input: { view: "knowledge_map", tediId, depth, maxNodes },
	});

export const tediExpertiseQueryOptions = (tediId: string) =>
	osQuery.memoryGraph.expertise.queryOptions({ input: { tediId } });

export const latestGrowthSnapshotQueryOptions = (tediId: string) =>
	osQuery.growthSnapshots.latest.queryOptions({ input: { tediId } });

/**
 * The organization's human membership, shared by the Team route loader and the
 * Members tab. `organizationId` comes from `operationalContextQueryOptions`
 * (the credential-resolved organization), never from the hostname or a path
 * segment. The complete input — including offset — is part of the generated
 * key, so the loader and the surface must pass identical paging.
 */
export const membersListQueryOptions = (
	input: ClientInput<typeof osApi.members.listMembers>,
) => osQuery.members.listMembers.queryOptions({ input });

/**
 * The organization's API keys, shared by the /admin/api-keys route loader and
 * the page. `organizationId` comes from `operationalContextQueryOptions`, never
 * from the hostname or a path segment. The complete input — including offset —
 * is part of the generated key, so the loader and the surface must pass
 * identical paging.
 */
export const apiKeyListQueryOptions = (
	input: ClientInput<typeof osApi.organizations.listApiKeys>,
) => osQuery.organizations.listApiKeys.queryOptions({ input });

/** Keys approaching expiry or overdue for rotation, for the admin banner. */
export const expiringApiKeysQueryOptions = (
	organizationId: string,
	withinDays: number,
) =>
	osQuery.organizations.getExpiringKeys.queryOptions({
		input: { organizationId, withinDays },
	});

/**
 * The organization's own record and effective features, read by
 * /admin/organization. `organizationId` comes from
 * `operationalContextQueryOptions` — never from the hostname or a path
 * segment.
 */
export const organizationDetailQueryOptions = (organizationId: string) =>
	osQuery.organizations.get.queryOptions({ input: { organizationId } });

export const organizationFeaturesQueryOptions = (organizationId: string) =>
	osQuery.organizations.getFeatures.queryOptions({
		input: { organizationId },
	});

/** Descope SSO Setup Suite state for the org's tenant (feature-gated read). */
export const organizationSsoStatusQueryOptions = (organizationId: string) =>
	osQuery.organizations.getSsoStatus.queryOptions({
		input: { organizationId },
	});

/**
 * The billing catalog backing the subscription section. The procedure declares
 * no `.input()`, so /admin/organization and /admin/billing share one cache row.
 */
export const billingPlansQueryOptions = () =>
	osQuery.billing.listPlans.queryOptions({});

/** Entitlement, balance, period totals, and plan limits — no `.input()`. */
export const billingOverviewQueryOptions = () =>
	osQuery.billing.getOverview.queryOptions({});

export const providerCapacitySponsorshipsQueryOptions = () =>
	osQuery.billing.listProviderCapacitySponsorships.queryOptions({});

export const portableWebMcpConfigurationsQueryOptions = () =>
	osQuery.tedis.listPortableWebMcpConfigurations.queryOptions({});

/**
 * /admin/billing reads one fixed window; the loader and the surface must pass
 * the identical period or they warm and read two different cache entries.
 */
export const ORG_USAGE_PERIOD = "30d" as const;

/**
 * Org-wide token usage and cost aggregation. `organizationId` comes from
 * `operationalContextQueryOptions` — never from the hostname or a path
 * segment.
 */
export const orgUsageQueryOptions = (
	organizationId: string,
	period: NonNullable<
		ClientInput<typeof osApi.orgUsage.getOrgUsage>["period"]
	> = ORG_USAGE_PERIOD,
	window?: ClientInput<typeof osApi.orgUsage.getOrgUsage>["window"],
) =>
	osQuery.orgUsage.getOrgUsage.queryOptions({
		input: { organizationId, period, window },
	});

/**
 * The MCP payment ledger backing /admin/payments. The complete validated
 * input — filters included — is the cache identity, so the route loader and
 * the surface must build it through the same `admin-payments-search.ts`
 * input builders.
 */
export const mcpPaymentsEventsQueryOptions = (
	input: ClientInput<typeof osApi.mcpPayments.listEvents>,
) => osQuery.mcpPayments.listEvents.queryOptions({ input });

export const mcpPaymentsSpendSummaryQueryOptions = (
	input: ClientInput<typeof osApi.mcpPayments.spendSummary>,
) => osQuery.mcpPayments.spendSummary.queryOptions({ input });

export const mcpPaymentsPoliciesQueryOptions = (
	input: ClientInput<typeof osApi.mcpPayments.listPolicies>,
) => osQuery.mcpPayments.listPolicies.queryOptions({ input });

export const mcpPaymentsReceiptQueryOptions = (id: string) =>
	osQuery.mcpPayments.getReceipt.queryOptions({ input: { id } });

/** The roster read shared by Team, a tedi's detail route, and gadget runs. */
export const tediRosterQueryOptions = (
	limit: number,
	options: Partial<
		Pick<ClientInput<typeof osApi.tedis.list>, "offset" | "search" | "status">
	> = {},
) =>
	osQuery.tedis.list.queryOptions({
		input: { limit, offset: options.offset ?? 0, ...options },
	});

/**
 * The id → name map only. `{}` is a DIFFERENT request from the roster above
 * (the handler defaults to 20 when limit/offset are omitted), so the two stay
 * separate cache entries — do not unify them.
 */
export const tediNamesQueryOptions = () =>
	osQuery.tedis.list.queryOptions({ input: {} });

/**
 * `listOperationsSummaries` declares an OPTIONAL input object: the no-input
 * form and `{ input: {} }` generate different keys, so both callers have to
 * come through this one factory to keep sharing a single expensive read.
 */
export const tediOperationsSummariesQueryOptions = (tediIds?: string[]) =>
	tediIds
		? osQuery.tedis.listOperationsSummaries.queryOptions({ input: { tediIds } })
		: osQuery.tedis.listOperationsSummaries.queryOptions({});

export const earnedDelegationProfileQueryOptions = (tediId: string) =>
	osQuery.earnedDelegation.getProfile.queryOptions({ input: { tediId } });

export const runtimeEventsQueryOptions = (
	input: ClientInput<typeof osApi.cognitiveRuntime.listEvents>,
) => osQuery.cognitiveRuntime.listEvents.queryOptions({ input });

/**
 * The admission gate itself, read identically by Settings, the entitlement
 * card, and schedule health — one generated key, one fetch.
 */
export const runtimeEntitlementsQueryOptions = () =>
	osQuery.runtimeEntitlements.get.queryOptions({ input: {} });

/**
 * Organization-scope catalog read: no tedi is named, so the per-tedi tier and
 * runtime filters stay deliberately absent from the input and the key.
 */
export const modelCatalogQueryOptions = (tediId?: string) =>
	osQuery.modelCatalog.list.queryOptions({
		input: { includeDenied: true, ...(tediId ? { tediId } : {}) },
	});

export const tediPairingRequestsQueryOptions = (tediId: string) =>
	osQuery.tedis.listPairingRequests.queryOptions({
		input: { tediId, channel: "telegram" },
	});

export const tediDetailQueryOptions = (tediId: string) =>
	osQuery.tedis.get.queryOptions({ input: { tediId } });

/**
 * Inbox pages are keyed by status so the loader and the filtered surface read
 * the identical cache entry.
 */
export const TEDI_EMAIL_INBOX_LIMIT = 50;

export const tediEmailAddressesQueryOptions = (tediId: string) =>
	osQuery.tediEmail.listAddresses.queryOptions({
		input: { tediId, status: "all" },
	});

export const tediEmailInboxQueryOptions = (
	tediId: string,
	status: "open" | "archived" | "spam" | "all" = "open",
) =>
	osQuery.tediEmail.listInbox.queryOptions({
		input: { tediId, status, limit: TEDI_EMAIL_INBOX_LIMIT },
	});

export const tediEmailThreadQueryOptions = (tediId: string, threadId: string) =>
	osQuery.tediEmail.readThread.queryOptions({
		input: { tediId, threadId },
	});

export const tediRuntimeStatusQueryOptions = (tediId: string) =>
	osQuery.tedis.getStatus.queryOptions({ input: { tediId } });

export const tediSecretsQueryOptions = (tediId: string) =>
	osQuery.tediSecrets.list.queryOptions({ input: { tediId } });

export const tediDevicesQueryOptions = (tediId: string) =>
	osQuery.tedis.listDevices.queryOptions({ input: { tediId } });

export const tediDomainsQueryOptions = (tediId: string) =>
	osQuery.tedis.listCustomDomains.queryOptions({ input: { tediId } });

export const projectListQueryOptions = (
	limit: number,
	options: { offset?: number; search?: string } = {},
) => osQuery.projects.list.queryOptions({ input: { limit, ...options } });

export const projectRollupQueryOptions = (id: string) =>
	osQuery.projects.getRollup.queryOptions({ input: { id } });

export const projectDetailQueryOptions = (id: string) =>
	osQuery.projects.get.queryOptions({ input: { id } });

/**
 * Audit search. The unfiltered page also sources the facet list, so its key
 * must stay distinct from a narrowed one — encoding the input guarantees it.
 */
export const auditSearchQueryOptions = (
	input: ClientInput<typeof osApi.audit.search>,
) => osQuery.audit.search.queryOptions({ input });

export const appListQueryOptions = (limit: number) =>
	osQuery.apps.list.queryOptions({ input: { limit } });

export const tediAppAssignmentsQueryOptions = (tediId: string) =>
	osQuery.tediAppAssignments.listByTedi.queryOptions({ input: { tediId } });

// ---------------------------------------------------------------------------
// App Store (/apps/store)
// ---------------------------------------------------------------------------

export const catalogListQueryOptions = (input: ListCatalogAppsInput) =>
	osQuery.catalog.list.queryOptions({ input });

export const catalogCategoriesQueryOptions = () =>
	osQuery.catalog.getCategories.queryOptions({ input: {} });

export const catalogStatsQueryOptions = () =>
	osQuery.catalog.getStats.queryOptions({ input: {} });

export const catalogHealthSummaryQueryOptions = () =>
	osQuery.catalog.getHealthSummary.queryOptions({ input: {} });

export const catalogAppDetailQueryOptions = (slug: string) =>
	osQuery.catalog.getBySlug.queryOptions({ input: { slug } });

/**
 * The app detail read shared by the /apps/$appId layout loader, the Overview
 * tab (widget previews), Content (sync interval on metadata), and Settings
 * (details form, MCP config). One `getByIdWithTools` entry is the app-record
 * source of truth on this surface — `apps.get` is deliberately NOT read here,
 * so an `apps.update` invalidation of the apps domain reaches every reader.
 */
export const appDetailQueryOptions = (appId: string) =>
	osQuery.apps.getByIdWithTools.queryOptions({ input: { appId } });

// ---------------------------------------------------------------------------
// App management (/apps/$appId sub-routes)
// ---------------------------------------------------------------------------

/**
 * List limits that are part of the generated key's INPUT — the route loader
 * and the mounted surface must pass the identical number or they warm and read
 * two different cache entries.
 */
/** Rows per server-owned page in the tools collection. */
export const APP_TOOLS_PAGE_SIZE = 25;
export const APP_ANALYTICS_TOOL_LIMIT = 50;
export const APP_RECENT_EXECUTIONS_LIMIT = 20;
export const APP_RECENT_ACTIVITY_LIMIT = 50;
export const APP_ACTIVITY_REVIEW_LIMIT = 250;
export const APP_TOOL_CALL_PAYLOADS_LIMIT = 5;

export interface AppAnalyticsRange {
	from: string;
	to: string;
}

/**
 * The analytics window (last 30 days), snapped to the minute. The from/to
 * timestamps are part of every analytics generated key, so the loader and the
 * mounted surface — which call this independently — must compute the identical
 * strings within the same minute to share cache entries.
 */
export function appAnalyticsRange(now: Date = new Date()): AppAnalyticsRange {
	const end = new Date(now);
	end.setSeconds(0, 0);
	const start = new Date(end);
	start.setDate(end.getDate() - 30);
	return { from: start.toISOString(), to: end.toISOString() };
}

export const widgetLifecycleHealthQueryOptions = (
	range: AppAnalyticsRange & { installationId?: string },
) => osQuery.analytics.getWidgetLifecycleHealth.queryOptions({ input: range });

export const appToolsListQueryOptions = (
	appId: string,
	options: { page?: number; query?: string } = {},
) =>
	osQuery.appTools.list.queryOptions({
		input: {
			appId,
			limit: APP_TOOLS_PAGE_SIZE,
			offset: Math.max(0, (options.page ?? 1) - 1) * APP_TOOLS_PAGE_SIZE,
			...(options.query ? { query: options.query } : {}),
		},
	});

export const appAdaptersListQueryOptions = (appId: string) =>
	osQuery.appAdapters.list.queryOptions({ input: { appId } });

export const contentSourcesQueryOptions = (appId: string) =>
	osQuery.content.listSources.queryOptions({ input: { appId } });

export const appSecretsListQueryOptions = (appId: string) =>
	osQuery.appSecrets.list.queryOptions({ input: { appId } });

export const tediAppAssignmentsByAppQueryOptions = (appId: string) =>
	osQuery.tediAppAssignments.listByApp.queryOptions({ input: { appId } });

/** Session metrics with period-over-period deltas (Analytics Engine). */
export const appMetricsQueryOptions = (
	appId: string,
	range: AppAnalyticsRange,
) => osQuery.analytics.getMetrics.queryOptions({ input: { appId, ...range } });

export const appAnalyticsSummaryQueryOptions = (
	appId: string,
	range: AppAnalyticsRange,
) =>
	osQuery.analytics.getAppSummary.queryOptions({ input: { appId, ...range } });

export const appToolBreakdownQueryOptions = (
	appId: string,
	range: AppAnalyticsRange,
) =>
	osQuery.analytics.getAppToolBreakdown.queryOptions({
		input: { appId, ...range, limit: APP_ANALYTICS_TOOL_LIMIT },
	});

export const appTimeSeriesQueryOptions = (
	appId: string,
	range: AppAnalyticsRange,
) =>
	osQuery.analytics.getAppTimeSeries.queryOptions({
		input: { appId, ...range, granularity: "day" },
	});

export const appRecentExecutionsQueryOptions = (
	appId: string,
	range: AppAnalyticsRange,
) =>
	osQuery.analytics.getRecentExecutions.queryOptions({
		input: { appId, ...range, limit: APP_RECENT_EXECUTIONS_LIMIT },
	});

export const appFreshnessQueryOptions = (appId: string) =>
	osQuery.analytics.getAppFreshness.queryOptions({ input: { appId } });

export const appRecentActivityQueryOptions = (appId: string) =>
	osQuery.analytics.getRecentActivity.queryOptions({
		input: { appId, limit: APP_RECENT_ACTIVITY_LIMIT },
	});

export const appHumanActivityReviewQueryOptions = (appId: string) =>
	osQuery.analytics.getHumanActivityReview.queryOptions({
		input: { appId, limit: APP_ACTIVITY_REVIEW_LIMIT },
	});

export const appCodemodeSummaryQueryOptions = (
	appId: string,
	range: AppAnalyticsRange,
) =>
	osQuery.analytics.getCodemodeAnalyticsSummary.queryOptions({
		input: { appId, ...range, limit: APP_ANALYTICS_TOOL_LIMIT },
	});

export const executionDrilldownQueryOptions = (executionId: string) =>
	osQuery.analytics.getExecutionDrilldown.queryOptions({
		input: { executionId },
	});

export const traceActivityQueryOptions = (traceId: string) =>
	osQuery.analytics.getTraceActivity.queryOptions({ input: { traceId } });

export const toolCallPayloadsQueryOptions = (
	executionId: string,
	toolName: string,
) =>
	osQuery.analytics.getToolCallPayloads.queryOptions({
		input: { executionId, toolName, limit: APP_TOOL_CALL_PAYLOADS_LIMIT },
	});

/** `appGating.installedEligibility` declares no `.input()`. */
export const installedAppEligibilityQueryOptions = () =>
	osQuery.appGating.installedEligibility.queryOptions({});

export const sitesQueryOptions = () =>
	osQuery.sites.list.queryOptions({ input: {} });

export const siteRecoveryManifestQueryOptions = (siteId: string) =>
	osQuery.sites.getRecoveryManifest.queryOptions({ input: { siteId } });

export const siteDeprovisionPlanQueryOptions = (siteId: string) =>
	osQuery.sites.getDeprovisionPlan.queryOptions({ input: { siteId } });

export const siteDeprovisionStatusQueryOptions = (siteId: string) =>
	osQuery.sites.getDeprovisionStatus.queryOptions({ input: { siteId } });

export const docsSiteWorkspaceQueryOptions = (siteId: string) =>
	osQuery.docs.getWorkspace.queryOptions({ input: { siteId } });

export const sitesReconciliationQueryOptions = () =>
	osQuery.sites.getReconciliation.queryOptions({ input: {} });

/**
 * The caller's operational context: organization identity plus the
 * credential-derived authority (role, permissions, machine scopes). This is
 * the read every permission-aware surface gates on — the /admin layout
 * prefetches it in its loader and Settings renders it.
 */
export const operationalContextQueryOptions = () =>
	osQuery.userSettings.getContext.queryOptions({
		input: {},
		staleTime: 60_000,
	});

/**
 * The cross-surface workspace directory that drives the launcher picker and the
 * directory-backed `returnTo` trust root. Every member org with its provisioned
 * surfaces (OS/MCP/CMS) and server-built canonical URLs.
 */
export const myWorkspacesDirectoryQueryOptions = (
	input: ClientInput<typeof osApi.directory.listMyWorkspaces> = {
		limit: 50,
		offset: 0,
	},
) => osQuery.directory.listMyWorkspaces.queryOptions({ input });

/** Partial generated keys for invalidating every input variant under a domain. */
export const osQueryKeys = {
	/** Every page of the key list; expiring-key reads live under their own key. */
	apiKeys: () => osQuery.organizations.listApiKeys.key({ type: "query" }),
	/**
	 * The whole apps domain: the list, the eligibility-free detail read, and
	 * `getByIdWithTools`. An `apps.update` (details form, sync interval, MCP
	 * config, logo bind) or `apps.delete` invalidates here so every app-record
	 * reader converges.
	 */
	apps: () => osQuery.apps.key({ type: "query" }),
	appAdapters: () => osQuery.appAdapters.key({ type: "query" }),
	appContentSources: () => osQuery.content.listSources.key({ type: "query" }),
	appSecrets: () => osQuery.appSecrets.key({ type: "query" }),
	appTediAssignments: () => osQuery.tediAppAssignments.key({ type: "query" }),
	appTools: () => osQuery.appTools.key({ type: "query" }),
	approvalRules: () => osQuery.osApprovalRules.key({ type: "query" }),
	/** The canonical read changed by subscription and capacity checkouts. */
	billingOverview: () => osQuery.billing.getOverview.key({ type: "query" }),
	expiringApiKeys: () =>
		osQuery.organizations.getExpiringKeys.key({ type: "query" }),
	approvals: () => osQuery.tediApprovals.key({ type: "query" }),
	blueprints: () => osQuery.osWorkspaces.blueprints.key({ type: "query" }),
	/**
	 * The whole connections domain — the caller's connections AND the provider
	 * catalog, whose `referencedByOrg`/connected state a connect, disconnect, or
	 * stored key can change. Written by the OAuth popup listener and both write
	 * mutations in `connections-actions.ts`.
	 */
	connections: () => osQuery.connections.key({ type: "query" }),
	/** Catalog list/detail/summary projections; installs can change installability. */
	catalog: () => osQuery.catalog.key({ type: "query" }),
	/**
	 * The org's own detail read plus every list projection that renders its
	 * name/slug/logo. Invalidating only `organizations.listMine` after a
	 * profile edit would leave the detail read — on the very page that edited
	 * it — stale; a profile mutation must invalidate all four.
	 */
	organizationDetail: () => osQuery.organizations.get.key({ type: "query" }),
	organizationFeatures: () =>
		osQuery.organizations.getFeatures.key({ type: "query" }),
	organizationSsoStatus: () =>
		osQuery.organizations.getSsoStatus.key({ type: "query" }),
	organizationsOsMine: () =>
		osQuery.organizations.listOsMine.key({ type: "query" }),
	organizationsAllMine: () =>
		osQuery.organizations.listAllMine.key({ type: "query" }),
	projectMilestones: () =>
		osQuery.projects.listMilestones.key({ type: "query" }),
	/** Active charter, revision history, and deterministic Owner brief. */
	organizationPurpose: () => osQuery.organizationPurpose.key({ type: "query" }),
	/** Org name/slug also render from the credential-resolved context. */
	operationalContext: () =>
		osQuery.userSettings.getContext.key({ type: "query" }),
	gadgets: () => osQuery.osWorkspaces.gadgets.key({ type: "query" }),
	homeMessages: () => osQuery.kernelRuntime.readMessages.key({ type: "query" }),
	homeRunSet: () => osQuery.kernelRuntime.readRunSet.key({ type: "query" }),
	members: () => osQuery.members.listMembers.key({ type: "query" }),
	modelCatalog: () => osQuery.modelCatalog.key({ type: "query" }),
	outputs: () => osQuery.osWorkspaces.outputs.key({ type: "query" }),
	/** Roster, detail, status, channel pairing, and operations projections. */
	tedis: () => osQuery.tedis.key({ type: "query" }),
	tediSecrets: () => osQuery.tediSecrets.key({ type: "query" }),
	/** Addresses, inbox pages, and thread reads for a tedi mailbox. */
	tediEmail: () => osQuery.tediEmail.key({ type: "query" }),
	tediAppAssignments: () => osQuery.tediAppAssignments.key({ type: "query" }),
	skillRunRetryCandidates: () =>
		osQuery.skills.listWorkflowRetryCandidates.key({ type: "query" }),
	skillRuns: () => osQuery.skills.runWorkflowHistory.key({ type: "query" }),
	skills: () => osQuery.skills.key({ type: "query" }),
	skillSchedules: () =>
		osQuery.skills.listWorkflowSchedules.key({ type: "query" }),
	workflowDefinitionHealth: () =>
		osQuery.workflows.listDefinitionHealth.key({ type: "query" }),
	workspacePreferences: () =>
		osQuery.osWorkspaces.workspacePreferences.key({ type: "query" }),
	workApprovals: () => osQuery.workApprovals.listInbox.key({ type: "query" }),
	workBudgetEnvelopes: () =>
		osQuery.workItems.listBudgetEnvelopes.key({ type: "query" }),
	workCases: () => osQuery.workItems.listCases.key({ type: "query" }),
	workInteractions: () =>
		osQuery.workInteractions.listInbox.key({ type: "query" }),
	workResourcePools: () =>
		osQuery.workItems.listResourcePools.key({ type: "query" }),
	workspaces: () => osQuery.osWorkspaces.workspaces.key({ type: "query" }),
} as const;

export const appGatewayMembershipQueryOptions = (appId: string) =>
	osQuery.apps.getGatewayMembership.queryOptions({ input: { appId } });

export const appGatewayMembershipsQueryOptions = () =>
	osQuery.apps.listGatewayMemberships.queryOptions({});

/** Optional bounded name lookup; authorization failures retain canonical ID labels. */
export const workExternalPrincipalsQueryOptions = (organizationId: string) =>
	osQuery.externalAgentIdentity.listPrincipals.queryOptions({
		input: { organizationId, limit: 100 },
	});
