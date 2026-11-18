import type { SkillRunSummary } from "@tedix/api-contract/schemas/cognitive";
import type { OsWorkspaceSchedule } from "@tedix/api-contract/schemas/os-workspace-schedules";
import { normalizeD1Timestamp } from "@/lib/time";
import type { ConversationSummary } from "@/lib/workspace-chat-protocol";

/**
 * The Agents view of a workspace: one row per agent that works there, built
 * from two things a workspace already records. A linked skill is an agent
 * whose runs nobody typed for (its schedule, or another agent or app, started
 * them). A conversation whose first message came from a tedi or a connected
 * app is a run of that agent, and stays one when a person writes in it later.
 */

export type WorkspaceAgentRunState =
	| "working"
	| "needs_you"
	| "done"
	| "failed"
	| "stopped";

export type WorkspaceAgentRun = {
	key: string;
	title: string;
	state: WorkspaceAgentRunState;
	/** When the run last did anything; null when it recorded no time. */
	at: string | null;
	/** A conversation opens in the workspace chat; a skill run opens its page. */
	open:
		| { type: "conversation"; conversationId: string }
		| { type: "link"; href: string };
};

export type WorkspaceAgent = {
	key: string;
	name: string;
	/** Who runs it, or what kind of agent it is. */
	detail: string | null;
	/** Newest first. */
	runs: WorkspaceAgentRun[];
	working: number;
	needsYou: number;
	/** Runs whose last activity was today, on the reader's own calendar. */
	today: number;
	lastActiveAt: string | null;
	/** Where every run of a linked skill is listed. */
	allRunsHref: string | null;
};

/** Conversations a person started: all the chat list shows beside an Agents view. */
export function ownConversations(
	conversations: readonly ConversationSummary[],
): ConversationSummary[] {
	return conversations.filter((conversation) => !conversation.startedBy);
}

/** Conversations an agent started that are not archived, as the object ordered them. */
export function agentConversations(
	conversations: readonly ConversationSummary[],
): ConversationSummary[] {
	return conversations.filter(
		(conversation) => conversation.startedBy && !conversation.archivedAt,
	);
}

/**
 * A skill run counts for the agent when no person started it: the schedule
 * did, or an agent or app, or the starter was never recorded. A run someone
 * started by hand, or a test, is theirs.
 */
export function isAgentSkillRun(
	run: Pick<SkillRunSummary, "trigger">,
): boolean {
	return run.trigger !== "manual" && run.trigger !== "test";
}

function skillRunState(
	status: SkillRunSummary["status"],
): WorkspaceAgentRunState {
	if (status === "queued" || status === "running") return "working";
	if (status === "paused") return "needs_you";
	if (status === "completed") return "done";
	return status === "failed" ? "failed" : "stopped";
}

function iso(value: string | null | undefined): string | null {
	return value ? normalizeD1Timestamp(value) : null;
}

function sameLocalDay(at: string | null, now: Date): boolean {
	if (!at) return false;
	const date = new Date(at);
	return (
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate()
	);
}

function summarize(
	agent: Pick<WorkspaceAgent, "key" | "name" | "detail" | "allRunsHref">,
	runs: WorkspaceAgentRun[],
	counts: { working: number; needsYou: number },
	now: Date,
): WorkspaceAgent {
	const sorted = runs.toSorted((a, b) =>
		(b.at ?? "").localeCompare(a.at ?? ""),
	);
	return {
		...agent,
		runs: sorted,
		...counts,
		today: sorted.filter((run) => sameLocalDay(run.at, now)).length,
		lastActiveAt: sorted[0]?.at ?? null,
	};
}

const RUN_TITLES: Record<string, string> = {
	scheduled: "Scheduled run",
	agent: "Started by an agent or app",
};

export function deriveWorkspaceAgents(input: {
	schedules: readonly OsWorkspaceSchedule[];
	/** Each linked skill's newest runs; a skill still loading is absent. */
	runsBySkill: ReadonlyMap<string, readonly SkillRunSummary[]>;
	conversations: readonly ConversationSummary[];
	/** Names of the tedis linked to the workspace, by tedi id. */
	tediNames: ReadonlyMap<string, string>;
	now: Date;
}): WorkspaceAgent[] {
	const agents: WorkspaceAgent[] = [];

	for (const schedule of input.schedules) {
		const runs = (input.runsBySkill.get(schedule.skillId) ?? []).filter(
			isAgentSkillRun,
		);
		agents.push(
			summarize(
				{
					key: `skill:${schedule.skillId}`,
					name: schedule.name,
					detail: schedule.tediName ? `Run by ${schedule.tediName}` : null,
					allRunsHref: `/skills/${encodeURIComponent(schedule.skillId)}/runs`,
				},
				runs.map((run) => ({
					key: run.id,
					title: RUN_TITLES[run.trigger ?? ""] ?? "Run",
					state: skillRunState(run.status),
					at: iso(run.completedAt) ?? iso(run.pausedAt) ?? iso(run.startedAt),
					open: {
						type: "link",
						href: `/work/runs/${encodeURIComponent(run.id)}`,
					},
				})),
				{
					working: runs.filter(
						(run) => run.status === "queued" || run.status === "running",
					).length,
					needsYou: runs.filter((run) => run.status === "paused").length,
				},
				input.now,
			),
		);
	}

	const byStarter = new Map<string, ConversationSummary[]>();
	for (const conversation of agentConversations(input.conversations)) {
		const starter = conversation.startedBy!;
		const key = `${starter.kind}:${starter.id}`;
		byStarter.set(key, [...(byStarter.get(key) ?? []), conversation]);
	}
	for (const [key, conversations] of byStarter) {
		const starter = conversations[0]!.startedBy!;
		agents.push(
			summarize(
				{
					key,
					name:
						starter.kind === "tedi"
							? (input.tediNames.get(starter.id) ?? "A tedi")
							: "Connected agent",
					detail:
						starter.kind === "tedi"
							? "Tedi that sends this workspace tasks"
							: "An agent that reaches this workspace through a connected app",
					allRunsHref: null,
				},
				conversations.map((conversation) => ({
					key: conversation.id,
					title: conversation.title ?? "Untitled run",
					// A decision the run waits for outranks the work still going on.
					state: conversation.pendingApprovals
						? "needs_you"
						: conversation.running
							? "working"
							: "done",
					at: conversation.lastTurnAt ?? conversation.updatedAt,
					open: { type: "conversation", conversationId: conversation.id },
				})),
				{
					working: conversations.filter((conversation) => conversation.running)
						.length,
					needsYou: conversations.filter(
						(conversation) => (conversation.pendingApprovals ?? 0) > 0,
					).length,
				},
				input.now,
			),
		);
	}

	// Newest activity first; an agent that has not run yet comes last, by name.
	return agents.toSorted((a, b) => {
		if (a.lastActiveAt && b.lastActiveAt)
			return b.lastActiveAt.localeCompare(a.lastActiveAt);
		if (a.lastActiveAt || b.lastActiveAt) return a.lastActiveAt ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
}

/** "1 working · 2 need you · 3 today", leaving out what is zero. */
export function agentCountsLine(
	agent: Pick<WorkspaceAgent, "working" | "needsYou" | "today">,
): string {
	return [
		agent.working ? `${agent.working} working` : null,
		agent.needsYou
			? `${agent.needsYou} ${agent.needsYou === 1 ? "needs" : "need"} you`
			: null,
		`${agent.today} today`,
	]
		.filter(Boolean)
		.join(" · ");
}

export const AGENT_RUN_STATE_LABELS: Record<WorkspaceAgentRunState, string> = {
	working: "Working",
	needs_you: "Needs you",
	done: "Finished",
	failed: "Failed",
	stopped: "Stopped",
};
