import {
	LedgerRow,
	LedgerRowMeta,
	RelativeTime,
} from "@/components/work-ledger-row";
import type { PortfolioBucket } from "@tedix/api-contract/schemas/organization";
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
import { OS_COPY } from "@/shared/os-copy";
import { plainWorkText } from "@/lib/work-detail";
import { errorMessage } from "@/lib/orpc-error";
import {
	factoryScoreboardQueryOptions,
	projectPortfolioQueryOptions,
	workOfficeKnocksQueryOptions,
} from "@/lib/os-query-options";
import { normalizeD1Timestamp } from "@/lib/time";
import { useDocumentTitle } from "@/lib/use-document-title";
import { resolveOsTenant } from "@/shared/os-tenant";
import { buildSurfaceUrl } from "@tedix/tenant-directory";

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

export function portfolioBucketOf(
	project: Project,
	buckets: readonly PortfolioBucket[],
): string | null {
	const raw = metadataString(project, "portfolioBucket")?.toLowerCase();
	return buckets.find((bucket) => bucket.key === raw)?.key ?? null;
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

export function groupPortfolio(
	rows: readonly ProjectPortfolioEntry[],
	config: readonly PortfolioBucket[] = OS_COPY.portfolio.defaults,
) {
	const grouped = new Map(
		config.map((bucket) => [bucket.key, [] as PortfolioEntry[]]),
	);
	const other: PortfolioEntry[] = [];
	const unknown = new Map<string, number>();
	for (const row of rows) {
		const key = portfolioBucketOf(row.project, config);
		const raw = metadataString(row.project, "portfolioBucket")?.toLowerCase();
		if (!key && raw) unknown.set(raw, (unknown.get(raw) ?? 0) + 1);
		if (
			!key ||
			row.project.status === "archived" ||
			row.project.status === "done"
		)
			other.push(portfolioEntry(row));
		else grouped.get(key)?.push(portfolioEntry(row));
	}
	return {
		buckets: config
			.map((bucket) => ({
				...bucket,
				name: bucket.label,
				entries: (grouped.get(bucket.key) ?? []).sort(byTitle),
			}))
			.filter((bucket) => bucket.entries.length > 0),
		other: other.sort(byTitle),
		unknown,
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

/** A published Template nobody ran this week is a template, not a factory. */
export function isIdleTemplate(row: FactoryScoreboardEntry): boolean {
	return row.kind === "blueprint" && row.runs === 0;
}

/** Phone-only 44px hit area for a short inline link; desktop is unchanged. */
const PHONE_INLINE_LINK =
	"max-sm:inline-flex max-sm:min-h-11 max-sm:items-center";

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
 * MCP report. A Template has no verdict, so it keeps the scoreboard's own
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

export function factoryFailureHref(row: FactoryScoreboardEntry): string {
	const runId = row.verdictReason?.match(
		/\bRun ([0-9a-f]{8}-[0-9a-f-]{27})\b/i,
	)?.[1];
	return runId ? `/work/runs/${runId}` : factoryHref(row);
}

function FactoryRow({ row }: { row: FactoryScoreboardEntry }) {
	const status = factoryStatus(row);
	return (
		<LedgerRow
			data-factory={`${row.kind}:${row.id}`}
			title={
				<Link
					variant="record"
					href={factoryHref(row)}
					className="tap-target-y min-w-0 font-medium"
				>
					<span className="line-clamp-1">{row.name}</span>
				</Link>
			}
			actions={
				<div className="flex shrink-0 flex-wrap justify-end gap-1">
					{status ? (
						<Badge
							variant={status.variant}
							title={
								row.verdictReason ? plainWorkText(row.verdictReason) : undefined
							}
						>
							{status.label}
						</Badge>
					) : null}
					<Badge variant="outline">
						{row.kind === "blueprint" ? "Template" : "Loop"}
					</Badge>
				</div>
			}
			meta={
				<span className="tabular-nums">
					{counted(row.runs, "run")} · {counted(row.outputs, "result")} ·{" "}
					{row.workClosed} closed
				</span>
			}
			hint={
				<>
					{isBroken(row) && row.verdictReason ? (
						<Text
							as="span"
							role="label"
							tone="error"
							className="block line-clamp-2 max-sm:line-clamp-none"
						>
							<Link
								variant="record"
								href={factoryFailureHref(row)}
								className="tap-target-y inline-block"
							>
								{plainWorkText(row.verdictReason)}
							</Link>
						</Text>
					) : null}
					{row.lastResult ? (
						<span className="flex min-w-0 items-baseline gap-1">
							<span className="shrink-0">Last result:</span>
							<Link
								variant="record"
								href={resultHref(row.lastResult)}
								className="tap-target-y min-w-0 truncate"
							>
								{row.lastResult.title}
							</Link>
							<span className="shrink-0">
								· <RelativeTime at={normalizeD1Timestamp(row.lastResult.at)} />
							</span>
						</span>
					) : (
						OS_COPY.work.nothingProduced
					)}
				</>
			}
		/>
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
						Runs and results of each scheduled loop and Template over the last 7
						days.
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
						<Link
							variant="section"
							href="/blueprints"
							className={PHONE_INLINE_LINK}
						>
							{counted(unusedTemplates, "Template")} with no runs
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
				<div className="columns-1 gap-3 md:max-[1200px]:columns-2 min-[1200px]:columns-3">
					{groups.map((group) => (
						<Collection
							key={group.tedi}
							aria-label={`${group.tedi} factories`}
							className="mb-3 break-inside-avoid"
						>
							<li className="px-4 py-3">
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
				<Text as="p" role="label" tone="secondary">
					{unusedTemplates
						? "No loop or Template ran in the last 7 days"
						: "No scheduled loops or published Templates yet"}
				</Text>
			)}
		</PageSection>
	);
}

function CrossOrgLink({ slug }: { slug: string }) {
	const href = crossOrgPortfolioUrl(slug);
	return href ? (
		<Link href={href} className={`type-tedix-label ${PHONE_INLINE_LINK}`}>
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
						className="tap-target-y min-w-0 font-medium focus-visible:ring-inset"
					>
						<span className="line-clamp-2">{title}</span>
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
					<Text as="p" role="label" tone="secondary">
						No records yet
					</Text>
				) : (
					<Text
						as="p"
						role="label"
						className="truncate whitespace-nowrap tabular-nums"
					>
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
							className="tap-target-y min-w-0 truncate"
						>
							{row.next.title}
						</Link>
					</Text>
				) : null}
				<LedgerRowMeta
					items={[
						...(row.leadTediName
							? [
									{
										term: "Coordinator",
										value: `Coordinator: ${row.leadTediName}`,
									},
								]
							: []),
						...(lastActivity
							? [
									{
										term: "Activity",
										value: (
											<>
												Active <RelativeTime at={lastActivity} />
											</>
										),
									},
								]
							: []),
						...(org
							? [{ term: "Organization", value: <CrossOrgLink slug={org} /> }]
							: []),
					]}
				/>
			</CardContent>
		</Card>
	);
}

function OtherProjects({ entries }: { entries: PortfolioEntry[] }) {
	if (!entries.length) return null;
	return (
		<Collapsible>
			<CollapsibleTrigger>
				{OS_COPY.portfolio.unsorted} ({entries.length})
			</CollapsibleTrigger>
			<CollapsibleContent>
				<Collection aria-label="Unsorted projects" className="mt-2">
					{entries.map(({ project, title }) => (
						<LedgerRow
							key={project.id}
							title={
								<Link
									variant="record"
									href={`/work/projects/${project.id}`}
									className="tap-target-y min-w-0 truncate"
								>
									{title}
								</Link>
							}
							actions={
								<Badge variant={projectStatusVariant(project.status)}>
									{sentenceCase(project.status)}
								</Badge>
							}
						/>
					))}
				</Collection>
			</CollapsibleContent>
		</Collapsible>
	);
}

export function PortfolioApp({
	buckets = OS_COPY.portfolio.defaults,
	isOwner = false,
}: {
	buckets?: readonly PortfolioBucket[];
	isOwner?: boolean;
}) {
	useDocumentTitle("Projects · Work");
	const portfolio = useQuery(projectPortfolioQueryOptions());
	const inbox = useQuery({
		...workOfficeKnocksQueryOptions(),
		refetchOnWindowFocus: false,
	});
	const grouped = useMemo(
		() => groupPortfolio(portfolio.data?.data ?? [], buckets),
		[portfolio.data, buckets],
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
					<PageTitle>Projects</PageTitle>
					<PageDescription>
						Your main projects, their factories, and what is open.
					</PageDescription>
				</PageHeading>
			</PageHeader>
			{portfolio.isPending ? (
				<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
					<Skeleton className="h-36" />
					<Skeleton className="h-36" />
					<Skeleton className="h-36" />
				</div>
			) : portfolio.isError ? (
				<Alert variant="destructive">
					<AlertTitle>Projects unavailable</AlertTitle>
					<AlertDescription>
						{errorMessage(portfolio.error, "Projects could not be loaded.")}
					</AlertDescription>
				</Alert>
			) : (
				<>
					{isOwner && grouped.unknown.size > 0 && (
						<Alert variant="warning">
							<AlertTitle>Check your portfolio sections</AlertTitle>
							<AlertDescription>
								{[...grouped.unknown].map(([key, count]) => (
									<p key={key}>{OS_COPY.portfolio.unknown(count, key)}</p>
								))}
								<Link
									href="/admin/organization#organization-portfolio"
									className={PHONE_INLINE_LINK}
								>
									Edit portfolio sections
								</Link>
							</AlertDescription>
						</Alert>
					)}
					{grouped.buckets.map(({ key, name, description, entries }) => (
						<PageSection
							key={key}
							aria-labelledby={`portfolio-bucket-${key}`}
							data-portfolio-bucket={key}
						>
							<SectionHeader>
								<SectionHeading>
									<SectionTitle id={`portfolio-bucket-${key}`}>
										{name}
									</SectionTitle>
									{description && (
										<SectionDescription>{description}</SectionDescription>
									)}
								</SectionHeading>
							</SectionHeader>
							<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
								{entries.map((entry) => (
									<PortfolioCard
										key={entry.project.id}
										entry={entry}
										openInteractions={openInteractions}
									/>
								))}
							</div>
						</PageSection>
					))}
					<OtherProjects entries={grouped.other} />
				</>
			)}
			<FactoryScoreboard />
		</Page>
	);
}
