import { useQuery } from "@tanstack/react-query";
import type {
	ListWorkAgentSessionsResultSchema,
	WorkAgentSessionEffectiveStateSchema,
} from "@tedix/api-contract/schemas/work-agent-sessions";
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
import { workAgentSessionsQueryOptions } from "@/lib/os-query-options";
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
	{ state: "needs_you", title: "Needs you", count: "Needs you" },
	{ state: "error", title: "Errors", count: "Errors" },
	{ state: "done", title: "Done", count: "Done" },
	{ state: "working", title: "Working", count: "Working" },
	{ state: "idle", title: "Idle", count: "Idle" },
];

const HARNESS_LABEL: Record<AgentSession["harness"], string> = {
	"claude-code": "Claude",
	codex: "Codex",
};

/** Only the two states that ask for a glance get colour; the rest stay neutral. */
const ROW_TINT: Partial<Record<BoardState, string>> = {
	needs_you: "bg-kumo-warning-tint",
	done: "bg-kumo-success-tint",
};

export function groupAgentSessions(sessions: readonly AgentSession[]) {
	const groups = new Map<BoardState, AgentSession[]>();
	for (const session of sessions) {
		if (session.effectiveState === "ended") continue;
		const group = groups.get(session.effectiveState) ?? [];
		group.push(session);
		groups.set(session.effectiveState, group);
	}
	return AGENT_BOARD_SECTIONS.flatMap((section) => {
		const rows = groups.get(section.state);
		return rows?.length ? [{ ...section, sessions: rows }] : [];
	});
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
				{HARNESS_LABEL[session.harness]}
			</Badge>
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
	now = new Date(),
}: {
	data: AgentSessionList;
	now?: Date;
}) {
	const sections = groupAgentSessions(data.sessions);
	if (!sections.length) {
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
			{sections.map((section) => {
				const rows = (
					<Collection aria-label={section.title}>
						{section.sessions.map((session) => (
							<AgentSessionRow key={session.id} session={session} now={now} />
						))}
					</Collection>
				);
				if (section.state === "idle") {
					return (
						<PageSection key={section.state} aria-label={section.title}>
							<Collapsible>
								<CollapsibleTrigger>
									{section.title} ({section.sessions.length})
								</CollapsibleTrigger>
								<CollapsibleContent>{rows}</CollapsibleContent>
							</Collapsible>
						</PageSection>
					);
				}
				return (
					<PageSection key={section.state} aria-label={section.title}>
						<SectionHeader>
							<SectionHeading>
								<SectionTitle>
									{section.title} ({section.sessions.length})
								</SectionTitle>
							</SectionHeading>
						</SectionHeader>
						{rows}
					</PageSection>
				);
			})}
		</>
	);
}

export function WorkAgentsPage() {
	useDocumentTitle("Agents · Work");
	const query = useQuery(workAgentSessionsQueryOptions());
	return (
		<Page width="xl">
			<PageHeader>
				<PageHeading>
					<PageTitle>Agents</PageTitle>
					<PageDescription>
						Your local Claude Code and Codex sessions, most urgent first.
					</PageDescription>
				</PageHeading>
			</PageHeader>
			{query.data ? (
				<WorkAgentsBoard data={query.data} />
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
