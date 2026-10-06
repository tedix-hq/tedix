import { CapabilityNavigation } from "@/components/capability-navigation";
import {
	ArrowRight,
	BookOpenText,
	FlowArrow,
	FolderOpen,
	UploadSimple,
} from "@phosphor-icons/react";
// schemas/cognitive is not in the api-contract export map; the cognitive
// contract re-exports these types on an exported path.
import type {
	SkillEntry,
	SkillLifecycleState,
	SkillSchedule,
} from "@tedix/api-contract/contracts/cognitive";
import type {
	WorkflowDefinition,
	WorkflowDefinitionDriftStatus,
	WorkflowDefinitionHealth,
	WorkflowDefinitionHealthStatus,
} from "@tedix/api-contract/contracts/workflows";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { getOsSurface } from "@/lib/os-navigation";
import type { ComponentType, ReactNode } from "react";
import { useMemo, useState } from "react";
import { Button } from "@/components/kumo/button";
import { SkillBundleImportDialog } from "@/components/skill-bundle-import-dialog";
import { useCanManageTedis } from "@/lib/tedi-permissions";
import { SearchInput } from "@/components/kumo/search-input";
import { Pagination } from "@/components/kumo/pagination";
import { KumoTabs } from "@/components/kumo/tabs";
import { type CardRunLinkProps, RunLinkChip } from "@/components/chat-cards";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import { IconFrame } from "@/components/kumo/icon-frame";
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
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import { ListSkeleton } from "@/components/list-skeleton";
import { useSkillsWebMcpTools } from "@/components/skills-webmcp-tools";
import { Text } from "@/components/kumo/text";
import { TriggersPanel } from "@/components/triggers-panel";
import { formatCount, humanize, sentenceCase } from "@/lib/format";
import {
	SKILL_SCHEDULES_LIMIT,
	skillCatalogQueryOptions,
	skillSchedulesQueryOptions,
	workflowDefinitionHealthQueryOptions,
	workflowDefinitionsQueryOptions,
} from "@/lib/os-query-options";
import { absoluteTime, relativeTime } from "@/lib/time";
import { useTediNames } from "@/lib/use-tedi-names";
import {
	SKILLS_PAGE_SIZE,
	SKILLS_SECTIONS,
	type SkillsSearch,
} from "@/lib/skills-search";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export type ChipTone = "neutral" | "active" | "blocked" | "done" | "warn";

export function lifecycleTone(
	state: SkillLifecycleState | null | undefined,
): ChipTone {
	switch (state) {
		case "active":
			return "active";
		case "proven":
		case "crystallized":
			return "done";
		case "stale":
			return "warn";
		case "archived":
			return "blocked";
		default:
			// draft, plus legacy rows with no lifecycle yet.
			return "neutral";
	}
}

/**
 * Executable = the skill backs a `dynamic_skill` workflow definition. The
 * summary catalog listing nulls `files`, so `scripts/workflow.ts` presence
 * cannot be read there — the honest source is the workflow-definition
 * catalog, which projects exactly those skills as `dynamic_skill`.
 */
export function executableSkillIds(
	definitions: readonly WorkflowDefinition[],
): Set<string> {
	const ids = new Set<string>();
	for (const definition of definitions) {
		if (definition.kind === "dynamic_skill") ids.add(definition.skillId);
	}
	return ids;
}

export function skillOwnerLabel(
	skill: Pick<SkillEntry, "tediId">,
	tediNames: Record<string, string> = {},
): string {
	if (!skill.tediId) return "org baseline";
	return tediNames[skill.tediId] ?? "a tedi";
}

/** Usage evidence from the catalog counters — honest "no runs" over a fake 0%. */
export function evidenceLabel(
	skill: Pick<SkillEntry, "successCount" | "failureCount">,
): string {
	const total = skill.successCount + skill.failureCount;
	if (total === 0) return "no recorded uses";
	const parts = [
		`${formatCount(skill.successCount)} ${
			skill.successCount === 1 ? "success" : "successes"
		}`,
	];
	if (skill.failureCount > 0) {
		parts.push(
			`${formatCount(skill.failureCount)} ${
				skill.failureCount === 1 ? "failure" : "failures"
			}`,
		);
	}
	return parts.join(" · ");
}

export type SkillCatalogNode = {
	name: string;
	path: string | null;
	skills: SkillEntry[];
	children: SkillCatalogNode[];
};

/**
 * Project the current server page into a stable catalog hierarchy. Folder
 * paths are presentation metadata only; the skill slug remains untouched.
 */
export function buildSkillCatalogTree(
	entries: readonly SkillEntry[],
): SkillCatalogNode {
	const root: SkillCatalogNode = {
		name: "Catalog root",
		path: null,
		skills: [],
		children: [],
	};
	const byPath = new Map<string, SkillCatalogNode>();
	for (const skill of entries) {
		const path = skill.folderPath ?? null;
		if (!path) {
			root.skills.push(skill);
			continue;
		}
		let parent = root;
		let currentPath = "";
		for (const segment of path.split("/")) {
			currentPath = currentPath ? `${currentPath}/${segment}` : segment;
			let node = byPath.get(currentPath);
			if (!node) {
				node = { name: segment, path: currentPath, skills: [], children: [] };
				byPath.set(currentPath, node);
				parent.children.push(node);
			}
			parent = node;
		}
		parent.skills.push(skill);
	}
	const sort = (node: SkillCatalogNode) => {
		node.skills.sort((left, right) => left.title.localeCompare(right.title));
		node.children.sort((left, right) => left.name.localeCompare(right.name));
		for (const child of node.children) sort(child);
	};
	sort(root);
	return root;
}

export function healthTone(status: WorkflowDefinitionHealthStatus): ChipTone {
	switch (status) {
		case "healthy":
			return "done";
		case "active":
			return "active";
		case "attention":
			return "warn";
		case "degraded":
			return "blocked";
		default:
			// dormant and unknown are neutral facts, not alarms.
			return "neutral";
	}
}

/** Missing history is explicitly not failure — `unobserved` stays neutral. */
export function driftTone(status: WorkflowDefinitionDriftStatus): ChipTone {
	switch (status) {
		case "in_sync":
			return "done";
		case "unobserved":
		case "not_applicable":
			return "neutral";
		case "missing_execution_surface":
			return "blocked";
		default:
			// unexecuted_revision, unknown_revision, revision_mismatch
			return "warn";
	}
}

export function workflowMetaLabel(
	definition: WorkflowDefinition,
	tediNames: Record<string, string> = {},
): string {
	if (definition.kind === "static_platform") {
		return `${humanize(definition.workflowType)} · ${definition.binding}`;
	}
	const owner = definition.tediId
		? (tediNames[definition.tediId] ?? "a tedi")
		: "org baseline";
	return `${definition.skillSlug ?? definition.skillId} · rev ${
		definition.skillRevision
	} · ${owner}`;
}

/**
 * One chip summarizing a workflow's manifest-owned schedules: enabled beats
 * disabled, and a lastError/budget block on an enabled schedule warns.
 */
export function scheduleSummary(
	schedules: readonly SkillSchedule[],
): { tone: ChipTone; label: string } | null {
	if (schedules.length === 0) return null;
	const enabled = schedules.filter((schedule) => schedule.enabled);
	if (enabled.length === 0) {
		return {
			tone: "neutral",
			label:
				schedules.length === 1
					? "schedule off"
					: `${schedules.length} schedules off`,
		};
	}
	const failing = enabled.some(
		(schedule) =>
			schedule.lastError != null || schedule.lastBudgetBlockedAt != null,
	);
	const first = enabled[0];
	const label =
		enabled.length === 1 && first
			? `scheduled · ${first.cron}`
			: `${enabled.length} schedules`;
	return { tone: failing ? "warn" : "active", label };
}

// ---------------------------------------------------------------------------
// Pure presentational subcomponents (exported for tests)
// ---------------------------------------------------------------------------

/** Chip tone → tinted Kumo Badge variant — same accent discipline as Apps. */
const CHIP_VARIANTS: Record<ChipTone, BadgeVariant> = {
	neutral: "outline",
	active: "info",
	blocked: "destructive",
	done: "success",
	warn: "warning",
};

export function SkillChip({
	tone,
	children,
}: {
	tone: ChipTone;
	children: ReactNode;
}) {
	// Sentence-case is applied by callers via sentenceCase — no CSS capitalize.
	return (
		<Badge variant={CHIP_VARIANTS[tone]} data-tone={tone}>
			{children}
		</Badge>
	);
}

export function SkillRow({
	skill,
	executable,
	tediNames = {},
}: {
	skill: SkillEntry;
	/** undefined = the workflow catalog has not resolved; render no execution chip. */
	executable?: boolean;
	tediNames?: Record<string, string>;
}) {
	const blurb = skill.summary ?? skill.description;
	const owner = skillOwnerLabel(skill, tediNames);
	const evidence = evidenceLabel(skill);
	const lastUsed = skill.lastUsedAt ? (
		<>
			{" · last used "}
			<time dateTime={skill.lastUsedAt} title={absoluteTime(skill.lastUsedAt)}>
				{relativeTime(skill.lastUsedAt)}
			</time>
		</>
	) : null;
	return (
		<li className="min-h-16 min-w-0 px-3 py-2.5 max-sm:min-h-0 max-sm:py-3">
			<Link
				to="/skills/$skillId"
				params={{ skillId: skill.id }}
				className="flex min-w-0 items-start gap-3 rounded-lg text-inherit no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-kumo-focus"
			>
				<IconFrame aria-hidden>
					<BookOpenText size={18} />
				</IconFrame>
				<span className="grid min-w-0 flex-1 gap-1">
					<span className="flex min-w-0 items-center gap-2">
						<Text
							as="strong"
							role="body"
							weight="medium"
							className="min-w-0 truncate tracking-[-0.2px]"
						>
							{skill.title}
						</Text>
						{skill.paceLayer ? (
							<Text
								as="span"
								role="caption"
								tone="secondary"
								className="max-sm:hidden"
							>
								{humanize(skill.paceLayer)} layer
							</Text>
						) : null}
					</span>
					{skill.lifecycleState || executable !== undefined ? (
						<span className="flex min-w-0 flex-wrap items-center gap-1.5">
							{skill.lifecycleState ? (
								<SkillChip tone={lifecycleTone(skill.lifecycleState)}>
									{sentenceCase(skill.lifecycleState)}
								</SkillChip>
							) : null}
							{executable !== undefined ? (
								<SkillChip tone={executable ? "active" : "neutral"}>
									{executable ? "Executable" : "Instructions"}
								</SkillChip>
							) : null}
						</span>
					) : null}
					<Text
						as="span"
						role="label"
						tone="secondary"
						className="truncate tracking-[-0.1px] sm:hidden"
						data-mobile-summary
					>
						{owner} · {evidence}
						{lastUsed}
					</Text>
					<Text
						as="span"
						role="label"
						tone="secondary"
						className="tracking-[-0.1px] max-sm:hidden"
						data-desktop-summary
					>
						{skill.slug ?? skill.id.slice(0, 8)} · rev {skill.revision} ·{" "}
						{owner} · {evidence}
						{lastUsed}
					</Text>
					{blurb ? (
						<Text
							as="span"
							role="label"
							tone="secondary"
							className="truncate tracking-[-0.1px] max-sm:hidden"
						>
							{blurb}
						</Text>
					) : null}
				</span>
				<span className="inline-flex shrink-0 items-center gap-1 self-center text-kumo-default type-tedix-control">
					Open <ArrowRight size={14} aria-hidden />
				</span>
			</Link>
		</li>
	);
}

export function SkillsEmpty() {
	return (
		<Empty appearance="quiet">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<BookOpenText size={20} />
				</EmptyMedia>
				<EmptyTitle>No skills yet</EmptyTitle>
				<EmptyDescription>
					Skills are recorded by tedis as they learn, or authored through the
					Skill Workshop — the same governed catalog renders here.
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}

export function SkillCatalogTree({
	entries,
	executableIds,
	executableResolved,
	tediNames,
}: {
	entries: readonly SkillEntry[];
	executableIds: ReadonlySet<string>;
	executableResolved: boolean;
	tediNames: Record<string, string>;
}) {
	const root = useMemo(() => buildSkillCatalogTree(entries), [entries]);
	const renderNode = (node: SkillCatalogNode, depth: number): ReactNode => (
		<section key={node.path ?? "root"} data-folder-path={node.path ?? ""}>
			{node.path ? (
				<SectionHeader className={depth > 1 ? "pl-6" : undefined}>
					<SectionHeading>
						<SectionTitle className="flex items-center gap-2 type-tedix-body">
							<FolderOpen size={16} aria-hidden /> {humanize(node.name)}
						</SectionTitle>
						<SectionDescription>{node.path}</SectionDescription>
					</SectionHeading>
				</SectionHeader>
			) : null}
			{node.skills.length > 0 ? (
				<Collection
					className={
						node.path
							? "ml-6 [&>li]:transition-colors [&>li]:duration-tedix-standard [&>li]:hover:bg-kumo-tint [&>li]:motion-reduce:transition-none"
							: "[&>li]:transition-colors [&>li]:duration-tedix-standard [&>li]:hover:bg-kumo-tint [&>li]:motion-reduce:transition-none"
					}
				>
					{node.skills.map((skill) => (
						<SkillRow
							key={skill.id}
							skill={skill}
							executable={
								executableResolved ? executableIds.has(skill.id) : undefined
							}
							tediNames={tediNames}
						/>
					))}
				</Collection>
			) : null}
			{node.children.map((child) => renderNode(child, depth + 1))}
		</section>
	);
	return <>{renderNode(root, 0)}</>;
}

export function WorkflowRow({
	definition,
	health,
	schedules = [],
	tediNames = {},
	LinkComponent,
}: {
	definition: WorkflowDefinition;
	/** undefined = the health read has not resolved; render no health chips. */
	health?: WorkflowDefinitionHealth;
	schedules?: readonly SkillSchedule[];
	tediNames?: Record<string, string>;
	LinkComponent?: ComponentType<CardRunLinkProps>;
}) {
	const schedule = scheduleSummary(schedules);
	const latestRun = health?.latestRun ?? null;
	const latestRunAt = latestRun?.completedAt ?? latestRun?.startedAt ?? null;
	return (
		<li className="flex min-h-16 min-w-0 items-start gap-3 px-3 py-2.5">
			<IconFrame>
				<FlowArrow size={18} />
			</IconFrame>
			<span className="grid min-w-0 gap-1">
				<span className="flex flex-wrap items-center gap-1.5">
					<Text
						as="strong"
						role="body"
						weight="medium"
						className="min-w-0 truncate tracking-[-0.2px]"
					>
						{definition.title}
					</Text>
					<SkillChip tone="neutral">
						{definition.kind === "static_platform" ? "Platform" : "Skill"}
					</SkillChip>
					{health ? (
						<SkillChip tone={healthTone(health.healthStatus)}>
							{sentenceCase(health.healthStatus)}
						</SkillChip>
					) : null}
					{health && health.driftStatus !== "not_applicable" ? (
						<SkillChip tone={driftTone(health.driftStatus)}>
							{sentenceCase(health.driftStatus)}
						</SkillChip>
					) : null}
					{schedule ? (
						<SkillChip tone={schedule.tone}>
							{sentenceCase(schedule.label)}
						</SkillChip>
					) : null}
				</span>
				<Text
					as="span"
					role="label"
					tone="secondary"
					className="flex flex-wrap items-center gap-1.5 tracking-[-0.1px]"
				>
					<span className="min-w-0 truncate">
						{workflowMetaLabel(definition, tediNames)}
						{definition.triggers.length > 0
							? ` · ${definition.triggers.length} ${
									definition.triggers.length === 1 ? "trigger" : "triggers"
								}`
							: ""}
						{latestRun ? (
							<>
								{" · last run "}
								{humanize(latestRun.status)}
								{latestRunAt ? (
									<>
										{" "}
										<time
											dateTime={latestRunAt}
											title={absoluteTime(latestRunAt)}
										>
											{relativeTime(latestRunAt)}
										</time>
									</>
								) : null}
							</>
						) : null}
					</span>
					{/* Run history lives on Activity — skill runs are the runs that
					    inspect there, so only dynamic_skill evidence links. */}
					{latestRun && definition.kind === "dynamic_skill" ? (
						<RunLinkChip runId={latestRun.id} LinkComponent={LinkComponent} />
					) : null}
				</Text>
				{definition.description ? (
					<Text
						as="span"
						role="label"
						tone="secondary"
						className="truncate tracking-[-0.1px]"
					>
						{definition.description}
					</Text>
				) : null}
			</span>
		</li>
	);
}

export function WorkflowsEmpty() {
	return (
		<Empty appearance="quiet">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<FlowArrow size={20} />
				</EmptyMedia>
				<EmptyTitle>No automations yet</EmptyTitle>
				<EmptyDescription>
					Executable skills become automations when a tedi records one with a
					script — run history lands in Activity.
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SkillsPage({
	search = { section: "skills", q: "", page: 1 },
	onSearchChange = () => undefined,
}: {
	search?: SkillsSearch;
	onSearchChange?: (patch: Partial<SkillsSearch>) => void;
}) {
	const surface = getOsSurface("skills");
	const canManage = useCanManageTedis();
	const [showImport, setShowImport] = useState(false);
	useSkillsWebMcpTools();
	const input = {
		limit: SKILLS_PAGE_SIZE,
		offset: (search.page - 1) * SKILLS_PAGE_SIZE,
		query: search.q.trim() || undefined,
	};

	const skills = useQuery({
		...skillCatalogQueryOptions(input),
		enabled: search.section === "skills",
	});
	const linkageDefinitions = useQuery({
		...workflowDefinitionsQueryOptions(200),
		enabled: search.section === "skills",
	});
	const definitions = useQuery({
		...workflowDefinitionsQueryOptions(input),
		enabled: search.section === "workflows",
	});
	const health = useQuery({
		...workflowDefinitionHealthQueryOptions(input),
		enabled: search.section === "workflows",
		staleTime: 60_000,
	});
	const schedules = useQuery({
		// Schedule state enriches the displayed definitions and therefore must
		// not inherit the independent definition page offset.
		...skillSchedulesQueryOptions(SKILL_SCHEDULES_LIMIT),
		enabled: search.section === "workflows",
		staleTime: 60_000,
	});
	const tediNames = useTediNames();

	const executableIds = useMemo(
		() => executableSkillIds(linkageDefinitions.data?.definitions ?? []),
		[linkageDefinitions.data],
	);
	const healthById = useMemo(() => {
		const map: Record<string, WorkflowDefinitionHealth> = {};
		for (const entry of health.data?.health ?? [])
			map[entry.definitionId] = entry;
		return map;
	}, [health.data]);
	const schedulesBySkillId = useMemo(() => {
		const map: Record<string, SkillSchedule[]> = {};
		for (const schedule of schedules.data?.schedules ?? []) {
			(map[schedule.skillId] ??= []).push(schedule);
		}
		return map;
	}, [schedules.data]);

	const skillEntries = skills.data?.entries ?? [];
	const workflowDefinitions = definitions.data?.definitions ?? [];
	const searchLabel = `Search ${search.section}`;
	const resultCount =
		search.section === "skills"
			? skills.data?.total
			: search.section === "workflows"
				? definitions.data?.counts.total
				: undefined;

	return (
		<Page width="lg">
			<PageHeader>
				<PageHeading>
					<PageTitle>{surface.label}</PageTitle>
					<PageDescription>
						Reusable instructions, ambient triggers, and durable workflows for
						your digital workers.
					</PageDescription>
				</PageHeading>
				{canManage && search.section === "skills" ? (
					<PageActions>
						<Button variant="outline" onClick={() => setShowImport(true)}>
							<UploadSimple size={14} /> Import bundle
						</Button>
					</PageActions>
				) : null}
			</PageHeader>
			<CapabilityNavigation active="skills" />
			<KumoTabs
				aria-label="Skills sections"
				value={search.section}
				onValueChange={(section) =>
					onSearchChange({
						section: section as SkillsSearch["section"],
						page: 1,
					})
				}
				tabs={SKILLS_SECTIONS.map(({ id, label }) => ({ value: id, label }))}
			/>
			<PageToolbar>
				<SearchInput
					aria-label={searchLabel}
					placeholder={`Search ${search.section} by name or purpose…`}
					containerClassName="w-full lg:max-w-md"
					value={search.q}
					onChange={(event) =>
						onSearchChange({ q: event.target.value, page: 1 })
					}
					trailing={
						resultCount == null ? undefined : (
							<span
								aria-label={`${resultCount} results`}
								className="whitespace-nowrap text-kumo-subtle type-tedix-label"
							>
								{formatCount(resultCount)} results
							</span>
						)
					}
				/>
			</PageToolbar>

			{search.section === "skills" ? (
				<PageSection>
					<SectionHeader>
						<SectionHeading>
							<SectionTitle>Skill catalog</SectionTitle>
							<SectionDescription>
								Open a skill to inspect its instructions, versions and
								schedules.
							</SectionDescription>
						</SectionHeading>
					</SectionHeader>
					{skills.isPending && <ListSkeleton />}
					{skills.isError && (
						<Alert variant="destructive">
							<AlertTitle>Skills are unavailable</AlertTitle>
							<AlertDescription>
								{(skills.error as Error).message}
							</AlertDescription>
						</Alert>
					)}
					{skills.data &&
						skillEntries.length === 0 &&
						(search.q ? <Text>No matching skills.</Text> : <SkillsEmpty />)}
					{skills.data && skillEntries.length > 0 && (
						<>
							<SkillCatalogTree
								entries={skillEntries}
								executableIds={executableIds}
								executableResolved={Boolean(linkageDefinitions.data)}
								tediNames={tediNames}
							/>
							<SkillsPagination
								total={skills.data.total}
								search={search}
								onSearchChange={onSearchChange}
							/>
						</>
					)}
					{linkageDefinitions.isError &&
						skills.data &&
						skillEntries.length > 0 && (
							<Text role="body" tone="secondary" className="m-0">
								Workflow linkage is unavailable right now — skills are listed
								without their execution badges.
							</Text>
						)}
				</PageSection>
			) : null}

			{search.section === "triggers" ? (
				<TriggersPanel
					search={search}
					onPageChange={(page) => onSearchChange({ page })}
				/>
			) : null}

			{search.section === "workflows" ? (
				<PageSection>
					<SectionHeader>
						<SectionHeading>
							<SectionTitle>Automations</SectionTitle>
							<SectionDescription>
								Executable definitions, schedules, health, and recent runs.
							</SectionDescription>
						</SectionHeading>
					</SectionHeader>
					{definitions.isPending && <ListSkeleton />}
					{definitions.isError && (
						<Alert variant="destructive">
							<AlertTitle>Automations are unavailable</AlertTitle>
							<AlertDescription>
								{(definitions.error as Error).message}
							</AlertDescription>
						</Alert>
					)}
					{definitions.data &&
						workflowDefinitions.length === 0 &&
						(search.q ? (
							<Text>No matching automations.</Text>
						) : (
							<WorkflowsEmpty />
						))}
					{definitions.data && workflowDefinitions.length > 0 && (
						<>
							<Collection>
								{workflowDefinitions.map((definition) => (
									<WorkflowRow
										key={definition.id}
										definition={definition}
										health={healthById[definition.id]}
										schedules={
											definition.kind === "dynamic_skill"
												? (schedulesBySkillId[definition.skillId] ?? [])
												: []
										}
										tediNames={tediNames}
									/>
								))}
							</Collection>
							<SkillsPagination
								total={definitions.data.counts.total}
								search={search}
								onSearchChange={onSearchChange}
							/>
						</>
					)}
					{health.isError &&
						definitions.data &&
						workflowDefinitions.length > 0 && (
							<Text role="body" tone="secondary" className="m-0">
								Health evaluation is unavailable right now — definitions are
								listed without health and drift chips.
							</Text>
						)}
				</PageSection>
			) : null}
			{showImport ? (
				<SkillBundleImportDialog onClose={() => setShowImport(false)} />
			) : null}
		</Page>
	);
}

function SkillsPagination({
	total,
	search,
	onSearchChange,
}: {
	total: number;
	search: SkillsSearch;
	onSearchChange: (patch: Partial<SkillsSearch>) => void;
}) {
	if (total <= SKILLS_PAGE_SIZE) return null;
	return (
		<Pagination
			className="flex-col items-stretch gap-3 border-kumo-hairline border-t pt-3 sm:flex-row sm:items-center"
			page={search.page}
			perPage={SKILLS_PAGE_SIZE}
			totalCount={total}
			setPage={(page) => onSearchChange({ page })}
		>
			<Pagination.Info />
			<Pagination.Controls controls="simple" />
		</Pagination>
	);
}
