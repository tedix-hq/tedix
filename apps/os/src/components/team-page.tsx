import {
	ArrowRight,
	CaretDown,
	CaretRight,
	MagnifyingGlass,
	UsersThree,
} from "@phosphor-icons/react";
import type { TediOperationsSummary } from "@tedix/api-contract/contracts/tedis";
import type { TediType } from "@tedix/api-contract/schemas/tedi";
import { useQuery } from "@tanstack/react-query";
import { getOsSurface } from "@/lib/os-navigation";
import type { ComponentType, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { OsRouterLink } from "@/components/kumo/link-provider";
import {
	Collection,
	Page,
	PageActions,
	PageDescription,
	PageHeader,
	PageHeading,
	PageSection,
	PageTitle,
	PageToolbar,
} from "@/components/kumo/page";
import { SearchInput } from "@/components/kumo/search-input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@/components/kumo/tabs";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { ListSkeleton } from "@/components/list-skeleton";
import { TeamMembersPanel } from "@/components/team-members";
import { TeamRolesPanel } from "@/components/team-roles";
import { formatCount, humanize, sentenceCase } from "@/lib/format";
import { TEAM_TABS, type TeamTab } from "@/lib/team-tabs";
import {
	TEDI_ROSTER_LIMIT,
	runtimeEntitlementsQueryOptions,
	tediOperationsSummariesQueryOptions,
	tediRosterQueryOptions,
} from "@/lib/os-query-options";
import { absoluteTime, relativeTime } from "@/lib/time";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export type ChipTone = "neutral" | "active" | "blocked" | "done" | "warn";

export function tediStatusTone(status: TediType["status"]): ChipTone {
	switch (status) {
		case "active":
			return "done";
		case "provisioning":
			return "active";
		case "paused":
			return "warn";
		case "error":
			return "blocked";
		default:
			return "neutral";
	}
}

/** The contract allows a null status; label it honestly instead of hiding it. */
export function tediStatusLabel(status: TediType["status"]): string {
	return status ?? "unknown";
}

/**
 * Roster avatar strategy: an http(s)/data URL renders as an image, a short
 * avatar string (emoji) renders as-is, anything else falls back to the
 * monogram initial.
 */
export function avatarKind(
	avatar: string | null,
): "image" | "emoji" | "monogram" {
	if (!avatar) return "monogram";
	if (/^https?:\/\//.test(avatar) || avatar.startsWith("data:")) return "image";
	if ([...avatar.trim()].length <= 2) return "emoji";
	return "monogram";
}

export function tediMonogram(tedi: {
	displayName: string | null;
	name: string;
	slug: string;
}): string {
	const source = (tedi.displayName ?? tedi.name ?? tedi.slug).trim();
	const first = [...source][0];
	return first ? first.toUpperCase() : "?";
}

const PERSONA_HINT_MAX = 80;

/**
 * One-line role hint for the roster row: the earned-delegation active role
 * wins (roleName · careerStage); otherwise the first line of the persona.
 * Titles never imply authority — this is presentation only.
 */
export function roleHint(
	tedi: { personality: string | null },
	activeRole?: { roleName: string; careerStage: string } | null,
): string | null {
	if (activeRole) {
		return `${activeRole.roleName} · ${humanize(activeRole.careerStage)}`;
	}
	const firstLine = tedi.personality?.split("\n")[0]?.trim();
	if (!firstLine) return null;
	return firstLine.length > PERSONA_HINT_MAX
		? `${firstLine.slice(0, PERSONA_HINT_MAX - 1).trimEnd()}…`
		: firstLine;
}

export type TediRosterStatusFilter =
	| "all"
	| NonNullable<TediType["status"]>
	| "unknown";

export type EntrustmentEffectiveStatus =
	| "active"
	| "restricted"
	| "expired"
	| "revoked";

const ENTRUSTMENT_STATUS_ORDER: readonly EntrustmentEffectiveStatus[] = [
	"active",
	"restricted",
	"expired",
	"revoked",
];

/** "2 active · 1 restricted entrustments" — null when there are none. */
export function entrustmentSummary(
	entrustments: readonly { effectiveStatus: EntrustmentEffectiveStatus }[],
): string | null {
	if (entrustments.length === 0) return null;
	const parts: string[] = [];
	for (const status of ENTRUSTMENT_STATUS_ORDER) {
		const count = entrustments.filter(
			(entrustment) => entrustment.effectiveStatus === status,
		).length;
		if (count > 0) parts.push(`${formatCount(count)} ${status}`);
	}
	const noun = entrustments.length === 1 ? "entrustment" : "entrustments";
	return `${parts.join(" · ")} ${noun}`;
}

/**
 * Structural subset of `TediOperationsSummary` the detail panel reads — the
 * full contract row assigns to it, and tests can build small fixtures.
 */
export interface TediOperationsDetail {
	delegationProfile: {
		activeRole: { roleName: string; careerStage: string } | null;
		entrustments: readonly { effectiveStatus: EntrustmentEffectiveStatus }[];
	};
	activeTasks: readonly {
		id: string;
		title: string;
		status: string;
		blocker: string | null;
	}[];
	objectives: readonly { id: string; status: string }[];
	completedObjectives: number;
	muscleCount: number;
	pulse: {
		decisionsLast24h: number;
		factsLearnedLast24h: number;
		lastRationale: { action: string; createdAt: string } | null;
	};
	approvalFatigueSignal: {
		type: string;
		evidence: readonly string[];
	} | null;
}

// ---------------------------------------------------------------------------
// Pure presentational subcomponents (exported for tests)
// ---------------------------------------------------------------------------

const CHIP_VARIANTS: Record<ChipTone, BadgeVariant> = {
	neutral: "outline",
	active: "info",
	blocked: "destructive",
	done: "success",
	warn: "warning",
};

export function TeamChip({
	tone,
	children,
}: {
	tone: ChipTone;
	children: ReactNode;
}) {
	return (
		<Badge variant={CHIP_VARIANTS[tone]} data-tone={tone}>
			{children}
		</Badge>
	);
}

/** 36px roster avatar tile: image URL → emoji avatar → monogram initial. */
export function TediAvatar({
	tedi,
}: {
	tedi: Pick<TediType, "avatar" | "displayName" | "name" | "slug">;
}) {
	const avatar = tedi.avatar;
	const kind = avatarKind(avatar);
	if (kind === "image" && avatar) {
		return (
			<img
				src={avatar}
				alt=""
				className="size-9 shrink-0 rounded-lg border border-kumo-hairline object-cover"
			/>
		);
	}
	return (
		<Text
			as="span"
			role="body"
			tone="secondary"
			weight="medium"
			className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-kumo-hairline bg-kumo-elevated"
		>
			{kind === "emoji" && avatar ? avatar.trim() : tediMonogram(tedi)}
		</Text>
	);
}

/** How many active tasks render in the detail panel before truncating. */
export const TASKS_PREVIEW_LIMIT = 5;

export function TediDetailPanel({ detail }: { detail: TediOperationsDetail }) {
	const activeRole = detail.delegationProfile.activeRole;
	const entrustments = entrustmentSummary(
		detail.delegationProfile.entrustments,
	);
	const blockedTasks = detail.activeTasks.filter(
		(task) => task.blocker !== null,
	).length;
	const shownTasks = detail.activeTasks.slice(0, TASKS_PREVIEW_LIMIT);
	const pulse = detail.pulse;
	return (
		<Surface className="grid gap-3 px-4 py-3 sm:ml-12">
			<div className="grid gap-1">
				<Text
					as="span"
					className="text-kumo-subtle uppercase tracking-[0.8px]"
					role="caption"
					weight="semibold"
				>
					Delegation
				</Text>
				<Text as="span" role="label" className="text-kumo-default">
					{activeRole
						? `${activeRole.roleName} · ${sentenceCase(activeRole.careerStage)}`
						: "No active role"}
				</Text>
				<Text as="span" role="label" tone="secondary">
					{entrustments ??
						"No entrustments — observe-only; titles never imply authority."}
				</Text>
			</div>

			<div className="grid gap-1">
				<Text
					as="span"
					className="text-kumo-subtle uppercase tracking-[0.8px]"
					role="caption"
					weight="semibold"
				>
					Workload
				</Text>
				<Text as="span" role="label" className="text-kumo-default">
					{formatCount(detail.activeTasks.length)}{" "}
					{detail.activeTasks.length === 1 ? "active task" : "active tasks"}
					{blockedTasks > 0 ? ` · ${formatCount(blockedTasks)} blocked` : ""}
					{" · "}
					{formatCount(detail.objectives.length)} current{" "}
					{detail.objectives.length === 1 ? "objective" : "objectives"} ·{" "}
					{formatCount(detail.completedObjectives)} completed
				</Text>
				{shownTasks.length > 0 && (
					<ul className="m-0 grid list-none gap-0.5 p-0">
						{shownTasks.map((task) => (
							<Text
								key={task.id}
								as="li"
								role="label"
								tone="secondary"
								className="truncate"
							>
								<span className="text-kumo-default">{task.title}</span> ·{" "}
								{humanize(task.status)}
								{task.blocker ? (
									<span className="text-kumo-danger">
										{" "}
										· blocked: {task.blocker}
									</span>
								) : null}
							</Text>
						))}
					</ul>
				)}
				{detail.activeTasks.length > TASKS_PREVIEW_LIMIT && (
					<Text as="span" role="label" tone="secondary">
						+{formatCount(detail.activeTasks.length - TASKS_PREVIEW_LIMIT)} more
						active tasks
					</Text>
				)}
			</div>

			<div className="grid gap-1">
				<Text
					as="span"
					className="text-kumo-subtle uppercase tracking-[0.8px]"
					role="caption"
					weight="semibold"
				>
					Pulse
				</Text>
				<Text as="span" role="label" tone="secondary">
					{formatCount(pulse.decisionsLast24h)}{" "}
					{pulse.decisionsLast24h === 1 ? "decision" : "decisions"} ·{" "}
					{formatCount(pulse.factsLearnedLast24h)}{" "}
					{pulse.factsLearnedLast24h === 1 ? "fact" : "facts"} learned in the
					last 24h · {formatCount(detail.muscleCount)}{" "}
					{detail.muscleCount === 1 ? "muscle memory" : "muscle memories"}
				</Text>
				{pulse.lastRationale ? (
					<Text as="span" role="label" tone="secondary" className="truncate">
						Last decision:{" "}
						<span className="text-kumo-default">
							{pulse.lastRationale.action}
						</span>{" "}
						<time
							dateTime={pulse.lastRationale.createdAt}
							title={absoluteTime(pulse.lastRationale.createdAt)}
						>
							{relativeTime(pulse.lastRationale.createdAt)}
						</time>
					</Text>
				) : null}
				{detail.approvalFatigueSignal ? (
					<Text as="span" role="label" tone="warning">
						Approval fatigue signal:{" "}
						{humanize(detail.approvalFatigueSignal.type)}
					</Text>
				) : null}
			</div>
		</Surface>
	);
}

/**
 * The operations read silently drops archived/paused/errored/provisioning
 * tedis — absence is exclusion, not failure, unless the whole read failed.
 */
export function TediDetailUnavailable({
	readFailed = false,
}: {
	readFailed?: boolean;
}) {
	return (
		<Surface
			className="m-0 border-dashed px-4 py-3 text-kumo-subtle text-xs sm:ml-12"
			render={<p />}
		>
			{readFailed
				? "Operations detail is unavailable right now — the delegation and workload read failed."
				: "No operations summary for this tedi — paused, provisioning, errored, or archived tedis are excluded from the operations read."}
		</Surface>
	);
}

/** Injectable-link seam for tests that render without a RouterProvider. */
export type TediDetailLinkProps = {
	to: "/team/$tediId";
	params: { tediId: string };
	className?: string;
	"aria-label"?: string;
	children?: ReactNode;
};
const DefaultTediDetailLink: ComponentType<TediDetailLinkProps> = OsRouterLink;

/**
 * The link into a tedi's full evidence page. A sibling of the roster row's
 * expand button, never nested inside it — an anchor inside a button is invalid
 * HTML and swallows one of the two activations.
 */
export function TediDetailLink({
	tediId,
	LinkComponent = DefaultTediDetailLink,
	compact = false,
	tediName,
}: {
	tediId: string;
	LinkComponent?: ComponentType<TediDetailLinkProps>;
	compact?: boolean;
	tediName?: string;
}) {
	return (
		<LinkComponent
			to="/team/$tediId"
			params={{ tediId }}
			aria-label={compact && tediName ? `Open ${tediName} details` : undefined}
			className={
				compact
					? "inline-flex min-h-9 shrink-0 items-center gap-1 rounded-lg px-3 py-1 text-kumo-default type-tedix-control no-underline ring ring-kumo-line transition-colors duration-tedix-standard hover:bg-kumo-tint motion-reduce:transition-none coarse:min-h-11"
					: "inline-flex w-fit items-center gap-1 rounded-lg px-3 py-1 text-kumo-subtle text-xs no-underline transition-colors duration-tedix-standard hover:text-kumo-strong motion-reduce:transition-none coarse:min-h-11 coarse:py-2 sm:ml-12"
			}
		>
			{compact ? "Open details" : "Authority, telemetry, and learning evidence"}
			<ArrowRight size={12} />
		</LinkComponent>
	);
}

export function TediRow({
	tedi,
	summary,
	summaryPending = false,
	summaryFailed = false,
	expanded = false,
	onToggle,
	LinkComponent,
}: {
	tedi: TediType;
	summary?: TediOperationsDetail;
	summaryPending?: boolean;
	summaryFailed?: boolean;
	expanded?: boolean;
	onToggle?: () => void;
	LinkComponent?: ComponentType<TediDetailLinkProps>;
}) {
	const hint = roleHint(tedi, summary?.delegationProfile.activeRole);
	const seenAt = tedi.lastActivityAt ?? tedi.lastSeenAt;
	const runtime =
		tedi.runtimeStatus && tedi.runtimeStatus !== "unknown"
			? sentenceCase(tedi.runtimeStatus)
			: null;
	return (
		<li className="grid gap-1">
			<div className="flex min-w-0 flex-col sm:flex-row sm:items-center">
				<Button
					aria-expanded={expanded}
					aria-label={`${expanded ? "Collapse" : "Expand"} ${tedi.displayName ?? tedi.name} details`}
					onClick={onToggle}
					className="min-h-16 w-full min-w-0 items-start gap-3 rounded-none px-3 py-2.5 text-left sm:flex-1"
					multiline
					variant="ghost"
				>
					<TediAvatar tedi={tedi} />
					<span className="flex min-w-0 flex-1 flex-col gap-1">
						<span className="flex flex-wrap items-center gap-1.5">
							<Text
								as="strong"
								role="body"
								tone="strong"
								weight="medium"
								className="min-w-0 truncate"
							>
								{tedi.displayName ?? tedi.name}
							</Text>
							<TeamChip tone={tediStatusTone(tedi.status)}>
								{sentenceCase(tediStatusLabel(tedi.status))}
							</TeamChip>
							{tedi.scope === "personal" && (
								<TeamChip tone="neutral">Personal</TeamChip>
							)}
						</span>
						<Text as="span" role="label" tone="secondary" className="truncate">
							{tedi.slug}
							{hint ? ` · ${hint}` : ""}
						</Text>
						<Text as="span" role="label" tone="secondary">
							{runtime ?? "No runtime signal"}
							{seenAt ? (
								<>
									{" · active "}
									<time dateTime={seenAt} title={absoluteTime(seenAt)}>
										{relativeTime(seenAt)}
									</time>
								</>
							) : (
								" · no recorded activity"
							)}
						</Text>
					</span>
					<span className="self-center text-kumo-subtle" aria-hidden>
						{expanded ? <CaretDown size={14} /> : <CaretRight size={14} />}
					</span>
				</Button>
				<div className="self-end px-3 pb-2 sm:self-center sm:p-0 sm:pr-3">
					<TediDetailLink
						tediId={tedi.id}
						tediName={tedi.displayName ?? tedi.name}
						LinkComponent={LinkComponent}
						compact
					/>
				</div>
			</div>
			{expanded &&
				(summary ? (
					<TediDetailPanel detail={summary} />
				) : summaryPending ? (
					<ListSkeleton rows={1} rowClassName="h-24" />
				) : (
					<TediDetailUnavailable readFailed={summaryFailed} />
				))}
		</li>
	);
}

export function TeamEmpty() {
	return (
		<Empty appearance="quiet">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<UsersThree size={20} />
				</EmptyMedia>
				<EmptyTitle>No tedis yet</EmptyTitle>
				<EmptyDescription>
					Tedis are your organization&apos;s durable digital workers. Launch one
					here or through the Tedix CLI — the same governed roster renders here.
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

// The contract's list default is 50, but the handler defaults to 20 when the
// input is omitted — always pass limit/offset explicitly (survey pitfall).
// Exported so the per-tedi detail route reads under the SAME generated key +
// limit and serves its roster row from cache instead of a second roster read.

export function TeamPage({
	tab = "tedis",
	page = 1,
	onTabChange,
	onPageChange,
}: {
	/** URL-validated tab from the route's search — never component state. */
	tab?: TeamTab;
	/** 1-based roster or members page from the route's search. */
	page?: number;
	onTabChange?: (tab: TeamTab) => void;
	onPageChange?: (page: number) => void;
}) {
	const surface = getOsSurface("team");

	return (
		<Page width="lg">
			<PageHeader>
				<PageHeading>
					<PageTitle>{surface.label}</PageTitle>
					<PageDescription>{surface.description}</PageDescription>
				</PageHeading>
				{tab === "tedis" ? (
					<PageActions>
						<Button
							render={
								<OsRouterLink
									to="/team/new"
									search={{ channel: "telegram", mode: "basic" }}
								/>
							}
						>
							Launch Tedi
						</Button>
					</PageActions>
				) : null}
			</PageHeader>

			<Tabs
				value={tab}
				onValueChange={(value) => {
					const next = TEAM_TABS.find((entry) => entry.id === value);
					if (next) onTabChange?.(next.id);
				}}
			>
				<TabsList aria-label="Team sections" variant="line">
					{TEAM_TABS.map((entry) => (
						<TabsTrigger key={entry.id} value={entry.id}>
							{entry.label}
						</TabsTrigger>
					))}
				</TabsList>
				<TabsContent value={tab}>
					{tab === "members" ? (
						<TeamMembersPanel
							page={page}
							onPageChange={(nextPage) => onPageChange?.(nextPage)}
						/>
					) : tab === "roles" ? (
						<TeamRolesPanel />
					) : (
						<TediRosterPanel page={page} onPageChange={onPageChange} />
					)}
				</TabsContent>
			</Tabs>
		</Page>
	);
}

/** The tedi roster — the surface /team has always rendered — as the first tab. */
export function TediRosterPanel({
	page = 1,
	onPageChange,
}: {
	page?: number;
	onPageChange?: (page: number) => void;
}) {
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const [debouncedSearch, setDebouncedSearch] = useState("");
	const [status, setStatus] = useState<TediRosterStatusFilter>("all");
	useEffect(() => {
		const timeout = setTimeout(() => setDebouncedSearch(search.trim()), 250);
		return () => clearTimeout(timeout);
	}, [search]);

	const tedis = useQuery(
		tediRosterQueryOptions(TEDI_ROSTER_LIMIT, {
			offset: (page - 1) * TEDI_ROSTER_LIMIT,
			...(debouncedSearch ? { search: debouncedSearch } : {}),
			...(status !== "all" ? { status } : {}),
		}),
	);
	const total = tedis.data?.pagination.total ?? 0;
	useEffect(() => {
		if (tedis.data && page > 1 && (page - 1) * TEDI_ROSTER_LIMIT >= total) {
			onPageChange?.(1);
		}
	}, [tedis.data, onPageChange, page, total]);

	const roster = tedis.data?.data ?? [];
	// Request one bounded read for this page's eligible rows. The operations
	// endpoint excludes archived, paused, errored and provisioning tedis; never
	// pass those ids because it rejects an excluded id rather than omitting it.
	const summaryIds = roster
		.filter(
			(tedi) =>
				tedi.runtimeState !== "archived" &&
				!["paused", "error", "provisioning"].includes(tedi.status ?? ""),
		)
		.map((tedi) => tedi.id);
	const summaries = useQuery({
		...tediOperationsSummariesQueryOptions(summaryIds),
		enabled: summaryIds.length > 0,
		staleTime: 60_000,
	});

	const summariesByTediId = useMemo(() => {
		const map: Record<string, TediOperationsSummary> = {};
		for (const summary of summaries.data?.data ?? []) {
			map[summary.tediId] = summary;
		}
		return map;
	}, [summaries.data]);

	const hasFilters = Boolean(search.trim()) || status !== "all";

	return (
		<div className="grid min-w-0 gap-5">
			<RuntimeGateNotice />

			<PageSection>
				<PageToolbar>
					<SearchInput
						aria-label="Search digital workers"
						placeholder="Search by name, slug, or role"
						maxLength={200}
						containerClassName="w-full lg:max-w-md"
						value={search}
						onChange={(event) => {
							setSearch(event.target.value);
							setExpandedId(null);
							onPageChange?.(1);
						}}
						trailing={
							<span className="whitespace-nowrap text-kumo-subtle type-tedix-label">
								{tedis.isPending
									? "Loading…"
									: `${total} ${total === 1 ? "result" : "results"}`}
							</span>
						}
					/>
					<Select
						value={status}
						onValueChange={(value) => {
							setStatus(value as TediRosterStatusFilter);
							setExpandedId(null);
							onPageChange?.(1);
						}}
					>
						<SelectTrigger
							aria-label="Filter digital worker status"
							className="w-full lg:w-44"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">All statuses</SelectItem>
							<SelectItem value="active">Active</SelectItem>
							<SelectItem value="provisioning">Provisioning</SelectItem>
							<SelectItem value="paused">Paused</SelectItem>
							<SelectItem value="error">Error</SelectItem>
							<SelectItem value="unknown">Unknown</SelectItem>
						</SelectContent>
					</Select>
				</PageToolbar>
				{tedis.isPending && <ListSkeleton />}
				{tedis.isError && (
					<Alert variant="destructive">
						<AlertTitle>The tedi roster is unavailable</AlertTitle>
						<AlertDescription>
							{(tedis.error as Error).message}
						</AlertDescription>
					</Alert>
				)}
				{tedis.data && total === 0 && !hasFilters && <TeamEmpty />}
				{tedis.data && total === 0 && hasFilters ? (
					<Empty
						appearance="quiet"
						icon={<MagnifyingGlass size={20} />}
						title="No digital workers match"
						description="Try another name, slug, role, or status."
						contents={
							<Button
								variant="outline"
								onClick={() => {
									setSearch("");
									setStatus("all");
									onPageChange?.(1);
								}}
							>
								Clear filters
							</Button>
						}
					/>
				) : null}
				{tedis.data && roster.length > 0 && (
					<>
						<Collection>
							{roster.map((tedi) => (
								<TediRow
									key={tedi.id}
									tedi={tedi}
									summary={summariesByTediId[tedi.id]}
									summaryPending={summaryIds.length > 0 && summaries.isPending}
									summaryFailed={summaries.isError}
									expanded={expandedId === tedi.id}
									onToggle={() =>
										setExpandedId((current) =>
											current === tedi.id ? null : tedi.id,
										)
									}
								/>
							))}
						</Collection>
						<div
							aria-live="polite"
							className="flex flex-col items-center justify-between gap-2 sm:flex-row"
						>
							<Text as="p" role="label" tone="secondary">
								Showing {formatCount((page - 1) * TEDI_ROSTER_LIMIT + 1)}–
								{formatCount((page - 1) * TEDI_ROSTER_LIMIT + roster.length)} of{" "}
								{formatCount(total)} tedis
							</Text>
							<div className="flex w-full gap-2 sm:w-auto">
								<Button
									className="flex-1 sm:flex-none"
									disabled={page === 1}
									onClick={() => onPageChange?.(page - 1)}
									variant="outline"
								>
									Previous page
								</Button>
								<Button
									className="flex-1 sm:flex-none"
									disabled={!tedis.data.pagination.hasMore}
									onClick={() => onPageChange?.(page + 1)}
									variant="outline"
								>
									Next page
								</Button>
							</div>
						</div>
					</>
				)}
				{summaries.isError && roster.length > 0 && (
					<Text role="body" tone="secondary" className="m-0">
						Operations detail is unavailable right now — tedis are listed
						without their delegation and workload.
					</Text>
				)}
			</PageSection>
		</div>
	);
}

/** The roster only needs to interrupt the operator when tedis cannot run. */
function RuntimeGateNotice() {
	const runtime = useQuery({
		...runtimeEntitlementsQueryOptions(),
		staleTime: 60_000,
	});
	if (runtime.isError) {
		return (
			<Alert variant="warning">
				<AlertTitle>Runtime status unavailable</AlertTitle>
				<AlertDescription>
					Inference access could not be checked.{" "}
					<OsRouterLink to="/compute">View Compute</OsRouterLink>
				</AlertDescription>
			</Alert>
		);
	}
	const plan = runtime.data?.entitlement;
	if (!runtime.data || plan?.active) return null;

	return (
		<Alert variant="destructive">
			<AlertTitle>Tedis cannot run</AlertTitle>
			<AlertDescription>
				{plan
					? `${plan.planName} is inactive. Runtime inference is blocked for this workspace.`
					: "This organization has no runtime plan. Runtime inference is blocked for this workspace."}{" "}
				<OsRouterLink to="/admin/billing">Review billing</OsRouterLink>
			</AlertDescription>
		</Alert>
	);
}
