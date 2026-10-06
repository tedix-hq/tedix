import { CapabilityNavigation } from "@/components/capability-navigation";
import { isLocalSession } from "@/lib/local-inference";
import { LocalCapabilityNotice } from "@/components/local-capability-notice";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ListCatalogAppsInput } from "@tedix/api-contract/schemas/catalog";
import {
	CheckCircle,
	Code,
	Globe,
	Pulse,
	Stack,
	WarningCircle,
	Wrench,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import {
	Empty,
	EmptyContent,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import { SearchInput } from "@/components/kumo/search-input";
import {
	Page,
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import {
	CATALOG_PAGE_SIZE,
	catalogCategoryLabel,
	catalogListInput,
	type CatalogRouteSearch,
} from "@/lib/catalog-search";
import {
	catalogCategoriesQueryOptions,
	catalogHealthSummaryQueryOptions,
	catalogListQueryOptions,
	catalogStatsQueryOptions,
} from "@/lib/os-query-options";

type CatalogListData = Awaited<
	ReturnType<typeof import("@/lib/api").osApi.catalog.list>
>;
type CatalogApp = CatalogListData["apps"][number];

const HEALTH = {
	healthy: {
		label: "Catalog check passed",
		variant: "success" as const,
		icon: CheckCircle,
	},
	degraded: {
		label: "Degraded",
		variant: "secondary" as const,
		icon: WarningCircle,
	},
	unhealthy: {
		label: "Unhealthy",
		variant: "destructive" as const,
		icon: Pulse,
	},
	requires_auth: {
		label: "Requires auth",
		variant: "outline" as const,
		icon: WarningCircle,
	},
	blocked: {
		label: "Blocked",
		variant: "destructive" as const,
		icon: Pulse,
	},
	unsupported: {
		label: "Unsupported",
		variant: "outline" as const,
		icon: WarningCircle,
	},
	unknown: {
		label: "Not checked",
		variant: "outline" as const,
		icon: Pulse,
	},
};

function HealthBadge({ status }: { status: string | null }) {
	const config = HEALTH[status as keyof typeof HEALTH] ?? HEALTH.unknown;
	const Icon = config.icon;
	return (
		<Badge variant={config.variant} className="gap-1">
			<Icon aria-hidden className="size-3" />
			{config.label}
		</Badge>
	);
}

export function CatalogAppLogo({
	logoUrl,
	name,
	size = "small",
}: {
	logoUrl: string | null;
	name: string;
	size?: "small" | "large";
}) {
	const [failed, setFailed] = useState(false);
	const usable =
		logoUrl &&
		!logoUrl.startsWith("connectors://") &&
		(logoUrl.startsWith("http") || logoUrl.startsWith("data:"));
	const sizeClass =
		size === "large" ? "size-16 rounded-xl" : "size-10 rounded-lg";
	if (usable && !failed) {
		return (
			<img
				src={logoUrl}
				alt={`${name} logo`}
				className={`${sizeClass} object-contain`}
				onError={() => setFailed(true)}
				loading="lazy"
			/>
		);
	}
	const hue =
		[...name].reduce((sum, value) => sum + value.charCodeAt(0), 0) % 360;
	return (
		<span
			className={`${sizeClass} flex shrink-0 items-center justify-center font-semibold text-white`}
			style={{ backgroundColor: `hsl(${hue}, 55%, 50%)` }}
		>
			{name.charAt(0).toUpperCase()}
		</span>
	);
}

function AppCard({ app }: { app: CatalogApp }) {
	return (
		<Link
			to="/explore/apps/$slug"
			params={{ slug: app.slug ?? app.id }}
			className="block min-w-0"
		>
			<Card
				size="sm"
				className="group h-full min-w-0 shadow-none transition-[border-color] motion-reduce:transition-none hover:border-kumo-brand/40"
			>
				<CardHeader className="flex flex-row items-start gap-3 space-y-0">
					<CatalogAppLogo logoUrl={app.logoUrl ?? null} name={app.name} />
					<div className="min-w-0 flex-1">
						<div className="flex min-w-0 flex-wrap items-center gap-2">
							<CardTitle className="min-w-0 truncate">{app.name}</CardTitle>
							<HealthBadge status={app.healthStatus ?? null} />
						</div>
						{app.developer ? (
							<CardDescription className="truncate">
								by {app.developer}
							</CardDescription>
						) : null}
					</div>
				</CardHeader>
				<CardContent className="space-y-3">
					{app.description ? (
						<Text as="p" role="body" tone="secondary" className="line-clamp-2">
							{app.description}
						</Text>
					) : null}
					<div className="flex flex-wrap items-center gap-1.5">
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
						{app.connectorType === "SERVICE" ? (
							<Badge variant="outline" className="gap-1">
								<Globe className="size-3" />
								Service
							</Badge>
						) : null}
						{!app.installability.installable ? (
							<Badge variant="outline">
								{app.installability.state === "listing_only"
									? "Listing only"
									: "Setup needed"}
							</Badge>
						) : null}
						{(app.mcpToolCount ?? 0) > 0 ? (
							<Badge variant="secondary" className="gap-1">
								<Wrench className="size-3" />
								{app.mcpToolCount} tools
							</Badge>
						) : null}
					</div>
				</CardContent>
			</Card>
		</Link>
	);
}

const CONNECTOR_OPTIONS = [
	"MCP",
	"SERVICE",
	"FIRST_PARTY_ECOSYSTEM",
	"NATIVE",
] as const;
const HEALTH_OPTIONS = Object.keys(
	HEALTH,
) as CatalogRouteSearch["healthStatus"][];
const SORT_OPTIONS = [
	"name",
	"sourceCreatedAt",
	"updatedAt",
	"lastSyncedAt",
] as const;

export function AppStorePage(props: {
	search: CatalogRouteSearch;
	updateSearch: (patch: Partial<CatalogRouteSearch>) => void;
}) {
	if (isLocalSession())
		return (
			<Page width="xl">
				<PageHeader>
					<PageHeading>
						<PageTitle>Browse apps</PageTitle>
					</PageHeading>
				</PageHeader>
				<LocalCapabilityNotice capability="catalog" />
			</Page>
		);
	return <CloudAppStorePage {...props} />;
}

function CloudAppStorePage({
	search,
	updateSearch,
}: {
	search: CatalogRouteSearch;
	updateSearch: (patch: Partial<CatalogRouteSearch>) => void;
}) {
	const [moreFilters, setMoreFilters] = useState(
		Boolean(search.connectorType || search.healthStatus || search.sortBy),
	);
	const advancedFilterCount = [
		search.connectorType,
		search.healthStatus,
		search.sortBy,
	].filter(Boolean).length;
	const input: ListCatalogAppsInput = catalogListInput(search);
	const { data, isPending, isPlaceholderData } = useQuery({
		...catalogListQueryOptions(input),
		placeholderData: keepPreviousData,
		throwOnError: true,
	});
	const categoriesQuery = useQuery(catalogCategoriesQueryOptions());
	const categories = categoriesQuery.data ?? [];
	const apps = data?.apps ?? [];
	const resultsPending = isPending || isPlaceholderData;
	// Keystrokes must not wait for URL navigation or catalog requests.
	const [searchDraft, setSearchDraft] = useState(search.search ?? "");
	const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	const submittedSearch = useRef<string | null>(null);
	const composingSearch = useRef(false);
	useEffect(() => {
		const value = search.search ?? "";
		if (submittedSearch.current === value) {
			// Acknowledge our navigation without overwriting newer keystrokes.
			submittedSearch.current = null;
			return;
		}
		clearTimeout(searchTimer.current);
		setSearchDraft(value);
	}, [search.search]);
	useEffect(() => () => clearTimeout(searchTimer.current), []);
	const submitSearch = (value: string) => {
		clearTimeout(searchTimer.current);
		submittedSearch.current = value;
		updateSearch({ search: value || undefined, offset: 0 });
	};
	const changeSearch = (value: string) => {
		setSearchDraft(value);
		clearTimeout(searchTimer.current);
		if (!composingSearch.current) {
			searchTimer.current = setTimeout(() => submitSearch(value), 250);
		}
	};
	const hasFilters = Boolean(
		search.search ||
		search.category ||
		search.connectorType ||
		search.healthStatus ||
		search.sortBy,
	);
	const clearFilters = () => {
		clearTimeout(searchTimer.current);
		setSearchDraft("");
		submittedSearch.current = "";
		updateSearch({
			search: undefined,
			category: undefined,
			connectorType: undefined,
			healthStatus: undefined,
			sortBy: undefined,
			offset: 0,
		});
	};

	return (
		<Page width="xl">
			<PageHeader>
				<PageHeading>
					<PageTitle>Explore apps</PageTitle>
					<PageDescription>
						Find tools for your work. Review an app, install it for your
						organization, then connect an account if needed.
					</PageDescription>
				</PageHeading>
			</PageHeader>
			<CapabilityNavigation active="browse" />
			<PageSection>
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>Browse apps</SectionTitle>
						<SectionDescription>
							Choose an app to see what it does and what access it needs.
						</SectionDescription>
					</SectionHeading>
				</SectionHeader>
				<div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_auto]">
					<div className="xl:col-span-1">
						<SearchInput
							aria-label="Search the app catalog"
							value={searchDraft}
							placeholder="Search apps…"
							onChange={(event) => changeSearch(event.target.value)}
							onCompositionStart={() => {
								composingSearch.current = true;
								clearTimeout(searchTimer.current);
							}}
							onCompositionEnd={(event) => {
								composingSearch.current = false;
								changeSearch(event.currentTarget.value);
							}}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !composingSearch.current) {
									event.preventDefault();
									submitSearch(searchDraft);
								}
							}}
						/>
					</div>
					<Select
						value={search.category ?? "all"}
						onValueChange={(value) =>
							updateSearch({
								category: value === "all" ? undefined : (value ?? undefined),
								offset: 0,
							})
						}
					>
						<SelectTrigger aria-label="Filter catalog by category">
							<SelectValue>
								{search.category
									? catalogCategoryLabel(search.category)
									: "All categories"}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">All categories</SelectItem>
							{categories.map((item) =>
								item.name ? (
									<SelectItem key={item.name} value={item.name}>
										{catalogCategoryLabel(item.name)} ({item.count})
									</SelectItem>
								) : null,
							)}
						</SelectContent>
					</Select>
					<Button
						variant="outline"
						aria-expanded={moreFilters}
						aria-controls="catalog-advanced-filters"
						onClick={() => setMoreFilters(!moreFilters)}
					>
						More filters{advancedFilterCount ? ` (${advancedFilterCount})` : ""}
					</Button>
				</div>
				{categoriesQuery.isError ? (
					<Text as="p" role="label" tone="secondary">
						Category filters are unavailable. Search and browsing still work.
					</Text>
				) : null}
				{moreFilters && (
					<div
						id="catalog-advanced-filters"
						className="grid min-w-0 gap-3 sm:grid-cols-3"
					>
						<Select
							value={search.connectorType ?? "all"}
							onValueChange={(value) =>
								updateSearch({
									connectorType:
										value === "all"
											? undefined
											: (value as CatalogRouteSearch["connectorType"]),
									offset: 0,
								})
							}
						>
							<SelectTrigger aria-label="Filter catalog by connector type">
								<SelectValue>
									{search.connectorType
										? search.connectorType.replaceAll("_", " ")
										: "All types"}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">All types</SelectItem>
								{CONNECTOR_OPTIONS.map((value) => (
									<SelectItem key={value} value={value}>
										{value.replaceAll("_", " ")}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Select
							value={search.healthStatus ?? "all"}
							onValueChange={(value) =>
								updateSearch({
									healthStatus:
										value === "all"
											? undefined
											: (value as CatalogRouteSearch["healthStatus"]),
									offset: 0,
								})
							}
						>
							<SelectTrigger aria-label="Filter catalog by health">
								<SelectValue>
									{search.healthStatus
										? HEALTH[search.healthStatus].label
										: "Any catalog status"}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">All health</SelectItem>
								{HEALTH_OPTIONS.map((value) =>
									value ? (
										<SelectItem key={value} value={value}>
											{HEALTH[value].label}
										</SelectItem>
									) : null,
								)}
							</SelectContent>
						</Select>
						<Select
							value={search.sortBy ?? "default"}
							onValueChange={(value) =>
								updateSearch({
									sortBy:
										value === "default"
											? undefined
											: (value as CatalogRouteSearch["sortBy"]),
									offset: 0,
								})
							}
						>
							<SelectTrigger aria-label="Sort catalog apps">
								<SelectValue>
									{search.sortBy === "name"
										? "A–Z"
										: search.sortBy
											? search.sortBy.replace(/([A-Z])/g, " $1")
											: "Default order"}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="default">Default sort</SelectItem>
								{SORT_OPTIONS.map((value) => (
									<SelectItem key={value} value={value}>
										{value === "name"
											? "A–Z"
											: value.replace(/([A-Z])/g, " $1")}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				)}
				<Text as="p" role="label" tone="secondary" aria-live="polite">
					{resultsPending ? (
						"Searching apps…"
					) : (
						<>
							Showing {apps.length ? search.offset + 1 : 0}–
							{search.offset + apps.length} of{" "}
							{(data?.total ?? 0).toLocaleString()} apps
						</>
					)}
				</Text>
				{apps.length ? (
					<div className="grid min-w-0 gap-3 sm:grid-cols-2">
						{apps.map((app) => (
							<AppCard key={app.id} app={app} />
						))}
					</div>
				) : !resultsPending ? (
					<Card>
						<Empty>
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<Stack aria-hidden="true" />
								</EmptyMedia>
								<EmptyTitle>No apps found</EmptyTitle>
							</EmptyHeader>
							{hasFilters ? (
								<EmptyContent>
									<Button variant="outline" onClick={clearFilters}>
										Clear filters
									</Button>
								</EmptyContent>
							) : null}
						</Empty>
					</Card>
				) : null}
				{search.offset > 0 || data?.pagination.hasMore ? (
					<nav
						aria-label="Catalog pagination"
						className="flex justify-center gap-2"
					>
						<Button
							variant="outline"
							disabled={resultsPending || search.offset === 0}
							onClick={() =>
								updateSearch({
									offset: Math.max(0, search.offset - CATALOG_PAGE_SIZE),
								})
							}
						>
							Previous page
						</Button>
						<Button
							variant="outline"
							disabled={resultsPending || !data?.pagination.hasMore}
							onClick={() =>
								updateSearch({ offset: search.offset + CATALOG_PAGE_SIZE })
							}
						>
							Next page
						</Button>
					</nav>
				) : null}
			</PageSection>
			<Collapsible>
				<CollapsibleTrigger className="text-sm text-kumo-subtle">
					Catalog diagnostics
				</CollapsibleTrigger>
				<CollapsibleContent>
					<CatalogDiagnostics />
				</CollapsibleContent>
			</Collapsible>
		</Page>
	);
}

function CatalogDiagnostics() {
	const statsQuery = useQuery(catalogStatsQueryOptions());
	const healthQuery = useQuery(catalogHealthSummaryQueryOptions());
	if (statsQuery.isError || healthQuery.isError)
		return (
			<Text>
				Catalog diagnostics are unavailable. You can still browse apps.
			</Text>
		);
	if (!statsQuery.data || !healthQuery.data)
		return <Text>Loading catalog diagnostics…</Text>;
	const stats = statsQuery.data;
	const health = healthQuery.data;
	return (
		<PageSection>
			<SectionHeader>
				<SectionHeading>
					<SectionTitle>Catalog overview</SectionTitle>
					<SectionDescription>
						Current inventory and connector coverage.
					</SectionDescription>
				</SectionHeading>
				{health.scanBacklog ? (
					<Badge variant="outline">
						{health.scanBacklog.dueNow.toLocaleString()} scans due
					</Badge>
				) : null}
			</SectionHeader>
			<Surface
				as="dl"
				className="grid grid-cols-2 overflow-hidden sm:grid-cols-4"
			>
				{[
					["Total apps", stats.total],
					["MCP apps", stats.mcp],
					["Interactive", stats.withInteractive],
					["With writes", stats.withWrites],
				].map(([label, value]) => (
					<div
						key={label}
						className="min-w-0 border-kumo-hairline p-3 even:border-l nth-[n+3]:border-t sm:border-l sm:first:border-l-0 sm:nth-[n+3]:border-t-0"
					>
						<Text as="dt" role="label" tone="secondary">
							{label}
						</Text>
						<Text
							as="dd"
							role="title"
							weight="semibold"
							tone="strong"
							className="m-0 mt-1"
						>
							{Number(value).toLocaleString()}
						</Text>
					</div>
				))}
			</Surface>
		</PageSection>
	);
}
