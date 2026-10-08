import type { QueryClient } from "@tanstack/react-query";
import { isLocalSession } from "@/lib/local-inference";
import { notFound } from "@tanstack/react-router";
import {
	AUDIT_DEFAULT_SEARCH,
	AUDIT_PAGE_SIZE,
	type AuditSearch,
	auditSearchInput,
	isDefaultAuditSearch,
} from "@/lib/audit-search";
import {
	type AdminPaymentsSearch,
	paymentsEventsInput,
	paymentsPoliciesInput,
	paymentsSummaryInput,
} from "@/lib/admin-payments-search";
import {
	activeOutputLibraryQueryOptions,
	appListQueryOptions,
	activeWorkspacesQueryOptions,
	API_KEYS_PAGE_SIZE,
	apiKeyListQueryOptions,
	appAdaptersListQueryOptions,
	appAnalyticsRange,
	appAnalyticsSummaryQueryOptions,
	appDetailQueryOptions,
	appFreshnessQueryOptions,
	appMetricsQueryOptions,
	appRecentExecutionsQueryOptions,
	appSecretsListQueryOptions,
	appTimeSeriesQueryOptions,
	appToolBreakdownQueryOptions,
	appToolsListQueryOptions,
	contentSourcesQueryOptions,
	tediAppAssignmentsByAppQueryOptions,
	auditSearchQueryOptions,
	EXPIRING_API_KEYS_WINDOW_DAYS,
	expiringApiKeysQueryOptions,
	billingOverviewQueryOptions,
	billingPlansQueryOptions,
	BLUEPRINT_GALLERY_LIMIT,
	BLUEPRINTS_LIST_LIMIT,
	blueprintGalleryQueryOptions,
	blueprintListQueryOptions,
	canvasGadgetsQueryOptions,
	canvasOutputsQueryOptions,
	connectionsOverviewQueryOptions,
	earnedDelegationProfileQueryOptions,
	homeRunQueryOptions,
	homeRunTraceQueryOptions,
	catalogAppDetailQueryOptions,
	catalogCategoriesQueryOptions,
	catalogListQueryOptions,
	MEMBERS_PAGE_SIZE,
	membersListQueryOptions,
	mcpPaymentsEventsQueryOptions,
	mcpPaymentsPoliciesQueryOptions,
	mcpPaymentsSpendSummaryQueryOptions,
	modelCatalogQueryOptions,
	latestGrowthSnapshotQueryOptions,
	operationalContextQueryOptions,
	pendingApprovalsQueryOptions,
	ORG_USAGE_PERIOD,
	orgUsageQueryOptions,
	organizationDetailQueryOptions,
	organizationFeaturesQueryOptions,
	outputDetailQueryOptions,
	runtimeEventsQueryOptions,
	projectListQueryOptions,
	projectRollupQueryOptions,
	SKILL_CATALOG_LIMIT,
	skillCatalogQueryOptions,
	skillDetailQueryOptions,
	skillReliabilityQueryOptions,
	skillRevisionsQueryOptions,
	skillRunsQueryOptions,
	skillSchedulesQueryOptions,
	skillSpecificSchedulesQueryOptions,
	SKILL_SCHEDULES_LIMIT,
	tediOperationsSummariesQueryOptions,
	tediPairingRequestsQueryOptions,
	tediAppAssignmentsQueryOptions,
	tediDetailQueryOptions,
	tediDevicesQueryOptions,
	tediDomainsQueryOptions,
	tediEmailAddressesQueryOptions,
	tediEmailInboxQueryOptions,
	tediExpertiseQueryOptions,
	tediKnowledgeMapQueryOptions,
	tediRationaleQueryOptions,
	tediRosterQueryOptions,
	tediRuntimeStatusQueryOptions,
	tediSecretsQueryOptions,
	TEDI_ROSTER_LIMIT,
	workflowDefinitionHealthQueryOptions,
	workflowDefinitionsQueryOptions,
	WORKFLOW_DEFINITIONS_LIMIT,
	workGraphItemsQueryOptions,
	workAttemptProjectionQueryOptions,
	workItemRelationsQueryOptions,
	workRecoveryProjectionQueryOptions,
	workReadinessProjectionQueryOptions,
	workApprovalsQueryOptions,
	workBudgetEnvelopesQueryOptions,
	workCaseListQueryOptions,
	workFleetQueryOptions,
	workInteractionsQueryOptions,
	workResourcePoolsQueryOptions,
	workspacePreferencesQueryOptions,
} from "@/lib/os-query-options";
import { SKILLS_PAGE_SIZE, type SkillsSearch } from "@/lib/skills-search";
import type { CatalogRouteSearch } from "@/lib/catalog-search";
import { catalogListInput } from "@/lib/catalog-search";

const UUID_ROUTE_PARAM =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuidRouteParam(value: unknown): value is string {
	return typeof value === "string" && UUID_ROUTE_PARAM.test(value);
}

export function optionalUuidSearchParam(value: unknown): string | undefined {
	return isUuidRouteParam(value) ? value : undefined;
}

export function requireUuidRouteParam(value: string): string {
	if (!isUuidRouteParam(value)) throw notFound();
	return value;
}

export function requireRunRouteParam(value: string): string {
	if (value.length === 0 || value.length > 256 || value.trim() !== value) {
		throw notFound();
	}
	return value;
}

/**
 * How long a route loader may hold first paint on a warm-up read.
 *
 * A loader await is NOT bounded by the API transport alone. `osApi` aborts an
 * attempt at `OS_API_REQUEST_TIMEOUT_MS` (15s), but the query client retries
 * twice (`router.tsx`), so one ensured read has a ~48s worst case — more than
 * twice `OS_ROUTE_PENDING_STALL_MS` (20s). A cold apps/api isolate that eats
 * one attempt therefore parks the route on the pending screen until the stall
 * watchdog fires: the route never failed, it was still legitimately waiting.
 *
 * So the awaited part of a loader carries its own deadline, well under the
 * watchdog. Past it the loader resolves anyway and the route renders its shell;
 * the read is NOT cancelled — it stays in flight and lands in the same cache
 * entry the component's own `useQuery` is subscribed to, so the data streams in
 * with no second request. First paint stops being hostage to the slowest read.
 */
export const OS_LOADER_FIRST_PAINT_DEADLINE_MS = 4_000;

/**
 * Resolve with the read's value, or with `undefined` once the deadline passes
 * or the read rejects. Never rejects: a loader that throws blocks the
 * navigation and shows the route error boundary, when the honest outcome is to
 * land on the page and let the surface render its own state.
 */
export function withFirstPaintDeadline<T>(
	read: Promise<T>,
	deadlineMs: number = OS_LOADER_FIRST_PAINT_DEADLINE_MS,
): Promise<T | undefined> {
	return new Promise<T | undefined>((resolve) => {
		const timer = setTimeout(() => resolve(undefined), deadlineMs);
		read.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				clearTimeout(timer);
				resolve(undefined);
			},
		);
	});
}

export async function prefetchCanvasRoute(
	queryClient: QueryClient,
	requestedWorkspaceId?: string,
) {
	const workspacesPromise = queryClient.ensureQueryData(
		activeWorkspacesQueryOptions(),
	);
	/*
	 * Warm the resource caches WITHOUT blocking first paint. This loader used to
	 * await gadgets and outputs too, which held the whole route on three reads --
	 * on a cold API isolate the pending screen sat for tens of seconds with no
	 * feedback and no bound. The resource rail and the workpiece pane each carry
	 * their own skeletons for exactly these queries, so the only read the route
	 * genuinely needs before painting is the workspace list (membership and the
	 * fallback id). `void` + allSettled: a failed prefetch surfaces where the
	 * component retries it, never as a route error.
	 */
	const warmResources = (workspaceId: string) => {
		void Promise.allSettled([
			queryClient.ensureQueryData(canvasGadgetsQueryOptions(workspaceId)),
			queryClient.ensureQueryData(canvasOutputsQueryOptions(workspaceId)),
		]);
	};
	// The fallback warm-up follows the list whenever it lands, deadline or not,
	// so a slow list still primes the rail instead of leaving it cold.
	const resolveWorkspaceId = (workspaces: {
		items: readonly { id: string }[];
	}) =>
		requestedWorkspaceId &&
		workspaces.items.some(({ id }) => id === requestedWorkspaceId)
			? requestedWorkspaceId
			: workspaces.items[0]?.id;
	if (requestedWorkspaceId) warmResources(requestedWorkspaceId);
	void workspacesPromise.then(
		(workspaces) => {
			const workspaceId = resolveWorkspaceId(workspaces);
			if (workspaceId && workspaceId !== requestedWorkspaceId) {
				warmResources(workspaceId);
			}
		},
		() => undefined,
	);

	const workspaces = await withFirstPaintDeadline(workspacesPromise);
	// Past the deadline (or on a failed read) the route renders its shell and
	// `CanvasPage`'s own `activeWorkspaces` query resolves the selection; the
	// loader's return value is warm-up evidence, not a render input.
	if (!workspaces) return { workspaceId: requestedWorkspaceId };
	return { workspaceId: resolveWorkspaceId(workspaces) };
}

/*
 * Detail-route identity loaders.
 *
 * Semantics: a slow read is not evidence of absence.
 *
 * These two loaders used to await an unbounded identity read, with the same
 * exposure that parked the workspace route past the stall watchdog — `osApi`
 * bounds one attempt at 15s and the query client retries twice, so a cold
 * apps/api isolate can hold one ensured read for ~48s against a 20s watchdog.
 * The difference from the canvas loader is that HERE the await also decided
 * whether the resource exists: a rejected read rejected the loader, so a
 * transport timeout and a genuine 404 were the same outcome to the operator.
 * That is the dishonest case — telling someone their run is gone because an
 * isolate was cold.
 *
 * So the verdict moves to the only layer that can tell those apart: the
 * component's own query, which distinguishes a settled `NOT_FOUND` from every
 * other failure (`DetailUnavailable`, `@/lib/orpc-error`). What stays in the
 * loader is the part that needs no read at all — a param whose SHAPE cannot
 * name a resource is still an immediate `notFound()`, evidence of absence
 * without asking the server.
 *
 * The read itself keeps its head start and is bounded by
 * `withFirstPaintDeadline`: past the deadline the loader resolves anyway and
 * the route renders, while the read stays in flight against the same cache
 * entry the component's `useQuery` subscribes to. A warm read still gates first
 * paint so the page paints with data; a slow one paints the skeleton and fills
 * in; a missing one paints the not-found state. No second request, no route
 * error boundary, and a timeout is never reported as "not found".
 */

export async function prefetchOutputRoute(
	queryClient: QueryClient,
	outputId: string,
) {
	const validatedOutputId = requireUuidRouteParam(outputId);
	await withFirstPaintDeadline(
		queryClient.ensureQueryData(outputDetailQueryOptions(validatedOutputId)),
	);
	return { outputId: validatedOutputId };
}

export async function prefetchHomeExecutionRoute(
	queryClient: QueryClient,
	runId: string,
) {
	const validatedRunId = requireRunRouteParam(runId);
	await withFirstPaintDeadline(
		Promise.all([
			queryClient.ensureQueryData(homeRunQueryOptions(validatedRunId)),
			queryClient.ensureQueryData(homeRunTraceQueryOptions(validatedRunId)),
		]),
	);
	return { runId: validatedRunId };
}

/*
 * List-route prefetchers.
 *
 * `defaultPreload: "intent"` already fetches a route's component chunk on hover
 * or touch; without a loader it fetches no DATA, so the page still starts its
 * reads after it renders. These close that gap.
 *
 * Every one of them uses `Promise.allSettled`, deliberately: a list route's
 * reads are independent, and a failed read must not reject the loader. A
 * rejected loader blocks the navigation entirely and shows the route error
 * boundary, when the honest outcome is to land on the page and let the
 * surface's own `useQuery` render its error state. The detail loaders above
 * reach the same outcome from the other direction: they still validate the
 * param shape synchronously, but their read is bounded and non-throwing.
 *
 * Each call passes the SAME input constant its surface passes. A generated key
 * encodes the complete input, so a loader that guessed the limit would warm a
 * different cache entry than the component reads and the prefetch would be
 * silently dead — which is why those limits live in `os-query-options.ts`.
 */

export async function prefetchWorkspacesRoute(queryClient: QueryClient) {
	await Promise.allSettled([
		queryClient.ensureQueryData(activeWorkspacesQueryOptions()),
		queryClient.ensureQueryData(workspacePreferencesQueryOptions()),
	]);
}

export async function prefetchOutputsRoute(queryClient: QueryClient) {
	await queryClient.ensureQueryData(activeOutputLibraryQueryOptions()).catch(
		// The library is this route's only read; landing on the page with its own
		// error state beats blocking the navigation.
		() => undefined,
	);
}

export async function prefetchTeamRoute(
	queryClient: QueryClient,
	deps: { tab: "tedis" | "members" | "roles"; page: number } = {
		tab: "tedis",
		page: 1,
	},
) {
	const reads: Promise<unknown>[] = [];
	if (deps.tab === "tedis") {
		reads.push(
			queryClient.ensureQueryData(
				tediRosterQueryOptions(TEDI_ROSTER_LIMIT, {
					offset: (deps.page - 1) * TEDI_ROSTER_LIMIT,
				}),
			),
		);
	}
	if (deps.tab === "members") {
		// The members read needs the credential-resolved organization id first.
		// Both reads stay inside the allSettled so a failed context or members
		// read lands on the page with its own error state instead of blocking
		// the navigation.
		reads.push(
			queryClient
				.ensureQueryData(operationalContextQueryOptions())
				.then((context) =>
					queryClient.ensureQueryData(
						membersListQueryOptions({
							organizationId: context.organization.id,
							limit: MEMBERS_PAGE_SIZE,
							offset: (deps.page - 1) * MEMBERS_PAGE_SIZE,
						}),
					),
				),
		);
	}
	await Promise.allSettled(reads);
}

export async function prefetchCreateTediRoute(queryClient: QueryClient) {
	// Model availability and caller authority are independent first-paint reads.
	// Runtime/policy/workspace-template profiles are server-bound to the three
	// system defaults by `tedis.create`; there is no client-selected profile read.
	await Promise.allSettled([
		queryClient.ensureQueryData(modelCatalogQueryOptions()),
		queryClient.ensureQueryData(operationalContextQueryOptions()),
	]);
}

export async function prefetchTediDetailRoute(
	queryClient: QueryClient,
	tediId: string,
) {
	const id = requireUuidRouteParam(tediId);
	await Promise.allSettled([
		queryClient.ensureQueryData(tediDetailQueryOptions(id)),
		queryClient.ensureQueryData(tediOperationsSummariesQueryOptions()),
	]);
	return { tediId: id };
}

export async function prefetchTediAuthorityRoute(
	queryClient: QueryClient,
	tediId: string,
) {
	await queryClient
		.ensureQueryData(earnedDelegationProfileQueryOptions(tediId))
		.catch(() => undefined);
}

export async function prefetchTediTelemetryRoute(
	queryClient: QueryClient,
	tediId: string,
) {
	await Promise.allSettled([
		queryClient.ensureQueryData(
			runtimeEventsQueryOptions({
				tediId,
				kind: "tool.completed",
				limit: 40,
			}),
		),
		queryClient.ensureQueryData(
			runtimeEventsQueryOptions({ tediId, kind: "tool.failed", limit: 40 }),
		),
	]);
}

export async function prefetchTediLearningRoute(
	queryClient: QueryClient,
	tediId: string,
) {
	await Promise.allSettled([
		queryClient.ensureQueryData(tediExpertiseQueryOptions(tediId)),
		queryClient.ensureQueryData(latestGrowthSnapshotQueryOptions(tediId)),
	]);
}

export async function prefetchTediMemoryRoute(
	queryClient: QueryClient,
	tediId: string,
) {
	await Promise.allSettled([
		queryClient.ensureQueryData(tediKnowledgeMapQueryOptions(tediId, 2, 60)),
		queryClient.ensureQueryData(tediRationaleQueryOptions(tediId, 25)),
	]);
}

export async function prefetchTediMailboxRoute(
	queryClient: QueryClient,
	tediId: string,
) {
	await Promise.allSettled([
		queryClient.ensureQueryData(tediDetailQueryOptions(tediId)),
		queryClient.ensureQueryData(tediEmailAddressesQueryOptions(tediId)),
		queryClient.ensureQueryData(tediEmailInboxQueryOptions(tediId, "open")),
	]);
}

export async function prefetchTediSettingsRoute(
	queryClient: QueryClient,
	tediId: string,
) {
	const context = await queryClient
		.ensureQueryData(operationalContextQueryOptions())
		.catch(() => undefined);
	const reads: Promise<unknown>[] = [
		queryClient.ensureQueryData(tediDetailQueryOptions(tediId)),
		queryClient.ensureQueryData(tediRuntimeStatusQueryOptions(tediId)),
		queryClient.ensureQueryData(modelCatalogQueryOptions(tediId)),
		queryClient.ensureQueryData(tediDevicesQueryOptions(tediId)),
		queryClient.ensureQueryData(tediDomainsQueryOptions(tediId)),
		queryClient.ensureQueryData(tediAppAssignmentsQueryOptions(tediId)),
		queryClient.ensureQueryData(tediPairingRequestsQueryOptions(tediId)),
		queryClient.ensureQueryData(appListQueryOptions(100)),
	];
	const permissions: readonly string[] = context?.authority.permissions ?? [];
	if (
		permissions.includes("secrets:manage") ||
		permissions.includes("tools:read")
	) {
		reads.push(queryClient.ensureQueryData(tediSecretsQueryOptions(tediId)));
	}
	await Promise.allSettled(reads);
}

export async function prefetchAdminApiKeysRoute(
	queryClient: QueryClient,
	deps: { page: number } = { page: 1 },
) {
	// Both reads need the credential-resolved organization id first. Everything
	// stays catch-tolerant: a failed context or key read lands on the page with
	// its own error state instead of blocking the navigation.
	await queryClient
		.ensureQueryData(operationalContextQueryOptions())
		.then((context) =>
			Promise.allSettled([
				queryClient.ensureQueryData(
					apiKeyListQueryOptions({
						organizationId: context.organization.id,
						limit: API_KEYS_PAGE_SIZE,
						offset: (deps.page - 1) * API_KEYS_PAGE_SIZE,
					}),
				),
				queryClient.ensureQueryData(
					expiringApiKeysQueryOptions(
						context.organization.id,
						EXPIRING_API_KEYS_WINDOW_DAYS,
					),
				),
			]),
		)
		.catch(() => undefined);
}

export async function prefetchAdminConnectionsRoute(
	queryClient: QueryClient,
	scope: "organization" | "personal" = "organization",
) {
	await queryClient
		.ensureQueryData(
			connectionsOverviewQueryOptions({
				scope,
				q: "",
				status: "all",
				limit: 100,
				offset: 0,
			}),
		)
		.catch(() => undefined);
}

export async function prefetchAdminOrganizationRoute(queryClient: QueryClient) {
	// The org detail and features reads need the credential-resolved
	// organization id first; the billing catalog/overview take no input and can
	// start immediately. Everything stays catch-tolerant: a failed read lands on
	// the page with its own error state instead of blocking the navigation.
	const billingReads = Promise.allSettled([
		queryClient.ensureQueryData(billingPlansQueryOptions()),
		queryClient.ensureQueryData(billingOverviewQueryOptions()),
	]);
	await queryClient
		.ensureQueryData(operationalContextQueryOptions())
		.then((context) =>
			Promise.allSettled([
				queryClient.ensureQueryData(
					organizationDetailQueryOptions(context.organization.id),
				),
				queryClient.ensureQueryData(
					organizationFeaturesQueryOptions(context.organization.id),
				),
			]),
		)
		.catch(() => undefined);
	await billingReads;
}

export async function prefetchAdminBillingRoute(queryClient: QueryClient) {
	if (isLocalSession()) return;
	// Usage is keyed by both the host-resolved organization and the canonical
	// billing window. Resolve those two authorities before warming the chart row.
	const plansRead = queryClient.ensureQueryData(billingPlansQueryOptions());
	const [contextResult, overviewResult] = await Promise.allSettled([
		queryClient.ensureQueryData(operationalContextQueryOptions()),
		queryClient.ensureQueryData(billingOverviewQueryOptions()),
	]);
	if (
		contextResult.status === "fulfilled" &&
		overviewResult.status === "fulfilled"
	) {
		// Warm the chart, but never gate the route on it. This read spans the
		// whole billing period, and a period is not bounded (an annual plan can
		// have most of a year left), and awaiting that query left /admin/billing blank behind "OS route load still
		// pending after 20000ms" — on the one page a blocked operator is sent to.
		// The surrounding `.catch()` already said a failed warm is survivable; a
		// SLOW warm has to be survivable for the same reason.
		void queryClient
			.ensureQueryData(
				orgUsageQueryOptions(
					contextResult.value.organization.id,
					ORG_USAGE_PERIOD,
					{
						from: overviewResult.value.snapshot.periodStart,
						to: overviewResult.value.snapshot.periodEnd,
					},
				),
			)
			.catch(() => undefined);
	}
	await Promise.allSettled([plansRead]);
}

export async function prefetchAdminPaymentsRoute(
	queryClient: QueryClient,
	deps: AdminPaymentsSearch,
) {
	// Three independent org-scoped reads built through the SAME input builders
	// the surface uses, so the loader warms the exact generated keys the page
	// reads. The open receipt is deliberately not prefetched: only a settled
	// event carries one and the sheet renders its own pending state.
	await Promise.allSettled([
		queryClient.ensureQueryData(
			mcpPaymentsEventsQueryOptions(paymentsEventsInput(deps)),
		),
		queryClient.ensureQueryData(
			mcpPaymentsSpendSummaryQueryOptions(paymentsSummaryInput(deps)),
		),
		queryClient.ensureQueryData(
			mcpPaymentsPoliciesQueryOptions(paymentsPoliciesInput(deps)),
		),
	]);
}

export async function prefetchAuditRoute(
	queryClient: QueryClient,
	deps: AuditSearch = AUDIT_DEFAULT_SEARCH,
) {
	// The unfiltered first page is both the default view and the facet source
	// (see audit-page.tsx), so it always warms; a narrowed or paged deep link
	// warms its own read alongside it. Both stay catch-tolerant: a failed read
	// lands on the page with its own error state instead of blocking the
	// navigation.
	const reads: Promise<unknown>[] = [
		queryClient.ensureQueryData(
			auditSearchQueryOptions({ limit: AUDIT_PAGE_SIZE }),
		),
	];
	if (!isDefaultAuditSearch(deps)) {
		reads.push(
			queryClient.ensureQueryData(
				auditSearchQueryOptions(auditSearchInput(deps)),
			),
		);
	}
	await Promise.allSettled(reads);
}

export async function prefetchBlueprintsRoute(queryClient: QueryClient) {
	await Promise.allSettled([
		queryClient.ensureQueryData(
			blueprintListQueryOptions(BLUEPRINTS_LIST_LIMIT),
		),
		queryClient.ensureQueryData(
			blueprintGalleryQueryOptions(BLUEPRINT_GALLERY_LIMIT),
		),
	]);
}

export async function prefetchSkillsRoute(
	queryClient: QueryClient,
	search?: SkillsSearch,
) {
	if (!search) {
		await Promise.allSettled([
			queryClient.ensureQueryData(
				skillCatalogQueryOptions(SKILL_CATALOG_LIMIT),
			),
			queryClient.ensureQueryData(
				workflowDefinitionHealthQueryOptions(WORKFLOW_DEFINITIONS_LIMIT),
			),
			queryClient.ensureQueryData(
				skillSchedulesQueryOptions(SKILL_SCHEDULES_LIMIT),
			),
		]);
		return;
	}
	const input = {
		limit: SKILLS_PAGE_SIZE,
		offset: (search.page - 1) * SKILLS_PAGE_SIZE,
		query: search.q || undefined,
	};
	const reads =
		search.section === "skills"
			? [queryClient.ensureQueryData(skillCatalogQueryOptions(input))]
			: search.section === "triggers"
				? [queryClient.ensureQueryData(skillSchedulesQueryOptions(input))]
				: [queryClient.ensureQueryData(workflowDefinitionsQueryOptions(input))];
	await Promise.allSettled(reads);
}

export async function prefetchSkillDetailRoute(
	queryClient: QueryClient,
	skillId: string,
) {
	const validatedSkillId = requireUuidRouteParam(skillId);
	const detail = await queryClient.ensureQueryData(
		skillDetailQueryOptions(validatedSkillId),
	);
	if (!detail.entry) throw notFound();
	return { skillId: validatedSkillId };
}

export async function prefetchSkillOverviewRoute(
	queryClient: QueryClient,
	skillId: string,
) {
	await Promise.allSettled([
		queryClient.ensureQueryData(skillReliabilityQueryOptions(skillId)),
		queryClient.ensureQueryData(skillRunsQueryOptions(skillId)),
	]);
}

export async function prefetchSkillRunsRoute(
	queryClient: QueryClient,
	skillId: string,
	status?: Parameters<typeof skillRunsQueryOptions>[1],
) {
	await queryClient
		.ensureQueryData(skillRunsQueryOptions(skillId, status))
		.catch(() => undefined);
}

export async function prefetchSkillVersionsRoute(
	queryClient: QueryClient,
	skillId: string,
) {
	await queryClient
		.ensureQueryData(skillRevisionsQueryOptions(skillId))
		.catch(() => undefined);
}

export async function prefetchSkillScheduleRoute(
	queryClient: QueryClient,
	skillId: string,
) {
	await queryClient
		.ensureQueryData(skillSpecificSchedulesQueryOptions(skillId))
		.catch(() => undefined);
}

const WORK_ROUTE_LIMIT = 100;

export async function prefetchWorkQueueRoute(queryClient: QueryClient) {
	await withFirstPaintDeadline(
		Promise.allSettled([
			queryClient.ensureQueryData(workReadinessProjectionQueryOptions()),
			queryClient.ensureQueryData(workFleetQueryOptions()),
		]),
	);
}

export async function prefetchWorkPortfolioRoute(queryClient: QueryClient) {
	// Match WorkPortfolioPage's first-page input exactly so it consumes this cache.
	const pageSize = 20;
	await withFirstPaintDeadline(
		(async () => {
			const projects = await queryClient
				.ensureQueryData(projectListQueryOptions(pageSize, { offset: 0 }))
				.catch(() => null);
			if (projects) {
				await Promise.allSettled(
					projects.data
						.slice(0, pageSize)
						.map((project) =>
							queryClient.ensureQueryData(
								projectRollupQueryOptions(project.id),
							),
						),
				);
			}
		})(),
	);
}

export async function prefetchWorkGraphRoute(queryClient: QueryClient) {
	await Promise.allSettled([
		queryClient.ensureQueryData(
			workGraphItemsQueryOptions({}, WORK_ROUTE_LIMIT),
		),
		queryClient.ensureQueryData(workItemRelationsQueryOptions({}, 5000)),
	]);
}

export async function prefetchWorkAttemptsRoute(queryClient: QueryClient) {
	await queryClient
		.ensureQueryData(workAttemptProjectionQueryOptions())
		.catch(() => undefined);
}

export async function prefetchWorkRecoveryRoute(queryClient: QueryClient) {
	await queryClient
		.ensureQueryData(workRecoveryProjectionQueryOptions())
		.catch(() => undefined);
}

export async function prefetchWorkCasesRoute(queryClient: QueryClient) {
	await queryClient
		.ensureQueryData(workCaseListQueryOptions())
		.catch(() => undefined);
}

export async function prefetchWorkApprovalsRoute(queryClient: QueryClient) {
	await Promise.allSettled([
		queryClient.ensureQueryData(pendingApprovalsQueryOptions()),
		queryClient.ensureQueryData(workApprovalsQueryOptions()),
	]);
}

export async function prefetchWorkInteractionsRoute(queryClient: QueryClient) {
	await queryClient
		.ensureQueryData(workInteractionsQueryOptions())
		.catch(() => undefined);
}

export async function prefetchWorkControlRoute(queryClient: QueryClient) {
	await queryClient
		.ensureQueryData(workFleetQueryOptions())
		.catch(() => undefined);
}

export async function prefetchWorkCapacityRoute(queryClient: QueryClient) {
	await Promise.allSettled([
		queryClient.ensureQueryData(workResourcePoolsQueryOptions()),
		queryClient.ensureQueryData(workBudgetEnvelopesQueryOptions()),
	]);
}

export async function prefetchCatalogRoute(
	queryClient: QueryClient,
	search: CatalogRouteSearch,
) {
	if (isLocalSession()) return;
	const input = catalogListInput(search);
	await Promise.allSettled([
		queryClient.ensureQueryData(catalogListQueryOptions(input)),
		queryClient.ensureQueryData(catalogCategoriesQueryOptions()),
	]);
}

export async function prefetchCatalogDetailRoute(
	queryClient: QueryClient,
	slug: string,
) {
	if (!slug || slug.length > 256 || slug.trim() !== slug) throw notFound();
	const app = await queryClient.ensureQueryData(
		catalogAppDetailQueryOptions(slug),
	);
	if (!app) throw notFound();
	return { slug };
}

/*
 * /apps/$appId loaders.
 *
 * The layout loader is the one awaited-and-throwing read: a malformed id or a
 * missing app is a `notFound()`, and every tab renders inside that identity.
 * Each tab's loader is catch-tolerant warm-up for its own reads — the tab
 * loaders run in parallel with the layout loader, so they must not assume the
 * app read already settled.
 */

export async function prefetchAppDetailRoute(
	queryClient: QueryClient,
	appId: string,
) {
	const validatedAppId = requireUuidRouteParam(appId);
	const detail = await queryClient.ensureQueryData(
		appDetailQueryOptions(validatedAppId),
	);
	if (!detail?.app) throw notFound();
	return { appId: validatedAppId };
}

export async function prefetchAppOverviewRoute(
	queryClient: QueryClient,
	appId: string,
) {
	await Promise.allSettled([
		queryClient.ensureQueryData(appDetailQueryOptions(appId)),
		queryClient.ensureQueryData(appAdaptersListQueryOptions(appId)),
		queryClient.ensureQueryData(contentSourcesQueryOptions(appId)),
		queryClient.ensureQueryData(
			appMetricsQueryOptions(appId, appAnalyticsRange()),
		),
	]);
}

export async function prefetchAppAnalyticsRoute(
	queryClient: QueryClient,
	appId: string,
) {
	const range = appAnalyticsRange();
	await Promise.allSettled([
		queryClient.ensureQueryData(appMetricsQueryOptions(appId, range)),
		queryClient.ensureQueryData(appAnalyticsSummaryQueryOptions(appId, range)),
		queryClient.ensureQueryData(appToolBreakdownQueryOptions(appId, range)),
		queryClient.ensureQueryData(appTimeSeriesQueryOptions(appId, range)),
		queryClient.ensureQueryData(appRecentExecutionsQueryOptions(appId, range)),
		queryClient.ensureQueryData(appFreshnessQueryOptions(appId)),
	]);
}

export async function prefetchAppContentRoute(
	queryClient: QueryClient,
	appId: string,
) {
	await Promise.allSettled([
		queryClient.ensureQueryData(appDetailQueryOptions(appId)),
		queryClient.ensureQueryData(contentSourcesQueryOptions(appId)),
	]);
}

export async function prefetchAppToolsRoute(
	queryClient: QueryClient,
	appId: string,
) {
	await Promise.allSettled([
		queryClient.ensureQueryData(appToolsListQueryOptions(appId)),
		queryClient.ensureQueryData(appAdaptersListQueryOptions(appId)),
	]);
}

export async function prefetchAppSettingsRoute(
	queryClient: QueryClient,
	appId: string,
) {
	await Promise.allSettled([
		queryClient.ensureQueryData(appDetailQueryOptions(appId)),
		queryClient.ensureQueryData(appSecretsListQueryOptions(appId)),
		queryClient.ensureQueryData(tediAppAssignmentsByAppQueryOptions(appId)),
		queryClient.ensureQueryData(tediRosterQueryOptions(TEDI_ROSTER_LIMIT)),
	]);
}
