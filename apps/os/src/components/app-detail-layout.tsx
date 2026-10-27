/**
 * /apps/$appId layout: the app's identity header plus the sub-route tab strip.
 *
 * The layout owns the one identity read (`appDetailQueryOptions`) — the route loader
 * validates the id and throws `notFound()` on a missing app, so every tab
 * renders inside a proven app identity. Tabs are REAL sibling sub-routes, not
 * component state: `autoCodeSplitting` gives each tab its own lazy chunk,
 * which is what keeps the analytics/settings code out of the entry.
 */

import { useQuery } from "@tanstack/react-query";
import {
	Link,
	Outlet,
	useParams,
	useRouterState,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
	LoadError,
	Alert,
	AlertDescription,
	AlertTitle,
} from "@/components/kumo/alert";
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
import { KumoTabs } from "@/components/kumo/tabs";
import type { App } from "@tedix/api-contract/schemas/app";
import { AppLogo } from "@/components/app-logo";
import { mcpEndpointHost } from "@/components/app-detail";
import { useIsOrganizationGateway } from "@/components/app-gateway-overview";
import { appDetailQueryOptions } from "@/lib/os-query-options";

function AppMetaCode({ children }: { children: ReactNode }) {
	return (
		<code className="rounded-md border border-kumo-hairline bg-kumo-fill px-2 py-1 [overflow-wrap:anywhere]">
			{children}
		</code>
	);
}

const APP_DETAIL_TABS = [
	{ value: "overview", label: "Overview", suffix: "" },
	{ value: "analytics", label: "Analytics", suffix: "/analytics" },
	{ value: "content", label: "Content", suffix: "/content" },
	{ value: "tools", label: "Tools", suffix: "/tools" },
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
		<KumoTabs
			aria-label="App sections"
			variant="underline"
			value={activeTab}
			tabs={APP_DETAIL_TABS.map((tab) => ({
				value: tab.value,
				label: tab.label,
				nativeButton: false,
				render: (
					<Link
						to={`/apps/$appId${tab.suffix}`}
						params={params}
						preload="intent"
					/>
				),
			}))}
		/>
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
	const isGateway = useIsOrganizationGateway(app);

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
				<LoadError
					title="App is unavailable"
					error={detail.error}
					onRetry={() => {
						void detail.refetch();
					}}
					retrying={detail.isFetching}
				/>
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
					<div className="grid min-w-0 gap-4">
						<PageHeader>
							<div className="flex min-w-0 items-start gap-4">
								<AppLogo
									id={app.slug}
									name={app.name}
									logoUrl={app.logoUrl}
									inheritedLogoUrl={app.inheritedLogoUrl}
									domain={app.primaryDomain}
									size="xl"
									decorative
								/>
								<PageHeading>
									<PageTitle>{app.name}</PageTitle>
									{isGateway ? (
										<PageDescription>
											Your organization&apos;s shared connection. Add it once to
											your AI tool, such as Claude, ChatGPT or Cursor, to use
											your organization&apos;s apps from there.
										</PageDescription>
									) : (
										<>
											{app.description && (
												<PageDescription>{app.description}</PageDescription>
											)}
											<AppMeta app={app} />
										</>
									)}
								</PageHeading>
							</div>
						</PageHeader>

						<AppTabStrip appId={appId} />
					</div>

					<Outlet />
				</>
			)}
		</Page>
	);
}

function AppMeta({ app }: { app: App }) {
	return (
		<PageMeta>
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
	);
}

export { resolveAppDetailTab };
