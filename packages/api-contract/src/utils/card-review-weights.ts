import type { DeckNotUsefulReason } from "../schemas/deck-pipeline";
import type {
	CardReviewSource,
	FactoryWeightProposal,
} from "../schemas/os-card-review";
import { factoryLearningClass } from "./card-review";

/**
 * Weekly weight update for a scored factory source. Verdicts recorded with a
 * card's features (`factory:<label>:<type>` learning events) become labelled
 * samples: Useful and Do it count as positive, Not useful as negative, and a
 * skip reason sets how much a negative counts. A regularised logistic step
 * from the current weights, bounded per weight, proposes the new weights.
 * Nothing here applies them; promotion stays with a person.
 */

type Weights = Record<string, number>;

export type FactoryVerdictEvent = {
	id: string;
	actorType: string;
	actorId: string | null;
	targetId: string | null;
	occurredAt: string;
	metadata: Record<string, unknown> | null;
};

export type WeightSample = {
	/** One card: its sheet and row. A later verdict on the same card wins. */
	key: string;
	reviewerId: string | null;
	features: Weights;
	label: 0 | 1;
	/** How much the sample counts, from 0 to 1. */
	weight: number;
	reason: string | null;
	occurredAt: string;
};

/** Default share a Not useful counts by shared reason: pipeline misses teach ranking little. */
const DEFAULT_REASON_WEIGHTS: Record<DeckNotUsefulReason, number> = {
	duplicate: 0.25,
	already_decided: 0.25,
	expired: 0.5,
	agent_could_do: 0.5,
	not_for_me: 1,
};

const FEATURE_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_FEATURES = 30;
const MAX_REVIEWERS = 20;
const DEFAULT_MAX_CHANGE = 0.25;
const DEFAULT_TOP_N = 10;
const STEPS = 300;
const LEARNING_RATE = 0.5;
const PRIOR_STRENGTH = 0.05;

function numericFeatures(value: unknown): Weights | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const entries = Object.entries(value).filter(
		(entry): entry is [string, number] =>
			FEATURE_NAME.test(entry[0]) &&
			typeof entry[1] === "number" &&
			Number.isFinite(entry[1]),
	);
	return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function reasonWeight(
	source: Pick<CardReviewSource, "scoring">,
	factoryReason: string | null,
	sharedReason: string | null,
): number {
	const configured = source.scoring?.weightUpdate?.reasonWeights ?? {};
	if (factoryReason && configured[factoryReason] !== undefined)
		return configured[factoryReason]!;
	if (sharedReason && configured[sharedReason] !== undefined)
		return configured[sharedReason]!;
	if (sharedReason && sharedReason in DEFAULT_REASON_WEIGHTS)
		return DEFAULT_REASON_WEIGHTS[sharedReason as DeckNotUsefulReason];
	return 1;
}

/** Labelled samples for one source from its verdict learning events. */
export function factoryWeightSamples(
	source: Pick<CardReviewSource, "label" | "scoring">,
	events: readonly FactoryVerdictEvent[],
): WeightSample[] {
	const prefix = factoryLearningClass(source.label, "x").slice(0, -1);
	const latest = new Map<string, WeightSample>();
	for (const event of events) {
		const m = event.metadata ?? {};
		const decisionClass = m.decisionClass;
		if (typeof decisionClass !== "string" || !decisionClass.startsWith(prefix))
			continue;
		const choice = m.decisionChoice;
		const label =
			choice === "useful" || choice === "do_it"
				? 1
				: choice === "not_useful"
					? 0
					: null;
		if (label === null) continue;
		const features = numericFeatures(m.features);
		if (!features) continue;
		const factoryReason =
			typeof m.factoryReason === "string" ? m.factoryReason : null;
		const sharedReason =
			typeof m.sharedReason === "string" ? m.sharedReason : null;
		const weight =
			label === 1 ? 1 : reasonWeight(source, factoryReason, sharedReason);
		if (weight <= 0) continue;
		const reviewerId =
			event.actorType === "user" && event.actorId ? event.actorId : null;
		const key = `${event.targetId ?? event.id}:${String(m.rowIndex ?? event.id)}:${reviewerId ?? ""}`;
		const sample: WeightSample = {
			key,
			reviewerId,
			features,
			label,
			weight,
			reason: label === 0 ? (factoryReason ?? sharedReason) : null,
			occurredAt: event.occurredAt,
		};
		const kept = latest.get(key);
		if (!kept || kept.occurredAt <= sample.occurredAt) latest.set(key, sample);
	}
	return [...latest.values()].sort((a, b) =>
		a.occurredAt.localeCompare(b.occurredAt),
	);
}

export function weightedScore(weights: Weights, features: Weights): number {
	let score = 0;
	for (const [name, value] of Object.entries(features))
		score += (weights[name] ?? 0) * value;
	return score;
}

/**
 * Share of positive/negative pairs the weights rank correctly (ties count
 * half): the held-out accuracy of a ranking. Null without both labels.
 */
export function rankingAccuracy(
	weights: Weights,
	samples: readonly WeightSample[],
): number | null {
	const positives = samples.filter((s) => s.label === 1);
	const negatives = samples.filter((s) => s.label === 0);
	if (positives.length === 0 || negatives.length === 0) return null;
	let correct = 0;
	let total = 0;
	for (const positive of positives) {
		const p = weightedScore(weights, positive.features);
		for (const negative of negatives) {
			const n = weightedScore(weights, negative.features);
			const pair = positive.weight * negative.weight;
			correct += (p > n ? 1 : p === n ? 0.5 : 0) * pair;
			total += pair;
		}
	}
	return total > 0 ? correct / total : null;
}

function featureNames(current: Weights, samples: readonly WeightSample[]) {
	const counts = new Map<string, number>();
	for (const sample of samples)
		for (const name of Object.keys(sample.features))
			counts.set(name, (counts.get(name) ?? 0) + 1);
	const extra = [...counts]
		.filter(([name]) => !(name in current))
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([name]) => name);
	return [...Object.keys(current), ...extra].slice(0, MAX_FEATURES);
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * A regularised logistic fit that starts at the current weights, is pulled
 * back toward them, and moves each weight by at most `maxChange`. Features
 * the samples never carry keep their current weight.
 */
export function fitFactoryWeights(
	current: Weights,
	samples: readonly WeightSample[],
	maxChange = DEFAULT_MAX_CHANGE,
): Weights {
	const names = featureNames(current, samples);
	if (samples.length === 0 || names.length === 0) return { ...current };
	const theta = names.map((name) => current[name] ?? 0);
	const prior = [...theta];
	const totalWeight = samples.reduce((sum, s) => sum + s.weight, 0);
	const base =
		samples.reduce((sum, s) => sum + s.weight * s.label, 0) / totalWeight;
	const clamped = Math.min(0.99, Math.max(0.01, base));
	let bias =
		Math.log(clamped / (1 - clamped)) -
		samples.reduce(
			(sum, s) =>
				sum +
				s.weight *
					names.reduce(
						(dot, name, i) => dot + theta[i]! * (s.features[name] ?? 0),
						0,
					),
			0,
		) /
			totalWeight;
	const rows = samples.map((s) => names.map((name) => s.features[name] ?? 0));
	for (let step = 0; step < STEPS; step += 1) {
		const gradient = names.map(() => 0);
		let biasGradient = 0;
		for (const [index, sample] of samples.entries()) {
			const row = rows[index]!;
			let z = bias;
			for (let i = 0; i < row.length; i += 1) z += theta[i]! * row[i]!;
			const error = (1 / (1 + Math.exp(-z)) - sample.label) * sample.weight;
			biasGradient += error;
			for (let i = 0; i < row.length; i += 1) gradient[i]! += error * row[i]!;
		}
		bias -= (LEARNING_RATE * biasGradient) / totalWeight;
		for (let i = 0; i < theta.length; i += 1) {
			const pull = PRIOR_STRENGTH * (theta[i]! - prior[i]!);
			theta[i] =
				theta[i]! - LEARNING_RATE * (gradient[i]! / totalWeight + pull);
		}
	}
	const result: Weights = { ...current };
	for (const [i, name] of names.entries()) {
		const start = prior[i]!;
		const bounded = Math.min(
			start + maxChange,
			Math.max(start - maxChange, theta[i]!),
		);
		const next = round(Math.min(100, Math.max(-100, bounded)));
		if (name in current || next !== 0) result[name] = next;
	}
	return result;
}

function topKeys(
	weights: Weights,
	samples: readonly WeightSample[],
	topN: number,
) {
	return samples
		.map((sample, order) => ({
			key: sample.key,
			score: weightedScore(weights, sample.features),
			order,
		}))
		.sort((a, b) => b.score - a.score || a.order - b.order)
		.slice(0, topN)
		.map((entry) => entry.key);
}

function weightsChanged(before: Weights, after: Weights) {
	const names = new Set([...Object.keys(before), ...Object.keys(after)]);
	return [...names].some(
		(name) => Math.abs((before[name] ?? 0) - (after[name] ?? 0)) >= 0.001,
	);
}

/** Fit on the older 75 % of samples, judge on the newest 25 %. */
function heldOutFit(
	current: Weights,
	samples: readonly WeightSample[],
	maxChange: number,
) {
	const heldOutSize = Math.max(1, Math.floor(samples.length / 4));
	const train = samples.slice(0, samples.length - heldOutSize);
	const heldOut = samples.slice(samples.length - heldOutSize);
	const weights = fitFactoryWeights(current, train, maxChange);
	return {
		weights,
		heldOut,
		before: rankingAccuracy(current, heldOut),
		after: rankingAccuracy(weights, heldOut),
	};
}

const shareRound = (value: number | null) =>
	value === null ? null : Math.round(value * 1000) / 1000;

/**
 * The weekly proposal for one source: source weights from every verdict,
 * reviewer weights for each signed-in reviewer with at least minSamples
 * verdicts of their own. Status is `insufficient` below minSamples and
 * `no_change` when nothing moves or the held-out accuracy would drop;
 * otherwise the caller sets `shadow` or `proposed` by mode.
 */
export function proposeFactoryWeights(input: {
	source: Pick<CardReviewSource, "label" | "scoring">;
	samples: readonly WeightSample[];
}): Pick<
	FactoryWeightProposal,
	| "previousWeights"
	| "weights"
	| "previousReviewerWeights"
	| "reviewerWeights"
	| "report"
> & { status: "insufficient" | "no_change" | "ready" } {
	const scoring = input.source.scoring;
	const current = scoring?.weights ?? {};
	const currentReviewers = scoring?.reviewerWeights ?? {};
	const minSamples = scoring?.weightUpdate?.minSamples ?? 1;
	const maxChange = scoring?.weightUpdate?.maxChange ?? DEFAULT_MAX_CHANGE;
	const topN = scoring?.topN ?? DEFAULT_TOP_N;
	const samples = input.samples;
	const reasons: Record<string, number> = {};
	for (const sample of samples)
		if (sample.reason)
			reasons[sample.reason] = (reasons[sample.reason] ?? 0) + 1;
	const positives = samples.filter((s) => s.label === 1).length;
	const report = {
		samples: samples.length,
		positives,
		negatives: samples.length - positives,
		heldOut: 0,
		accuracyBefore: null as number | null,
		accuracyAfter: null as number | null,
		topN,
		topNChanged: 0,
		reasons,
		reviewers: 0,
	};
	const unchanged = {
		previousWeights: current,
		weights: current,
		previousReviewerWeights: currentReviewers,
		reviewerWeights: currentReviewers,
	};
	if (samples.length < minSamples)
		return {
			...unchanged,
			status: "insufficient",
			report: {
				...report,
				note: `${samples.length} of ${minSamples} verdicts with features`,
			},
		};
	const fit = heldOutFit(current, samples, maxChange);
	const before = topKeys(current, samples, topN);
	const after = new Set(topKeys(fit.weights, samples, topN));
	const reviewerWeights: Record<string, Weights> = {};
	const byReviewer = new Map<string, WeightSample[]>();
	for (const sample of samples)
		if (sample.reviewerId)
			byReviewer.set(sample.reviewerId, [
				...(byReviewer.get(sample.reviewerId) ?? []),
				sample,
			]);
	const eligible = [...byReviewer]
		.filter(([, own]) => own.length >= minSamples)
		.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
		.slice(0, MAX_REVIEWERS);
	for (const [reviewerId, own] of eligible) {
		const start = currentReviewers[reviewerId] ?? current;
		const reviewerFit = heldOutFit(start, own, maxChange);
		if (
			weightsChanged(start, reviewerFit.weights) &&
			(reviewerFit.before === null ||
				reviewerFit.after === null ||
				reviewerFit.after >= reviewerFit.before)
		)
			reviewerWeights[reviewerId] = reviewerFit.weights;
		else if (currentReviewers[reviewerId])
			reviewerWeights[reviewerId] = currentReviewers[reviewerId]!;
	}
	const fullReport = {
		...report,
		heldOut: fit.heldOut.length,
		accuracyBefore: shareRound(fit.before),
		accuracyAfter: shareRound(fit.after),
		topNChanged: before.filter((key) => !after.has(key)).length,
		reviewers: Object.keys(reviewerWeights).filter((id) =>
			weightsChanged(currentReviewers[id] ?? {}, reviewerWeights[id]!),
		).length,
	};
	const sourceImproves =
		weightsChanged(current, fit.weights) &&
		(fit.before === null || fit.after === null || fit.after >= fit.before);
	const keptReviewers = { ...currentReviewers, ...reviewerWeights };
	if (!sourceImproves && fullReport.reviewers === 0)
		return { ...unchanged, status: "no_change", report: fullReport };
	return {
		previousWeights: current,
		weights: sourceImproves ? fit.weights : current,
		previousReviewerWeights: currentReviewers,
		reviewerWeights: keptReviewers,
		status: "ready",
		report: fullReport,
	};
}

const percent = (value: number | null) =>
	value === null ? "n/a" : `${Math.round(value * 100)}%`;

/** The rules-sheet text a person reads before Accept or Reject. */
export function weightProposalText(
	proposal: Pick<
		FactoryWeightProposal,
		"previousWeights" | "weights" | "report"
	>,
): string {
	const names = [
		...new Set([
			...Object.keys(proposal.previousWeights),
			...Object.keys(proposal.weights),
		]),
	];
	const changes = names
		.filter(
			(name) =>
				Math.abs(
					(proposal.previousWeights[name] ?? 0) - (proposal.weights[name] ?? 0),
				) >= 0.001,
		)
		.map(
			(name) =>
				`${name.replace(/_/g, " ")} ${(proposal.previousWeights[name] ?? 0).toFixed(2)} → ${(proposal.weights[name] ?? 0).toFixed(2)}`,
		);
	const { report } = proposal;
	return [
		`Retune card weights from ${report.samples} verdicts (${report.positives} useful, ${report.negatives} not useful)`,
		changes.length ? `: ${changes.join("; ")}.` : ": source weights unchanged.",
		` Held-out ranking accuracy ${percent(report.accuracyBefore)} → ${percent(report.accuracyAfter)} on the newest ${report.heldOut};`,
		` ${report.topNChanged} of the top ${report.topN} cards would change.`,
		report.reviewers
			? ` Personal weights for ${report.reviewers} reviewer${report.reviewers === 1 ? "" : "s"}.`
			: "",
	].join("");
}
