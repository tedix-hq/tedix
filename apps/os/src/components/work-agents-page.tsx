import {
	ATTENTION_COPY,
	attentionCopy,
	inactiveSessionLabel,
} from "@tedix/api-contract/utils/attention-copy";
import { useQuery } from "@tanstack/react-query";
import type {
	ListWorkAgentSessionsResultSchema,
	WorkAgentSessionEffectiveStateSchema,
	WorkProjectContributorStateSchema,
} from "@tedix/api-contract/schemas/work-agent-sessions";
import { useMemo } from "react";
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
	Page,
	PageDescription,
	PageHeader,
	PageHeading,
	PageSection,
	PageTitle,
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
import { useDocumentTitle } from "@/lib/use-document-title";
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
): AgentProjectGroup[] {
	const ordered = sessions
		.filter((session) => session.effectiveState !== "ended")
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
						: (projectNames.get(projectId) ?? projectId.slice(0, 8)),
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

function AgentSessionRow({
	session,
	now,
}: {
	session: AgentSession;
	now: Date;
}) {
	const state = session.effectiveState as BoardState;
	return (
		<li
			data-agent-state={state}
			className={cn(
				"flex min-w-0 items-center gap-3 px-3 py-2",
				ROW_TINT[state],
			)}
		>
			<Badge variant="outline" className="shrink-0">
				{AGENT_HARNESS_LABEL[session.harness] ?? ATTENTION_COPY.local}
			</Badge>
			<AgentStateBadge
				state={state}
				lastSeenAt={session.lastEventAt}
				reason={session.summary}
				now={now}
			/>
			<Text
				as="span"
				role="body"
				tone="strong"
				className="max-w-[40%] shrink-0 truncate"
				title={session.label}
			>
				{session.label || session.sessionKey}
			</Text>
			<Text
				as="span"
				role="body"
				tone="secondary"
				className="min-w-0 flex-1 truncate"
				title={session.summary}
			>
				{session.summary}
			</Text>
			<Text as="span" role="label" tone="secondary" className="shrink-0">
				<time
					dateTime={session.stateSince}
					title={absoluteTime(session.stateSince)}
				>
					{relativeTime(session.stateSince, now)}
				</time>
			</Text>
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
	data,
	projectNames,
	now = new Date(),
}: {
	data: AgentSessionList;
	projectNames?: ReadonlyMap<string, string>;
	now?: Date;
}) {
	const groups = groupAgentSessions(data.sessions, projectNames);
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

export function WorkAgentsPage() {
	useDocumentTitle("Agents · Work");
	const query = useQuery(workAgentSessionsQueryOptions());
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
	return (
		<Page width="xl">
			<PageHeader>
				<PageHeading>
					<PageTitle>Agents</PageTitle>
					<PageDescription>
						Your local Claude Code and Codex sessions by project, most urgent
						first.
					</PageDescription>
				</PageHeading>
			</PageHeader>
			{query.data ? (
				<WorkAgentsBoard data={query.data} projectNames={projectNames} />
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
		</Page>
	);
}
