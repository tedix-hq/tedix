import { useState } from "react";
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogCancel,
} from "@/components/kumo/alert-dialog";
import {
	useMutation,
	useQueryClient,
	useSuspenseQuery,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type {
	CatalogAppDetail,
	CatalogMcpToolWithMetrics,
} from "@tedix/api-contract/schemas/catalog";
import {
	ArrowSquareOut,
	CheckCircle,
	Code,
	DownloadSimple,
	Globe,
	Pulse,
	Shield,
	WarningCircle,
	XCircle,
} from "@phosphor-icons/react";
import { toast } from "@/components/kumo/toast";
import { CatalogAppLogo } from "@/components/app-store-page";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Card } from "@/components/kumo/card";
import { CodeBlock } from "@/components/kumo/code";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import {
	Collection,
	Page,
	PageActions,
	PageBack,
	PageDescription,
	PageHeader,
	PageHeading,
	PageSection,
	PageTitle,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { catalogCategoryLabel } from "@/lib/catalog-search";
import {
	catalogAppDetailQueryOptions,
	osQueryKeys,
} from "@/lib/os-query-options";

function HealthBadge({ status }: { status: string | null }) {
	const options = {
		healthy: {
			icon: CheckCircle,
			label: "Catalog check passed",
			variant: "success" as const,
		},
		degraded: {
			icon: WarningCircle,
			label: "Degraded",
			variant: "secondary" as const,
		},
		unhealthy: {
			icon: XCircle,
			label: "Unhealthy",
			variant: "destructive" as const,
		},
		requires_auth: {
			icon: Shield,
			label: "Requires auth",
			variant: "outline" as const,
		},
		blocked: {
			icon: XCircle,
			label: "Blocked",
			variant: "destructive" as const,
		},
		unsupported: {
			icon: Pulse,
			label: "Unsupported",
			variant: "outline" as const,
		},
		unknown: {
			icon: Pulse,
			label: "Not checked",
			variant: "outline" as const,
		},
	};
	const option = options[status as keyof typeof options] ?? options.unknown;
	const Icon = option.icon;
	return (
		<Badge variant={option.variant} className="gap-1">
			<Icon className="size-3" />
			{option.label}
		</Badge>
	);
}

function InfoRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex min-w-0 items-start justify-between gap-4">
			<Text as="span" role="body" tone="secondary">
				{label}
			</Text>
			<Text
				as="span"
				role="body"
				weight="medium"
				className="min-w-0 text-right [overflow-wrap:anywhere]"
			>
				{value}
			</Text>
		</div>
	);
}

export function CatalogToolList({
	tools,
}: {
	tools: CatalogMcpToolWithMetrics[];
}) {
	return (
		<Collection aria-label="MCP tools">
			{tools.map((tool) => (
				<li key={tool.id} className="min-w-0 space-y-2 px-4 py-3">
					<div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
						<Text
							as="code"
							role="body"
							tone="mono"
							weight="semibold"
							className="min-w-0 max-w-full truncate"
						>
							{tool.toolName}
						</Text>
						<div className="flex flex-wrap gap-2">
							{tool.annotations?.readOnlyHint ? (
								<Badge variant="outline">Read-only</Badge>
							) : null}
							{tool.annotations?.destructiveHint ? (
								<Badge variant="destructive">Destructive</Badge>
							) : null}
							{tool.testSuccessRate != null ? (
								<Badge
									variant={
										tool.testSuccessRate >= 0.8
											? "success"
											: tool.testSuccessRate >= 0.5
												? "secondary"
												: "destructive"
									}
								>
									{Math.round(tool.testSuccessRate * 100)}% success
								</Badge>
							) : null}
						</div>
					</div>
					{tool.description ? (
						<Text
							as="p"
							role="label"
							tone="secondary"
							className="[overflow-wrap:anywhere]"
						>
							{tool.description}
						</Text>
					) : null}
					{tool.inputSchema ? (
						<Collapsible className="min-w-0 text-xs">
							<CollapsibleTrigger className="cursor-pointer text-kumo-subtle hover:text-kumo-default">
								Input schema
							</CollapsibleTrigger>
							<CollapsibleContent className="min-w-0 max-w-full">
								<CodeBlock
									className="mt-1 max-h-48 w-full min-w-0 max-w-full overflow-auto"
									code={JSON.stringify(tool.inputSchema, null, 2)}
									lang="json"
								/>
							</CollapsibleContent>
						</Collapsible>
					) : null}
				</li>
			))}
		</Collection>
	);
}

function variantSummary(
	variant: NonNullable<CatalogAppDetail["variants"]>[number],
): string {
	const runnable =
		variant.installabilityState === "installable" ||
		variant.installabilityState === "needs_base_app";
	if (!runnable) return "Listing only";
	if (variant.mcpToolCount === 0) return "MCP server";
	return `${variant.mcpToolCount} ${variant.mcpToolCount === 1 ? "tool" : "tools"}`;
}

export function CatalogAppMetadata({ app }: { app: CatalogAppDetail }) {
	const listings = app.storeListings ?? [];
	const variants = app.variants ?? [];
	const hasLinks = Boolean(
		app.website || app.privacyPolicy || app.termsOfService,
	);
	return (
		<Card
			size="sm"
			aria-label="App metadata"
			className="gap-0 overflow-hidden p-0"
		>
			<section
				aria-labelledby="app-details-heading"
				className="space-y-3 p-4 text-sm"
			>
				<Text
					as="h2"
					id="app-details-heading"
					role="section"
					weight="semibold"
					className="m-0"
				>
					Details
				</Text>
				<InfoRow label="Status" value={app.status ?? "—"} />
				<InfoRow
					label="Installability"
					value={
						app.installability.installable
							? "Installable"
							: app.installability.reason
					}
				/>
				<InfoRow label="Connector" value={app.connectorType ?? "—"} />
				<InfoRow label="Developer type" value={app.developerType ?? "—"} />
				{app.mcpToolCount != null ? (
					<InfoRow label="Tools" value={String(app.mcpToolCount)} />
				) : null}
				{app.mcpResourceCount != null ? (
					<InfoRow label="Resources" value={String(app.mcpResourceCount)} />
				) : null}
				{app.healthUptimePercent != null ? (
					<InfoRow
						label="Uptime (30d)"
						value={`${app.healthUptimePercent.toFixed(1)}%`}
					/>
				) : null}
				{app.healthConnectTimeMs != null ? (
					<InfoRow
						label="Connect time"
						value={`${app.healthConnectTimeMs}ms`}
					/>
				) : null}
				{app.mcpServerName ? (
					<InfoRow label="Server" value={app.mcpServerName} />
				) : null}
				{app.mcpServerVersion ? (
					<InfoRow label="Version" value={app.mcpServerVersion} />
				) : null}
				{app.baseUrl ? (
					<div>
						<Text as="p" role="label" tone="secondary">
							MCP endpoint
						</Text>
						<Text as="code" role="label" className="block max-w-full truncate">
							{app.baseUrl}
						</Text>
					</div>
				) : null}
			</section>
			{listings.length ? (
				<section
					aria-labelledby="store-listings-heading"
					className="border-kumo-line border-t p-4"
				>
					<Text
						as="h2"
						id="store-listings-heading"
						role="section"
						weight="semibold"
						className="m-0 mb-3 flex items-center gap-2"
					>
						<Globe className="size-4" />
						Store listings ({listings.length})
					</Text>
					<Collection appearance="inline" aria-label="Store listings">
						{listings.map((listing) => (
							<li
								key={listing.id}
								className="flex min-w-0 items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
							>
								<div className="min-w-0">
									<Text
										as="p"
										role="body"
										weight="medium"
										className="capitalize"
									>
										{listing.source}
									</Text>
									{listing.regions?.length ? (
										<Text
											as="p"
											role="label"
											tone="secondary"
											className="[overflow-wrap:anywhere]"
										>
											{listing.regions.join(", ")}
										</Text>
									) : null}
								</div>
								{listing.storeUrl ? (
									<Button
										variant="ghost"
										size="sm"
										aria-label={`Open ${listing.source} store listing`}
										render={
											<a
												href={listing.storeUrl}
												target="_blank"
												rel="noopener noreferrer"
											/>
										}
									>
										<ArrowSquareOut className="size-3" />
									</Button>
								) : null}
							</li>
						))}
					</Collection>
				</section>
			) : null}
			{variants.length ? (
				<section
					aria-labelledby="app-variants-heading"
					className="border-kumo-line border-t p-4"
				>
					<Text
						as="h2"
						id="app-variants-heading"
						role="section"
						weight="semibold"
						className="m-0 mb-3"
					>
						Also available as
					</Text>
					<Collection appearance="inline" aria-label="Same-vendor variants">
						{variants.map((variant) => (
							<li
								key={variant.id}
								className="flex min-w-0 items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
							>
								<Link
									to="/explore/apps/$slug"
									params={{ slug: variant.slug ?? variant.id }}
									className="min-w-0 text-kumo-brand hover:underline [overflow-wrap:anywhere]"
								>
									{variant.name}
									{variant.source ? (
										<span className="capitalize"> · {variant.source}</span>
									) : null}
								</Link>
								<Text as="span" role="label" tone="secondary">
									{variantSummary(variant)}
								</Text>
							</li>
						))}
					</Collection>
				</section>
			) : null}
			{hasLinks ? (
				<section
					aria-labelledby="app-links-heading"
					className="border-kumo-line border-t p-4"
				>
					<Text
						as="h2"
						id="app-links-heading"
						role="section"
						weight="semibold"
						className="m-0 mb-3"
					>
						Links
					</Text>
					<div className="grid gap-2 text-sm">
						{app.website ? (
							<a
								href={app.website}
								target="_blank"
								rel="noopener noreferrer"
								className="flex items-center gap-2 text-kumo-brand hover:underline"
							>
								<Globe className="size-3.5" />
								Website
							</a>
						) : null}
						{app.privacyPolicy ? (
							<a
								href={app.privacyPolicy}
								target="_blank"
								rel="noopener noreferrer"
								className="flex items-center gap-2 text-kumo-brand hover:underline"
							>
								<Shield className="size-3.5" />
								Privacy policy
							</a>
						) : null}
						{app.termsOfService ? (
							<a
								href={app.termsOfService}
								target="_blank"
								rel="noopener noreferrer"
								className="flex items-center gap-2 text-kumo-brand hover:underline"
							>
								<Shield className="size-3.5" />
								Terms of service
							</a>
						) : null}
					</div>
				</section>
			) : null}
		</Card>
	);
}

export function CatalogAboutSection({ content }: { content: string }) {
	return (
		<PageSection aria-labelledby="catalog-about-heading">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="catalog-about-heading">About</SectionTitle>
				</SectionHeading>
			</SectionHeader>
			<Text
				as="p"
				role="body"
				className="m-0 max-w-3xl whitespace-pre-wrap leading-relaxed [overflow-wrap:anywhere]"
			>
				{content}
			</Text>
		</PageSection>
	);
}

export function InstallButton({
	appId,
	name,
	disabled,
	reason,
}: {
	appId: string;
	name: string;
	disabled: boolean;
	reason: string;
}) {
	const queryClient = useQueryClient();
	const [reviewOpen, setReviewOpen] = useState(false);
	const mutation = useMutation({
		mutationFn: () =>
			osApi.catalog.installFromCatalog({
				catalogAppId: appId,
				visibility: "private",
			}),
		onSuccess: () => {
			setReviewOpen(false);
			toast.success(
				`Installed ${name} for this organization. Review account setup in Installed apps.`,
			);
		},
		onError: (error) =>
			toast.error(error instanceof Error ? error.message : "Install failed"),
		onSettled: async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: osQueryKeys.apps() }),
				queryClient.invalidateQueries({ queryKey: osQueryKeys.catalog() }),
			]);
		},
	});
	return (
		<>
			{mutation.isSuccess ? (
				<Button variant="outline" render={<Link to="/apps" />}>
					Manage installed apps
				</Button>
			) : (
				<Button
					size="sm"
					className="gap-1.5"
					disabled={disabled || mutation.isPending}
					title={disabled ? reason : undefined}
					onClick={() => setReviewOpen(true)}
				>
					<DownloadSimple className="size-3.5" />
					{mutation.isPending
						? "Installing…"
						: disabled
							? "Not installable"
							: "Review installation"}
				</Button>
			)}
			<AlertDialog
				open={reviewOpen}
				onOpenChange={(open) => {
					if (!mutation.isPending) setReviewOpen(open);
				}}
			>
				<AlertDialogContent size="sm">
					<AlertDialogHeader>
						<AlertDialogTitle>
							Install {name} for this organization?
						</AlertDialogTitle>
						<AlertDialogDescription>
							This creates a private organization app. It does not connect a
							personal or shared account, grant tool access, or start an
							automation. Review account setup and permissions after
							installation.
						</AlertDialogDescription>
					</AlertDialogHeader>
					{mutation.isError && (
						<Text role="body" tone="secondary">
							Installation failed. You can retry or cancel.
						</Text>
					)}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={mutation.isPending}>
							Cancel
						</AlertDialogCancel>
						<Button
							disabled={mutation.isPending || disabled}
							onClick={(event) => {
								event.preventDefault();
								mutation.mutate();
							}}
						>
							{mutation.isPending ? "Installing…" : "Install for organization"}
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

export function AppStoreDetailPage({ slug }: { slug: string }) {
	const { data: app } = useSuspenseQuery(catalogAppDetailQueryOptions(slug));
	if (!app) return null;
	const tools = app.tools ?? [];
	return (
		<Page width="xl">
			<PageBack
				render={
					<Link
						to="/explore/apps"
						search={{
							search: undefined,
							category: undefined,
							connectorType: undefined,
							sortBy: undefined,
							healthStatus: undefined,
							offset: 0,
						}}
					/>
				}
			>
				Back to explore
			</PageBack>
			<PageHeader>
				<div className="flex min-w-0 items-start gap-4">
					<CatalogAppLogo
						logoUrl={app.logoUrl ?? null}
						name={app.name}
						size="large"
					/>
					<PageHeading>
						<div className="flex min-w-0 flex-wrap items-center gap-2">
							<PageTitle className="min-w-0 [overflow-wrap:anywhere]">
								{app.name}
							</PageTitle>
							<HealthBadge status={app.healthStatus ?? null} />
						</div>
						{app.developer ? (
							<Text as="p" role="body" tone="secondary">
								by {app.developer}
							</Text>
						) : null}
						{app.description ? (
							<PageDescription className="line-clamp-4 [overflow-wrap:anywhere] sm:line-clamp-none">
								{app.description}
							</PageDescription>
						) : null}
						<div className="flex flex-wrap gap-2">
							{app.category ? (
								<Badge variant="secondary">
									{catalogCategoryLabel(app.category)}
								</Badge>
							) : null}
							{app.connectorType === "MCP" ? (
								<Badge variant="outline" className="gap-1">
									<Code className="size-3" />
									MCP
								</Badge>
							) : null}
							{app.hasInteractive ? (
								<Badge variant="secondary">Interactive</Badge>
							) : null}
							{app.hasWrites ? <Badge variant="secondary">Writes</Badge> : null}
							{app.hasFileSearch ? (
								<Badge variant="secondary">File search</Badge>
							) : null}
							{app.hasDeepResearch ? (
								<Badge variant="secondary">Deep research</Badge>
							) : null}
						</div>
					</PageHeading>
				</div>
				<PageActions>
					<InstallButton
						appId={app.id}
						name={app.name}
						disabled={!app.installability.installable}
						reason={app.installability.reason}
					/>
				</PageActions>
			</PageHeader>
			<div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-3">
				<div className="min-w-0 space-y-6 lg:col-span-2">
					{tools.length ? (
						<PageSection>
							<SectionHeader>
								<SectionHeading>
									<SectionTitle>Capabilities</SectionTitle>
									<SectionDescription>
										{tools.length} MCP {tools.length === 1 ? "tool" : "tools"}{" "}
										discovered from the endpoint.
									</SectionDescription>
								</SectionHeading>
							</SectionHeader>
							<Surface className="px-3">
								<CatalogToolList tools={tools} />
							</Surface>
						</PageSection>
					) : null}
					{app.seoDescription ? (
						<CatalogAboutSection content={app.seoDescription} />
					) : null}
					{app.screenshotUrl ? (
						<PageSection>
							<SectionHeader>
								<SectionHeading>
									<SectionTitle>Preview</SectionTitle>
								</SectionHeading>
							</SectionHeader>
							<img
								src={app.screenshotUrl}
								alt={`${app.name} screenshot`}
								className="w-full rounded-lg border border-kumo-line"
								loading="lazy"
							/>
						</PageSection>
					) : null}
				</div>
				<div className="min-w-0">
					<CatalogAppMetadata app={app} />
				</div>
			</div>
		</Page>
	);
}
