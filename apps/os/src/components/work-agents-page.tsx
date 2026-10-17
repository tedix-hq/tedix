import {
	ATTENTION_COPY,
	attentionCopy,
	inactiveSessionLabel,
} from "@tedix/api-contract/utils/attention-copy";
import { useQuery } from "@tanstack/react-query";
import {
	WorkAgentSessionHarnessSchema,
	WorkAgentSessionEffectiveStateSchema,
} from "@tedix/api-contract/schemas/work-agent-sessions";
import type {
	ListWorkAgentSessionsResultSchema,
	WorkProjectContributorStateSchema,
} from "@tedix/api-contract/schemas/work-agent-sessions";
import { useMemo, useState } from "react";
import type { AgentsConfig } from "@tedix/api-contract/schemas/os-session-apps";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import type * as z from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@/components/kumo/empty";
import {
	Collection,
	PageSection,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Skeleton } from "@/components/kumo/skeleton";
import { Text } from "@/components/kumo/text";
import {
	projectListQueryOptions,
	workAgentSessionsQueryOptions,
} from "@/lib/os-query-options";
import { absoluteTime, relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";

type AgentSessionList = z.output<typeof ListWorkAgentSessionsResultSchema>;
type AgentSession = AgentSessionList["sessions"][number];
type BoardState = Exclude<
	z.output<typeof WorkAgentSessionEffectiveStateSchema>,
	"ended"
>;

/** Board order: what needs the owner first, quiet sessions last. */
export const AGENT_BOARD_SECTIONS: readonly {
	state: BoardState;
	title: string;
	count: string;
}[] = [
	{
		state: "needs_you",
		title: ATTENTION_COPY.waiting,
		count: ATTENTION_COPY.waiting,
	},
	{
		state: "error",
		title: ATTENTION_COPY.blocked,
		count: ATTENTION_COPY.blocked,
	},
	{ state: "done", title: ATTENTION_COPY.done, count: ATTENTION_COPY.done },
	{
		state: "working",
		title: ATTENTION_COPY.running,
		count: ATTENTION_COPY.running,
	},
	{
		state: "idle",
		title: ATTENTION_COPY.inactive,
		count: ATTENTION_COPY.inactive,
	},
];

export const AGENT_HARNESS_LABEL: Record<string, string> = {
	"claude-code": ATTENTION_COPY.local_claude,
	codex: ATTENTION_COPY.local_codex,
	tedi: "Tedi",
	skill: "Skill",
};

type AgentStateBadgeState = z.output<typeof WorkProjectContributorStateSchema>;

const STATE_BADGE: Record<
	AgentStateBadgeState,
	{
		label: string;
		variant: "warning" | "error" | "success" | "info" | "secondary";
	}
> = {
	needs_you: { label: ATTENTION_COPY.waiting, variant: "warning" },
	error: { label: ATTENTION_COPY.blocked, variant: "error" },
	done: { label: ATTENTION_COPY.done, variant: "success" },
	working: { label: ATTENTION_COPY.running, variant: "info" },
	idle: { label: ATTENTION_COPY.inactive, variant: "secondary" },
	ended: { label: ATTENTION_COPY.ended, variant: "secondary" },
	unknown: { label: ATTENTION_COPY.unknown, variant: "secondary" },
};

/** One state badge for agent sessions, shared by the board and project contributors. */
export function AgentStateBadge({
	state,
	lastSeenAt,
	reason,
	now = new Date(),
}: {
	state: AgentStateBadgeState;
	lastSeenAt?: string;
	reason?: string;
	now?: Date;
}) {
	const badge = STATE_BADGE[state];
	return (
		<Badge variant={badge.variant} className="shrink-0">
			{state === "idle" && lastSeenAt
				? inactiveSessionLabel(lastSeenAt, now)
				: state === "error" && reason
					? attentionCopy("blockedReason", { reason })
					: badge.label}
		</Badge>
	);
}

/** Only the two states that ask for a glance get colour; the rest stay neutral. */
const ROW_TINT: Partial<Record<BoardState, string>> = {
	needs_you: "bg-kumo-warning-tint",
	done: "bg-kumo-success-tint",
};

const URGENCY = new Map(
	AGENT_BOARD_SECTIONS.map((section, index) => [section.state, index]),
);

export const NO_PROJECT_TITLE = "No project";

export type AgentProjectGroup = {
	projectId: string | null;
	title: string;
	sessions: AgentSession[];
	idle: AgentSession[];
};

/**
 * Board groups: one per project, ordered by each project's most urgent
 * session, with unbound sessions last. Rows keep the urgency order inside a
 * group; idle rows are split out so the board can collapse them.
 */
export function groupAgentSessions(
	sessions: readonly AgentSession[],
	projectNames: ReadonlyMap<string, string> = new Map(),
	includeEnded = false,
): AgentProjectGroup[] {
	const ordered = sessions
		.filter(
			(session) =>
				includeEnded || session.effectiveState !== "ended" || session.telemetry,
		)
		.map((session, index) => ({ session, index }))
		.sort(
			(a, b) =>
				(URGENCY.get(a.session.effectiveState as BoardState) ?? 0) -
					(URGENCY.get(b.session.effectiveState as BoardState) ?? 0) ||
				a.index - b.index,
		)
		.map(({ session }) => session);
	const groups = new Map<string | null, AgentProjectGroup>();
	for (const session of ordered) {
		const projectId = session.projectId;
		let group = groups.get(projectId);
		if (!group) {
			group = {
				projectId,
				title:
					projectId === null
						? NO_PROJECT_TITLE
						: (projectNames.get(projectId) ?? "Project unavailable"),
				sessions: [],
				idle: [],
			};
			groups.set(projectId, group);
		}
		(session.effectiveState === "idle" ? group.idle : group.sessions).push(
			session,
		);
	}
	const unbound = groups.get(null);
	groups.delete(null);
	return unbound ? [...groups.values(), unbound] : [...groups.values()];
}

export function laneDailyTotals(sessions: readonly AgentSession[], now: Date) {
	const day = (at: string) => new Date(at).toLocaleDateString("en-CA");
	const lanes = sessions.flatMap((s) =>
		s.telemetry && day(s.telemetry.startedAt) === day(now.toISOString())
			? [s.telemetry]
			: [],
	);
	const measured = lanes.filter((l) => l.usage !== null);
	const priced = lanes.filter((l) => l.estimatedCostUsd !== null);
	const settled = lanes.filter((l) => l.outcome !== null);
	return {
		lanes: lanes.length,
		tokens: measured.reduce((n, l) => n + l.usage!.input + l.usage!.output, 0),
		unmeasured: lanes.length - measured.length,
		cost: priced.reduce((n, l) => n + l.estimatedCostUsd!, 0),
		unpriced: lanes.length - priced.length,
		successRate: settled.length
			? settled.filter((l) => l.outcome === "succeeded").length / settled.length
			: null,
	};
}
const number = (value: number) => new Intl.NumberFormat().format(value);
const cost = (value: number) =>
	new Intl.NumberFormat(undefined, {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: 4,
	}).format(value);
function duration(from: string, to: string) {
	const seconds = Math.max(
		0,
		Math.round((Date.parse(to) - Date.parse(from)) / 1000),
	);
	return seconds < 60
		? `${seconds}s`
		: `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function AgentSessionRow({
	session,
	now,
}: {
	session: AgentSession;
	now: Date;
}) {
	const lane = session.telemetry;
	const state = session.effectiveState;
	return (
		<li
			data-agent-state={state}
			className={cn("min-w-0 px-3 py-2", ROW_TINT[state as BoardState])}
		>
			<div className="flex flex-wrap items-center gap-3">
				<Badge variant="outline">
					{AGENT_HARNESS_LABEL[lane?.executor ?? session.harness] ?? "Agent"}
				</Badge>
				<AgentStateBadge
					state={state}
					lastSeenAt={session.lastEventAt}
					reason={session.summary}
					now={now}
				/>
				<Text as="span" role="body" tone="strong">
					{lane?.model ??
						(lane ? "Model unknown" : session.label || "Unnamed session")}
				</Text>
				{lane?.reasoningEffort ? (
					<Text as="span" role="label" tone="secondary">
						{lane.reasoningEffort} reasoning
					</Text>
				) : null}
				<Text
					as="span"
					role="body"
					tone="secondary"
					className="min-w-0 flex-1 truncate"
					title={lane?.brief ?? session.summary}
				>
					{lane?.brief.split("\n").find((line) => line.trim()) ||
						session.summary}
				</Text>
				<Text as="span" role="label" tone="secondary">
					{lane ? (
						duration(lane.startedAt, lane.finishedAt ?? now.toISOString())
					) : (
						<time
							dateTime={session.stateSince}
							title={absoluteTime(session.stateSince)}
						>
							{relativeTime(session.stateSince, now)}
						</time>
					)}
				</Text>
			</div>
			{lane ? (
				<div className="mt-2 space-y-2">
					<Text role="label" tone="secondary">
						{lane.outcome ?? "Running"} ·{" "}
						{lane.usage
							? `${number(lane.usage.input + lane.usage.output)} tokens`
							: "Tokens unknown"}{" "}
						·{" "}
						{lane.estimatedCostUsd === null
							? "Cost unknown"
							: `${cost(lane.estimatedCostUsd)} estimated`}
						{" · "}Heartbeat {relativeTime(lane.heartbeatAt, now)}
					</Text>
					<Text role="body">
						{lane.lesson
							? `What we learned: ${lane.lesson}`
							: `What we learned: ${lane.lessonStatus === "pending" ? "waiting for the result" : "unavailable"}`}
					</Text>
					<Collapsible>
						<CollapsibleTrigger>
							Result and execution details
						</CollapsibleTrigger>
						<CollapsibleContent>
							<div className="space-y-2 py-2">
								<Text role="body">
									Asked: {lane.brief || "Brief unavailable"}
								</Text>
								<Text role="body">
									Result: {lane.finalMessage || "No final message recorded"}
								</Text>
								<Text role="body">
									Tools:{" "}
									{Object.entries(lane.tools)
										.map(([name, count]) => `${name} (${number(count)})`)
										.join(", ") || "No calls recorded"}
								</Text>
								{lane.usage ? (
									<Text role="body">
										Input {number(lane.usage.input)}, cached{" "}
										{number(lane.usage.cached)}, output{" "}
										{number(lane.usage.output)}, reasoning{" "}
										{number(lane.usage.reasoning)}. Cached and reasoning are
										included in input and output.
									</Text>
								) : null}
								<Text role="body">
									Started {absoluteTime(lane.startedAt)}
									{lane.finishedAt
										? ` · Finished ${absoluteTime(lane.finishedAt)}`
										: ""}
								</Text>
								<Text role="body">
									{lane.shas.length} reported commits · {lane.workItems.length}{" "}
									Work items touched ·{" "}
									{lane.source === "import"
										? "Imported observation"
										: "Executor observation"}
								</Text>
								<Text role="label" tone="secondary">
									Executor success records that the process finished.
									Verification is recorded separately on Work. Costs use
									published Standard list rates at report time, not subscription
									invoices.
								</Text>
							</div>
						</CollapsibleContent>
					</Collapsible>
				</div>
			) : null}
		</li>
	);
}

function AgentCountStrip({ counts }: { counts: AgentSessionList["counts"] }) {
	return (
		<dl
			aria-label="Agent session counts"
			className="m-0 flex flex-wrap gap-x-4 gap-y-1"
		>
			{AGENT_BOARD_SECTIONS.map((section) => (
				<div key={section.state} className="flex items-baseline gap-1.5">
					<Text as="dt" role="label" tone="secondary">
						{section.count}
					</Text>
					<Text as="dd" role="label" tone="strong" className="m-0">
						{counts[section.state] ?? 0}
					</Text>
				</div>
			))}
		</dl>
	);
}

export function WorkAgentsBoard({
	includeEnded = false,
	data,
	projectNames,
	now = new Date(),
}: {
	data: AgentSessionList;
	includeEnded?: boolean;
	projectNames?: ReadonlyMap<string, string>;
	now?: Date;
}) {
	const groups = groupAgentSessions(data.sessions, projectNames, includeEnded);
	const totals = laneDailyTotals(data.sessions, now);
	if (!groups.length) {
		return (
			<Empty appearance="quiet">
				<EmptyHeader>
					<EmptyTitle>No agent sessions reporting</EmptyTitle>
					<EmptyDescription>
						Create <code>~/.tedix/agent-status.json</code> with{" "}
						<code>
							{
								'{"enabled": true, "profile": "<CLI profile>", "organization": "<org>"}'
							}
						</code>{" "}
						and restart your Claude Code or Codex sessions.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}
	return (
		<>
			<div aria-label="Today’s delegation totals" className="space-y-1">
				<Text role="body" tone="strong">
					Today: {number(totals.lanes)} lanes · {number(totals.tokens)} measured
					tokens · {cost(totals.cost)} estimated ·{" "}
					{totals.successRate === null
						? "Success rate unknown"
						: `${Math.round(totals.successRate * 100)}% executor success`}
				</Text>
				<Text role="label" tone="secondary">
					{totals.unmeasured} lanes without usage · {totals.unpriced} without
					rates · Time to verified: see Work verification receipts. Totals cover
					the sessions returned by the board.
				</Text>
			</div>
			<AgentCountStrip counts={data.counts} />
			{groups.map((group) => (
				<PageSection key={group.projectId ?? "none"} aria-label={group.title}>
					<SectionHeader>
						<SectionHeading>
							<SectionTitle>
								{group.title} ({group.sessions.length + group.idle.length})
							</SectionTitle>
						</SectionHeading>
					</SectionHeader>
					{group.sessions.length ? (
						<Collection aria-label={`${group.title} sessions`}>
							{group.sessions.map((session) => (
								<AgentSessionRow key={session.id} session={session} now={now} />
							))}
						</Collection>
					) : null}
					{group.idle.length ? (
						<Collapsible>
							<CollapsibleTrigger>
								{ATTENTION_COPY.inactive} ({group.idle.length})
							</CollapsibleTrigger>
							<CollapsibleContent>
								<Collection aria-label={`${group.title} idle sessions`}>
									{group.idle.map((session) => (
										<AgentSessionRow
											key={session.id}
											session={session}
											now={now}
										/>
									))}
								</Collection>
							</CollapsibleContent>
						</Collapsible>
					) : null}
				</PageSection>
			))}
		</>
	);
}

export function AgentsApp({ config }: { config: AgentsConfig }) {
	const [project, setProject] = useState("all");
	const [state, setState] = useState("all");
	const [harness, setHarness] = useState("all");
	const includeEnded =
		config.states?.includes("ended") === true || state === "ended";
	const query = useQuery(workAgentSessionsQueryOptions(includeEnded));
	const projects = useQuery(projectListQueryOptions(100));
	const projectNames = useMemo(
		() =>
			new Map(
				(projects.data?.data ?? []).map((project) => [
					project.id,
					project.name,
				]),
			),
		[projects.data],
	);
	const data =
		query.data &&
		filterAgentSessions(query.data, config, { project, state, harness });
	return (
		<div className="grid min-w-0 gap-4" data-workspace-app-entry="agents">
			<div className="flex flex-wrap gap-3">
				<Select
					value={project}
					onValueChange={(value) => setProject(value ?? "all")}
				>
					<SelectTrigger aria-label="Agent project">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">
							{config.projectId
								? (projectNames.get(config.projectId) ?? "Configured project")
								: "All projects"}
						</SelectItem>
						{!config.projectId &&
							[...projectNames].map(([id, name]) => (
								<SelectItem key={id} value={id}>
									{name}
								</SelectItem>
							))}
					</SelectContent>
				</Select>
				<Select
					value={state}
					onValueChange={(value) => setState(value ?? "all")}
				>
					<SelectTrigger aria-label="Agent state">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All configured states</SelectItem>
						{(
							config.states ?? WorkAgentSessionEffectiveStateSchema.options
						).map((value) => (
							<SelectItem key={value} value={value}>
								{STATE_BADGE[value].label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Select
					value={harness}
					onValueChange={(value) => setHarness(value ?? "all")}
				>
					<SelectTrigger aria-label="Agent harness">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All configured harnesses</SelectItem>
						{(config.harnesses ?? WorkAgentSessionHarnessSchema.options).map(
							(value) => (
								<SelectItem key={value} value={value}>
									{AGENT_HARNESS_LABEL[value] ?? value}
								</SelectItem>
							),
						)}
					</SelectContent>
				</Select>
			</div>
			{data ? (
				<WorkAgentsBoard
					data={data}
					projectNames={projectNames}
					includeEnded={includeEnded}
				/>
			) : query.isError ? (
				<Alert variant="destructive">
					<AlertTitle>Agent sessions unavailable</AlertTitle>
					<AlertDescription>
						{query.error instanceof Error
							? query.error.message
							: "The canonical read failed."}
					</AlertDescription>
				</Alert>
			) : (
				<div className="grid gap-2" aria-label="Loading">
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
				</div>
			)}
		</div>
	);
}

/** Filters affect rows, state counts and telemetry totals together. */
export function filterAgentSessions(
	data: AgentSessionList,
	config: AgentsConfig,
	selected = { project: "all", state: "all", harness: "all" },
): AgentSessionList {
	const sessions = data.sessions.filter(
		(session) =>
			(!config.projectId || session.projectId === config.projectId) &&
			(!config.states || config.states.includes(session.effectiveState)) &&
			(!config.harnesses || config.harnesses.includes(session.harness)) &&
			(selected.project === "all" || session.projectId === selected.project) &&
			(selected.state === "all" || session.effectiveState === selected.state) &&
			(selected.harness === "all" || session.harness === selected.harness),
	);
	const counts: AgentSessionList["counts"] = {
		needs_you: 0,
		error: 0,
		done: 0,
		working: 0,
		idle: 0,
		ended: 0,
	};
	for (const session of sessions) counts[session.effectiveState] += 1;
	return { sessions, counts };
}
