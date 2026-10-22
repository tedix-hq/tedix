/**
 * Pure rules of the agent decision journal: learning class, envelope,
 * who must see a decision, per-class standing, the Feed projection and the
 * morning review text. Nothing here grants authority.
 */

import {
	AGENT_DECISION_OUTCOMES,
	type AgentDecision,
	type AgentDecisionClassStanding,
	type AgentDecisionJournalConfig,
	type AgentDecisionOutcome,
	type RecordAgentDecisionInput,
} from "../schemas/agent-decisions";
import type { ActivityFeedItem } from "../schemas/os-activity-feed";
import {
	DecisionEnvelopeSchema,
	decisionNeedsPerson,
	type DecisionEnvelope,
} from "../schemas/os-decision-deck";

export const AGENT_DECISION_SURFACE = "agent_decision";
export const AGENT_DECISION_SCHEMA = "tedix.agent-decision.v1";
export const AGENT_DECISION_OUTCOME_SCHEMA = "tedix.agent-decision-outcome.v1";
/** Learning event kind of each outcome. */
export const AGENT_DECISION_OUTCOME_EVENT_KIND = {
	worked: "accepted",
	reverted: "undone",
	partial: "edited",
} as const satisfies Record<AgentDecisionOutcome, string>;
/** The morning review card's class; the card itself changes nothing. */
export const AGENT_DECISION_REVIEW_CLASS = "agent-decisions.review";
export const AGENT_DECISION_REVIEW_MAX_WORDS = 60;

const HARNESS_NAMES: Record<string, string> = {
	"claude-code": "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
	devin: "Devin",
};

export function slug(value: string, max = 40): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, max) || "agent"
	);
}

export function agentSessionHarness(agentSession: string): string {
	return agentSession.slice(0, agentSession.indexOf(":"));
}

/** Display name: the given role name, else the harness. */
export function agentDisplayName(input: {
	agentName?: string | null;
	agentSession: string;
}): string {
	const harness = agentSessionHarness(input.agentSession);
	return input.agentName?.trim() || HARNESS_NAMES[harness] || harness;
}

/** `agent:<actor>:<decision class>`, at most 100 characters. */
export function agentDecisionClassId(
	actor: string,
	decisionClass: string,
): string {
	return `agent:${slug(actor)}:${decisionClass}`.slice(0, 100);
}

/** The shared DecisionEnvelope of a recorded decision: display and learning only. */
export function agentDecisionEnvelope(
	input: RecordAgentDecisionInput,
	classId: string,
): DecisionEnvelope {
	const chosen = input.options.find((option) => option.id === input.chosen)!;
	return DecisionEnvelopeSchema.parse({
		version: 1,
		kind: "decision",
		classId,
		proposal: input.question,
		whyNow: input.reason,
		recommendation: `Chose: ${chosen.label}`,
		reversibility: input.reversibility,
		tasteOrStrategy: input.tasteOrStrategy,
		protectedEffects: input.protectedEffects,
		blastRadius: input.workItemId
			? `Work item ${input.workItemId}`
			: "The agent's own work",
		confidence: input.confidence,
		costOfWaiting: "Already decided by the agent; nothing waits on a person.",
		reasoning: input.reason,
		options: input.options.map((option) => ({
			id: option.id,
			label: option.label,
			intent: option.id === input.chosen ? "approve" : "reject",
			consequence:
				option.id === input.chosen ? "The agent's choice." : "Not chosen.",
			cost: "None recorded",
		})),
	});
}

export function agentDecisionNeedsPerson(
	input: Pick<
		RecordAgentDecisionInput,
		"protectedEffects" | "reversibility" | "tasteOrStrategy"
	>,
): boolean {
	return decisionNeedsPerson({
		kind: "decision",
		protectedEffects: input.protectedEffects,
		reversibility: input.reversibility,
		tasteOrStrategy: input.tasteOrStrategy,
	} as DecisionEnvelope);
}

/** A person sees it in the review: it needs a person, or it is unsure. */
export function agentDecisionAskable(
	decision: { needsPerson: boolean; confidence: number | null },
	config: Pick<AgentDecisionJournalConfig, "askBelowConfidence">,
): boolean {
	return (
		decision.needsPerson ||
		(decision.confidence !== null &&
			decision.confidence < config.askBelowConfidence)
	);
}

type JournalEvent = {
	id: string;
	eventKind: string;
	targetId: string | null;
	metadata: Record<string, unknown> | null;
	occurredAt: string;
};

function rec(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
function str(value: unknown): string | null {
	return typeof value === "string" && value ? value : null;
}
function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

/**
 * Journal rows → decisions with their latest outcome. Rows that are not a
 * well-formed decision record are skipped.
 */
export function agentDecisionsFromEvents(
	events: readonly JournalEvent[],
	config: Pick<AgentDecisionJournalConfig, "askBelowConfidence">,
): AgentDecision[] {
	const outcomes = new Map<string, NonNullable<AgentDecision["outcome"]>>();
	for (const event of [...events].sort((a, b) =>
		a.occurredAt.localeCompare(b.occurredAt),
	)) {
		const meta = rec(event.metadata);
		if (meta.schema !== AGENT_DECISION_OUTCOME_SCHEMA || !event.targetId)
			continue;
		const outcome = meta.outcome as AgentDecisionOutcome;
		if (!AGENT_DECISION_OUTCOMES.includes(outcome)) continue;
		outcomes.set(event.targetId, {
			outcome,
			by: meta.by === "person" ? "person" : "agent",
			evidence: str(meta.evidence) ?? "",
			at: event.occurredAt,
		});
	}
	const decisions: AgentDecision[] = [];
	for (const event of events) {
		const meta = rec(event.metadata);
		if (event.eventKind !== "decided" || meta.schema !== AGENT_DECISION_SCHEMA)
			continue;
		const agent = rec(meta.agent);
		const options = (Array.isArray(meta.options) ? meta.options : [])
			.map(rec)
			.flatMap((option) => {
				const id = str(option.id);
				const label = str(option.label);
				return id && label ? [{ id, label }] : [];
			});
		const chosen = options.find((option) => option.id === meta.chosen);
		const classId = str(meta.classId);
		const question = str(meta.question);
		if (!chosen || !classId || !question) continue;
		const reversibility = ["two_way", "one_way", "unknown"].includes(
			String(meta.reversibility),
		)
			? (meta.reversibility as AgentDecision["reversibility"])
			: "unknown";
		const confidence =
			typeof meta.confidence === "number" ? meta.confidence : null;
		const needsPerson = meta.needsPerson === true;
		decisions.push({
			id: event.id,
			classId,
			decisionClass: str(meta.decisionClass) ?? classId.split(":").at(-1)!,
			agent: {
				name: str(agent.name) ?? "Agent",
				harness: str(agent.harness) ?? "unknown",
				session: str(agent.session) ?? "",
			},
			question,
			chosen,
			options,
			reason: str(meta.reason) ?? "",
			reversibility,
			protectedEffects: strings(meta.protectedEffects),
			confidence,
			needsPerson,
			askable: agentDecisionAskable({ needsPerson, confidence }, config),
			workItemId: str(meta.workItemId),
			outputId: str(meta.outputId),
			commitShas: strings(meta.commitShas),
			priorDecisionId: str(meta.priorDecisionId),
			occurredAt: event.occurredAt,
			outcome: outcomes.get(event.id) ?? null,
		});
	}
	return decisions.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

/**
 * Which decision classes agents get right: outcomes per class, newest last.
 * A class has earned trust after `earnedAfter` outcomes that worked with no
 * correction since; the latest reverted or partial outcome marks it corrected.
 * Standing is information for people and learning; it unlocks nothing.
 */
export function agentDecisionStandings(
	decisions: readonly AgentDecision[],
	config: Pick<AgentDecisionJournalConfig, "earnedAfter">,
): AgentDecisionClassStanding[] {
	const byClass = new Map<string, AgentDecision[]>();
	for (const decision of decisions)
		byClass.set(decision.classId, [
			...(byClass.get(decision.classId) ?? []),
			decision,
		]);
	return [...byClass.entries()]
		.map(([classId, rows]) => {
			const judged = rows
				.filter((row) => row.outcome)
				.sort((a, b) => a.outcome!.at.localeCompare(b.outcome!.at));
			const count = (outcome: AgentDecisionOutcome) =>
				judged.filter((row) => row.outcome!.outcome === outcome).length;
			let streak = 0;
			for (const row of [...judged].reverse()) {
				if (row.outcome!.outcome !== "worked") break;
				streak += 1;
			}
			const latest = judged.at(-1)?.outcome;
			const status: AgentDecisionClassStanding["status"] =
				latest && latest.outcome !== "worked"
					? "corrected"
					: streak >= config.earnedAfter
						? "earned"
						: "learning";
			const corrections = judged.filter(
				(row) =>
					row.outcome!.by === "person" && row.outcome!.outcome !== "worked",
			).length;
			const label = `${rows[0]!.agent.name} — ${rows[0]!.decisionClass}`;
			const remaining = Math.max(0, config.earnedAfter - streak);
			const sentence =
				status === "earned"
					? `${label}: ${streak} ${streak === 1 ? "decision" : "decisions"} in a row worked.`
					: status === "corrected"
						? `${label}: the latest decision was ${latest!.outcome === "reverted" ? "undone" : "partly changed"}.`
						: `${label}: ${judged.length} of ${rows.length} ${rows.length === 1 ? "decision has" : "decisions have"} an outcome; ${remaining} more that ${remaining === 1 ? "works earns" : "work earn"} trust.`;
			return {
				classId,
				decisions: rows.length,
				worked: count("worked"),
				reverted: count("reverted"),
				partial: count("partial"),
				corrections,
				streak,
				status,
				sentence,
			};
		})
		.sort(
			(a, b) => b.decisions - a.decisions || a.classId.localeCompare(b.classId),
		);
}

function words(text: string, max: number): string {
	const parts = text.split(/\s+/).filter(Boolean);
	return parts.length <= max
		? parts.join(" ")
		: `${parts
				.slice(0, max)
				.join(" ")
				.replace(/[,;:.]+$/, "")}…`;
}

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function classCounts(decisions: readonly AgentDecision[]): string {
	const counts = new Map<string, number>();
	for (const decision of decisions)
		counts.set(
			decision.decisionClass,
			(counts.get(decision.decisionClass) ?? 0) + 1,
		);
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 4)
		.map(([name, count]) => `${count} ${name}`)
		.join(", ");
}

/**
 * At most 60 words of plain English: how many decisions, grouped by class,
 * and which ones a person may want to check.
 */
export function agentDecisionReviewText(
	decisions: readonly AgentDecision[],
): string {
	if (decisions.length === 0) return "No agent decisions to review.";
	const agents = [...new Set(decisions.map((d) => d.agent.name))];
	const who = agents.length === 1 ? agents[0]! : "Your agents";
	const askable = decisions.filter((d) => d.askable);
	const head = `${who} made ${decisions.length} decision${decisions.length === 1 ? "" : "s"} on their own (${classCounts(decisions)}).`;
	const ask =
		askable.length === 0
			? " None needs you."
			: ` Check ${askable.length === 1 ? "this one" : `these ${askable.length}`}: ${askable
					.slice(0, 3)
					.map((d) => `${clip(d.question, 60)} → ${clip(d.chosen.label, 30)}`)
					.join("; ")}.`;
	const rest =
		askable.length < decisions.length ? " The rest are in your Feed." : "";
	return words(`${head}${ask}${rest}`, AGENT_DECISION_REVIEW_MAX_WORDS);
}

function decisionSource(decision: AgentDecision): string {
	if (decision.workItemId) return `/work/items/${decision.workItemId}`;
	if (decision.outputId) return `/outputs/${decision.outputId}`;
	return "/work";
}

function outcomeLine(decision: AgentDecision): string {
	if (!decision.outcome) return "Outcome not recorded yet.";
	const verb =
		decision.outcome.outcome === "worked"
			? "Worked"
			: decision.outcome.outcome === "reverted"
				? "Undone"
				: "Partly changed";
	return `${verb}${decision.outcome.by === "person" ? " by a person" : ""}: ${clip(decision.outcome.evidence, 200)}`;
}

function reversibilityLine(decision: AgentDecision): string {
	const reversible =
		decision.reversibility === "two_way"
			? "Easy to undo"
			: decision.reversibility === "one_way"
				? "Hard to undo"
				: "Unclear whether it can be undone";
	const effects = decision.protectedEffects.length
		? `; touches ${decision.protectedEffects.join(", ")}`
		: "";
	const confidence =
		decision.confidence === null
			? ""
			: `; confidence ${Math.round(decision.confidence * 100)}%`;
	return `${reversible}${effects}${confidence}.`;
}

/**
 * Feed projection: each decision a person may want to check is its own
 * "Decided by" update; the rest of each agent's day is one digest grouped by
 * class. Never a Deck question, never needs action.
 */
export function agentDecisionFeedItems(
	decisions: readonly AgentDecision[],
): ActivityFeedItem[] {
	const items: ActivityFeedItem[] = [];
	const digests = new Map<string, AgentDecision[]>();
	for (const decision of decisions) {
		if (decision.askable) {
			items.push({
				id: `agent-decision:${decision.id}`,
				actor: decision.agent.name,
				actorIdentity: {
					type: "agent",
					id: decision.agent.session || null,
					harness: decision.agent.harness,
				},
				sentence: clip(
					`Decided by ${decision.agent.name}: ${decision.chosen.label} — ${decision.question}`,
					1000,
				),
				source: decisionSource(decision),
				projectId: null,
				tediId: null,
				workItemId: decision.workItemId,
				kind: "result",
				classId: decision.classId,
				importance: decision.needsPerson ? "high" : "normal",
				at: decision.occurredAt,
				dueAt: null,
				needsAction: false,
				stalled: decision.outcome?.outcome === "reverted",
				done: true,
				explanation: clip(
					`${decision.reason}\n${reversibilityLine(decision)}\n${outcomeLine(decision)}`,
					2000,
				),
				reactions: ["why", "comment"],
			});
			continue;
		}
		const key = `${decision.agent.name}:${decision.occurredAt.slice(0, 10)}`;
		digests.set(key, [...(digests.get(key) ?? []), decision]);
	}
	for (const [key, rows] of digests) {
		const newest = rows[0]!;
		items.push({
			id: `agent-decisions:${key}`,
			actor: newest.agent.name,
			actorIdentity: { type: "agent", harness: newest.agent.harness },
			sentence: `Decided by ${newest.agent.name}: ${rows.length} routine decision${rows.length === 1 ? "" : "s"} (${classCounts(rows)}).`,
			source: rows.length === 1 ? decisionSource(newest) : "/work",
			projectId: null,
			tediId: null,
			workItemId: rows.length === 1 ? newest.workItemId : null,
			kind: "result",
			classId: `agent:${slug(newest.agent.name)}:digest`,
			importance: "low",
			at: newest.occurredAt,
			dueAt: null,
			needsAction: false,
			stalled: false,
			done: true,
			explanation: clip(
				rows
					.slice(0, 12)
					.map((row) => `• ${row.question} → ${row.chosen.label}`)
					.join("\n"),
				2000,
			),
			reactions: ["why", "mute"],
		});
	}
	return items;
}
