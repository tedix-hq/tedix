import type { Project } from "@tedix/api-contract/contracts/projects";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Card, CardContent, CardHeader } from "@/components/kumo/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { Link } from "@/components/kumo/link";
import {
	Collection,
	Page,
	PageDescription,
	PageHeader,
	PageHeading,
	PageSection,
	PageTitle,
	SectionActions,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Skeleton } from "@/components/kumo/skeleton";
import { Text } from "@/components/kumo/text";
import { officeAsk } from "@/components/work-office-page";
import { sentenceCase } from "@/lib/format";
import { errorMessage } from "@/lib/orpc-error";
import {
	projectHealthJudgmentsQueryOptions,
	projectListQueryOptions,
	projectRollupQueryOptions,
	tediRosterQueryOptions,
	workApprovalsQueryOptions,
	workOfficeKnocksQueryOptions,
	workProjectContributorsQueryOptions,
} from "@/lib/os-query-options";
import { absoluteTime, normalizeD1Timestamp, relativeTime } from "@/lib/time";
import { useDocumentTitle } from "@/lib/use-document-title";
import { resolveOsTenant } from "@/shared/os-tenant";
import { buildSurfaceUrl } from "@tedix/tenant-directory";

/** One read holds the whole portfolio; the owner keeps a few dozen projects. */
export const PORTFOLIO_PROJECT_LIMIT = 100;

/** Portfolio buckets, in display order. `metadata.portfolioBucket` picks one. */
export const PORTFOLIO_BUCKETS = [
	"Projects",
	"Active",
	"Leads",
	"Side",
	"Rezagados",
	"Programs",
	"Applications",
	"Communities",
] as const;

export const NEEDS_YOU_LIMIT = 5;

type PortfolioBucket = (typeof PORTFOLIO_BUCKETS)[number];

export type PortfolioEntry = {
	project: Project;
	title: string;
	org: string | null;
};

function metadataString(project: Project, key: string): string | null {
	const value = project.metadata?.[key];
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function portfolioBucketOf(project: Project): PortfolioBucket | null {
	const raw = metadataString(project, "portfolioBucket")?.toLowerCase();
	if (!raw) return null;
	return (
		PORTFOLIO_BUCKETS.find((bucket) => bucket.toLowerCase() === raw) ?? null
	);
}

function portfolioEntry(project: Project): PortfolioEntry {
	return {
		project,
		title: metadataString(project, "portfolioTitle") ?? project.name,
		org: metadataString(project, "portfolioOrg"),
	};
}

const byTitle = (a: PortfolioEntry, b: PortfolioEntry) =>
	a.title.localeCompare(b.title);

/**
 * Bucket projects in the fixed order. Archived and done projects, and projects
 * with no recognised bucket, fall into `other`.
 */
export function groupPortfolio(projects: readonly Project[]): {
	buckets: Array<{ name: PortfolioBucket; entries: PortfolioEntry[] }>;
	other: PortfolioEntry[];
} {
	const grouped = new Map<PortfolioBucket, PortfolioEntry[]>(
		PORTFOLIO_BUCKETS.map((bucket) => [bucket, []]),
	);
	const other: PortfolioEntry[] = [];
	for (const project of projects) {
		const bucket = portfolioBucketOf(project);
		const closed = project.status === "archived" || project.status === "done";
		if (!bucket || closed) other.push(portfolioEntry(project));
		else grouped.get(bucket)?.push(portfolioEntry(project));
	}
	return {
		buckets: PORTFOLIO_BUCKETS.map((name) => ({
			name,
			entries: (grouped.get(name) ?? []).sort(byTitle),
		})),
		other: other.sort(byTitle),
	};
}

/** The first line of a description that carries words, without list/heading marks. */
export function projectBriefLine(description: string | null): string | null {
	for (const line of description?.split(/\r?\n/) ?? []) {
		const text = line.replace(/^\s*(?:#+|[-*>]|\d+[.)])\s*/, "").trim();
		if (text) return text;
	}
	return null;
}

/** Placeholder briefs (containing "No records yet; owner to define") read as empty. */
export function isPlaceholderBrief(brief: string): boolean {
	return /\bno records yet\b/i.test(brief);
}

/** Newest of the given timestamps (D1 or ISO), or null. */
export function latestActivity(
	timestamps: ReadonlyArray<string | null | undefined>,
): string | null {
	let latest: { at: string; ms: number } | null = null;
	for (const at of timestamps) {
		if (!at) continue;
		const iso = normalizeD1Timestamp(at);
		const ms = Date.parse(iso);
		if (!Number.isNaN(ms) && (!latest || ms > latest.ms))
			latest = { at: iso, ms };
	}
	return latest?.at ?? null;
}

export function projectStatusVariant(status: Project["status"]) {
	if (status === "active") return "success" as const;
	if (status === "paused") return "warning" as const;
	if (status === "done") return "secondary" as const;
	return "outline" as const;
}

const HEALTH_VARIANT = {
	on_track: "success",
	at_risk: "warning",
	off_track: "destructive",
	paused: "secondary",
} as const;

/**
 * The same Portfolio on another organization's OS (`https://<slug>.os.tedix.dev`),
 * on the platform domain this OS runs under. Null when the slug is not a valid
 * tenant hostname label.
 */
export function crossOrgPortfolioUrl(slug: string): string | null {
	const hostname =
		typeof window === "undefined" ? "" : window.location.hostname;
	const platformDomain =
		hostname === "os.tedix.tech" || hostname.endsWith(".os.tedix.tech")
			? "tedix.tech"
			: undefined;
	const origin = buildSurfaceUrl(
		"os",
		slug,
		platformDomain ? { platformDomain } : {},
	);
	if (!origin) return null;
	try {
		const url = new URL("/work/portfolio", origin);
		return resolveOsTenant(url.hostname).kind === "tenant"
			? url.toString()
			: null;
	} catch {
		return null;
	}
}

type InboxRow = {
	request: {
		id: string;
		subject: string;
		metadata?: unknown;
		workItemId?: string | null;
		projectId?: string | null;
		requestedAt: string;
	};
	effectiveState: string;
	workItem: { id: string; title: string; projectId: string | null } | null;
};

type ApprovalRow = {
	proposal: { id: string; requestedAt: string; requestRationale: string };
	effectiveStatus: string;
	canDecide: boolean;
	workItem: { id: string; title: string };
};

export type NeedsYouRow = {
	key: string;
	href: string;
	label: string;
	kind: "Question" | "Approval";
	at: string;
};

/** Open questions in the owner's inbox plus approvals they can decide, newest first. */
export function needsYouRows(
	interactions: readonly InboxRow[],
	approvals: readonly ApprovalRow[],
): NeedsYouRow[] {
	return [
		...interactions
			.filter((row) => row.effectiveState === "open")
			.map((row) => ({
				key: `interaction:${row.request.id}`,
				href: `/work/interactions/${row.request.id}`,
				label: officeAsk(row.request),
				kind: "Question" as const,
				at: row.request.requestedAt,
			})),
		...approvals
			.filter((row) => row.effectiveStatus === "pending" && row.canDecide)
			.map((row) => ({
				key: `approval:${row.proposal.id}`,
				href: `/work/items/${row.workItem.id}`,
				label: row.workItem.title,
				kind: "Approval" as const,
				at: row.proposal.requestedAt,
			})),
	].sort((a, b) => b.at.localeCompare(a.at));
}

function Time({ at }: { at: string }) {
	return (
		<time dateTime={at} title={absoluteTime(at)}>
			{relativeTime(at)}
		</time>
	);
}

function Muted({ children }: { children: string }) {
	return (
		<Text as="p" role="label" tone="secondary">
			{children}
		</Text>
	);
}

function NeedsYouStrip({ rows }: { rows: NeedsYouRow[] }) {
	if (!rows.length) return null;
	return (
		<PageSection aria-labelledby="portfolio-needs-you-title">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="portfolio-needs-you-title">Needs you</SectionTitle>
				</SectionHeading>
				{rows.length > NEEDS_YOU_LIMIT ? (
					<SectionActions>
						<Link variant="section" href="/work/office">
							See all ({rows.length})
						</Link>
					</SectionActions>
				) : null}
			</SectionHeader>
			<Collection aria-label="Needs you">
				{rows.slice(0, NEEDS_YOU_LIMIT).map((row) => (
					<li
						key={row.key}
						className="flex min-w-0 items-start gap-2 px-4 py-3"
					>
						<Link
							variant="record"
							href={row.href}
							className="line-clamp-2 min-w-0 flex-1"
						>
							{row.label}
						</Link>
						<Text as="span" role="label" tone="secondary" className="shrink-0">
							{row.kind} · <Time at={row.at} />
						</Text>
					</li>
				))}
			</Collection>
		</PageSection>
	);
}

function CrossOrgLink({ slug }: { slug: string }) {
	const href = crossOrgPortfolioUrl(slug);
	return href ? (
		<Link href={href} className="type-tedix-label">
			in {slug}
		</Link>
	) : (
		<Text as="span" role="label" tone="secondary">
			in {slug}
		</Text>
	);
}

function PortfolioCard({
	entry,
	tediNames,
	openInteractions,
}: {
	entry: PortfolioEntry;
	tediNames: ReadonlyMap<string, string>;
	openInteractions: readonly InboxRow[];
}) {
	const { project, title, org } = entry;
	const rollup = useQuery(projectRollupQueryOptions(project.id));
	const health = useQuery({
		...projectHealthJudgmentsQueryOptions(project.id),
		retry: false,
	});
	const contributors = useQuery({
		...workProjectContributorsQueryOptions(project.id),
		refetchInterval: false,
		retry: false,
	});
	const brief = projectBriefLine(project.description);
	const latestHealth = health.data?.[0]?.health;
	const lead = project.leadTediId
		? tediNames.get(project.leadTediId)
		: undefined;
	const lastActivity = latestActivity([
		project.updatedAt,
		project.createdAt,
		...(contributors.data?.contributors ?? []).map((row) => row.lastActivityAt),
	]);
	const data = rollup.data;
	const topLevelIds = new Set(data?.topLevelItems.map((item) => item.id));
	const needsYou = openInteractions.filter((row) => {
		const workItemId = row.workItem?.id ?? row.request.workItemId;
		return (
			row.request.projectId === project.id ||
			row.workItem?.projectId === project.id ||
			(workItemId ? topLevelIds.has(workItemId) : false)
		);
	}).length;
	const next =
		data?.topLevelItems.find((item) => item.disposition === "accepted") ??
		data?.topLevelItems.find((item) => item.disposition === "proposed");
	return (
		<Card size="sm" data-portfolio-card={project.id}>
			<CardHeader className="grid gap-1">
				<div className="flex min-w-0 items-start justify-between gap-2">
					<Link
						variant="record"
						href={`/work/projects/${project.id}`}
						className="line-clamp-2 min-w-0 font-medium"
					>
						{title}
					</Link>
					<div className="flex shrink-0 flex-wrap justify-end gap-1">
						{latestHealth ? (
							<Badge variant={HEALTH_VARIANT[latestHealth]}>
								{sentenceCase(latestHealth)}
							</Badge>
						) : null}
						<Badge variant={projectStatusVariant(project.status)}>
							{sentenceCase(project.status)}
						</Badge>
					</div>
				</div>
				{brief ? (
					<Text
						as="p"
						role="label"
						tone={isPlaceholderBrief(brief) ? "secondary" : "default"}
						className="line-clamp-2"
					>
						{brief}
					</Text>
				) : null}
			</CardHeader>
			<CardContent className="grid gap-1.5">
				{rollup.isPending ? (
					<Skeleton className="h-4 w-40" />
				) : !data ? (
					<Muted>Counts unavailable</Muted>
				) : data.total === 0 ? (
					<Muted>No records yet</Muted>
				) : (
					<Text as="p" role="label" className="tabular-nums">
						{data.byDisposition.proposed ?? 0} open ·{" "}
						{data.byDisposition.accepted ?? 0} accepted
						{needsYou ? ` · ${needsYou} need you` : ""}
					</Text>
				)}
				{next ? (
					<Text
						as="p"
						role="label"
						className="flex min-w-0 items-baseline gap-1"
					>
						<span className="shrink-0">Next:</span>
						<Link
							variant="record"
							href={`/work/items/${next.id}`}
							className="min-w-0 truncate"
						>
							{next.title}
						</Link>
					</Text>
				) : null}
				<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
					{lead ? (
						<Text as="span" role="label" tone="secondary">
							Lead: {lead}
						</Text>
					) : null}
					{lastActivity ? (
						<Text as="span" role="label" tone="secondary">
							Active <Time at={lastActivity} />
						</Text>
					) : null}
					{org ? <CrossOrgLink slug={org} /> : null}
				</div>
			</CardContent>
		</Card>
	);
}

function OtherProjects({ entries }: { entries: PortfolioEntry[] }) {
	if (!entries.length) return null;
	return (
		<Collapsible>
			<CollapsibleTrigger>Other ({entries.length})</CollapsibleTrigger>
			<CollapsibleContent>
				<Collection aria-label="Other projects" className="mt-2">
					{entries.map(({ project, title }) => (
						<li
							key={project.id}
							className="flex min-w-0 items-center justify-between gap-2 px-4 py-2"
						>
							<Link
								variant="record"
								href={`/work/projects/${project.id}`}
								className="min-w-0 truncate"
							>
								{title}
							</Link>
							<Badge variant={projectStatusVariant(project.status)}>
								{sentenceCase(project.status)}
							</Badge>
						</li>
					))}
				</Collection>
			</CollapsibleContent>
		</Collapsible>
	);
}

export function WorkPortfolioPage() {
	useDocumentTitle("Portfolio · Work");
	const projects = useQuery(projectListQueryOptions(PORTFOLIO_PROJECT_LIMIT));
	const tedis = useQuery({ ...tediRosterQueryOptions(100), retry: false });
	const inbox = useQuery(workOfficeKnocksQueryOptions());
	const approvals = useQuery({ ...workApprovalsQueryOptions(), retry: false });
	const grouped = useMemo(
		() => groupPortfolio(projects.data?.data ?? []),
		[projects.data],
	);
	const tediNames = useMemo(
		() =>
			new Map(
				(tedis.data?.data ?? []).map((tedi) => [
					tedi.id,
					tedi.displayName || tedi.name,
				]),
			),
		[tedis.data],
	);
	const openInteractions = useMemo(
		() =>
			(inbox.data?.data ?? []).filter((row) => row.effectiveState === "open"),
		[inbox.data],
	);
	const needsYou = useMemo(
		() => needsYouRows(openInteractions, approvals.data?.data ?? []),
		[openInteractions, approvals.data],
	);
	return (
		<Page width="full" className="gap-8">
			<PageHeader>
				<PageHeading>
					<PageTitle>Portfolio</PageTitle>
					<PageDescription>
						Your main projects, what is open, and what needs you.
					</PageDescription>
				</PageHeading>
			</PageHeader>
			<NeedsYouStrip rows={needsYou} />
			{projects.isPending ? (
				<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
					<Skeleton className="h-36" />
					<Skeleton className="h-36" />
					<Skeleton className="h-36" />
				</div>
			) : projects.isError ? (
				<Alert variant="destructive">
					<AlertTitle>Portfolio unavailable</AlertTitle>
					<AlertDescription>
						{errorMessage(projects.error, "Projects could not be loaded.")}
					</AlertDescription>
				</Alert>
			) : (
				<>
					{grouped.buckets.map(({ name, entries }) => (
						<PageSection
							key={name}
							aria-labelledby={`portfolio-bucket-${name.toLowerCase()}`}
							data-portfolio-bucket={name}
						>
							<SectionHeader>
								<SectionHeading>
									<SectionTitle id={`portfolio-bucket-${name.toLowerCase()}`}>
										{name}
									</SectionTitle>
								</SectionHeading>
							</SectionHeader>
							{entries.length ? (
								<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
									{entries.map((entry) => (
										<PortfolioCard
											key={entry.project.id}
											entry={entry}
											tediNames={tediNames}
											openInteractions={openInteractions}
										/>
									))}
								</div>
							) : (
								<Muted>No records yet</Muted>
							)}
						</PageSection>
					))}
					<OtherProjects entries={grouped.other} />
				</>
			)}
		</Page>
	);
}
