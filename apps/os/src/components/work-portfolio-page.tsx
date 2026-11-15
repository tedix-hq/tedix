import { LedgerRow, RelativeTime } from "@/components/work-ledger-row";
import type { PortfolioBucket } from "@tedix/api-contract/schemas/organization";
import { factoryHref } from "@/lib/work-display";
import type {
	FactoryScoreboardEntry,
	Project,
	ProjectPortfolioEntry,
} from "@tedix/api-contract/contracts/projects";
import { useQuery } from "@tanstack/react-query";
import { useContext, useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import {
	Collapsible,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
} from "@/components/kumo/collapsible";
import { Link } from "@/components/kumo/link";
import {
	Collection,
	Page,
	PageActions,
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
import {
	Progress,
	ProgressIndicator,
	ProgressTrack,
} from "@/components/kumo/progress";
import { SearchInput } from "@/components/kumo/search-input";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Skeleton } from "@/components/kumo/skeleton";
import { Text } from "@/components/kumo/text";
import {
	WorkActorAvatar,
	WorkActorDirectoryContext,
	WorkActorOwnerContext,
} from "@/components/work-actor-avatar";
import { WorkEmpty } from "@/components/work-surface-primitives";
import { sentenceCase } from "@/lib/format";
import { OS_COPY } from "@/shared/os-copy";
import { plainWorkText } from "@/lib/work-detail";
import { errorMessage } from "@/lib/orpc-error";
import {
	factoryScoreboardQueryOptions,
	projectPortfolioQueryOptions,
	workOfficeKnocksQueryOptions,
} from "@/lib/os-query-options";
import {
	isProjectOverdue,
	projectTargetLabel,
} from "@/lib/project-target-date";
import { normalizeD1Timestamp } from "@/lib/time";
import { useDocumentTitle } from "@/lib/use-document-title";
import { resolveOsTenant } from "@/shared/os-tenant";
import { buildSurfaceUrl } from "@tedix/tenant-directory";

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

/** One project as the Projects list shows it. */
export type ProjectListEntry = {
	row: ProjectPortfolioEntry;
	project: Project;
	title: string;
	org: string | null;
	section: PortfolioBucket | null;
	brief: string | null;
	/** Work Items still to do: proposed plus accepted. */
	open: number;
	done: number;
	needsYou: number;
	lastActivity: string | null;
};

export const PROJECT_STATUS_GROUPS = [
	{ status: "active", label: "Active", collapsed: false },
	{ status: "paused", label: "Paused", collapsed: false },
	{ status: "done", label: "Done", collapsed: true },
	{ status: "archived", label: "Archived", collapsed: true },
] as const satisfies readonly {
	status: Project["status"];
	label: string;
	collapsed: boolean;
}[];

export type ProjectWhoFilter = "all" | "needs_you" | "mine";

export type ProjectListFilter = {
	query: string;
	who: ProjectWhoFilter;
	/** A section key, or null for every section. */
	section: string | null;
};

/** Every portfolio row as a list entry; nothing is dropped or folded away. */
export function projectListEntries(
	rows: readonly ProjectPortfolioEntry[],
	buckets: readonly PortfolioBucket[],
	openInteractions: readonly InboxRow[] = [],
): ProjectListEntry[] {
	return rows.map((row) => {
		const { project } = row;
		const sectionKey = portfolioBucketOf(project, buckets);
		const brief = projectBriefLine(project.description);
		return {
			row,
			project,
			title: metadataString(project, "portfolioTitle") ?? project.name,
			org: metadataString(project, "portfolioOrg"),
			section: buckets.find((bucket) => bucket.key === sectionKey) ?? null,
			brief: brief && !isPlaceholderBrief(brief) ? brief : null,
			open:
				(row.byDisposition.proposed ?? 0) + (row.byDisposition.accepted ?? 0),
			done: row.byDisposition.completed ?? 0,
			needsYou: openInteractions.filter(
				(interaction) =>
					interaction.request.projectId === project.id ||
					interaction.workItem?.projectId === project.id,
			).length,
			lastActivity: latestActivity([
				project.updatedAt,
				project.createdAt,
				row.lastActivityAt,
			]),
		};
	});
}

export function filterProjects(
	entries: readonly ProjectListEntry[],
	filter: ProjectListFilter,
	currentUserId?: string,
): ProjectListEntry[] {
	const words = filter.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	return entries.filter((entry) => {
		if (filter.section && entry.section?.key !== filter.section) return false;
		if (filter.who === "needs_you" && entry.needsYou === 0) return false;
		if (
			filter.who === "mine" &&
			(!currentUserId || entry.project.ownerUserId !== currentUserId)
		)
			return false;
		if (!words.length) return true;
		const haystack = [
			entry.title,
			entry.project.name,
			entry.project.key,
			entry.brief,
			entry.section?.label,
		]
			.filter(Boolean)
			.join(" ")
			.toLowerCase();
		return words.every((word) => haystack.includes(word));
	});
}

const byRecentActivity = (a: ProjectListEntry, b: ProjectListEntry) =>
	(b.lastActivity ?? "").localeCompare(a.lastActivity ?? "") ||
	a.title.localeCompare(b.title);

/** Status groups in a fixed order, newest activity first; empty groups are left out. */
export function groupProjectsByStatus(entries: readonly ProjectListEntry[]) {
	return PROJECT_STATUS_GROUPS.map((group) => ({
		...group,
		entries: entries
			.filter((entry) => entry.project.status === group.status)
			.sort(byRecentActivity),
	})).filter((group) => group.entries.length > 0);
}

/** Sections that hold at least one project, in the owner's configured order. */
export function usedSections(
	entries: readonly ProjectListEntry[],
	buckets: readonly PortfolioBucket[],
) {
	return buckets
		.map((bucket) => ({
			...bucket,
			count: entries.filter((entry) => entry.section?.key === bucket.key)
				.length,
		}))
		.filter((bucket) => bucket.count > 0);
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
					className="group/factory-name tap-target-y min-w-0 font-medium"
				>
					<span className="line-clamp-1 wrap-anywhere group-hover/factory-name:line-clamp-none group-focus/factory-name:line-clamp-none">
						{row.name}
					</span>
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

function ProjectOwner({
	project,
	leadTediName,
}: {
	project: Project;
	leadTediName: string | null;
}) {
	const directory = useContext(WorkActorDirectoryContext);
	const actor = project.ownerUserId
		? { type: "user", id: project.ownerUserId }
		: project.leadTediId
			? { type: "tedi", id: project.leadTediId }
			: null;
	if (!actor) return <span data-project-owner="" />;
	const name =
		directory.get(`${actor.type}:${actor.id}`)?.name ??
		(actor.type === "tedi" ? leadTediName : null);
	// A raw id is never a name: an owner we cannot name is left out.
	if (!name) return <span data-project-owner="" />;
	return (
		<span
			className="inline-flex min-w-0 items-center gap-2"
			data-project-owner={name}
		>
			<WorkActorAvatar actor={actor} name={name} className="shrink-0" />
			<Text as="span" role="label" className="truncate">
				{name}
			</Text>
		</span>
	);
}

function ProjectProgress({ open, done }: { open: number; done: number }) {
	const total = open + done;
	if (total === 0)
		return (
			<Text as="span" role="label" tone="secondary" data-project-progress="">
				No tasks yet
			</Text>
		);
	const percent = Math.round((done / total) * 100);
	return (
		<span className="grid min-w-0 gap-1" data-project-progress={percent}>
			<Text as="span" role="label" className="tabular-nums">
				{open} open · {done} done
			</Text>
			<Progress
				value={percent}
				aria-label={`${percent}% of tasks done`}
				className="w-full max-w-40"
			>
				<ProgressTrack className="h-1">
					<ProgressIndicator />
				</ProgressTrack>
			</Progress>
		</span>
	);
}

function ProjectRow({ entry }: { entry: ProjectListEntry }) {
	const { row, project, title, org, section, brief, needsYou, lastActivity } =
		entry;
	const target = projectTargetLabel(project.targetDate);
	const overdue = isProjectOverdue(project);
	return (
		<li
			data-project-row={project.id}
			className="flex flex-col gap-2 px-4 py-3 sm:grid sm:grid-cols-[minmax(0,1fr)_11rem_10rem_6.5rem] sm:items-center sm:gap-4"
		>
			<div className="grid min-w-0 gap-1">
				<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
					<Link
						variant="record"
						href={`/work/projects/${project.id}`}
						className="tap-target-y min-w-0 font-medium"
					>
						<span className="line-clamp-2 wrap-anywhere">{title}</span>
					</Link>
					{section ? <Badge variant="outline">{section.label}</Badge> : null}
					{row.health ? (
						<Badge variant={HEALTH_VARIANT[row.health]}>
							{sentenceCase(row.health)}
						</Badge>
					) : null}
					{needsYou ? (
						<Badge variant="warning">
							{needsYou === 1
								? "1 question for you"
								: `${needsYou} questions for you`}
						</Badge>
					) : null}
					{target ? (
						<Badge variant={overdue ? "error" : "secondary"}>
							{overdue ? `Was due ${target}` : `Due ${target}`}
						</Badge>
					) : null}
				</div>
				{brief || org ? (
					<Text
						as="p"
						role="label"
						tone="secondary"
						className="m-0 flex min-w-0 items-baseline gap-1"
					>
						{brief ? <span className="min-w-0 truncate">{brief}</span> : null}
						{org ? (
							<span className="shrink-0">
								{brief ? "· " : null}
								<CrossOrgLink slug={org} />
							</span>
						) : null}
					</Text>
				) : null}
			</div>
			<div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 sm:contents">
				<ProjectOwner project={project} leadTediName={row.leadTediName} />
				<ProjectProgress open={entry.open} done={entry.done} />
				<Text
					as="span"
					role="label"
					tone="secondary"
					className="tabular-nums sm:text-right"
				>
					{lastActivity ? <RelativeTime at={lastActivity} /> : null}
				</Text>
			</div>
		</li>
	);
}

function ProjectStatusGroup({
	label,
	collapsed,
	entries,
	forceOpen,
}: {
	label: string;
	collapsed: boolean;
	entries: readonly ProjectListEntry[];
	forceOpen: boolean;
}) {
	const id = `projects-${label.toLowerCase()}`;
	const list = (
		<Collection aria-label={`${label} projects`}>
			{entries.map((entry) => (
				<ProjectRow key={entry.project.id} entry={entry} />
			))}
		</Collection>
	);
	const heading = (
		<>
			{label}{" "}
			<Text as="span" role="label" tone="secondary" className="tabular-nums">
				{entries.length}
			</Text>
		</>
	);
	if (collapsed && !forceOpen)
		return (
			<Collapsible data-project-group={label.toLowerCase()}>
				<CollapsibleDefaultTrigger className="-ml-2">
					{heading}
				</CollapsibleDefaultTrigger>
				<CollapsibleDefaultContent>
					<div className="pt-2">{list}</div>
				</CollapsibleDefaultContent>
			</Collapsible>
		);
	return (
		<section
			aria-labelledby={id}
			className="grid gap-2"
			data-project-group={label.toLowerCase()}
		>
			<Text as="h2" id={id} role="label" weight="medium" className="m-0">
				{heading}
			</Text>
			{list}
		</section>
	);
}

const WHO_OPTIONS = [
	{ value: "all", label: "All" },
	{ value: "needs_you", label: "Needs you" },
	{ value: "mine", label: "Mine" },
] as const satisfies readonly { value: ProjectWhoFilter; label: string }[];

const ALL_SECTIONS = "all";

export function PortfolioApp({
	buckets = OS_COPY.portfolio.defaults,
	isOwner = false,
}: {
	buckets?: readonly PortfolioBucket[];
	isOwner?: boolean;
}) {
	useDocumentTitle("Projects · Work");
	const currentUserId = useContext(WorkActorOwnerContext);
	const portfolio = useQuery(projectPortfolioQueryOptions());
	const inbox = useQuery({
		...workOfficeKnocksQueryOptions(),
		refetchOnWindowFocus: false,
	});
	const [query, setQuery] = useState("");
	const [who, setWho] = useState<ProjectWhoFilter>("all");
	const [section, setSection] = useState<string>(ALL_SECTIONS);
	const entries = useMemo(
		() =>
			projectListEntries(
				portfolio.data?.data ?? [],
				buckets,
				(inbox.data?.data ?? []).filter((row) => row.effectiveState === "open"),
			),
		[portfolio.data, inbox.data, buckets],
	);
	const sections = useMemo(
		() => usedSections(entries, buckets),
		[entries, buckets],
	);
	const filter: ProjectListFilter = {
		query,
		who,
		section: section === ALL_SECTIONS ? null : section,
	};
	const visible = filterProjects(entries, filter, currentUserId);
	const groups = groupProjectsByStatus(visible);
	const filtering = Boolean(query.trim()) || who !== "all" || filter.section;
	const active = entries.filter((entry) => entry.project.status === "active");
	return (
		<Page width="full" className="gap-8">
			<PageHeader>
				<PageHeading>
					<PageTitle>Projects</PageTitle>
					<PageDescription>
						{portfolio.data
							? `All ${counted(entries.length, "project")} in this organization, ${active.length} active. Open one to see its tasks.`
							: "Every project in this organization. Open one to see its tasks."}
					</PageDescription>
				</PageHeading>
				{isOwner ? (
					<PageActions>
						<Link
							variant="section"
							href="/admin/organization#organization-portfolio"
							className={PHONE_INLINE_LINK}
						>
							Edit sections
						</Link>
					</PageActions>
				) : null}
			</PageHeader>
			{portfolio.isPending ? (
				<div className="grid gap-2">
					<Skeleton className="h-9 w-full max-w-md" />
					<Skeleton className="h-64 w-full" />
				</div>
			) : portfolio.isError ? (
				<Alert variant="destructive">
					<AlertTitle>Projects unavailable</AlertTitle>
					<AlertDescription>
						{errorMessage(portfolio.error, "Projects could not be loaded.")}
					</AlertDescription>
				</Alert>
			) : entries.length === 0 ? (
				<WorkEmpty
					title="No projects yet"
					description="A project groups related tasks. Ask a tedi to start one."
				/>
			) : (
				<div className="grid gap-6">
					<div
						role="search"
						aria-label="Filter projects"
						className="flex min-w-0 flex-wrap items-center gap-2"
					>
						<SearchInput
							aria-label="Search projects"
							placeholder="Search projects"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							containerClassName="w-full sm:w-72"
						/>
						<SegmentedControl
							ariaLabel="Show"
							value={who}
							onValueChange={setWho}
							options={WHO_OPTIONS}
						/>
						{sections.length ? (
							<Select
								value={section}
								onValueChange={(value) => setSection(String(value))}
							>
								<SelectTrigger aria-label="Section" className="min-w-36">
									<SelectValue>
										{(value: string) =>
											value === ALL_SECTIONS
												? "All sections"
												: (sections.find((item) => item.key === value)?.label ??
													"All sections")
										}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={ALL_SECTIONS}>All sections</SelectItem>
									{sections.map((item) => (
										<SelectItem key={item.key} value={item.key}>
											{item.label} ({item.count})
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						) : null}
					</div>
					{groups.length ? (
						groups.map((group) => (
							<ProjectStatusGroup
								key={group.status}
								label={group.label}
								collapsed={group.collapsed}
								entries={group.entries}
								forceOpen={Boolean(filtering)}
							/>
						))
					) : (
						<WorkEmpty
							title="No projects match"
							description="Try another search, or show all projects."
						/>
					)}
				</div>
			)}
			<FactoryScoreboard />
		</Page>
	);
}
