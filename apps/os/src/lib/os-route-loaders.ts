import { notFound } from "@tanstack/react-router";

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

export const OS_LOADER_FIRST_PAINT_DEADLINE_MS = 4_000;

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

type Loaders = typeof import("./os-route-loaders-impl");
type LoaderName = {
	[K in keyof Loaders]: K extends `prefetch${string}Route` ? K : never;
}[keyof Loaders];

const loadRouteLoaders = () => import("./os-route-loaders-impl");

function demandLoaded<K extends LoaderName>(name: K): Loaders[K] {
	return ((...args: unknown[]) =>
		loadRouteLoaders().then((loaders) => {
			const loader = loaders[name] as (...values: unknown[]) => unknown;
			return loader(...args);
		})) as Loaders[K];
}

export const prefetchCanvasRoute = demandLoaded("prefetchCanvasRoute");
export const prefetchOutputRoute = demandLoaded("prefetchOutputRoute");
export const prefetchHomeExecutionRoute = demandLoaded(
	"prefetchHomeExecutionRoute",
);
export const prefetchWorkspacesRoute = demandLoaded("prefetchWorkspacesRoute");
export const prefetchOutputsRoute = demandLoaded("prefetchOutputsRoute");
export const prefetchTeamRoute = demandLoaded("prefetchTeamRoute");
export const prefetchCreateTediRoute = demandLoaded("prefetchCreateTediRoute");
export const prefetchTediDetailRoute = demandLoaded("prefetchTediDetailRoute");
export const prefetchTediAuthorityRoute = demandLoaded(
	"prefetchTediAuthorityRoute",
);
export const prefetchTediTelemetryRoute = demandLoaded(
	"prefetchTediTelemetryRoute",
);
export const prefetchTediLearningRoute = demandLoaded(
	"prefetchTediLearningRoute",
);
export const prefetchTediMemoryRoute = demandLoaded("prefetchTediMemoryRoute");
export const prefetchTediMailboxRoute = demandLoaded(
	"prefetchTediMailboxRoute",
);
export const prefetchTediSettingsRoute = demandLoaded(
	"prefetchTediSettingsRoute",
);
export const prefetchAdminApiKeysRoute = demandLoaded(
	"prefetchAdminApiKeysRoute",
);
export const prefetchAdminConnectionsRoute = demandLoaded(
	"prefetchAdminConnectionsRoute",
);
export const prefetchAdminOrganizationRoute = demandLoaded(
	"prefetchAdminOrganizationRoute",
);
export const prefetchAdminBillingRoute = demandLoaded(
	"prefetchAdminBillingRoute",
);
export const prefetchAdminPaymentsRoute = demandLoaded(
	"prefetchAdminPaymentsRoute",
);
export const prefetchAuditRoute = demandLoaded("prefetchAuditRoute");
export const prefetchBlueprintsRoute = demandLoaded("prefetchBlueprintsRoute");
export const prefetchSkillsRoute = demandLoaded("prefetchSkillsRoute");
export const prefetchSkillDetailRoute = demandLoaded(
	"prefetchSkillDetailRoute",
);
export const prefetchSkillOverviewRoute = demandLoaded(
	"prefetchSkillOverviewRoute",
);
export const prefetchSkillRunsRoute = demandLoaded("prefetchSkillRunsRoute");
export const prefetchSkillVersionsRoute = demandLoaded(
	"prefetchSkillVersionsRoute",
);
export const prefetchSkillScheduleRoute = demandLoaded(
	"prefetchSkillScheduleRoute",
);
export const prefetchWorkQueueRoute = demandLoaded("prefetchWorkQueueRoute");
export const prefetchWorkPortfolioRoute = demandLoaded(
	"prefetchWorkPortfolioRoute",
);
export const prefetchWorkGraphRoute = demandLoaded("prefetchWorkGraphRoute");
export const prefetchWorkAttemptsRoute = demandLoaded(
	"prefetchWorkAttemptsRoute",
);
export const prefetchWorkRecoveryRoute = demandLoaded(
	"prefetchWorkRecoveryRoute",
);
export const prefetchWorkCasesRoute = demandLoaded("prefetchWorkCasesRoute");
export const prefetchWorkApprovalsRoute = demandLoaded(
	"prefetchWorkApprovalsRoute",
);

export function prefetchWorkNeedsYouRoute(
	...args: Parameters<Loaders["prefetchWorkNeedsYouRoute"]>
): void {
	void loadRouteLoaders().then((loaders) =>
		loaders.prefetchWorkNeedsYouRoute(...args),
	);
}

export const prefetchWorkCapacityRoute = demandLoaded(
	"prefetchWorkCapacityRoute",
);
export const prefetchCatalogRoute = demandLoaded("prefetchCatalogRoute");
export const prefetchCatalogDetailRoute = demandLoaded(
	"prefetchCatalogDetailRoute",
);
export const prefetchAppDetailRoute = demandLoaded("prefetchAppDetailRoute");
export const prefetchAppOverviewRoute = demandLoaded(
	"prefetchAppOverviewRoute",
);
export const prefetchAppAnalyticsRoute = demandLoaded(
	"prefetchAppAnalyticsRoute",
);
export const prefetchAppContentRoute = demandLoaded("prefetchAppContentRoute");
export const prefetchAppToolsRoute = demandLoaded("prefetchAppToolsRoute");
export const prefetchAppSettingsRoute = demandLoaded(
	"prefetchAppSettingsRoute",
);
