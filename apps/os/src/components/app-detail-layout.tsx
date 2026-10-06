/**
 * /apps/$appId layout: the app's identity header plus the sub-route tab strip.
 *
 * The layout owns the one identity read (`appDetailQueryOptions`) — the route loader
 * validates the id and throws `notFound()` on a missing app, so every tab
 * renders inside a proven app identity. Tabs are REAL sibling sub-routes, not
 * component state: `autoCodeSplitting` gives each tab its own lazy chunk,
 * which is what keeps the analytics/evals/settings code out of the entry.
 */

import { useQuery } from "@tanstack/react-query";
import {
	Link,
	Outlet,
	useParams,
	useRouterState,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import {
	Page,
	PageBack,
	PageDescription,
	PageHeader,
	PageHeading,
	PageMeta,
	PageTitle,
} from "@/components/kumo/page";
import { Skeleton } from "@/components/kumo/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/kumo/tabs";
import { mcpEndpointHost } from "@/components/app-detail";
import { appDetailQueryOptions } from "@/lib/os-query-options";

function AppMetaCode({ children }: { children: ReactNode }) {
	return (
		<code className="rounded-md border border-kumo-hairline bg-kumo-fill px-1.5 py-px">
			{children}
		</code>
	);
}

const APP_DETAIL_TABS = [
	{ value: "overview", label: "Overview", suffix: "" },
	{ value: "analytics", label: "Analytics", suffix: "/analytics" },
	{ value: "content", label: "Content", suffix: "/content" },
	{ value: "tools", label: "Tools", suffix: "/tools" },
	{ value: "evals", label: "Evals", suffix: "/evals" },
	{ value: "settings", label: "Settings", suffix: "/settings" },
] as const;

type AppDetailTab = (typeof APP_DETAIL_TABS)[number]["value"];

function resolveAppDetailTab(pathname: string, appId: string): AppDetailTab {
	const basePath = `/apps/${appId}`;
	return (
		APP_DETAIL_TABS.find(
			(tab) => tab.suffix && pathname.startsWith(`${basePath}${tab.suffix}`),
		)?.value ?? "overview"
	);
}

function AppTabStrip({ appId }: { appId: string }) {
	const params = { appId };
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	const activeTab = resolveAppDetailTab(pathname, appId);

	return (
		<Tabs value={activeTab}>
			<TabsList aria-label="App sections" variant="line">
				{APP_DETAIL_TABS.map((tab) => (
					<TabsTrigger
						key={tab.value}
						nativeButton={false}
						value={tab.value}
						render={
							<Link
								to={`/apps/$appId${tab.suffix}`}
								params={params}
								preload="intent"
							/>
						}
					>
						{tab.label}
					</TabsTrigger>
				))}
			</TabsList>
		</Tabs>
	);
}

export function AppDetailLayout() {
	// The trailing underscore belongs to the generated route ID, not the URL. It
	// keeps this detail branch a sibling of /apps so AppsPage is not its layout.
	const params = useParams({ from: "/_session/_tenant/apps_/$appId" });
	const appId = params.appId ?? "";

	const detail = useQuery({
		...appDetailQueryOptions(appId),
		enabled: appId.length > 0,
	});

	const app = detail.data?.app ?? null;

	return (
		<Page width="lg">
			<PageBack render={<Link to="/apps" />}>All apps</PageBack>

			{detail.isPending && (
				<div aria-hidden="true" className="grid gap-4">
					<Skeleton className="h-8 w-64" />
					<Skeleton className="h-14" />
					<Skeleton className="h-14" />
					<Skeleton className="h-14" />
				</div>
			)}
			{detail.isError && (
				<Alert variant="destructive">
					<AlertTitle>App is unavailable</AlertTitle>
					<AlertDescription>{(detail.error as Error).message}</AlertDescription>
				</Alert>
			)}
			{detail.data && !app && (
				<Alert variant="destructive">
					<AlertTitle>App not found</AlertTitle>
					<AlertDescription>
						No app with id {appId} exists in this workspace's organization.
					</AlertDescription>
				</Alert>
			)}

			{app && (
				<>
					<PageHeader>
						<PageHeading>
							<PageTitle>{app.name}</PageTitle>
							{app.description && (
								<PageDescription>{app.description}</PageDescription>
							)}
							<PageMeta className="tracking-[-0.1px]">
								<li>
									Slug <strong>{app.slug}</strong>
								</li>
								{app.visibility && (
									<li>
										Visibility <strong>{app.visibility}</strong>
									</li>
								)}
								{app.appStoreStatus && (
									<li>
										App store <strong>{app.appStoreStatus}</strong>
									</li>
								)}
								{app.metadata?.mcpConfig?.authMode && (
									<li>
										MCP auth <strong>{app.metadata.mcpConfig.authMode}</strong>
									</li>
								)}
								<li>
									MCP endpoint <AppMetaCode>{mcpEndpointHost(app)}</AppMetaCode>
								</li>
							</PageMeta>
						</PageHeading>
					</PageHeader>

					<AppTabStrip appId={appId} />

					<Outlet />
				</>
			)}
		</Page>
	);
}

export { resolveAppDetailTab };
