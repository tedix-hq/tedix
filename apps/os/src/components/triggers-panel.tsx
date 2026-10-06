import { Alarm, Play } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SkillSchedule } from "@tedix/api-contract/contracts/cognitive";
import type {
	WorkflowDefinition,
	WorkflowDefinitionHealth,
} from "@tedix/api-contract/contracts/workflows";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { RunStatusChip } from "@/components/activity-runs";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { IconFrame } from "@/components/kumo/icon-frame";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import { ListSkeleton } from "@/components/list-skeleton";
import { SectionEyebrow } from "@/components/section-eyebrow";
import { Text } from "@/components/kumo/text";
import { Pagination } from "@/components/kumo/pagination";
import { osApi } from "@/lib/api";
import {
	osQueryKeys,
	skillSchedulesQueryOptions,
	workflowDefinitionHealthQueryOptions,
	workflowDefinitionsQueryOptions,
} from "@/lib/os-query-options";
import { absoluteTime, relativeTime } from "@/lib/time";
import { useTediNames } from "@/lib/use-tedi-names";
import { SKILLS_PAGE_SIZE, type SkillsSearch } from "@/lib/skills-search";

const TRIGGER_DEFINITION_LOOKUP_LIMIT = 200;

// Shared with the sibling catalog/workflow sections on the Skills surface —
// identical query keys mean React Query dedupes the reads across sections.

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

const DAY_NAMES = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
] as const;

const DAY_ALIASES: Record<string, number> = {
	sun: 0,
	mon: 1,
	tue: 2,
	wed: 3,
	thu: 4,
	fri: 5,
	sat: 6,
};

function parseDayToken(token: string): number | null {
	if (/^\d+$/.test(token)) {
		const value = Number(token);
		// Both 0 and 7 mean Sunday in cron.
		return value <= 7 ? value % 7 : null;
	}
	const alias = DAY_ALIASES[token.slice(0, 3).toLowerCase()];
	return alias === undefined ? null : alias;
}

function dayName(day: number): string {
	return DAY_NAMES[day] ?? "?";
}

/** "9 AM", "6:30 PM", "12 AM" — the OS 12-hour dialect without :00 noise. */
function timeOfDay(hour: number, minute: number): string {
	const suffix = hour < 12 ? "AM" : "PM";
	const displayHour = hour % 12 === 0 ? 12 : hour % 12;
	return minute === 0
		? `${displayHour} ${suffix}`
		: `${displayHour}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function dowPhrase(dow: string): string | null {
	const range = /^([^,\-\s]+)-([^,\-\s]+)$/.exec(dow);
	if (range?.[1] !== undefined && range[2] !== undefined) {
		const from = parseDayToken(range[1]);
		const to = parseDayToken(range[2]);
		if (from === null || to === null) return null;
		if (from === 1 && to === 5) return "weekdays";
		return `${dayName(from)} through ${dayName(to)}`;
	}
	if (dow.includes(",")) {
		const days: number[] = [];
		for (const token of dow.split(",")) {
			const day = parseDayToken(token);
			if (day === null) return null;
			days.push(day);
		}
		const unique = new Set(days);
		if (unique.size === 2 && unique.has(0) && unique.has(6)) return "weekends";
		return `on ${days.map(dayName).join(", ")}`;
	}
	const day = parseDayToken(dow);
	return day === null ? null : `weekly on ${dayName(day)}`;
}

/**
 * Human-readable cadence for the common 5-field cron shapes; anything the
 * translator does not fully understand renders as the raw expression — an
 * honest fallback beats a wrong paraphrase.
 */
export function cronToHuman(cron: string): string {
	const fields = cron.trim().split(/\s+/);
	if (fields.length !== 5) return cron;
	const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
		string,
		string,
		string,
		string,
		string,
	];
	// Month restrictions are rare enough that paraphrasing risks lying.
	if (month !== "*") return cron;

	const minuteStep = /^\*\/(\d+)$/.exec(minute)?.[1];
	const hourStep = /^\*\/(\d+)$/.exec(hour)?.[1];
	const fixedMinute = /^\d+$/.test(minute) ? Number(minute) : null;
	const fixedHour = /^\d+$/.test(hour) ? Number(hour) : null;
	if (fixedMinute !== null && fixedMinute > 59) return cron;
	if (fixedHour !== null && fixedHour > 23) return cron;

	if (dayOfMonth === "*" && dayOfWeek === "*") {
		if (minute === "*" && hour === "*") return "every minute";
		if (minuteStep && hour === "*") return `every ${minuteStep} minutes`;
		if (fixedMinute !== null && hour === "*") {
			return `hourly at :${String(fixedMinute).padStart(2, "0")}`;
		}
		if (fixedMinute === 0 && hourStep) return `every ${hourStep} hours`;
		if (fixedMinute !== null && fixedHour !== null) {
			return `daily at ${timeOfDay(fixedHour, fixedMinute)}`;
		}
		return cron;
	}

	if (fixedMinute === null || fixedHour === null) return cron;
	const at = timeOfDay(fixedHour, fixedMinute);
	if (dayOfMonth === "*") {
		const phrase = dowPhrase(dayOfWeek);
		return phrase === null ? cron : `${phrase} at ${at}`;
	}
	if (dayOfWeek === "*" && /^\d+$/.test(dayOfMonth)) {
		return `monthly on day ${Number(dayOfMonth)} at ${at}`;
	}
	// Combined day-of-month + day-of-week semantics are OR in cron — too
	// subtle to paraphrase.
	return cron;
}

/** Dynamic-skill definitions keyed by their owning skill id. */
export function dynamicDefinitionsBySkillId(
	definitions: readonly WorkflowDefinition[],
): Record<string, WorkflowDefinition> {
	const map: Record<string, WorkflowDefinition> = {};
	for (const definition of definitions) {
		if (definition.kind === "dynamic_skill")
			map[definition.skillId] = definition;
	}
	return map;
}

export function triggerTitle(
	schedule: Pick<SkillSchedule, "skillId">,
	definition?: WorkflowDefinition,
): string {
	if (definition) {
		if (definition.kind === "dynamic_skill" && definition.skillSlug) {
			return definition.title || definition.skillSlug;
		}
		return definition.title;
	}
	return `skill ${schedule.skillId.slice(0, 8)}`;
}

/** Enabled triggers first, each group by soonest next fire. */
export function sortTriggers(
	schedules: readonly SkillSchedule[],
): SkillSchedule[] {
	return [...schedules].sort((a, b) => {
		if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
		return a.nextFireAt.localeCompare(b.nextFireAt);
	});
}

// ---------------------------------------------------------------------------
// Pure presentational subcomponents (exported for tests)
// ---------------------------------------------------------------------------

export type TriggerTone = "neutral" | "active" | "warn";

const CHIP_VARIANTS: Record<TriggerTone, BadgeVariant> = {
	neutral: "outline",
	active: "info",
	warn: "warning",
};

export function TriggerChip({
	tone,
	children,
}: {
	tone: TriggerTone;
	children: ReactNode;
}) {
	return (
		<Badge variant={CHIP_VARIANTS[tone]} data-tone={tone}>
			{children}
		</Badge>
	);
}

export function TriggerRow({
	schedule,
	definition,
	health,
	tediNames = {},
	runPending = false,
	onRunNow,
}: {
	schedule: SkillSchedule;
	/** undefined = the workflow catalog has no dynamic definition for this skill. */
	definition?: WorkflowDefinition;
	/** undefined = the health read has not resolved; render no last-run chip. */
	health?: WorkflowDefinitionHealth;
	tediNames?: Record<string, string>;
	runPending?: boolean;
	onRunNow?: () => void;
}) {
	const owner = tediNames[schedule.tediId] ?? "a tedi";
	const latestRun = health?.latestRun ?? null;
	return (
		<li className="flex min-h-14 min-w-0 items-start gap-3 rounded-lg px-3 py-2.5">
			<IconFrame aria-hidden>
				<Alarm size={18} />
			</IconFrame>
			<span className="grid min-w-0 flex-1 gap-1">
				<span className="flex flex-wrap items-center gap-1.5">
					{/* Read-only state: the contract has no schedule pause/resume verb —
					    schedules are manifest-owned, so the state only renders here. */}
					<TriggerChip tone={schedule.enabled ? "active" : "neutral"}>
						{schedule.enabled ? "On" : "Off"}
					</TriggerChip>
					{latestRun ? <RunStatusChip status={latestRun.status} /> : null}
					{schedule.enabled && schedule.lastError != null ? (
						<TriggerChip tone="warn">Last fire failed</TriggerChip>
					) : null}
					{schedule.enabled && schedule.lastBudgetBlockedAt != null ? (
						<TriggerChip tone="warn">Budget blocked</TriggerChip>
					) : null}
				</span>
				<Text
					as="strong"
					role="body"
					weight="medium"
					className="truncate tracking-[-0.2px]"
				>
					{triggerTitle(schedule, definition)}
				</Text>
				<Text
					as="span"
					role="label"
					tone="secondary"
					className="tracking-[-0.1px]"
				>
					{cronToHuman(schedule.cron)}
					{" · next run "}
					<time
						dateTime={schedule.nextFireAt}
						title={absoluteTime(schedule.nextFireAt)}
					>
						{absoluteTime(schedule.nextFireAt)}
					</time>
					{" · "}
					{owner}
					{schedule.lastFireAt ? (
						<>
							{" · last fired "}
							<time
								dateTime={schedule.lastFireAt}
								title={absoluteTime(schedule.lastFireAt)}
							>
								{relativeTime(schedule.lastFireAt)}
							</time>
						</>
					) : null}
				</Text>
			</span>
			<span className="ml-auto flex shrink-0 items-center self-center">
				<Button
					size="sm"
					variant="outline"
					icon={<Play size={14} />}
					disabled={runPending}
					onClick={() => onRunNow?.()}
				>
					Run now
				</Button>
			</span>
		</li>
	);
}

export function TriggersEmpty() {
	return (
		<Empty appearance="quiet">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<Alarm size={20} />
				</EmptyMedia>
				<EmptyTitle>No ambient triggers yet</EmptyTitle>
				<EmptyDescription>
					Triggers come from skill schedules — record or improve a skill with a
					schedule in its manifest and it fires here on cadence.
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

type RunNowInput = {
	scheduleId: string;
	skillId: string;
	tediId: string;
	params: Record<string, unknown>;
};

export function TriggersPanel({
	search = { section: "triggers", q: "", page: 1 },
	onPageChange = () => undefined,
}: {
	search?: SkillsSearch;
	onPageChange?: (page: number) => void;
}) {
	const queryClient = useQueryClient();
	const input = {
		limit: SKILLS_PAGE_SIZE,
		offset: (search.page - 1) * SKILLS_PAGE_SIZE,
		query: search.q.trim() || undefined,
	};

	const schedules = useQuery({
		...skillSchedulesQueryOptions(input),
		staleTime: 60_000,
	});

	// Schedule pages need the complete definition inventory to resolve every
	// skill title; paging this lookup with the schedules exposes raw skill IDs.
	const definitions = useQuery(
		workflowDefinitionsQueryOptions(TRIGGER_DEFINITION_LOOKUP_LIMIT),
	);

	// Degrades gracefully — rows render without last-run chips when this fails.
	const health = useQuery({
		...workflowDefinitionHealthQueryOptions(TRIGGER_DEFINITION_LOOKUP_LIMIT),
		staleTime: 60_000,
	});

	const tediNames = useTediNames();

	const definitionsBySkillId = useMemo(
		() => dynamicDefinitionsBySkillId(definitions.data?.definitions ?? []),
		[definitions.data],
	);

	const healthByDefinitionId = useMemo(() => {
		const map: Record<string, WorkflowDefinitionHealth> = {};
		for (const entry of health.data?.health ?? []) {
			map[entry.definitionId] = entry;
		}
		return map;
	}, [health.data]);

	const runNow = useMutation({
		mutationFn: (input: RunNowInput) =>
			osApi.skills.runWorkflow({
				skillId: input.skillId,
				tediId: input.tediId,
				params: input.params,
				idempotencyKey: crypto.randomUUID(),
				confirmDestructive: true,
				reason: "Operator run-now from the Tedix OS Triggers surface",
			}),
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: osQueryKeys.skillRuns() });
			queryClient.invalidateQueries({
				queryKey: osQueryKeys.skillSchedules(),
			});
			queryClient.invalidateQueries({
				queryKey: workflowDefinitionHealthQueryOptions(
					TRIGGER_DEFINITION_LOOKUP_LIMIT,
				).queryKey,
			});
		},
	});

	const rows = useMemo(
		() => sortTriggers(schedules.data?.schedules ?? []),
		[schedules.data],
	);

	return (
		<div className="grid gap-3">
			<SectionEyebrow title="Triggers" count={schedules.data?.total} />
			{schedules.isPending && <ListSkeleton />}
			{schedules.isError && (
				<Alert variant="destructive">
					<AlertTitle>Triggers are unavailable</AlertTitle>
					<AlertDescription>
						{(schedules.error as Error).message}
					</AlertDescription>
				</Alert>
			)}
			{schedules.data && rows.length === 0 && <TriggersEmpty />}
			{schedules.data && rows.length > 0 && (
				<ul className="m-0 grid list-none gap-1 p-0">
					{rows.map((schedule) => {
						const definition = definitionsBySkillId[schedule.skillId];
						return (
							<TriggerRow
								key={schedule.id}
								schedule={schedule}
								definition={definition}
								health={
									definition ? healthByDefinitionId[definition.id] : undefined
								}
								tediNames={tediNames}
								runPending={
									runNow.isPending &&
									runNow.variables?.scheduleId === schedule.id
								}
								onRunNow={() =>
									runNow.mutate({
										scheduleId: schedule.id,
										skillId: schedule.skillId,
										tediId: schedule.tediId,
										params: schedule.params,
									})
								}
							/>
						);
					})}
				</ul>
			)}
			{schedules.data && schedules.data.total > SKILLS_PAGE_SIZE ? (
				<Pagination
					className="flex-col items-stretch gap-3 border-kumo-hairline border-t pt-3 sm:flex-row sm:items-center"
					page={search.page}
					perPage={SKILLS_PAGE_SIZE}
					totalCount={schedules.data.total}
					setPage={onPageChange}
				>
					<Pagination.Info />
					<Pagination.Controls controls="simple" />
				</Pagination>
			) : null}
			{/* role="alert"/"status" is a raw HTML attribute; Text's own `role`
			    prop is the Tedix type role and shadows it, so these stay plain
			    elements rather than losing the ARIA announcement. */}
			{runNow.isError && (
				<p className="m-0 text-kumo-danger text-sm" role="alert">
					Could not dispatch the run: {(runNow.error as Error).message}
				</p>
			)}
			{runNow.isSuccess && (
				<p className="m-0 text-kumo-subtle text-sm" role="status">
					{runNow.data.deduplicated
						? `Run ${runNow.data.runId.slice(0, 8)} was already in flight — nothing new was dispatched.`
						: `Run ${runNow.data.runId.slice(0, 8)} dispatched — track it in Activity.`}
				</p>
			)}
		</div>
	);
}
