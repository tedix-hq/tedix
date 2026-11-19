import { CaretDown, CaretRight } from "@phosphor-icons/react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { WORKSPACE_TEDI_RESOURCE } from "@tedix/api-contract/schemas/os-workspace-schedules";
import { useContext, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Empty } from "@/components/kumo/empty";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";
import { EntityAvatar } from "@/shared/entity-avatar";
import { WorkActorDirectoryContext } from "@/components/work-actor-avatar";
import { ListSkeleton } from "@/components/list-skeleton";
import {
	skillRunsQueryOptions,
	skillDetailQueryOptions,
	tediDetailQueryOptions,
	workspaceCollaboratorsQueryOptions,
	workspaceResourcesQueryOptions,
	workspaceSchedulesQueryOptions,
} from "@/lib/os-query-options";
import { relativeTime } from "@/lib/time";
import {
	AGENT_RUN_STATE_LABELS,
	agentCountsLine,
	deriveWorkspaceAgents,
	type WorkspaceAgent,
	type WorkspaceAgentRun,
	type WorkspaceTedi,
} from "@/lib/workspace-agents";
import type { ConversationSummary } from "@/lib/workspace-chat-protocol";

/** Each linked skill's newest runs read for its counts. */
const RUNS_READ = 30;
/** Runs listed under an opened agent. */
const RUNS_SHOWN = 10;
const MINUTE_MS = 60_000;

/**
 * A workspace's Agents view: one row per agent that works there, with how
 * many of its runs are working now, need a person, and ran today. Opening a
 * row lists its latest runs. Linked skills are read here; the runs an agent
 * started in the workspace chat come from the chat, which already has them.
 */
export function WorkspaceAgentsPanel({
	workspaceId,
	conversations,
	onOpenConversation,
	onMessageTedi,
}: {
	workspaceId: string;
	/** The workspace chat's conversations; the agent-started ones are runs. */
	conversations: readonly ConversationSummary[];
	onOpenConversation: (conversationId: string) => void;
	/** Starts a conversation addressed to a tedi; without it no Message button shows. */
	onMessageTedi?: (tediId: string) => void;
}) {
	const schedules = useQuery(workspaceSchedulesQueryOptions(workspaceId));
	const resources = useQuery(workspaceResourcesQueryOptions(workspaceId));
	const sharing = useQuery(workspaceCollaboratorsQueryOptions(workspaceId));
	const skillIds = useMemo(
		() => (schedules.data?.items ?? []).map((item) => item.skillId),
		[schedules.data?.items],
	);
	const skills = useQueries({ queries: skillIds.map(skillDetailQueryOptions) });
	const tediIdsBySkill = new Map(
		skillIds.map((id, at) => [id, skills[at]?.data?.entry?.tediId ?? null]),
	);
	const directory = useContext(WorkActorDirectoryContext);
	const runs = useQueries({
		queries: skillIds.map((skillId) => ({
			...skillRunsQueryOptions(skillId, undefined, RUNS_READ),
			refetchInterval: MINUTE_MS,
		})),
	});
	// "Today" and "5m ago" have to move on in a workspace where nothing changes.
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const timer = setInterval(() => setNow(new Date()), MINUTE_MS);
		return () => clearInterval(timer);
	}, []);
	const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

	const tediNames = new Map(
		(resources.data?.items ?? [])
			.filter(
				(row) =>
					row.providerId === WORKSPACE_TEDI_RESOURCE.providerId &&
					row.resourceType === WORKSPACE_TEDI_RESOURCE.resourceType,
			)
			.map((row) => [row.providerResourceId, row.name]),
	);
	for (const collaborator of sharing.data?.collaborators ?? []) {
		if (collaborator.principalKind !== "tedi") continue;
		tediNames.set(
			collaborator.userId,
			collaborator.name ??
				tediNames.get(collaborator.userId) ??
				"Tedi profile unavailable",
		);
	}
	const tediIds = [
		...new Set([
			...tediNames.keys(),
			...[...tediIdsBySkill.values()].filter((id): id is string => Boolean(id)),
			...conversations.flatMap((row) =>
				row.startedBy?.kind === "tedi" && !row.archivedAt
					? [row.startedBy.id]
					: [],
			),
		]),
	];
	const profiles = useQueries({ queries: tediIds.map(tediDetailQueryOptions) });
	const tedis = new Map<string, WorkspaceTedi>(
		tediIds.map((id, at) => {
			const profile = profiles[at]?.data;
			const owner = profile?.ownerUserId
				? directory.get(`user:${profile.ownerUserId}`)?.name
				: null;
			return [
				id,
				{
					name:
						profile?.displayName ||
						profile?.name ||
						tediNames.get(id) ||
						"Tedi profile unavailable",
					avatar: profile?.avatar ?? null,
					owner: profile
						? profile.scope === "organization"
							? "Belongs to the organization"
							: profile.ownerUserId
								? owner
									? `Owned by ${owner}`
									: "Owned by a member"
								: "Owner unavailable"
						: "Owner unavailable",
				},
			];
		}),
	);
	const runsBySkill = new Map(
		skillIds.flatMap((skillId, at) => {
			const data = runs[at]?.data;
			return data ? [[skillId, data.runs] as const] : [];
		}),
	);
	// A skill whose runs did not load must not read as an agent with nothing on.
	const unknown = new Set(
		skillIds
			.filter((_, at) => !runs[at]?.data)
			.map((skillId) =>
				tediIdsBySkill.get(skillId)
					? `tedi:${tediIdsBySkill.get(skillId)}`
					: `skill:${skillId}`,
			),
	);
	const agents = deriveWorkspaceAgents({
		schedules: (schedules.data?.items ?? []).filter(
			(_, at) => skills[at]?.isSuccess,
		),
		runsBySkill,
		conversations,
		tedis,
		tediIdsBySkill,
		now,
	});

	return (
		<section
			aria-label="Workspace agents"
			className="min-h-0 min-w-0 flex-1 overflow-auto"
		>
			<header className="grid gap-1 border-b border-kumo-line px-4 py-3 md:px-6">
				<Text as="h2" role="section" tone="strong" className="m-0">
					Agents
				</Text>
				<Text as="p" role="label" tone="secondary" className="m-0">
					Work that starts without you typing in the chat: what is running, what
					needs you and what ran today.
				</Text>
			</header>
			<div className="grid gap-2 p-4 md:p-6">
				{(schedules.isPending ||
					resources.isPending ||
					sharing.isPending ||
					skills.some((row) => row.isPending)) &&
				agents.length === 0 ? (
					<ListSkeleton rows={2} rowClassName="h-14" />
				) : agents.length === 0 &&
				  !schedules.isError &&
				  !resources.isError &&
				  !skills.some((row) => row.isError) ? (
					<Empty
						appearance="quiet"
						title="No agents work in this workspace yet"
						description="Invite a tedi, link a skill in Overview, or let a connected app send this workspace a task."
					/>
				) : (
					<ul className="m-0 grid list-none gap-2 p-0" aria-label="Agents">
						{agents.map((agent) => (
							<AgentRow
								key={agent.key}
								agent={agent}
								countsUnknown={unknown.has(agent.key)}
								expanded={open.has(agent.key)}
								now={now}
								onOpenConversation={onOpenConversation}
								onMessageTedi={onMessageTedi}
								onToggle={() =>
									setOpen((current) => {
										const next = new Set(current);
										if (!next.delete(agent.key)) next.add(agent.key);
										return next;
									})
								}
							/>
						))}
					</ul>
				)}
				{resources.isError ? (
					<Text as="p" role="label" tone="secondary" className="m-0">
						The tedis linked to this workspace could not be loaded.
					</Text>
				) : null}
				{schedules.isError || skills.some((row) => row.isError) ? (
					<Text as="p" role="label" tone="secondary" className="m-0">
						Some skills or their owners could not be loaded, so their runs are
						missing from this list.
					</Text>
				) : null}
			</div>
		</section>
	);
}

function AgentRow({
	agent,
	countsUnknown,
	expanded,
	now,
	onOpenConversation,
	onMessageTedi,
	onToggle,
}: {
	agent: WorkspaceAgent;
	countsUnknown: boolean;
	expanded: boolean;
	now: Date;
	onOpenConversation: (conversationId: string) => void;
	onMessageTedi?: (tediId: string) => void;
	onToggle: () => void;
}) {
	const runsId = `workspace-agent-runs-${agent.key}`;
	const Caret = expanded ? CaretDown : CaretRight;
	return (
		<li
			className="min-w-0 rounded-lg border border-kumo-line"
			data-workspace-agent={agent.key}
		>
			<button
				aria-controls={expanded ? runsId : undefined}
				aria-expanded={expanded}
				className="flex min-h-11 w-full min-w-0 items-start gap-3 rounded-lg px-3 py-3 text-left hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-focus"
				onClick={onToggle}
				type="button"
			>
				<Caret
					aria-hidden
					className="mt-1 shrink-0 text-kumo-subtle"
					size={14}
				/>
				<EntityAvatar
					id={agent.tediId ?? agent.key}
					name={agent.name}
					kind={agent.tediId ? "tedi" : "app"}
					image={agent.avatar}
					className="size-9 shrink-0"
				/>
				<span className="grid min-w-0 flex-1 gap-0.5">
					<Text as="span" role="body" weight="medium" className="wrap-anywhere">
						{agent.name}
					</Text>
					{agent.detail ? (
						<Text as="span" role="label" tone="secondary">
							{agent.detail}
						</Text>
					) : null}
					<Text as="span" role="label" tone="secondary" data-agent-counts>
						{countsUnknown
							? "Its runs could not be loaded"
							: agent.runs.length === 0
								? "Has not run yet"
								: agentCountsLine(agent)}
					</Text>
				</span>
				{agent.needsYou > 0 ? (
					<Badge className="shrink-0" variant="warning">
						Needs you
					</Badge>
				) : null}
				{agent.lastActiveAt ? (
					<Text
						as="span"
						role="caption"
						tone="secondary"
						className="shrink-0 whitespace-nowrap"
					>
						{relativeTime(agent.lastActiveAt, now)}
					</Text>
				) : null}
			</button>
			{/* Indented to start under the name, past the caret and avatar. */}
			{agent.tediId ? (
				<div className="flex flex-wrap items-center gap-3 pr-3 pb-3 pl-19.5">
					<Link
						href={agent.profileHref!}
						variant="navigation"
						aria-label={`View ${agent.name} profile`}
					>
						View profile
					</Link>
					{onMessageTedi ? (
						<Button
							size="sm"
							variant="secondary"
							aria-label={`Message ${agent.name}`}
							onClick={() => onMessageTedi(agent.tediId!)}
						>
							Message
						</Button>
					) : null}
				</div>
			) : null}
			{expanded ? (
				<div
					className="grid gap-2 border-t border-kumo-line px-3 py-3"
					id={runsId}
				>
					{agent.runs.length === 0 ? (
						<Text as="p" role="label" tone="secondary" className="m-0">
							{countsUnknown
								? "Try again in a moment."
								: "Its runs show here once it has run."}
						</Text>
					) : (
						<ul
							className="m-0 grid list-none gap-1 p-0"
							aria-label={`Latest runs of ${agent.name}`}
						>
							{agent.runs.slice(0, RUNS_SHOWN).map((run) => (
								<RunRow
									key={run.key}
									run={run}
									now={now}
									onOpenConversation={onOpenConversation}
								/>
							))}
						</ul>
					)}
					{agent.skills.map((skill) => (
						<Link
							key={skill.id}
							className="w-fit"
							variant="navigation"
							href={skill.href}
						>
							{skill.name} · See all runs
						</Link>
					))}
				</div>
			) : null}
		</li>
	);
}

function RunRow({
	run,
	now,
	onOpenConversation,
}: {
	run: WorkspaceAgentRun;
	now: Date;
	onOpenConversation: (conversationId: string) => void;
}) {
	// A run that waits for a person opens where its request can be answered.
	const action = run.state === "needs_you" ? "Review" : "Open";
	const open = run.open;
	return (
		<li
			className="flex min-h-9 min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
			data-agent-run={run.key}
			data-agent-run-state={run.state}
		>
			<Badge
				className="shrink-0"
				variant={
					run.state === "needs_you"
						? "warning"
						: run.state === "failed"
							? "destructive"
							: "outline"
				}
			>
				{AGENT_RUN_STATE_LABELS[run.state]}
			</Badge>
			<Text as="span" role="body" className="min-w-0 flex-1 truncate">
				{run.title}
			</Text>
			{run.at ? (
				<Text
					as="span"
					role="caption"
					tone="secondary"
					className="shrink-0 whitespace-nowrap"
				>
					{relativeTime(run.at, now)}
				</Text>
			) : null}
			{open.type === "conversation" ? (
				<Button
					aria-label={`${action} ${run.title}`}
					onClick={() => onOpenConversation(open.conversationId)}
					size="xs"
					variant={run.state === "needs_you" ? "secondary" : "ghost"}
				>
					{action}
				</Button>
			) : (
				<Link
					aria-label={`${action} ${run.title}`}
					className="shrink-0"
					href={open.href}
					variant="navigation"
				>
					{action}
				</Link>
			)}
		</li>
	);
}
