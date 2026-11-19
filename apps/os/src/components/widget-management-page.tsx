import { ExperienceEditor } from "@/components/widget-experience-editor";
import { WidgetContacts } from "@/components/widget-contacts";
import { WidgetAccessSettings } from "@/components/widget-access-settings";
import { getOsSurface } from "@/lib/os-navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import {
	LoadError,
	Alert,
	AlertDescription,
	AlertTitle,
} from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
} from "@/components/kumo/collapsible";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import {
	Page,
	PageDescription,
	PageHeader,
	PageHeading,
	PageTitle,
	PageToolbar,
} from "@/components/kumo/page";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Skeleton } from "@/components/kumo/skeleton";
import { Switch } from "@/components/kumo/switch";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@/components/kumo/tabs";
import { osApi } from "@/lib/api";
import { PortableWebMcpBuilder } from "@/components/portable-webmcp-builder";
import {
	osQuery,
	operationalContextQueryOptions,
	organizationDetailQueryOptions,
	appAnalyticsRange,
	widgetLifecycleHealthQueryOptions,
} from "@/lib/os-query-options";
import { resolveTediWidgetConfig } from "@/lib/tedi-widget-config";

type Tab = "experience" | "customers" | "settings" | "performance";

function Panel({
	title,
	description,
	children,
}: {
	title: string;
	description: string;
	children: ReactNode;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>{title}</CardTitle>
				<CardDescription>{description}</CardDescription>
			</CardHeader>
			<CardContent className="grid gap-4">{children}</CardContent>
		</Card>
	);
}

export function WidgetManagementPage() {
	const context = useQuery(operationalContextQueryOptions());
	if (context.isPending)
		return (
			<Page width="xl">
				<Skeleton className="h-64 w-full" />
			</Page>
		);
	if (context.isError)
		return (
			<Page width="xl">
				<LoadError
					title="Website chat settings unavailable"
					error={context.error}
					onRetry={() => {
						void context.refetch();
					}}
					retrying={context.isFetching}
					help="The organization context could not be loaded."
				/>
			</Page>
		);
	return <WidgetManagementBody organizationId={context.data.organization.id} />;
}

function WidgetManagementBody({ organizationId }: { organizationId: string }) {
	const surface = getOsSurface("widget");
	const [tab, setTab] = useState<Tab>("experience");
	const [performanceInstallation, setPerformanceInstallation] = useState("all");
	const [audienceBusiness, setAudienceBusiness] = useState<string | null>();
	const client = useQueryClient();
	const organizationQuery = useQuery(
		organizationDetailQueryOptions(organizationId),
	);
	const businesses = useQuery({
		...osQuery.tedis.listWidgetAccessConfigurations.queryOptions({ input: {} }),
		enabled: tab === "settings" || tab === "performance",
	});
	const businessByInstallation = new Map(
		(businesses.data?.data ?? []).map((row) => [row.installationId, row]),
	);
	const lifecycleHealth = useQuery({
		...widgetLifecycleHealthQueryOptions({
			...appAnalyticsRange(),
			...(performanceInstallation === "all"
				? {}
				: { installationId: performanceInstallation }),
		}),
		refetchInterval: tab === "performance" ? 30_000 : false,
	});
	const rows = businesses.data?.data ?? [];
	const hasProviderInstallations = rows.length > 0;
	if (organizationQuery.isPending)
		return (
			<Page width="xl">
				<Skeleton className="h-64 w-full" />
			</Page>
		);
	if (organizationQuery.isError)
		return (
			<Page width="xl">
				<LoadError
					title="Website chat settings unavailable"
					error={organizationQuery.error}
					onRetry={() => {
						void organizationQuery.refetch();
					}}
					retrying={organizationQuery.isFetching}
					help="The organization profile could not be loaded."
				/>
			</Page>
		);
	const organization = organizationQuery.data;
	const config = resolveTediWidgetConfig(organization);
	const selectedPerformanceBusiness = businessByInstallation.get(
		performanceInstallation,
	);

	return (
		<Page width="xl">
			<Tabs
				className="gap-8"
				value={tab}
				onValueChange={(value) => setTab(value as Tab)}
			>
				<div className="grid min-w-0 gap-4">
					<PageHeader className="font-normal">
						<PageHeading>
							<PageTitle>{surface.label}</PageTitle>
							<PageDescription>
								Customize your assistant, manage customer access, and review
								usage for {organization.name}.
							</PageDescription>
						</PageHeading>
					</PageHeader>
					<TabsList variant="line" aria-label="Website chat settings">
						<TabsTrigger value="experience">Customize</TabsTrigger>
						<TabsTrigger value="customers">Customers</TabsTrigger>
						<TabsTrigger value="settings">Installations</TabsTrigger>
						<TabsTrigger value="performance">Performance</TabsTrigger>
					</TabsList>
				</div>
				<TabsContent value="experience" keepMounted className="grid gap-8">
					<ExperienceEditor
						key={organization.id}
						organization={organization}
						config={config}
					/>
					<Collapsible>
						<CollapsibleDefaultTrigger>Advanced</CollapsibleDefaultTrigger>
						<CollapsibleDefaultContent>
							<Card>
								<CardHeader>
									<CardTitle>Tenant route profiles</CardTitle>
									<CardDescription>
										Catalog-driven Portable WebMCP publication with
										tenant-scoped revisions and rollback.
									</CardDescription>
								</CardHeader>
								<CardContent>
									<PortableWebMcpBuilder
										fallbackProfile={config.webMcpProfile}
									/>
								</CardContent>
							</Card>
						</CollapsibleDefaultContent>
					</Collapsible>
				</TabsContent>
				<TabsContent value="customers" className="grid gap-8">
					{audienceBusiness === undefined ? (
						<>
							<Button
								className="w-fit"
								variant="secondary"
								onClick={() => setAudienceBusiness(null)}
							>
								Manage audience
							</Button>
							<WidgetContacts onAudience={setAudienceBusiness} />
						</>
					) : (
						<>
							<Button
								className="w-fit"
								variant="secondary"
								onClick={() => setAudienceBusiness(undefined)}
							>
								Back to customers
							</Button>
							<WidgetAccessSettings
								key={audienceBusiness ?? "all"}
								initialBusinessId={audienceBusiness ?? undefined}
							/>
						</>
					)}
				</TabsContent>
				<TabsContent value="settings" className="grid max-w-4xl gap-8">
					<Panel
						title="Distribution"
						description={
							hasProviderInstallations
								? `${organization.name} is the provider and billing relationship.`
								: "No external host installations are connected to this organization."
						}
					>
						<p>
							{rows.length} tenant installation{rows.length === 1 ? "" : "s"}
						</p>
						<Badge variant={hasProviderInstallations ? "success" : "outline"}>
							{hasProviderInstallations
								? "Embedded provider"
								: "Not acting as an embedded provider"}
						</Badge>
					</Panel>
					<Alert>
						<AlertTitle>
							{organization.name} can see only its own embedded installations
						</AlertTitle>
						<AlertDescription>
							Signed activity is provider-scoped. Regular Tedix OS sign-ins are
							not listed here, and each embedded tenant remains isolated.
						</AlertDescription>
					</Alert>
					{rows.map((row) => (
						<Card key={row.installationId}>
							<CardContent className="py-4">
								<p className="font-medium text-kumo-strong">
									{row.businessName ?? `Installation ${row.installationId}`}
								</p>
								<p className="text-kumo-subtle type-tedix-label">
									{row.allowedOrigin ?? "Business details unavailable"}
								</p>
							</CardContent>
						</Card>
					))}
				</TabsContent>
				<TabsContent value="performance" className="grid max-w-4xl gap-8">
					<PageToolbar
						appearance="inline"
						className="sm:flex-row sm:items-center"
					>
						<Select
							value={performanceInstallation}
							onValueChange={(value) =>
								setPerformanceInstallation(value ?? "all")
							}
						>
							<SelectTrigger
								disabled={businesses.isPending || businesses.isError}
								aria-label="Customer app"
								className="min-w-64"
							>
								<SelectValue>
									{performanceInstallation === "all"
										? "All customer apps"
										: selectedPerformanceBusiness
											? `${selectedPerformanceBusiness.businessName ?? selectedPerformanceBusiness.externalTenantId} · ${new URL(selectedPerformanceBusiness.allowedOrigin).host}`
											: "Selected customer app"}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">All customer apps</SelectItem>
								{businesses.data?.data.map((row) => (
									<SelectItem
										key={row.installationId}
										value={row.installationId}
									>
										{row.businessName ?? row.externalTenantId} ·{" "}
										{new URL(row.allowedOrigin).host}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Button
							variant="secondary"
							disabled={lifecycleHealth.isFetching}
							onClick={() => void lifecycleHealth.refetch()}
						>
							Refresh
						</Button>
					</PageToolbar>
					{businesses.isError && (
						<p className="text-kumo-subtle">
							Customer filters are unavailable. Try again shortly.
						</p>
					)}
					<Panel
						title="Assistant performance"
						description="Response speed and reliability in your customers’ apps over the last 30 days. Updates every 30 seconds; new measurements can take a few minutes to appear. Console chat is excluded."
					>
						{lifecycleHealth.isPending ? (
							<Skeleton className="h-16 w-full" />
						) : lifecycleHealth.isError ? (
							<Badge variant="warning">Health unavailable</Badge>
						) : (
							<>
								<Badge
									variant={
										lifecycleHealth.data.status === "healthy"
											? "success"
											: "warning"
									}
								>
									{!config.analyticsEnabled
										? "Collection off"
										: lifecycleHealth.data.status === "no_data"
											? "Awaiting first event"
											: lifecycleHealth.data.status.replace("_", " ")}
								</Badge>
								{!config.analyticsEnabled ? (
									<p className="text-kumo-subtle">
										Customer activity still appears under Customers. Response
										speed and reliability measurements are turned off.
									</p>
								) : (
									<>
										<p>
											{lifecycleHealth.data.totalEvents} measurements ·{" "}
											{lifecycleHealth.data.sessionAttempts} successful
											connections measured
										</p>
										<p>
											{lifecycleHealth.data.messageSubmissions} messages ·{" "}
											{lifecycleHealth.data.completedAnswers} completed ·{" "}
											{lifecycleHealth.data.cancelledAnswers} cancelled ·{" "}
											{lifecycleHealth.data.failedAnswers} failed
										</p>
										<p className="text-kumo-subtle">
											Average ready {lifecycleHealth.data.avgReadyMs} ms ·
											session {lifecycleHealth.data.avgSessionMs} ms · first
											token {lifecycleHealth.data.avgFirstTokenMs} ms · answer{" "}
											{lifecycleHealth.data.avgAnswerMs} ms. No transcript, tool
											payload, or page URL is collected.
										</p>
									</>
								)}
							</>
						)}
					</Panel>
					<Panel
						title="Performance analytics"
						description="Choose whether to collect assistant performance measurements."
					>
						<div className="flex items-center justify-between gap-4">
							<div>
								<p className="font-medium">Collect performance measurements</p>
								<p className="text-kumo-subtle">
									Collect timing and outcomes without message content. New
									widget sessions collect automatically; an explicit host
									opt-out takes priority.
								</p>
							</div>
							<Switch
								aria-label="Collect assistant performance measurements"
								checked={config.analyticsEnabled === true}
								disabled={organizationQuery.isFetching}
								onCheckedChange={(analyticsEnabled) => {
									void osApi.organizations
										.update({
											organizationId: organization.id,
											metadata: { tediWidget: { ...config, analyticsEnabled } },
										})
										.then(() =>
											client.invalidateQueries({
												queryKey: organizationDetailQueryOptions(
													organization.id,
												).queryKey,
											}),
										);
								}}
							/>
						</div>
					</Panel>
				</TabsContent>
			</Tabs>
		</Page>
	);
}
