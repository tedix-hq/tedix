import type { DeckRetirementReason } from "../schemas/deck-curation";
import type {
	DeckGateRequirement,
	DeckHidingClass,
	DeckLearnedRule,
	DeckNotUsefulReason,
	DeckPipelineConfig,
	DeckPipelineMetrics,
	DeckPipelineStatus,
	DeckSweepReceipt,
} from "../schemas/deck-pipeline";
import { DecisionEnvelopeSchema } from "../schemas/os-decision-deck";
import { deckCardExpired, deckCardStale } from "./deck-ask";
import type { DecisionContext } from "../schemas/decision-graph";
import defaults from "../assets/deck-pipeline.v1.json";

type Metadata = Record<string, unknown>;

/** The agent (and its named producer) that put a card on the Deck. */
export function deckSourceKey(card: {
	creatorType: string;
	creatorId: string;
	metadata?: Metadata | null;
}) {
	const source = card.metadata?.source;
	return `${card.creatorType}:${card.creatorId}${
		typeof source === "string" && source.trim()
			? `:${source.trim().slice(0, 80)}`
			: ""
	}`.slice(0, 300);
}

/** Earned hiding is tracked per ask kind and source. */
export function deckHidingClassKey(askKind: string, sourceKey: string) {
	return `${askKind}|${sourceKey}`.slice(0, 300);
}

const STOPWORDS = new Set(
	"the a an to of for and or in on at by with from your you our this that is are be it its into about".split(
		" ",
	),
);
function contentWords(value: string) {
	return new Set(
		(
			value
				.normalize("NFKC")
				.toLowerCase()
				.match(/[\p{L}\p{N}]+/gu) ?? []
		).filter((word) => word.length > 1 && !STOPWORDS.has(word)),
	);
}

/** Jaccard overlap of content words; 1 means the same words. */
export function subjectSimilarity(a: string, b: string) {
	const x = contentWords(a);
	const y = contentWords(b);
	if (!x.size && !y.size) return 1;
	let shared = 0;
	for (const word of x) if (y.has(word)) shared += 1;
	return shared / (x.size + y.size - shared);
}

type GateCard = {
	kind: string;
	subject: string;
	prompt: string;
	workItemId?: string | null;
	caseId?: string | null;
	metadata?: Metadata | null;
};

function hasEvidence(card: GateCard) {
	const m = card.metadata ?? {};
	return (
		Boolean(card.workItemId || card.caseId) ||
		(Array.isArray(m.evidenceRefs) && m.evidenceRefs.length > 0) ||
		typeof m.sourceUrl === "string" ||
		typeof m.reportUrl === "string" ||
		m.decisionDeck !== undefined ||
		/https?:\/\/\S+|\/work\/items\/[0-9a-f-]{36}/i.test(card.prompt)
	);
}

/** S0: deterministic create-time rules. No model; protected asks always pass, flagged. */
export function evaluateDeckCreateGate(
	card: GateCard,
	config: DeckPipelineConfig["createGate"],
	options: { protected: boolean; ruleBounce?: DeckLearnedRule | null },
): {
	verdict: "pass" | "bounce" | "pass_protected";
	missing: DeckGateRequirement[];
	rule: string | null;
} {
	if (config.mode === "off")
		return { verdict: "pass", missing: [], rule: null };
	const m = card.metadata ?? {};
	const decision = DecisionEnvelopeSchema.safeParse(m.decisionDeck);
	const text = `${card.subject}\n${card.prompt}`;
	const checks: Record<DeckGateRequirement, () => boolean> = {
		ask: () =>
			decision.success ||
			["approval", "handoff"].includes(card.kind) ||
			m.schema === "tedix.outbound.v1" ||
			new RegExp(config.askPattern, "iu").test(text),
		recommendation: () =>
			(decision.success && decision.data.recommendation.trim().length > 0) ||
			(typeof m.recommendation === "string" &&
				m.recommendation.trim().length > 0) ||
			new RegExp(config.recommendationPattern, "iu").test(card.prompt),
		evidence: () => hasEvidence(card),
	};
	const missing = config.requirements.filter((key) => !checks[key]());
	const rule = options.ruleBounce?.id ?? null;
	if (!missing.length && !rule) return { verdict: "pass", missing, rule: null };
	return {
		verdict: options.protected ? "pass_protected" : "bounce",
		missing,
		rule,
	};
}

export function deckGateMessage(
	missing: readonly DeckGateRequirement[],
	rule: DeckLearnedRule | null | undefined,
) {
	const needs: Record<DeckGateRequirement, string> = {
		ask: "a clear ask (what the person must decide or do)",
		recommendation:
			"your recommendation (metadata.decisionDeck.recommendation or metadata.recommendation)",
		evidence: "evidence (a Work Item, metadata.evidenceRefs or a source link)",
	};
	const parts = missing.map((key) => needs[key]);
	return [
		parts.length
			? `This card was returned to you: it needs ${parts.join("; ")}.`
			: "",
		rule
			? `The recipient's learned rule says: ${rule.sentence} Handle it yourself or mark it protected.`
			: "",
		"Protected asks (consent, money, credentials, sending, deletion, legal) always reach the person.",
	]
		.filter(Boolean)
		.join(" ");
}

export type SweepCard = {
	id: string;
	kind: string;
	subject: string;
	prompt: string;
	creatorType: string;
	creatorId: string;
	workItemId: string | null;
	workItemDisposition?: string | null;
	dueAt: string | null;
	expiresAt: string | null;
	createdAt: string;
	metadata: Metadata;
	/**
	 * Agent-decision review card: the listed decision ids that still have no
	 * outcome. Its presence marks a review card, which is judged by those
	 * decisions, never by the Work Item it is filed under.
	 */
	pendingDecisions?: string[];
	protected: boolean;
	/** Latest revision by the card's owner; refreshes reset the overdue clock. */
	refreshedAt?: string | null;
	askKind: string;
	responseKind?: "task" | "choice" | "open";
	actionable?: boolean;
	/**
	 * The person taught "less like this" for the card's class often enough that
	 * routing would have sent it to the Feed; an ask is withdrawn, never hidden.
	 */
	learnedFeed?: boolean;
	graph?: Partial<
		Pick<
			DecisionContext,
			"priorDecision" | "supersededBy" | "duplicates" | "blocksCount"
		>
	>;
};

export type SweepAction = {
	cardId: string;
	reason: DeckRetirementReason;
	cause: "expired" | "handled" | "duplicate" | "rule";
	successorId?: string;
	workItemId?: string;
	note: string;
	evidenceRefs: string[];
	ruleId?: string;
};

/** S2 retires only expired asks, settled sources, graph facts and learned rules. */
export function planDeckSweep(input: {
	cards: readonly SweepCard[];
	now: Date;
	config: DeckPipelineConfig["sweep"];
	qualification?: DeckPipelineConfig["qualification"];
	timeZone?: string;
	rules: readonly DeckLearnedRule[];
}): { actions: SweepAction[]; proposals: SweepAction[] } {
	const { cards, now, config } = input;
	const qualification = input.qualification ?? defaults.qualification;
	const actions = new Map<string, SweepAction>();
	const add = (action: SweepAction) => {
		if (!actions.has(action.cardId)) actions.set(action.cardId, action);
	};
	for (const card of cards) {
		if (card.pendingDecisions) {
			if (!card.pendingDecisions.length)
				add({
					cardId: card.id,
					reason: "already_decided",
					cause: "handled",
					note: "Every listed decision already has an outcome.",
					evidenceRefs: [`work-interaction:${card.id}`],
				});
			continue;
		}
		const decision = DecisionEnvelopeSchema.safeParse(
			card.metadata.decisionDeck,
		).data;
		const prior = card.graph?.priorDecision;
		if (
			qualification.enabled &&
			qualification.alreadyDecided &&
			prior &&
			card.responseKind !== "task"
		) {
			add({
				cardId: card.id,
				reason: "already_decided",
				cause: "handled",
				note: "Already decided.",
				evidenceRefs: [
					prior.edge.evidenceRef ?? `${prior.node.kind}:${prior.node.id}`,
				],
			});
			continue;
		}
		if (
			deckCardStale(
				{
					dueAt: card.dueAt,
					decision,
					request: {
						subject: card.subject,
						prompt: card.prompt,
						expiresAt: card.expiresAt,
						metadata: card.metadata,
						creatorType: card.creatorType,
					},
					workItem: { disposition: card.workItemDisposition },
				},
				now,
				qualification,
				input.timeZone,
			)
		) {
			add({
				cardId: card.id,
				reason: "expired",
				cause: "expired",
				workItemId: card.workItemId ?? undefined,
				note: "Withdrawn: check the source before asking again. Create a fresh ask only if a decision is still needed.",
				evidenceRefs: card.workItemId
					? [`/work/items/${card.workItemId}`]
					: [`work-interaction:${card.id}`],
			});
			continue;
		}
		if (
			card.creatorType !== "user" &&
			deckCardExpired({ decision, request: { expiresAt: card.expiresAt } }, now)
		) {
			add({
				cardId: card.id,
				reason: "expired",
				cause: "expired",
				note: "The ask passed its expiry and can no longer be acted on.",
				evidenceRefs: [`work-interaction:${card.id}`],
			});
			continue;
		}
		if (card.workItemId && card.workItemDisposition === "completed") {
			add({
				cardId: card.id,
				reason: "already_decided",
				cause: "handled",
				workItemId: card.workItemId,
				note: "Already decided.",
				evidenceRefs: [`/work/items/${card.workItemId}`],
			});
			continue;
		}
		if (
			!card.protected &&
			card.workItemId &&
			card.workItemDisposition === "cancelled"
		) {
			add({
				cardId: card.id,
				reason: "handled_elsewhere",
				cause: "handled",
				workItemId: card.workItemId,
				note: "Its Work Item is cancelled.",
				evidenceRefs: [`/work/items/${card.workItemId}`],
			});
		}
	}
	// A reminder folds into its original ask; it is never kept over it.
	const byId = new Map(cards.map((card) => [card.id, card]));
	for (const card of cards) {
		const nudge = card.metadata.laneNudge;
		const originalId =
			nudge && typeof nudge === "object" && "requestId" in nudge
				? nudge.requestId
				: undefined;
		const original =
			typeof originalId === "string" ? byId.get(originalId) : undefined;
		if (original && !actions.has(original.id))
			add({
				cardId: card.id,
				reason: "duplicate",
				cause: "duplicate",
				successorId: original.id,
				workItemId: original.workItemId ?? undefined,
				note: "A reminder of the linked ask.",
				evidenceRefs: [`work-interaction:${original.id}`],
			});
	}
	// Only linked cards in this recipient's bounded live set can be keepers.
	const newestFirst = [...cards].sort(
		(a, b) =>
			b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
	);
	if (qualification.enabled && qualification.graphDuplicates) {
		const groups = new Map(cards.map((card) => [card.id, card.id]));
		const group = (id: string) => {
			let current = id;
			while (groups.get(current) && groups.get(current) !== current)
				current = groups.get(current)!;
			return current;
		};
		for (const card of cards)
			for (const other of card.graph?.duplicates ?? []) {
				if (groups.has(other)) groups.set(group(card.id), group(other));
			}
		// Directed supersedes takes precedence over age-based duplicate selection.
		for (const card of newestFirst) {
			if (actions.has(card.id)) continue;
			const successor = card.graph?.supersededBy;
			if (!successor) continue;
			const keeper = newestFirst.find(
				(c) =>
					c.id === successor.node.id &&
					!actions.has(c.id) &&
					(!card.protected || c.protected),
			);
			if (
				successor.node.kind === "deck_card" &&
				keeper &&
				keeper.id !== card.id &&
				keeper.graph?.supersededBy?.node.id !== card.id
			)
				add({
					cardId: card.id,
					reason: "superseded",
					cause: "duplicate",
					successorId: keeper.id,
					note: `Replaced by ${keeper.id}.`,
					evidenceRefs: [
						successor.edge.evidenceRef ?? `work-interaction:${keeper.id}`,
					],
				});
		}
		for (const [index, older] of newestFirst.entries()) {
			if (actions.has(older.id)) continue;
			const keeper = newestFirst
				.slice(0, index)
				.find(
					(newer) =>
						!actions.has(newer.id) &&
						(newer.responseKind === "task") ===
							(older.responseKind === "task") &&
						(!older.protected || newer.protected) &&
						group(older.id) === group(newer.id),
				);
			if (keeper)
				add({
					cardId: older.id,
					reason: "duplicate",
					cause: "duplicate",
					successorId: keeper.id,
					workItemId: keeper.workItemId ?? undefined,
					note: `Merged into ${keeper.id}.`,
					evidenceRefs: [`work-interaction:${keeper.id}`],
				});
		}
	}
	for (const rule of input.rules) {
		for (const card of cards) {
			if (
				actions.has(card.id) ||
				card.protected ||
				deckSourceKey(card) !== rule.sourceKey
			)
				continue;
			// An "agent could do it" rule bounces new asks at create time; the
			// sweep records no agent route, so an open ask stays visible.
			if (rule.reason === "not_for_me")
				add({
					cardId: card.id,
					cause: "rule",
					ruleId: rule.id,
					reason: "no_longer_relevant",
					note: rule.sentence,
					evidenceRefs: [`deck-rule:${rule.id}`],
				});
		}
	}
	for (const card of cards)
		if (card.learnedFeed && !card.protected && !actions.has(card.id))
			add({
				cardId: card.id,
				reason: "no_longer_relevant",
				cause: "rule",
				note: "Withdrawn: you marked asks like this as not worth your time. Undo puts it back.",
				evidenceRefs: [`work-interaction:${card.id}`],
			});
	return {
		actions: [...actions.values()].slice(0, config.maxRetirementsPerRun),
		proposals: [],
	};
}

/** The retirement each "Not useful" chip implies for the card in hand. */
export function notUsefulRetirement(
	reason: DeckNotUsefulReason,
): DeckRetirementReason {
	switch (reason) {
		case "already_decided":
			return "handled_elsewhere";
		case "expired":
			return "expired";
		case "duplicate":
			return "duplicate";
		case "agent_could_do":
		case "not_for_me":
			return "no_longer_relevant";
	}
}

const RULE_SENTENCES: Record<DeckNotUsefulReason, (source: string) => string> =
	{
		already_decided: (s) =>
			`Cards from ${s} that repeat an ask you already answered retire automatically.`,
		expired: (s) =>
			`Cards from ${s} retire automatically once their deadline passes.`,
		agent_could_do: (s) =>
			`Asks from ${s} go back to the agent to handle itself.`,
		duplicate: (s) =>
			`Near-duplicate cards from ${s} fold into the newest one.`,
		not_for_me: (s) => `Cards from ${s} stay out of your Decisions.`,
	};

export function deckSourceLabel(sourceKey: string) {
	const [type, id, source] = sourceKey.split(":");
	const who = type === "tedi" ? "tedi" : type === "system" ? "Tedix" : "agent";
	return source ? `${source} (${who})` : `${who} ${String(id).slice(0, 8)}`;
}

/** S6: N identical reasons from one source become a removable D1 rule. */
export function deriveDeckRule(input: {
	recipientId: string;
	sourceKey: string;
	reason: DeckNotUsefulReason;
	/** Earlier "Not useful" event ids with this reason and source, plus this one. */
	evidenceIds: readonly string[];
	existing: readonly DeckLearnedRule[];
	threshold: number;
	now: Date;
}): DeckLearnedRule | null {
	if (input.evidenceIds.length < input.threshold) return null;
	if (
		input.existing.some(
			(rule) =>
				rule.recipientId === input.recipientId &&
				rule.sourceKey === input.sourceKey &&
				rule.reason === input.reason,
		)
	)
		return null;
	return {
		id: `rule-${input.reason}-${hash(`${input.recipientId}|${input.sourceKey}`)}`,
		recipientId: input.recipientId,
		sourceKey: input.sourceKey,
		reason: input.reason,
		sentence: RULE_SENTENCES[input.reason](deckSourceLabel(input.sourceKey)),
		evidenceIds: input.evidenceIds.slice(-20),
		createdAt: input.now.toISOString(),
	};
}

function hash(value: string) {
	let h = 2166136261;
	for (let i = 0; i < value.length; i++) {
		h ^= value.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(36);
}

export type HidingSwipe = {
	classKey: string;
	/** true: the person found it valuable (answered or "useful"). */
	valuable: boolean;
	/** Qwen and the second key both said NOISE when it was shown. */
	wouldHide: boolean;
};

/**
 * Earned hiding per class (never before `notBefore`): on after N cards the
 * person found useful with none that Qwen NOISE plus the second key would have
 * hidden, and few not-useful cards among those kept; off again after K undos
 * among the last W hides or any useful card it would hide.
 */
export function nextHidingClasses(input: {
	recipientId: string;
	classes: readonly DeckHidingClass[];
	swipes: readonly HidingSwipe[];
	/** Card ids that were hidden and are open again (the person undid them). */
	undone: ReadonlySet<string>;
	config: DeckPipelineConfig["earnedHiding"];
	now: Date;
}): DeckHidingClass[] {
	const at = input.now.toISOString();
	const byClass = new Map<string, HidingSwipe[]>();
	for (const swipe of input.swipes)
		byClass.set(swipe.classKey, [
			...(byClass.get(swipe.classKey) ?? []),
			swipe,
		]);
	const result = new Map(
		input.classes
			.filter((entry) => entry.recipientId === input.recipientId)
			.map((entry) => [entry.classKey, { ...entry }]),
	);
	const earned = input.now.getTime() >= Date.parse(input.config.notBefore);
	for (const [classKey, swipes] of byClass) {
		const current = result.get(classKey);
		const useful = swipes.filter((swipe) => swipe.valuable);
		const valuableHidden = useful.filter((swipe) => swipe.wouldHide).length;
		const kept = swipes.filter((swipe) => !swipe.wouldHide);
		const keptNoise = kept.filter((swipe) => !swipe.valuable).length;
		if (
			earned &&
			current?.state !== "hiding" &&
			useful.length >= input.config.minUsefulCards &&
			valuableHidden <= input.config.maxValuableHidden &&
			keptNoise <= kept.length * input.config.maxKeptNotUsefulRate
		)
			result.set(classKey, {
				recipientId: input.recipientId,
				classKey,
				state: "hiding",
				changedAt: at,
				reason: `${useful.length} useful cards, ${valuableHidden} would have been hidden`,
				recentHides: current?.recentHides ?? [],
			});
	}
	for (const [classKey, entry] of result) {
		if (entry.state !== "hiding") continue;
		const window = entry.recentHides.slice(-input.config.demoteWindow);
		const undos = window.filter((id) => input.undone.has(id)).length;
		const valuableHidden = (byClass.get(classKey) ?? []).filter(
			(swipe) => swipe.valuable && swipe.wouldHide,
		).length;
		if (
			undos >= input.config.demoteUndos ||
			valuableHidden > input.config.maxValuableHidden
		)
			result.set(classKey, {
				...entry,
				state: "shadow",
				changedAt: at,
				reason:
					undos >= input.config.demoteUndos
						? `${undos} undos in the last ${window.length} hides`
						: `${valuableHidden} valuable cards would have been hidden`,
				recentHides: [],
			});
	}
	return [
		...input.classes.filter((entry) => entry.recipientId !== input.recipientId),
		...result.values(),
	];
}

export function deckPipelineStatus(
	receipt: DeckSweepReceipt | null,
	config: DeckPipelineConfig,
	recipientId: string | null,
	now: Date,
): DeckPipelineStatus {
	const lastCleanedAt = receipt?.at ?? null;
	const {
		removed: _removed,
		metrics,
		...lastSweep
	} = receipt ?? {
		removed: [],
		metrics: [],
	};
	return {
		lastCleanedAt,
		stale:
			config.sweep.mode !== "off" &&
			(!lastCleanedAt ||
				now.getTime() - Date.parse(lastCleanedAt) >
					config.sweep.staleAfterHours * 3_600_000),
		staleAfterHours: config.sweep.staleAfterHours,
		lastSweep: receipt ? (lastSweep as DeckPipelineStatus["lastSweep"]) : null,
		metrics: metrics.find((entry) => entry.recipientId === recipientId) ?? null,
		rules: recipientId
			? config.rules.filter((rule) => rule.recipientId === recipientId)
			: [],
	};
}

/** Week-1 go/no-go verdicts for the Deck rail and the daily Feed digest. */
export function deckWeekOneVerdicts(metrics: DeckPipelineMetrics) {
	const live = metrics.morning?.liveCards ?? metrics.liveCards;
	const rate = metrics.settled ? metrics.notUseful / metrics.settled : null;
	const wrongRate = metrics.removals
		? metrics.wrongRemovals / metrics.removals
		: 0;
	const verdict = (go: boolean, noGo: boolean) =>
		go ? "go" : noGo ? "no_go" : "watch";
	return {
		liveCards: { value: live, verdict: verdict(live <= 10, live > 15) },
		notUsefulRate: {
			value: rate,
			verdict: rate === null ? "watch" : verdict(rate <= 0.25, rate > 0.4),
		},
		wrongRemovals: {
			value: metrics.wrongRemovals,
			protected: metrics.wrongProtectedRemovals,
			verdict: verdict(
				metrics.wrongProtectedRemovals === 0 && wrongRate <= 0.05,
				metrics.wrongProtectedRemovals > 0 || metrics.wrongRemovals > 3,
			),
		},
	} as const;
}
