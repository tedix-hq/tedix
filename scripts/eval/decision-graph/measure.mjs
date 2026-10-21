import { createHash } from "node:crypto";
import { DecisionContextSchema } from "@tedix/api-contract/schemas/decision-graph";
import { DeckPipelineConfigSchema } from "@tedix/api-contract/schemas/deck-pipeline";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { humanReservedActionClasses } from "@tedix/api-contract/utils/approval-policy";
import { credentialCard } from "@tedix/api-contract/utils/card-secrets";
import { deckAskKind } from "@tedix/api-contract/utils/deck-ask";
import {
	deckSourceKey,
	planDeckSweep,
} from "@tedix/api-contract/utils/deck-pipeline";
import {
	compareDeckOrders,
	ruleRankDeck,
} from "@tedix/api-contract/utils/deck-rule-rank";
import {
	deckInteractionKind,
	projectDeckCards,
} from "@tedix/api-contract/utils/deck-projection";

export const RULES = ["already_decided", "duplicate", "stale"];
const hash = (text) => createHash("sha256").update(text).digest("hex");

export function sweepCard(row) {
	const r = row.request;
	const m = r.metadata;
	const decision = DecisionEnvelopeSchema.safeParse(m.decisionDeck);
	return {
		...r,
		createdAt: r.requestedAt,
		kind: deckInteractionKind(r.kind, m),
		protected:
			r.kind === "handoff" ||
			r.kind === "approval" ||
			m.schema === "tedix.outbound.v1" ||
			m.approvalOperation !== undefined ||
			Boolean(m.localImport) ||
			["high", "critical"].includes(String(m.riskLevel)) ||
			(m.protectedEffects !== undefined &&
				(!Array.isArray(m.protectedEffects) ||
					m.protectedEffects.length > 0)) ||
			(m.decisionDeck !== undefined &&
				(!decision.success || decision.data.protectedEffects.length > 0)) ||
			humanReservedActionClasses(`${r.subject}\n${r.prompt}`).length > 0 ||
			credentialCard(`${r.subject} ${r.prompt}`, m),
		askKind: deckAskKind({
			kind: r.kind,
			decision: decision.data,
			request: { metadata: m },
		}),
		workItemDisposition: row.workItem?.disposition ?? null,
	};
}

/** Shadow recommendations from the landed context API; never executes a retirement. */
export function graphRecommendations(cards, contexts) {
	const byId = new Map(cards.map((c) => [c.id, c]));
	const candidates = [];
	for (const card of cards) {
		const raw = contexts[card.id];
		if (!raw) continue;
		const context = DecisionContextSchema.parse(raw);
		if (context.cardId !== card.id) throw new Error("Context/card mismatch");
		if (card.protected || card.creatorType === "user") continue;
		// A card's own answer is its outcome, not an earlier decision it repeated.
		if (
			context.priorDecision &&
			!(
				context.priorDecision.edge.kind === "card_answers" &&
				context.priorDecision.edge.from.id === card.id
			)
		)
			candidates.push({
				cardId: card.id,
				rule: "already_decided",
				evidence: context.priorDecision.edge.evidenceRef,
				linkedId: context.priorDecision.node.id,
			});
		if (context.supersededBy)
			candidates.push({
				cardId: card.id,
				rule: "stale",
				evidence: context.supersededBy.edge.evidenceRef,
				linkedId: context.supersededBy.node.id,
			});
		// One deterministic keeper, never retire every member of a duplicate group.
		const peers = context.duplicates.map((id) => byId.get(id)).filter(Boolean);
		const newer = peers.filter(
			(p) =>
				p.createdAt > card.createdAt ||
				(p.createdAt === card.createdAt && p.id < card.id),
		);
		newer.sort(
			(a, b) =>
				b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
		);
		if (newer.length)
			candidates.push({
				cardId: card.id,
				rule: "duplicate",
				linkedId: newer[0].id,
				evidence: `work-interaction:${newer[0].id}`,
			});
	}
	return candidates;
}

/** Selection is independent of labels and stable across input ordering. */
export function sample(candidates, rule, seed = "decision-graph-v1") {
	return candidates
		.filter((c) => c.rule === rule)
		.sort((a, b) =>
			hash(`${seed}:${rule}:${a.cardId}`).localeCompare(
				hash(`${seed}:${rule}:${b.cardId}`),
			),
		)
		.slice(0, 20);
}

/** @returns {Record<import("./types").Rule, import("./types").PrecisionResult>} */
export function precision(candidates, labels, seed) {
	return Object.fromEntries(
		RULES.map((rule) => {
			const selected = sample(candidates, rule, seed).map((c) => {
				const label = labels.find(
					(l) => l.cardId === c.cardId && l.rule === rule,
				);
				if (
					label &&
					(typeof label.correct !== "boolean" ||
						!label.evidenceRef ||
						!label.note ||
						!label.sourceType ||
						!label.observedAt)
				)
					throw new Error(
						"Labels require a verdict and independent dated evidence",
					);
				return { ...c, label: label ?? null };
			});
			const checked = selected.filter((c) => c.label);
			const correct = checked.filter((c) => c.label.correct).length;
			return [
				rule,
				{
					eligible: candidates.filter((c) => c.rule === rule).length,
					sampled: selected.length,
					shortfall: 20 - selected.length,
					checked: checked.length,
					correct,
					contradicted: checked.length - correct,
					unknown: selected.length - checked.length,
					precision: checked.length ? correct / checked.length : null,
					labelCoverage: selected.length
						? checked.length / selected.length
						: null,
					examples: selected,
				},
			];
		}),
	);
}

/** @returns {import("./types").Measurement} */
export function measure(snapshot, labels = [], seed = "decision-graph-v1") {
	const now = new Date(snapshot.observedAt);
	if (!Number.isFinite(now.getTime()))
		throw new Error("Invalid observation time");
	const cutoff = new Date(now.getTime() - 30 * 86400000).toISOString();
	const config = DeckPipelineConfigSchema.parse(snapshot.baselineConfig ?? {});
	const recipients = new Set(
		snapshot.rows.map((r) => r.request.requestedFromId).filter(Boolean),
	);
	config.rules = config.rules.filter((rule) =>
		recipients.has(rule.recipientId),
	);
	const answered = snapshot.rows
		.filter((r) => r.effectiveState === "resolved")
		.map((r) => ({
			id: r.request.id,
			subject: r.request.subject,
			sourceKey: deckSourceKey(r.request),
		}));
	const historicalIds = new Set(
		projectDeckCards({
			requests: snapshot.rows.map((row) => ({
				...row,
				effectiveState: "open",
				canRespond: true,
			})),
			work: [],
			runtime: [],
			now,
			timeZone: snapshot.timeZone ?? "UTC",
		}).map((c) => c.id),
	);
	const all = snapshot.rows
		.filter(
			(r) =>
				historicalIds.has(r.request.id) ||
				snapshot.currentIds.includes(r.request.id),
		)
		.map(sweepCard);
	const byId = new Map(all.map((c) => [c.id, c]));
	const cohorts = {
		current: snapshot.currentIds.map((id) => byId.get(id)).filter(Boolean),
		last30Days: all.filter(
			(c) => c.createdAt >= cutoff && c.createdAt <= snapshot.observedAt,
		),
	};
	const result = {};
	const uniqueCandidates = new Map();
	for (const [name, cards] of Object.entries(cohorts)) {
		const graph = graphRecommendations(cards, snapshot.contexts);
		for (const c of graph) uniqueCandidates.set(`${c.rule}:${c.cardId}`, c);
		const baseline = planDeckSweep({
			cards,
			now,
			config: config.sweep,
			rules: config.rules,
			answered,
		});
		const graphRemoved = new Set(graph.map((c) => c.cardId));
		const baselineRemoved = new Set(baseline.actions.map((c) => c.cardId));
		const actionable = cards.filter(
			(c) =>
				!graphRemoved.has(c.id) &&
				!baselineRemoved.has(c.id) &&
				snapshot.contexts[c.id],
		);
		const ranked = ruleRankDeck(actionable, now, snapshot.timeZone ?? "UTC");
		const before =
			name === "current"
				? snapshot.currentIds.filter((id) =>
						actionable.some((c) => c.id === id),
					)
				: ranked.map((r) => r.card.id);
		const tiers = new Map(ranked.map((r) => [r.card.id, r.tier]));
		const buckets = new Map();
		for (const id of before) {
			const tier = tiers.get(id);
			if (!buckets.has(tier)) buckets.set(tier, []);
			buckets.get(tier).push(id);
		}
		for (const ids of buckets.values())
			ids.sort(
				(a, b) =>
					snapshot.contexts[b].blocksCount - snapshot.contexts[a].blocksCount,
			);
		// Keep every priority tier in its observed slots; zero blocked counts preserve the baseline.
		const after = before.map((id) => buckets.get(tiers.get(id)).shift());
		result[name] = {
			cards: cards.length,
			contextRead: cards.filter((c) => snapshot.contexts[c.id]).length,
			protected: cards.filter((c) => c.protected).length,
			graph: Object.fromEntries(
				RULES.map((rule) => [
					rule,
					graph.filter((c) => c.rule === rule).length,
				]),
			),
			graphUniqueRemovals: graphRemoved.size,
			incrementalRemovals: [...graphRemoved].filter(
				(id) => !baselineRemoved.has(id),
			).length,
			baseline: {
				actions: baseline.actions.length,
				proposals: baseline.proposals.length,
				byReason: Object.fromEntries(
					[...new Set(baseline.actions.map((a) => a.reason))].map((reason) => [
						reason,
						baseline.actions.filter((a) => a.reason === reason).length,
					]),
				),
			},
			ranking: {
				...compareDeckOrders(before, after),
				moved: before.filter((id, i) => after[i] !== id).length,
				before,
				after,
				blocked: Object.fromEntries(
					actionable.map((c) => [
						c.id,
						snapshot.contexts[c.id]?.blocksCount ?? null,
					]),
				),
			},
			candidates: graph,
		};
	}
	return {
		observedAt: snapshot.observedAt,
		cutoff,
		mode: snapshot.mode,
		deployment: snapshot.deployment,
		coverage: snapshot.coverage,
		baselineConfigSource:
			snapshot.baselineConfigSource ??
			"versioned defaults (organization override unavailable)",
		currentUnmapped: snapshot.currentIds.filter((id) => !byId.has(id)),
		cohorts: result,
		precision: precision([...uniqueCandidates.values()], labels, seed),
		caveats: [
			"Read-only shadow recommendations, not executed retirements or measured time savings. Validate against the production graph gate before claiming identical behavior.",
			"Last-30-day cohort uses today's graph and default Deck routing, not a replay of information available when each card was created; recipient-specific routing overrides are unverified.",
			"Rule counts overlap; graphUniqueRemovals counts cards once. Historical cards are scored together, including resolved cards; these are retrospective opportunities, not current removable cards. A card's own answer is excluded as prior-decision evidence.",
			"Current rank baseline is the observed Deck order; historical baseline uses ruleRankDeck. countBlocked sorts within priority tiers on shared survivors, holding retirement effects separate.",
			"Graph reads are bounded by the core API (four hops and bounded edge reads); absent links do not prove no relationship.",
		],
	};
}

export function markdown(result) {
	const lines = [
		"# Decision graph — measured value",
		"",
		`Observed ${result.observedAt}. Mode: ${result.mode}.`,
		"",
		"| Cohort | Cards | Contexts | Already decided | Duplicate | Superseded/stale | Unique | Additional vs text | Rank moved |",
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
	];
	for (const [name, c] of Object.entries(result.cohorts))
		lines.push(
			`| ${name} | ${c.cards} | ${c.contextRead} | ${c.graph.already_decided} | ${c.graph.duplicate} | ${c.graph.stale} | ${c.graphUniqueRemovals} | ${c.incrementalRemovals} | ${c.ranking.moved} |`,
		);
	lines.push(
		"",
		"## Precision",
		"",
		"| Rule | Eligible | Sampled | Checked | Correct | Contradicted | Unknown | Precision among checked |",
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
	);
	for (const [rule, p] of Object.entries(result.precision))
		lines.push(
			`| ${rule} | ${p.eligible} | ${p.sampled} | ${p.checked} | ${p.correct} | ${p.contradicted} | ${p.unknown} | ${p.precision === null ? "unmeasured" : `${(100 * p.precision).toFixed(1)}%`} |`,
		);
	lines.push(
		"",
		`Baseline configuration: ${result.baselineConfigSource}.`,
		"",
		`Coverage: ${JSON.stringify(result.coverage)}. Unmapped current cards: ${result.currentUnmapped.length}.`,
		"",
		`Deployment: ${JSON.stringify(result.deployment ?? null)}.`,
		"",
		...result.caveats.map((c) => `- ${c}`),
	);
	for (const [name, c] of Object.entries(result.cohorts))
		lines.push(
			"",
			`## ${name} baseline and ranking`,
			"",
			`Text actions ${c.baseline.actions}; text proposals ${c.baseline.proposals}. Reasons: ${JSON.stringify(c.baseline.byReason)}. Pairwise disagreement ${c.ranking.discordant}/${c.ranking.pairs}; top-${c.ranking.topK} overlap ${c.ranking.topOverlap}.`,
		);
	for (const [rule, p] of Object.entries(result.precision)) {
		lines.push(
			"",
			`## ${rule} examples`,
			"",
			`Sample shortfall: ${p.shortfall}.`,
		);
		for (const e of p.examples)
			lines.push(
				"",
				`- Card ${e.cardId}; linked ${e.linkedId}; graph evidence ${e.evidence ?? "none"}. ${e.label ? `${e.label.correct ? "Supported" : "Contradicted"}: ${e.label.note} (${e.label.sourceType}, ${e.label.observedAt}, ${e.label.evidenceRef})` : "Ground truth unknown."}`,
			);
	}
	return `${lines.join("\n")}\n`;
}
