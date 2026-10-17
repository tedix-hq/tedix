import { factoryHref } from "@/lib/work-display";
import type {
	FactoryScoreboardEntry,
	Project,
	ProjectPortfolioEntry,
} from "@tedix/api-contract/contracts/projects";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
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
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Skeleton } from "@/components/kumo/skeleton";
import { Text } from "@/components/kumo/text";
import { sentenceCase } from "@/lib/format";
import { errorMessage } from "@/lib/orpc-error";
import {
	factoryScoreboardQueryOptions,
	projectPortfolioQueryOptions,
	workOfficeKnocksQueryOptions,
} from "@/lib/os-query-options";
import { absoluteTime, normalizeD1Timestamp, relativeTime } from "@/lib/time";
import { useDocumentTitle } from "@/lib/use-document-title";
import { resolveOsTenant } from "@/shared/os-tenant";
import { buildSurfaceUrl } from "@tedix/tenant-directory";

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

type PortfolioBucket = (typeof PORTFOLIO_BUCKETS)[number];

export type PortfolioEntry = {
	row: ProjectPortfolioEntry;
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

function portfolioEntry(row: ProjectPortfolioEntry): PortfolioEntry {
	const { project } = row;
	return {
		row,
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
export function groupPortfolio(rows: readonly ProjectPortfolioEntry[]): {
	buckets: Array<{ name: PortfolioBucket; entries: PortfolioEntry[] }>;
	other: PortfolioEntry[];
} {
	const grouped = new Map<PortfolioBucket, PortfolioEntry[]>(
		PORTFOLIO_BUCKETS.map((bucket) => [bucket, []]),
	);
	const other: PortfolioEntry[] = [];
	for (const row of rows) {
		const bucket = portfolioBucketOf(row.project);
		const closed =
			row.project.status === "archived" || row.project.status === "done";
		if (!bucket || closed) other.push(portfolioEntry(row));
		else grouped.get(bucket)?.push(portfolioEntry(row));
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

export type FactoryGroup = {
	tedi: string;
	factories: FactoryScoreboardEntry[];
};

/** Factories grouped by tedi, in the server's order; unassigned ones last. */
export function groupFactories(
	rows: readonly FactoryScoreboardEntry[],
): FactoryGroup[] {
	const groups = new Map<string, FactoryScoreboardEntry[]>();
	for (const row of rows) {
		const tedi = row.tediName ?? "No tedi";
		groups.set(tedi, [...(groups.get(tedi) ?? []), row]);
	}
	return [...groups].map(([tedi, factories]) => ({ tedi, factories }));
}

/** A published Blueprint nobody ran this week is a template, not a factory. */
export function isIdleTemplate(row: FactoryScoreboardEntry): boolean {
	return row.kind === "blueprint" && row.runs === 0;
}

function counted(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function resultHref(result: NonNullable<FactoryScoreboardEntry["lastResult"]>) {
	return result.kind === "output"
		? `/outputs/${result.id}`
		: `/work/items/${result.id}`;
}

type FactoryVerdict = NonNullable<FactoryScoreboardEntry["verdict"]>;

const VERDICT_BADGES: Record<
	FactoryVerdict,
	{ label: string; variant: BadgeVariant }
> = {
	healthy: { label: "Healthy", variant: "success" },
	idle: { label: "Idle", variant: "warning" },
	failing: { label: "Failing", variant: "destructive" },
	not_firing: { label: "Not firing", variant: "destructive" },
	paused: { label: "Paused", variant: "outline" },
	pending: { label: "Waiting for a run", variant: "secondary" },
};

/**
 * A loop shows the inspect_factory_health verdict, the same one the CLI and
 * MCP report. A Blueprint has no verdict, so it keeps the scoreboard's own
 * idle flag.
 */
export function factoryStatus(
	row: FactoryScoreboardEntry,
): { label: string; variant: BadgeVariant } | null {
	if (row.verdict) return VERDICT_BADGES[row.verdict];
	if (row.paused) return VERDICT_BADGES.paused;
	if (row.idle) return VERDICT_BADGES.idle;
	return null;
}

function isBroken(row: FactoryScoreboardEntry): boolean {
	return row.verdict === "failing" || row.verdict === "not_firing";
}

function FactoryRow({ row }: { row: FactoryScoreboardEntry }) {
	const status = factoryStatus(row);
	return (
		<li
			className="grid min-w-0 gap-1 px-4 py-3"
			data-factory={`${row.kind}:${row.id}`}
		>
			<div className="flex min-w-0 items-start justify-between gap-2">
				<Link
					variant="record"
					href={factoryHref(row)}
					className="line-clamp-1 min-w-0 font-medium"
				>
					{row.name}
				</Link>
				<div className="flex shrink-0 flex-wrap justify-end gap-1">
					{status ? (
						<Badge
							variant={status.variant}
							title={row.verdictReason ?? undefined}
						>
							{status.label}
						</Badge>
					) : null}
					<Badge variant="outline">
						{row.kind === "blueprint" ? "Blueprint" : "Loop"}
					</Badge>
				</div>
			</div>
			<Text as="p" role="label" className="tabular-nums">
				{counted(row.runs, "run")} ({row.succeeded} ok) ·{" "}
				{counted(row.outputs, "Output")} · {row.workClosed} Work closed
			</Text>
			{isBroken(row) && row.verdictReason ? (
				<Text as="p" role="label" tone="error" className="line-clamp-2">
					{row.verdictReason}
				</Text>
			) : null}
			{row.lastResult ? (
				<Text
					as="p"
					role="label"
					tone="secondary"
					className="flex min-w-0 items-baseline gap-1"
				>
					<span className="shrink-0">Last result:</span>
					<Link
						variant="record"
						href={resultHref(row.lastResult)}
						className="min-w-0 truncate"
					>
						{row.lastResult.title}
					</Link>
					<span className="shrink-0">
						· <Time at={normalizeD1Timestamp(row.lastResult.at)} />
					</span>
				</Text>
			) : (
				<Muted>No results in the last 30 days</Muted>
			)}
		</li>
	);
}

function FactoryScoreboard() {
	const scoreboard = useQuery(factoryScoreboardQueryOptions());
	const rows = scoreboard.data?.data;
	const groups = useMemo(
		() => groupFactories((rows ?? []).filter((row) => !isIdleTemplate(row))),
		[rows],
	);
	const unusedTemplates = rows?.filter(isIdleTemplate).length ?? 0;
	const failing = rows?.filter((row) => row.verdict === "failing").length ?? 0;
	const notFiring =
		rows?.filter((row) => row.verdict === "not_firing").length ?? 0;
	return (
		<PageSection aria-labelledby="portfolio-factories-title">
			<SectionHeader>
				<SectionHeading>
					<SectionTitle id="portfolio-factories-title">Factories</SectionTitle>
					<SectionDescription>
						Runs and results of each scheduled loop and Blueprint over the last
						7 days.
					</SectionDescription>
					{failing || notFiring ? (
						<Text as="p" role="label" tone="error" data-factory-problems="">
							{[
								failing ? `${failing} failing` : null,
								notFiring ? `${notFiring} not firing` : null,
							]
								.filter(Boolean)
								.join(" · ")}
						</Text>
					) : null}
				</SectionHeading>
				{unusedTemplates ? (
					<SectionActions>
						<Link variant="section" href="/blueprints">
							{counted(unusedTemplates, "Blueprint")} with no runs
						</Link>
					</SectionActions>
				) : null}
			</SectionHeader>
			{scoreboard.isPending ? (
				<Skeleton className="h-24" />
			) : scoreboard.isError ? (
				<Alert variant="destructive">
					<AlertTitle>Factories unavailable</AlertTitle>
					<AlertDescription>
						{errorMessage(scoreboard.error, "Factories could not be loaded.")}
					</AlertDescription>
				</Alert>
			) : groups.length ? (
				<div className="grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
					{groups.map((group) => (
						<Collection key={group.tedi} aria-label={`${group.tedi} factories`}>
							<li className="px-4 pt-3">
								<Text as="p" role="label" tone="secondary">
									{group.tedi}
								</Text>
							</li>
							{group.factories.map((row) => (
								<FactoryRow key={`${row.kind}:${row.id}`} row={row} />
							))}
						</Collection>
					))}
				</div>
			) : (
				<Muted>
					{unusedTemplates
						? "No loop or Blueprint ran in the last 7 days"
						: "No scheduled loops or published Blueprints yet"}
				</Muted>
			)}
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
	openInteractions,
}: {
	entry: PortfolioEntry;
	openInteractions: readonly InboxRow[];
}) {
	const { row, project, title, org } = entry;
	const brief = projectBriefLine(project.description);
	const lastActivity = latestActivity([
		project.updatedAt,
		project.createdAt,
		row.lastActivityAt,
	]);
	const needsYou = openInteractions.filter(
		(interaction) =>
			interaction.request.projectId === project.id ||
			interaction.workItem?.projectId === project.id,
	).length;
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
						{row.health ? (
							<Badge variant={HEALTH_VARIANT[row.health]}>
								{sentenceCase(row.health)}
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
				{row.total === 0 ? (
					<Muted>No records yet</Muted>
				) : (
					<Text as="p" role="label" className="tabular-nums">
						{row.byDisposition.proposed ?? 0} open ·{" "}
						{row.byDisposition.accepted ?? 0} accepted
						{needsYou ? ` · ${needsYou} need you` : ""}
					</Text>
				)}
				{row.next ? (
					<Text
						as="p"
						role="label"
						className="flex min-w-0 items-baseline gap-1"
					>
						<span className="shrink-0">Next:</span>
						<Link
							variant="record"
							href={`/work/items/${row.next.id}`}
							className="min-w-0 truncate"
						>
							{row.next.title}
						</Link>
					</Text>
				) : null}
				<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
					{row.leadTediName ? (
						<Text as="span" role="label" tone="secondary">
							Coordinator: {row.leadTediName}
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
	const portfolio = useQuery(projectPortfolioQueryOptions());
	const inbox = useQuery({
		...workOfficeKnocksQueryOptions(),
		refetchOnWindowFocus: false,
	});
	const grouped = useMemo(
		() => groupPortfolio(portfolio.data?.data ?? []),
		[portfolio.data],
	);
	const openInteractions = useMemo(
		() =>
			(inbox.data?.data ?? []).filter((row) => row.effectiveState === "open"),
		[inbox.data],
	);
	return (
		<Page width="full" className="gap-8">
			<PageHeader>
				<PageHeading>
					<PageTitle>Portfolio</PageTitle>
					<PageDescription>
						Your main projects, their factories, and what is open.
					</PageDescription>
				</PageHeading>
			</PageHeader>
			<FactoryScoreboard />
			{portfolio.isPending ? (
				<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
					<Skeleton className="h-36" />
					<Skeleton className="h-36" />
					<Skeleton className="h-36" />
				</div>
			) : portfolio.isError ? (
				<Alert variant="destructive">
					<AlertTitle>Portfolio unavailable</AlertTitle>
					<AlertDescription>
						{errorMessage(portfolio.error, "Projects could not be loaded.")}
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
