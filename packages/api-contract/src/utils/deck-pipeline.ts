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
import { deckCardExpired } from "./deck-ask";

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
	protected: boolean;
	/** Latest revision by the card's owner; refreshes reset the overdue clock. */
	refreshedAt?: string | null;
	askKind: string;
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

/**
 * S2: which live cards leave the Deck. Deterministic and bounded by its input.
 * Only a hard expiry, a finished Work Item, an exact duplicate or a learned
 * rule retires a card; a missed due time never does (it is still actionable).
 * A protected ask leaves only when it hard-expired or when an agent's own
 * duplicate folds into a protected card with the same ask.
 */
export function planDeckSweep(input: {
	cards: readonly SweepCard[];
	now: Date;
	config: DeckPipelineConfig["sweep"];
	rules: readonly DeckLearnedRule[];
	/** Recently answered cards; feed the "already decided" rule. */
	answered?: readonly { id: string; sourceKey: string; subject: string }[];
}): { actions: SweepAction[]; proposals: SweepAction[] } {
	const { cards, now, config } = input;
	const actions = new Map<string, SweepAction>();
	const proposals: SweepAction[] = [];
	const add = (action: SweepAction) => {
		if (!actions.has(action.cardId)) actions.set(action.cardId, action);
	};
	const nowMs = now.getTime();
	for (const card of cards) {
		const decision = DecisionEnvelopeSchema.safeParse(
			card.metadata.decisionDeck,
		).data;
		const agentCard = card.creatorType !== "user";
		if (
			agentCard &&
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
		if (card.protected) continue;
		if (
			card.workItemId &&
			(card.workItemDisposition === "completed" ||
				card.workItemDisposition === "cancelled")
		) {
			add({
				cardId: card.id,
				reason: "handled_elsewhere",
				cause: "handled",
				workItemId: card.workItemId,
				note: `Its Work Item is ${card.workItemDisposition}.`,
				evidenceRefs: [`/work/items/${card.workItemId}`],
			});
			continue;
		}
	}

	// Newer supersedes older on an exact key: same agent, same Work Item (or
	// none; a learned duplicate rule drops this), same ask kind, same subject.
	const live = cards.filter((card) => !actions.has(card.id));
	const newestFirst = [...live].sort(
		(a, b) =>
			b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
	);
	const duplicateRuleSources = new Set(
		input.rules
			.filter((rule) => rule.reason === "duplicate")
			.map((rule) => rule.sourceKey),
	);
	for (const [index, older] of newestFirst.entries()) {
		if (older.creatorType === "user" || actions.has(older.id)) continue;
		const source = deckSourceKey(older);
		const learned = duplicateRuleSources.has(source);
		const keeper = newestFirst
			.slice(0, index)
			.find(
				(newer) =>
					!actions.has(newer.id) &&
					newer.creatorType === older.creatorType &&
					newer.creatorId === older.creatorId &&
					newer.askKind === older.askKind &&
					(learned || (newer.workItemId ?? "") === (older.workItemId ?? "")) &&
					(!older.protected || newer.protected) &&
					subjectSimilarity(newer.subject, older.subject) >=
						config.duplicateSimilarity,
			);
		if (keeper)
			add({
				cardId: older.id,
				reason: "duplicate",
				cause: "duplicate",
				successorId: keeper.id,
				workItemId: keeper.workItemId ?? undefined,
				note: `Superseded by the newer card “${keeper.subject.slice(0, 120)}”.`,
				evidenceRefs: [`work-interaction:${keeper.id}`],
			});
	}

	// Learned rules never touch a protected ask; at most they lower it.
	for (const rule of input.rules) {
		for (const card of cards) {
			if (actions.has(card.id) || card.protected) continue;
			if (deckSourceKey(card) !== rule.sourceKey) continue;
			const base = {
				cardId: card.id,
				cause: "rule" as const,
				ruleId: rule.id,
				evidenceRefs: [`deck-rule:${rule.id}`],
			};
			if (rule.reason === "not_for_me" || rule.reason === "agent_could_do")
				add({ ...base, reason: "no_longer_relevant", note: rule.sentence });
			else if (rule.reason === "already_decided") {
				// A fuzzy match only proposes; settling needs a cited decision record.
				const match = input.answered?.find(
					(answered) =>
						answered.id !== card.id &&
						answered.sourceKey === rule.sourceKey &&
						subjectSimilarity(answered.subject, card.subject) >=
							config.duplicateSimilarity,
				);
				if (match)
					proposals.push({
						cardId: card.id,
						reason: "handled_elsewhere",
						cause: "rule",
						ruleId: rule.id,
						note: rule.sentence,
						evidenceRefs: [
							`deck-rule:${rule.id}`,
							`work-interaction:${match.id}`,
						],
					});
			}
			// "expired" rules act at create time: the card's due time becomes its expiry.
		}
	}
	return {
		actions: [...actions.values()].slice(0, config.maxRetirementsPerRun),
		proposals,
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
		not_for_me: (s) => `Cards from ${s} stay off your Deck.`,
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
