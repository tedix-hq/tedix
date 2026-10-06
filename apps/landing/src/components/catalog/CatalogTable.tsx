import {
	keepPreviousData,
	QueryClient,
	QueryClientProvider,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import type { CatalogAppListItem } from "@tedix/api-contract/schemas/catalog";
import {
	formatCatalogCategory,
	normalizeCatalogCategory,
} from "@tedix/api-contract/utils/catalog-categories";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	CATEGORY_COLORS,
	CATEGORY_LABELS,
	CATEGORY_LABELS_SHORT,
} from "@/lib/catalog-constants";
import { cn } from "@/lib/utils";

interface CatalogTableProps {
	apps: CatalogAppListItem[];
	categories: { name: string; count: number }[];
	initialPagination: { limit: number; offset: number; hasMore: boolean };
	initialTotal: number;
	initialQuery: {
		search: string;
		category: string | null;
		connectorType: string | null;
		healthStatus: string | null;
		source: string | null;
		sortBy: string;
		sortDir: string;
		limit: number;
		page: number;
	};
}

export default function CatalogTable(props: CatalogTableProps) {
	const [queryClient] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: {
						staleTime: 1000 * 60 * 5,
						refetchOnWindowFocus: false,
					},
				},
			}),
	);

	return (
		<QueryClientProvider client={queryClient}>
			<CatalogTableInner {...props} />
		</QueryClientProvider>
	);
}

const FALLBACK_COLORS = [
	"bg-blue-500",
	"bg-violet-500",
	"bg-emerald-500",
	"bg-orange-500",
	"bg-pink-500",
	"bg-cyan-500",
	"bg-red-500",
	"bg-indigo-500",
	"bg-rose-500",
	"bg-amber-500",
	"bg-fuchsia-500",
	"bg-lime-500",
];

function getFallbackColor(name: string): string {
	let hash = 0;
	for (let i = 0; i < name.length; i++)
		hash = (hash * 31 + name.charCodeAt(i)) | 0;
	return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}

function isUsableLogo(url: string | null): boolean {
	if (!url) return false;
	const trimmed = url.trim();
	return /^https?:\/\//i.test(trimmed) && trimmed.includes("/app_catalog/");
}

function resolveLogoSrc(app: CatalogAppListItem): string | null {
	if (isUsableLogo(app.logoUrl)) {
		return app.logoUrl;
	}

	return null;
}

function LogoTile({
	app,
	sizeClassName = "h-11 w-11",
	textClassName = "text-sm",
}: {
	app: CatalogAppListItem;
	sizeClassName?: string;
	textClassName?: string;
}) {
	const logoSrc = resolveLogoSrc(app);
	const [failed, setFailed] = useState(false);
	const hasLogo = logoSrc !== null && !failed;

	return (
		<div
			className={cn(
				"flex items-center justify-center overflow-hidden rounded-lg transition-shadow",
				sizeClassName,
				hasLogo
					? "bg-white ring-1 ring-border/30 dark:bg-muted"
					: getFallbackColor(app.name),
			)}
		>
			{hasLogo ? (
				<img
					src={logoSrc}
					alt=""
					className="h-full w-full object-cover"
					loading="lazy"
					onError={() => setFailed(true)}
				/>
			) : (
				<span className={cn("font-bold text-white", textClassName)}>
					{app.name.charAt(0).toUpperCase()}
				</span>
			)}
		</div>
	);
}

function cleanPublicText(value: string | null | undefined): string {
	return (value ?? "")
		.replace(/\\r\\n/g, "\n")
		.replace(/\\n/g, "\n")
		.replace(/\\r/g, "\n")
		.replace(/\\t/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function formatDate(dateStr: string | null | undefined): string {
	if (!dateStr) return "";
	try {
		return new Date(dateStr).toLocaleDateString("en-US", {
			month: "short",
			day: "numeric",
			year: "numeric",
		});
	} catch {
		return "";
	}
}

const PLATFORM_CONFIG: Record<
	string,
	{ label: string; color: string; dot: string }
> = {
	chatgpt: {
		label: "ChatGPT",
		color: "bg-[#10a37f]/10 text-[#10a37f] border-[#10a37f]/30",
		dot: "bg-[#10a37f]",
	},
	claude: {
		label: "Claude Connector",
		color: "bg-[#d97706]/10 text-[#d97706] border-[#d97706]/30",
		dot: "bg-[#d97706]",
	},
	official: {
		label: "Official",
		color: "bg-blue-500/10 text-blue-500 border-blue-500/30",
		dot: "bg-blue-500",
	},
	gemini: {
		label: "Gemini",
		color: "bg-[#4285f4]/10 text-[#4285f4] border-[#4285f4]/30",
		dot: "bg-[#4285f4]",
	},
	copilot: {
		label: "Copilot",
		color: "bg-[#6264a7]/10 text-[#6264a7] border-[#6264a7]/30",
		dot: "bg-[#6264a7]",
	},
};

const HEALTH_CONFIG: Record<
	string,
	{ label: string; color: string; dot: string }
> = {
	healthy: {
		label: "Connected",
		color:
			"border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
		dot: "bg-emerald-500",
	},
	degraded: {
		label: "Partial",
		color:
			"border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
		dot: "bg-amber-500",
	},
	requires_auth: {
		label: "Auth required",
		color: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
		dot: "bg-blue-500",
	},
	unhealthy: {
		label: "Offline",
		color: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
		dot: "bg-red-500",
	},
	blocked: {
		label: "Blocked",
		color: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
		dot: "bg-red-500",
	},
	unsupported: {
		label: "Unsupported",
		color: "border-border/60 bg-muted/60 text-muted-foreground",
		dot: "bg-muted-foreground/50",
	},
	unknown: {
		label: "Not checked",
		color: "border-border/60 bg-muted/40 text-muted-foreground",
		dot: "bg-muted-foreground/50",
	},
};

const QUALITY_CONFIG: Record<string, { label: string; color: string }> = {
	publishable: {
		label: "Complete profile",
		color:
			"border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
	},
	thin: {
		label: "Thin profile",
		color:
			"border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
	},
	needs_review: {
		label: "Needs review",
		color: "border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-300",
	},
	quarantined: {
		label: "Quarantined",
		color: "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300",
	},
};

function PlatformBadge({ source }: { source: string | null }) {
	if (!source) return null;
	const cfg = PLATFORM_CONFIG[source];
	if (!cfg) return null;
	return (
		<Badge variant="outline" className={cn("gap-1 text-[10px]", cfg.color)}>
			<span className={cn("h-1.5 w-1.5 rounded-full", cfg.dot)} />
			{cfg.label}
		</Badge>
	);
}

function HealthBadge({ status }: { status: string | null }) {
	if (!status) return null;
	const cfg = HEALTH_CONFIG[status];
	if (!cfg) return null;
	return (
		<Badge variant="outline" className={cn("gap-1 text-[10px]", cfg.color)}>
			<span className={cn("h-1.5 w-1.5 rounded-full", cfg.dot)} />
			{cfg.label}
		</Badge>
	);
}

function QualityBadge({ app }: { app: CatalogAppListItem }) {
	const cfg = QUALITY_CONFIG[app.quality?.status ?? ""];
	if (!cfg) return null;
	return (
		<Badge variant="outline" className={cn("text-[10px]", cfg.color)}>
			{cfg.label}
		</Badge>
	);
}

function FreshnessBadge({ app }: { app: CatalogAppListItem }) {
	const status = app.quality?.freshnessStatus;
	if (!status || status === "unknown") return null;
	const color =
		status === "fresh"
			? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
			: status === "aging"
				? "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300"
				: "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300";
	return (
		<Badge variant="outline" className={cn("text-[10px]", color)}>
			{status === "fresh" ? "Fresh" : status === "aging" ? "Aging" : "Stale"}
		</Badge>
	);
}

function InstallabilityBadge({ app }: { app: CatalogAppListItem }) {
	const state = app.installability?.state;
	if (!state || state === "installable") return null;
	const label =
		state === "listing_only"
			? "Listing only"
			: state === "needs_base_app"
				? "Setup needed"
				: state === "needs_mcp_endpoint"
					? "Endpoint needed"
					: "Unavailable";
	return (
		<Badge variant="secondary" className="text-[10px]">
			{label}
		</Badge>
	);
}

function SortIcon({ active, dir }: { active: boolean; dir: string }) {
	if (!active)
		return (
			<svg
				className="ml-1 inline h-3.5 w-3.5 text-muted-foreground/40"
				viewBox="0 0 16 16"
				fill="currentColor"
			>
				<path d="M8 3l4 5H4l4-5zM8 13l-4-5h8l-4 5z" />
			</svg>
		);
	return (
		<svg
			className="ml-1 inline h-3.5 w-3.5 text-foreground"
			viewBox="0 0 16 16"
			fill="currentColor"
		>
			{dir === "asc" ? (
				<path d="M8 3l4 5H4l4-5z" />
			) : (
				<path d="M8 13l-4-5h8l-4 5z" />
			)}
		</svg>
	);
}

/* ── View toggle icons ── */
function GridIcon({ className }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 16 16" fill="currentColor">
			<rect x="1" y="1" width="6" height="6" rx="1" />
			<rect x="9" y="1" width="6" height="6" rx="1" />
			<rect x="1" y="9" width="6" height="6" rx="1" />
			<rect x="9" y="9" width="6" height="6" rx="1" />
		</svg>
	);
}

function ListIcon({ className }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 16 16" fill="currentColor">
			<rect x="1" y="2" width="14" height="2.5" rx="0.5" />
			<rect x="1" y="6.75" width="14" height="2.5" rx="0.5" />
			<rect x="1" y="11.5" width="14" height="2.5" rx="0.5" />
		</svg>
	);
}

/* ── App Card ── */
function AppCard({ app }: { app: CatalogAppListItem }) {
	return (
		<Card className="min-h-[216px] p-0 transition-colors duration-200 hover:border-kumo-brand motion-reduce:transition-none">
			<CardContent className="flex h-full flex-col p-0">
				<a
					href={`/apps/${app.slug || app.id}/`}
					className="group flex h-full flex-col p-4"
				>
					{/* Top row: logo + meta */}
					<div className="mb-3 flex items-start gap-3">
						<div className="flex-shrink-0">
							<LogoTile
								app={app}
								sizeClassName="h-11 w-11 group-hover:ring-border/60"
							/>
						</div>
						<div className="min-w-0 flex-1">
							<h3 className="truncate font-semibold text-foreground text-sm transition-colors group-hover:text-primary">
								{app.name}
							</h3>
							{app.developer && (
								<p className="mt-0.5 truncate text-muted-foreground text-xs">
									{app.developer}
								</p>
							)}
							<div className="mt-2 flex flex-wrap gap-1.5">
								<HealthBadge status={app.healthStatus ?? null} />
								<QualityBadge app={app} />
							</div>
						</div>
					</div>

					{/* Description */}
					{app.description && (
						<p className="mb-3 line-clamp-2 flex-1 text-muted-foreground text-xs leading-relaxed">
							{cleanPublicText(app.description)}
						</p>
					)}
					{!app.description && <div className="flex-1" />}

					{/* Bottom row: badges */}
					<div className="mt-auto flex flex-wrap items-center gap-1.5 border-border/20 border-t pt-2">
						{app.category && (
							<Badge
								variant="outline"
								className={cn(
									"text-[10px]",
									CATEGORY_COLORS[app.category] ||
										"border-border bg-muted text-muted-foreground",
								)}
							>
								{CATEGORY_LABELS_SHORT[app.category] || app.category}
							</Badge>
						)}
						<PlatformBadge source={app.source ?? null} />
						<FreshnessBadge app={app} />
						<InstallabilityBadge app={app} />
						{(app.mcpToolCount ?? 0) > 0 && (
							<Badge variant="secondary" className="gap-0.5 text-[10px]">
								<svg
									className="h-2.5 w-2.5"
									viewBox="0 0 16 16"
									fill="currentColor"
								>
									<path d="M3 1h10a2 2 0 012 2v1H1V3a2 2 0 012-2zM1 5h14v8a2 2 0 01-2 2H3a2 2 0 01-2-2V5zm4 3a1 1 0 100 2h6a1 1 0 100-2H5z" />
								</svg>
								{app.mcpToolCount} MCP
							</Badge>
						)}
					</div>
				</a>
			</CardContent>
		</Card>
	);
}

function CatalogTableInner({
	apps: initialApps,
	categories,
	initialPagination,
	initialTotal,
	initialQuery,
}: CatalogTableProps) {
	const [searchQuery, setSearchQuery] = useState(initialQuery.search);
	const [selectedCategory, setSelectedCategory] = useState<string | null>(
		normalizeCatalogCategory(initialQuery.category),
	);
	const [selectedHealth, setSelectedHealth] = useState<string | null>(
		initialQuery.healthStatus,
	);
	const [selectedSource, setSelectedSource] = useState<string | null>(
		initialQuery.source,
	);
	const [sortBy, setSortBy] = useState(
		initialQuery.sortBy || "sourceCreatedAt",
	);
	const [sortDir, setSortDir] = useState(initialQuery.sortDir || "desc");
	const [page, setPage] = useState(initialQuery.page || 1);
	const [limit] = useState(initialQuery.limit || 24);
	const [viewMode, setViewMode] = useState<"grid" | "table">("grid");
	const wasSearchingRef = useRef(Boolean(initialQuery.search.trim()));

	const queryClient = useQueryClient();

	const connectorType = null;
	const effectiveSortBy = sortBy;
	const effectiveSortDir = sortDir;

	const updateURL = useCallback(
		(filters: Record<string, string | number | null | undefined>) => {
			if (typeof window === "undefined") return;
			const params = new URLSearchParams();
			if (filters.q) params.set("q", String(filters.q));
			if (filters.category) params.set("category", String(filters.category));
			if (filters.type) params.set("type", String(filters.type));
			if (filters.health) params.set("health", String(filters.health));
			if (filters.source) params.set("source", String(filters.source));
			if (filters.sortBy && filters.sortBy !== "sourceCreatedAt")
				params.set("sortBy", String(filters.sortBy));
			if (filters.sortDir && filters.sortDir !== "desc")
				params.set("sortDir", String(filters.sortDir));
			if (filters.page && Number(filters.page) > 1)
				params.set("page", String(filters.page));
			const newUrl = params.toString()
				? `${window.location.pathname}?${params.toString()}`
				: window.location.pathname;
			window.history.replaceState({}, "", newUrl);
		},
		[],
	);

	useEffect(() => {
		updateURL({
			q: searchQuery,
			category: selectedCategory,
			type: connectorType,
			health: selectedHealth,
			source: selectedSource,
			sortBy:
				effectiveSortBy === "relevance" && searchQuery.trim()
					? undefined
					: effectiveSortBy,
			sortDir: effectiveSortDir,
			page,
			limit,
		});
	}, [
		searchQuery,
		selectedCategory,
		connectorType,
		selectedHealth,
		selectedSource,
		effectiveSortBy,
		effectiveSortDir,
		page,
		limit,
		updateURL,
	]);

	useEffect(() => {
		setPage(1);
	}, [
		searchQuery,
		selectedCategory,
		selectedHealth,
		selectedSource,
		sortBy,
		sortDir,
	]);

	useEffect(() => {
		const isSearching = Boolean(searchQuery.trim());
		if (
			isSearching &&
			!wasSearchingRef.current &&
			sortBy === "sourceCreatedAt"
		) {
			setSortBy("relevance");
			setSortDir("desc");
		}
		if (!isSearching && wasSearchingRef.current && sortBy === "relevance") {
			setSortBy("sourceCreatedAt");
			setSortDir("desc");
		}
		wasSearchingRef.current = isSearching;
	}, [searchQuery, sortBy]);

	const currentQuery = useMemo(
		() => ({
			search: searchQuery,
			category: selectedCategory,
			connectorType,
			healthStatus: selectedHealth,
			source: selectedSource,
			sortBy: effectiveSortBy,
			sortDir: effectiveSortDir,
			limit,
			page,
		}),
		[
			searchQuery,
			selectedCategory,
			connectorType,
			selectedHealth,
			selectedSource,
			effectiveSortBy,
			effectiveSortDir,
			limit,
			page,
		],
	);

	const isInitialQuery =
		initialQuery.search === currentQuery.search &&
		initialQuery.category === currentQuery.category &&
		initialQuery.healthStatus === currentQuery.healthStatus &&
		initialQuery.source === currentQuery.source &&
		initialQuery.sortBy === currentQuery.sortBy &&
		initialQuery.sortDir === currentQuery.sortDir &&
		initialQuery.limit === currentQuery.limit &&
		initialQuery.page === currentQuery.page;

	const fetchApps = async () => {
		const params = new URLSearchParams();
		if (searchQuery) params.set("search", searchQuery);
		if (selectedCategory) params.set("category", selectedCategory);
		if (connectorType) params.set("connectorType", connectorType);
		if (selectedHealth && selectedHealth !== "all")
			params.set("healthStatus", selectedHealth);
		if (selectedSource) params.set("source", selectedSource);
		if (effectiveSortBy) params.set("sortBy", effectiveSortBy);
		if (effectiveSortDir) params.set("sortDir", effectiveSortDir);
		params.set("limit", String(limit));
		params.set("offset", String((page - 1) * limit));
		const res = await fetch(`/api/catalog/apps/?${params.toString()}`);
		if (!res.ok) {
			throw new Error("Failed to fetch apps");
		}
		const data = (await res.json()) as {
			apps?: CatalogAppListItem[];
			total?: number;
			pagination?: { limit: number; offset: number; hasMore: boolean };
		};
		const filtered = (data.apps || []).filter(
			(a) => a.connectorType !== "FIRST_PARTY_ECOSYSTEM",
		);
		return {
			apps: filtered,
			total: data.total || 0,
			pagination: data.pagination || initialPagination,
		};
	};

	const { data, isFetching } = useQuery({
		queryKey: ["catalog-apps", currentQuery],
		queryFn: fetchApps,
		initialData: isInitialQuery
			? {
					apps: initialApps,
					total: initialTotal,
					pagination: initialPagination,
				}
			: undefined,
		placeholderData: keepPreviousData,
		staleTime: 1000 * 60 * 5,
	});

	const apps = data?.apps ?? [];
	const total = data?.total ?? initialTotal;
	const pagination = data?.pagination ?? initialPagination;
	const isLoading = isFetching;

	useEffect(() => {
		const totalPages = Math.max(1, Math.ceil(total / limit));
		const nextPage = page + 1;
		const prevPage = page - 1;

		const prefetch = (targetPage: number) => {
			if (targetPage < 1 || targetPage > totalPages) return;
			const params = new URLSearchParams();
			if (searchQuery) params.set("search", searchQuery);
			if (selectedCategory) params.set("category", selectedCategory);
			if (connectorType) params.set("connectorType", connectorType);
			if (selectedHealth && selectedHealth !== "all")
				params.set("healthStatus", selectedHealth);
			if (selectedSource) params.set("source", selectedSource);
			if (effectiveSortBy) params.set("sortBy", effectiveSortBy);
			if (effectiveSortDir) params.set("sortDir", effectiveSortDir);
			params.set("limit", String(limit));
			params.set("offset", String((targetPage - 1) * limit));

			queryClient.prefetchQuery({
				queryKey: ["catalog-apps", { ...currentQuery, page: targetPage }],
				queryFn: async () => {
					const res = await fetch(`/api/catalog/apps/?${params.toString()}`);
					if (!res.ok)
						return { apps: [], total: 0, pagination: initialPagination };
					const payload = (await res.json()) as {
						apps?: CatalogAppListItem[];
						total?: number;
						pagination?: { limit: number; offset: number; hasMore: boolean };
					};
					const filtered = (payload.apps || []).filter(
						(a) => a.connectorType !== "FIRST_PARTY_ECOSYSTEM",
					);
					return {
						apps: filtered,
						total: payload.total || 0,
						pagination: payload.pagination || initialPagination,
					};
				},
				staleTime: 1000 * 60 * 5,
			});
		};

		prefetch(nextPage);
		prefetch(prevPage);
	}, [
		page,
		total,
		limit,
		searchQuery,
		selectedCategory,
		selectedHealth,
		selectedSource,
		connectorType,
		effectiveSortBy,
		effectiveSortDir,
		currentQuery,
		initialPagination,
		queryClient,
	]);

	const clearFilters = () => {
		setSearchQuery("");
		setSelectedCategory(null);
		setSelectedHealth("healthy");
		setSelectedSource(null);
		setSortBy("sourceCreatedAt");
		setSortDir("desc");
		setPage(1);
	};

	const handleSort = (col: "name" | "sourceCreatedAt") => {
		if (sortBy === col) {
			setSortDir(sortDir === "asc" ? "desc" : "asc");
		} else {
			setSortBy(col);
			setSortDir(col === "name" ? "asc" : "desc");
		}
	};

	const hasActiveFilters =
		searchQuery ||
		selectedCategory ||
		(selectedHealth && selectedHealth !== "healthy") ||
		selectedSource ||
		sortBy !== "sourceCreatedAt" ||
		sortDir !== "desc";
	const totalPages = Math.max(1, Math.ceil(total / limit));

	return (
		<div className="space-y-5">
			{/* Search + View Toggle */}
			<div className="flex items-center gap-3">
				<div className="relative mx-auto max-w-xl flex-1">
					<label htmlFor="apps-catalog-search" className="sr-only">
						Search AI apps
					</label>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						className="absolute top-1/2 left-4 h-5 w-5 -translate-y-1/2 text-muted-foreground"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
						strokeWidth={2}
					>
						<circle cx="11" cy="11" r="8" />
						<path d="m21 21-4.3-4.3" />
					</svg>
					<Input
						id="apps-catalog-search"
						aria-label="Search AI apps"
						type="search"
						placeholder="Search AI apps, MCP servers, or integrations"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="h-12 rounded-lg border-border/60 pl-11 text-base"
					/>
				</div>
			</div>

			{/* Filter row */}
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex flex-wrap items-center gap-2">
					<label htmlFor="apps-category-filter" className="sr-only">
						Filter by category
					</label>
					<Select
						id="apps-category-filter"
						aria-label="Filter by category"
						value={selectedCategory || "all"}
						onValueChange={(value) =>
							setSelectedCategory(value === "all" ? null : value)
						}
					>
						<Select.Option value="all">All categories</Select.Option>
						{categories.map((cat) =>
							cat?.name ? (
								<Select.Option key={cat.name} value={cat.name}>
									{CATEGORY_LABELS[cat.name] || formatCatalogCategory(cat.name)}{" "}
									({cat.count})
								</Select.Option>
							) : null,
						)}
					</Select>

					<label htmlFor="apps-source-filter" className="sr-only">
						Filter by platform
					</label>
					<Select
						id="apps-source-filter"
						aria-label="Filter by platform"
						value={selectedSource || "all"}
						onValueChange={(value) =>
							setSelectedSource(value === "all" ? null : value)
						}
					>
						<Select.Option value="all">All platforms</Select.Option>
						<Select.Option value="chatgpt">ChatGPT apps</Select.Option>
						<Select.Option value="claude">Claude connectors</Select.Option>
						<Select.Option value="official">Official</Select.Option>
						<Select.Option value="gemini">Gemini</Select.Option>
						<Select.Option value="copilot">Copilot</Select.Option>
					</Select>

					<label htmlFor="apps-health-filter" className="sr-only">
						Filter by connector health
					</label>
					<Select
						id="apps-health-filter"
						aria-label="Filter by connector health"
						value={selectedHealth || "all"}
						onValueChange={(value) => setSelectedHealth(value)}
					>
						<Select.Option value="all">All health states</Select.Option>
						<Select.Option value="healthy">Connected</Select.Option>
						<Select.Option value="degraded">Partial inventory</Select.Option>
						<Select.Option value="requires_auth">Auth required</Select.Option>
						<Select.Option value="unhealthy">Offline</Select.Option>
						<Select.Option value="unknown">Not checked</Select.Option>
					</Select>

					<label htmlFor="apps-sort-filter" className="sr-only">
						Sort apps
					</label>
					<Select
						id="apps-sort-filter"
						aria-label="Sort apps"
						value={`${effectiveSortBy}:${effectiveSortDir}`}
						onValueChange={(value) => {
							if (!value) return;
							const [s, d] = value.split(":");
							setSortBy(s);
							setSortDir(d);
							setPage(1);
						}}
					>
						{searchQuery.trim() && (
							<Select.Option value="relevance:desc">Best match</Select.Option>
						)}
						<Select.Option value="sourceCreatedAt:desc">
							Newest first
						</Select.Option>
						<Select.Option value="sourceCreatedAt:asc">
							Oldest first
						</Select.Option>
						<Select.Option value="name:asc">Name A-Z</Select.Option>
						<Select.Option value="name:desc">Name Z-A</Select.Option>
					</Select>
				</div>

				{/* View toggle */}
				<div className="flex items-center gap-1">
					<Button
						variant={viewMode === "grid" ? "secondary" : "ghost"}
						size="sm"
						onClick={() => setViewMode("grid")}
						className="px-2"
						aria-label="Grid view"
					>
						<GridIcon className="h-4 w-4" />
					</Button>
					<Button
						variant={viewMode === "table" ? "secondary" : "ghost"}
						size="sm"
						onClick={() => setViewMode("table")}
						className="px-2"
						aria-label="Table view"
					>
						<ListIcon className="h-4 w-4" />
					</Button>
				</div>
			</div>

			{/* Active filters summary */}
			{hasActiveFilters && (
				<div className="flex items-center justify-between text-muted-foreground text-sm">
					<span className="tabular-nums">
						Showing {apps.length} of {total} {total === 1 ? "app" : "apps"}
					</span>
					<Button
						variant="ghost"
						size="sm"
						onClick={clearFilters}
						className="text-primary"
					>
						Clear filters
					</Button>
				</div>
			)}

			{isLoading && (
				<div
					className="py-2 text-center text-muted-foreground text-sm"
					role="status"
					aria-live="polite"
				>
					Loading...
				</div>
			)}

			{/* Content */}
			{apps.length > 0 ? (
				viewMode === "grid" ? (
					/* ── Card Grid ── */
					<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
						{apps.map((app: CatalogAppListItem) => (
							<AppCard key={app.id} app={app} />
						))}
					</div>
				) : (
					/* ── Table View ── */
					<>
						{/* Desktop table */}
						<div className="hidden overflow-hidden rounded-xl border border-kumo-line md:block">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead className="w-[280px]">
											<Button
												variant="ghost"
												size="xs"
												onClick={() => handleSort("name")}
												className="h-auto min-h-0 p-0 font-medium"
											>
												App{" "}
												<SortIcon active={sortBy === "name"} dir={sortDir} />
											</Button>
										</TableHead>
										<TableHead>Category</TableHead>
										<TableHead className="w-[140px]">Trust</TableHead>
										<TableHead className="w-[80px]">Tools</TableHead>
										<TableHead className="hidden lg:table-cell">
											Description
										</TableHead>
										<TableHead className="w-[120px] text-right">
											<Button
												variant="ghost"
												size="xs"
												onClick={() => handleSort("sourceCreatedAt")}
												className="h-auto min-h-0 p-0 font-medium"
											>
												Added{" "}
												<SortIcon
													active={sortBy === "sourceCreatedAt"}
													dir={sortDir}
												/>
											</Button>
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{apps.map((app: CatalogAppListItem) => {
										return (
											<TableRow
												key={app.id}
												className="cursor-pointer border-border/20 border-b transition-colors hover:bg-muted/20"
												onClick={() => {
													window.location.href = `/apps/${app.slug || app.id}/`;
												}}
											>
												<TableCell>
													<div className="flex items-center gap-3">
														<div className="flex-shrink-0">
															<LogoTile
																app={app}
																sizeClassName="h-8 w-8 ring-1 ring-border/20"
																textClassName="text-xs"
															/>
														</div>
														<div className="min-w-0">
															<div className="truncate font-semibold text-foreground">
																{app.name}
															</div>
															{app.developer && (
																<div className="truncate text-muted-foreground text-xs">
																	{app.developer}
																</div>
															)}
															<PlatformBadge source={app.source ?? null} />
														</div>
													</div>
												</TableCell>
												<TableCell>
													{app.category ? (
														<Badge
															variant="outline"
															className={cn(
																"text-[11px]",
																CATEGORY_COLORS[app.category] ||
																	"border-border bg-muted text-muted-foreground",
															)}
														>
															{CATEGORY_LABELS_SHORT[app.category] ||
																app.category}
														</Badge>
													) : (
														<span className="text-muted-foreground/50 text-xs">
															Uncategorized
														</span>
													)}
												</TableCell>
												<TableCell>
													<div className="flex flex-wrap gap-1.5">
														<HealthBadge status={app.healthStatus ?? null} />
														<FreshnessBadge app={app} />
														<InstallabilityBadge app={app} />
													</div>
												</TableCell>
												<TableCell className="text-muted-foreground text-xs">
													{(app.mcpToolCount ?? 0) > 0 ? (
														<span>{app.mcpToolCount} MCP tools</span>
													) : (
														<span className="text-muted-foreground/40">
															&mdash;
														</span>
													)}
												</TableCell>
												<TableCell className="hidden lg:table-cell">
													<span className="line-clamp-1 text-muted-foreground">
														{cleanPublicText(app.description)}
													</span>
												</TableCell>
												<TableCell className="text-right text-muted-foreground text-xs">
													{formatDate(app.sourceCreatedAt || app.createdAt)}
												</TableCell>
											</TableRow>
										);
									})}
								</TableBody>
							</Table>
						</div>

						{/* Mobile card list (always cards on mobile, even in table mode) */}
						<div className="space-y-2 md:hidden">
							{apps.map((app: CatalogAppListItem) => (
								<AppCard key={app.id} app={app} />
							))}
						</div>
					</>
				)
			) : (
				<Empty
					className="py-16"
					title="No apps found"
					description="Try adjusting your search or filters."
					icon={
						<div className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-muted">
							<svg
								xmlns="http://www.w3.org/2000/svg"
								className="h-7 w-7 text-muted-foreground"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
								strokeWidth={2}
							>
								<circle cx="11" cy="11" r="8" />
								<path d="m21 21-4.3-4.3" />
							</svg>
						</div>
					}
					contents={
						<Button
							variant="outline"
							onClick={clearFilters}
							className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline"
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								className="h-4 w-4"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
								strokeWidth={2}
							>
								<path d="M3 6h18M3 12h18M3 18h18" />
							</svg>
							Clear all filters
						</Button>
					}
				/>
			)}

			{/* Pagination */}
			{totalPages > 1 && (
				<div className="flex items-center justify-center gap-3 pt-4 text-sm">
					<Button
						variant="outline"
						onClick={() => setPage(Math.max(1, page - 1))}
						disabled={page <= 1 || isLoading}
					>
						Previous
					</Button>
					<span className="text-muted-foreground">
						{page} / {totalPages}
					</span>
					<Button
						variant="outline"
						onClick={() => setPage(page + 1)}
						disabled={!pagination.hasMore || isLoading}
					>
						Next
					</Button>
				</div>
			)}
		</div>
	);
}
