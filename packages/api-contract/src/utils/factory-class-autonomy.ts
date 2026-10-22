import type * as z from "zod";
import type { LearningInteractionEvent } from "../schemas/learning-feedback";
import type { CardReviewSource } from "../schemas/os-card-review";
import {
	DEFAULT_DECK_ROUTING,
	DecisionClassPolicySchema,
	type DecisionEnvelope,
	type DeckRoutingPolicy,
} from "../schemas/os-decision-deck";
import { humanReservedActionClasses } from "./approval-policy";
import {
	factoryCardDecisionEnvelope,
	factoryLearningClass,
	type ReviewCard,
} from "./card-review";
import {
	type DecisionStreakEvent,
	unchangedApprovalStreak,
} from "./decision-class-streak";

/**
 * Agent-decidable factory classes. A class a source lists in
 * `scoring.agentDecidableClasses` is a candidate for earned quiet delivery.
 * It graduates per person only through the existing class gate: N distinct
 * unchanged Do it verdicts in a row, the audit sample, and never when the
 * card needs a person. Status is derived from the append-only learning log,
 * so every graduation and demotion names its evidence.
 */

export type DecisionClassPolicy = z.infer<typeof DecisionClassPolicySchema>;
export type FactoryAutonomyEvent = DecisionStreakEvent &
	Pick<LearningInteractionEvent, "eventKind" | "surface">;

/** "Agent could do this" marks needed before a candidate is offered for handoff. */
export const AGENT_COULD_DO_REPEAT = 2;

export function isAgentDecidable(
	source: Pick<CardReviewSource, "scoring">,
	type: string,
): boolean {
	const wanted = type.trim().toLowerCase() || "card";
	return (source.scoring?.agentDecidableClasses ?? []).some(
		(entry) => entry.trim().toLowerCase() === wanted,
	);
}

/** Why a factory class always stays with a person; empty when nothing reserves it. */
export function factoryClassBlockers(
	source: Pick<CardReviewSource, "label" | "protectedEffects">,
	type: string,
	routing: DeckRoutingPolicy = DEFAULT_DECK_ROUTING,
): string[] {
	const classIds = [
		type.trim().toLowerCase() || "card",
		factoryLearningClass(source.label, type).toLowerCase(),
	];
	const critical = routing.criticalClasses.some((value) =>
		classIds.some(
			(classId) =>
				classId === value ||
				classId.startsWith(`${value}.`) ||
				classId.startsWith(`${value}:`),
		),
	);
	return [
		...new Set([
			...(source.protectedEffects ?? []).map((effect) => `protected:${effect}`),
			...(critical ? ["critical_class"] : []),
			...humanReservedActionClasses(`${source.label} ${type}`).map(
				(id) => `reserved:${id}`,
			),
		]),
	];
}

/** Class blockers plus anything the card's own action or draft reserves. */
export function factoryCardBlockers(
	source: Pick<CardReviewSource, "label" | "protectedEffects">,
	card: Pick<ReviewCard, "type" | "action" | "draft">,
	routing: DeckRoutingPolicy = DEFAULT_DECK_ROUTING,
): string[] {
	return [
		...new Set([
			...factoryClassBlockers(source, card.type, routing),
			...humanReservedActionClasses(`${card.action ?? ""}\n${card.draft}`).map(
				(id) => `reserved:${id}`,
			),
		]),
	];
}

/**
 * The envelope a candidate card is judged by. Listing a class as
 * agent-decidable states its Do it can be undone; protected effects, expiry
 * and the rest of the card envelope are kept, so `decisionNeedsPerson` still
 * applies. Null when the class is not listed.
 */
export function factoryAgentEnvelope(
	source: CardReviewSource,
	card: ReviewCard,
): DecisionEnvelope | null {
	if (!isAgentDecidable(source, card.type)) return null;
	return {
		...factoryCardDecisionEnvelope(source, card),
		classId: factoryLearningClass(source.label, card.type),
		reversibility: "two_way",
	};
}

/** An explicit class policy wins; listing the class is the opt-in otherwise. */
export function factoryClassPolicy(
	decisionClass: string,
	policies: Record<string, DecisionClassPolicy> = {},
): DecisionClassPolicy {
	return (
		policies[decisionClass] ??
		DecisionClassPolicySchema.parse({ autoApprove: true })
	);
}

export type FactoryDemotion = {
	eventId: string;
	at: string;
	reason: "undo" | "changed";
};

const POSITIVE = new Set(["useful", "do_it"]);

function cardKey(event: FactoryAutonomyEvent) {
	const row = event.metadata?.rowIndex;
	return `${event.targetId ?? event.id}:${typeof row === "number" ? row : ""}`;
}

/**
 * One person's factory verdicts for a class, as approval evidence the shared
 * streak reads. Do it is an unchanged approval; Useful, Later and "agent could
 * do this" are neutral; any other Not useful ends the run. An undo of a
 * verdict, an edit, or a card decided both ways demotes: nothing before the
 * latest demotion counts.
 */
export function factoryClassEvidence(
	events: readonly FactoryAutonomyEvent[],
	decisionClass: string,
	userId: string,
): {
	events: DecisionStreakEvent[];
	agentCouldDo: number;
	demotion: FactoryDemotion | null;
} {
	const wanted = decisionClass.toLowerCase();
	const mine = events.filter(
		(event) => event.actorType === "user" && event.actorId === userId,
	);
	const verdicts = mine.filter(
		(event) =>
			event.surface === "decision_deck" &&
			typeof event.metadata?.decisionClass === "string" &&
			event.metadata.decisionClass.toLowerCase() === wanted &&
			typeof event.metadata.decisionChoice === "string",
	);
	const ids = new Set(verdicts.map((event) => event.id));
	const demotions: FactoryDemotion[] = [];
	const undone = new Set<string>();
	for (const event of mine) {
		const corrects = event.metadata?.correctsEventId;
		if (
			event.eventKind === "undone" &&
			event.metadata?.learningCorrection === true &&
			typeof corrects === "string" &&
			ids.has(corrects)
		) {
			undone.add(corrects);
			demotions.push({
				eventId: event.id,
				at: event.occurredAt,
				reason: "undo",
			});
		}
	}
	const kept = verdicts.filter((event) => !undone.has(event.id));
	const byCard = new Map<string, FactoryAutonomyEvent[]>();
	for (const event of kept) {
		if (event.eventKind === "edited")
			demotions.push({
				eventId: event.id,
				at: event.occurredAt,
				reason: "changed",
			});
		const choice = event.metadata?.decisionChoice as string;
		if (choice !== "not_useful" && !POSITIVE.has(choice)) continue;
		byCard.set(cardKey(event), [...(byCard.get(cardKey(event)) ?? []), event]);
	}
	for (const decided of byCard.values()) {
		const polarity = new Set(
			decided.map((event) =>
				POSITIVE.has(event.metadata?.decisionChoice as string),
			),
		);
		if (polarity.size < 2) continue;
		const latest = decided.reduce((a, b) =>
			b.occurredAt > a.occurredAt ? b : a,
		);
		demotions.push({
			eventId: latest.id,
			at: latest.occurredAt,
			reason: "changed",
		});
	}
	const demotion =
		demotions.sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
	let agentCouldDo = 0;
	const evidence = kept
		.filter((event) => !demotion || event.occurredAt > demotion.at)
		.map((event): DecisionStreakEvent => {
			const choice = event.metadata?.decisionChoice;
			let signal: Record<string, string> = { decisionChoice: "later" };
			if (choice === "do_it")
				signal = {
					decisionChoice: "approve",
					feedbackSignal: "approve-as-is",
				};
			else if (choice === "not_useful") {
				if (event.metadata?.sharedReason === "agent_could_do") agentCouldDo++;
				else signal = { decisionChoice: "reject", feedbackSignal: "rejected" };
			}
			return {
				id: event.id,
				clientEventId: `decision-capture:${event.id}`,
				actorType: event.actorType,
				actorId: event.actorId,
				targetId: cardKey(event),
				metadata: { decisionClass, ...signal },
				occurredAt: event.occurredAt,
			};
		});
	return { events: evidence, agentCouldDo, demotion };
}

export type FactoryClassStatus =
	/** Reserved for a person; feedback cannot change this. */
	| "blocked"
	/** Earned quiet delivery for this person; audit samples still ask. */
	| "earned"
	/** Repeatedly marked "agent could do this"; offered, never graduated by it. */
	| "eligible"
	| "candidate";

export type FactoryClassStanding = {
	sourceLabel: string;
	type: string;
	decisionClass: string;
	status: FactoryClassStatus;
	blockers: string[];
	unchanged: number;
	threshold: number;
	auditSampleRate: number;
	agentCouldDo: number;
	evidenceIds: string[];
	demotion: FactoryDemotion | null;
};

/** One listed class's standing for one person. */
export function factoryClassStanding(input: {
	source: CardReviewSource;
	type: string;
	events: readonly FactoryAutonomyEvent[];
	userId: string;
	policies?: Record<string, DecisionClassPolicy>;
	routing?: DeckRoutingPolicy;
}): FactoryClassStanding {
	const decisionClass = factoryLearningClass(input.source.label, input.type);
	const policy = factoryClassPolicy(decisionClass, input.policies);
	const blockers = [
		...(isAgentDecidable(input.source, input.type) ? [] : ["not_listed"]),
		...factoryClassBlockers(input.source, input.type, input.routing),
	];
	const evidence = factoryClassEvidence(
		input.events,
		decisionClass,
		input.userId,
	);
	const streak = unchangedApprovalStreak(
		evidence.events,
		decisionClass,
		input.userId,
	);
	const status: FactoryClassStatus =
		blockers.length > 0
			? "blocked"
			: policy.autoApprove && streak.unchanged >= policy.unchangedThreshold
				? "earned"
				: evidence.agentCouldDo >= AGENT_COULD_DO_REPEAT
					? "eligible"
					: "candidate";
	return {
		sourceLabel: input.source.label,
		type: input.type,
		decisionClass,
		status,
		blockers,
		unchanged: streak.unchanged,
		threshold: policy.unchangedThreshold,
		auditSampleRate: policy.auditSampleRate,
		agentCouldDo: evidence.agentCouldDo,
		evidenceIds: streak.evidenceIds,
		demotion: evidence.demotion,
	};
}

/** Standings for every class the sources list. */
export function factoryClassStandings(input: {
	sources: readonly CardReviewSource[];
	events: readonly FactoryAutonomyEvent[];
	userId: string;
	policies?: Record<string, DecisionClassPolicy>;
	routing?: DeckRoutingPolicy;
}): FactoryClassStanding[] {
	return input.sources.flatMap((source) =>
		[...new Set(source.scoring?.agentDecidableClasses ?? [])].map((type) =>
			factoryClassStanding({ ...input, source, type }),
		),
	);
}

/** Stable audit draw, so a refresh cannot evade a sampled review. */
export function stableAuditSample(key: string): number {
	let hash = 2166136261;
	for (const char of key)
		hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
	return hash / 4294967296;
}

/** Plain-English line for a standing, for Settings, the Deck and the Feed. */
export function factoryStandingSentence(
	standing: FactoryClassStanding,
): string {
	const name = `${standing.sourceLabel} ${standing.type}`;
	switch (standing.status) {
		case "blocked":
			return `${name} cards stay with you: ${standing.blockers
				.map((blocker) => blocker.replace(/^[a-z_]+:/, "").replace(/_/g, " "))
				.join(", ")}.`;
		case "earned":
			return `An agent may decide ${name} cards for you: you did ${standing.unchanged} in a row unchanged. About ${Math.round(standing.auditSampleRate * 100)}% still come to you. Undo or change a verdict to take it back.`;
		case "eligible":
			return `Eligible to hand to an agent: you marked ${standing.agentCouldDo} ${name} cards "an agent could do this". An agent takes over after ${standing.threshold} unchanged Do it verdicts in a row.`;
		default:
			return `${name}: ${standing.unchanged} of ${standing.threshold} unchanged Do it verdicts in a row before an agent may decide these.`;
	}
}
