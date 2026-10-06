import type { KernelPricingEvidence } from "@tedix/api-contract/schemas/cost-provenance";
/**
 * What a cost chip is allowed to say.
 *
 * Money next to work is a claim the reader cannot check, so this module makes
 * the claim checkable by refusing to collapse distinct situations into one
 * number. A missing row, a read still in flight, a read the caller may not
 * make, a broken read, an unpriced row, a held-out row and a genuine zero are
 * SEVEN different things, and exactly one of them is "$0.00".
 *
 * The failure this prevents: a cost drilldown reporting
 * `$0 / rowCount 0 / level "ok" / score 1` while ingestion was failing every
 * fetch. Nothing about that was zero; everything about it
 * rendered as zero.
 *
 * Pure and injectable-clock by construction. Every function here is exported
 * and unit-tested; nothing in this module fetches.
 */

import {
	type CostProvenance,
	COST_PROVENANCE_DETAIL,
	ledgerRowProvenance,
	persistedCostAmount,
	provenanceFloor,
} from "@tedix/api-contract/schemas/cost-provenance";
import type { ComputePosture } from "@tedix/api-contract/contracts/os-compute";
import { isAuthorizationError } from "@/lib/orpc-error";

/**
 * The one reading a chip renders.
 *
 * `absent` and `zero` are deliberately separate: `absent` means nothing was
 * recorded, `zero` means rows WERE recorded and they total nothing. Only the
 * second is a fact about spend.
 */
export type CostReading =
	/** The read has not landed. Never a number, not even a placeholder zero. */
	| { kind: "pending" }
	/** The caller may not read this cost. An authorization state, not an outage. */
	| { kind: "refused" }
	/** The read failed. A broken read is not "0 spent". */
	| { kind: "broken"; message: string }
	/** The read landed and there is nothing to attest. */
	| { kind: "absent"; reason: AbsentReason }
	/** Tokens were spent and no price could be resolved. Not $0. */
	| { kind: "unpriced"; tokens: number }
	/** Value held out of totals by ingestion or settlement. Not spend, not zero. */
	| { kind: "quarantined"; tokens: number; costUsd: number | null }
	/** Rows exist and genuinely total nothing. The only honest "$0.00". */
	| { kind: "zero"; provenance: CostProvenance }
	/** A real number, with the label it earned. */
	| {
			kind: "priced";
			costUsd: number;
			tokens: number | null;
			provenance: CostProvenance;
			/**
			 * Why the number is a floor rather than a total, or null when it is
			 * whole. A boolean here was WRONG: it made a ledger dark for three days
			 * render byte-identical to one waiting on the next 15-minute tick,
			 * including the reassuring "not ingested yet" sentence. The chip in the
			 * Canvas header carries no freshness badge beside it, so this field is
			 * the only thing that can tell those apart.
			 */
			partial: CostFloorReason | null;
	  };

/**
 * Why a priced amount understates what was really spent.
 *
 * Kept distinct because the remedies differ: `ingestion_pending` resolves
 * itself within a cron tick, `ingestion_dark` is a P1 the pager is already
 * firing, and `usage_incomplete` is a permanent gap in what the producer
 * reported and will never fill in.
 */
export type CostFloorReason =
	/** Window tail is newer than the last ingestion tick. Resolves on its own. */
	| "ingestion_pending"
	/** Ingestion is behind the staleness ladder but still moving. */
	| "ingestion_lagging"
	/** No row for hours; the pager is firing. The shortfall is unbounded. */
	| "ingestion_dark"
	/** Some contributing records reported no usage at all. Never fills in. */
	| "usage_incomplete";

const FLOOR_DETAIL: Readonly<Record<CostFloorReason, string>> = {
	ingestion_pending:
		" The tail of this window has not been ingested yet, so this is a floor rather than a total.",
	ingestion_lagging:
		" Cost ingestion is lagging behind its schedule, so this is a floor and understates real spend.",
	ingestion_dark:
		" Cost ingestion is DARK — no row has arrived for hours — so this understates real spend by an unknown amount.",
	usage_incomplete:
		" Some contributing records reported no usage, so this covers only the ones that did.",
};

export type AbsentReason =
	/** No cost row exists for this subject at all. */
	| "no_rows"
	/** Work is newer than the last ingestion tick; cost has not landed yet. */
	| "ingestion_pending"
	/** Ingestion is stale enough that any total understates real spend. */
	| "ingestion_dark"
	/** The subject records effort but no money — its producer emits no dollars. */
	| "not_priced_here"
	/** Cost was self-reported by an executor with no schema, so nothing is parseable. */
	| "unattested"
	/** No join key exists from this record to any cost row. Structural, not empty. */
	| "no_attribution_path";

export const ABSENT_LABEL: Readonly<Record<AbsentReason, string>> = {
	no_rows: "No cost recorded",
	ingestion_pending: "Cost pending",
	ingestion_dark: "Cost ingestion dark",
	not_priced_here: "No cost attributed",
	unattested: "Cost unattested",
	no_attribution_path: "Cost not attributable",
};

export const ABSENT_DETAIL: Readonly<Record<AbsentReason, string>> = {
	no_rows:
		"No cost row exists for this. That is an absence of evidence, not a spend of zero.",
	ingestion_pending:
		"The cost ledger ingests on a 15-minute cycle, so work newer than the last tick has no row yet.",
	ingestion_dark:
		"The cost ledger has not received a row for hours. Any total shown understates real spend by an unknown amount.",
	not_priced_here:
		"The producer of this record emits effort (steps, attempts, tool calls, duration) and no monetary cost. Money for this work, if any, is attributed on the call ledger instead.",
	unattested:
		"The executor self-reported this cost with no schema and the server recorded it without verifying it, so no monetary value can be read from it.",
	no_attribution_path:
		"Nothing links this record to a cost row — it carries no run, workflow or reservation id — so its cost cannot be attributed here at all. That is a missing join, not a spend of zero. Cost for the work that produced it is on that run.",
};

/** Chip tone. `caution` covers every state that is not a trustworthy number. */
export type CostTone = "known" | "estimate" | "caution" | "unavailable";

export function readingTone(reading: CostReading): CostTone {
	switch (reading.kind) {
		case "pending":
		case "refused":
		case "broken":
			return "unavailable";
		case "absent":
		case "unpriced":
		case "quarantined":
			return "caution";
		case "zero":
		case "priced":
			return reading.provenance === "gateway_reported" ? "known" : "estimate";
	}
}

/**
 * Short provenance word for the chip face. The long form lives in the title
 * attribute so the chip stays scannable without hiding what it means.
 */
export const PROVENANCE_LABEL: Readonly<Record<CostProvenance, string>> = {
	provider_reported: "provider-reported",
	gateway_reported: "gateway-reported",
	pricing_table_estimate: "estimate",
	unknown: "unknown basis",
	quarantined: "quarantined",
};

/**
 * The one USD formatter for the OS.
 *
 * Four decimals below ten cents because per-call model spend is routinely
 * $0.0007, and a two-decimal render of that is "$0.00" — a fabricated zero in a
 * module whose whole purpose is to not fabricate zeros.
 *
 * Four decimals is still one decade short of real data: a single cheap call
 * lands at $0.00004, which `toFixed(4)` renders as "$0.0000" — the same
 * fabricated zero, one decade down. Anything nonzero that would round to
 * nothing is reported as a bound instead, because "less than a hundredth of a
 * cent" is true and "$0.0000" is not.
 */
export function formatUsd(usd: number): string {
	if (usd > 0 && usd < 0.0001) return "<$0.0001";
	return `$${usd.toFixed(usd < 0.1 ? 4 : 2)}`;
}

/** Chip face text. Never returns a bare number without a qualifier when one applies. */
export function readingLabel(reading: CostReading): string {
	switch (reading.kind) {
		case "pending":
			return "Cost loading";
		case "refused":
			return "Cost not visible";
		case "broken":
			return "Cost unavailable";
		case "absent":
			return ABSENT_LABEL[reading.reason];
		case "unpriced":
			return `${reading.tokens.toLocaleString()} tokens · price unknown`;
		case "quarantined":
			// Null is unavailable; an explicitly recorded zero remains a known amount.
			return reading.costUsd !== null
				? `${formatUsd(reading.costUsd)} quarantined`
				: `${reading.tokens.toLocaleString()} tokens quarantined · amount unknown`;
		case "zero":
			return "$0.00";
		case "priced":
			return reading.partial !== null
				? `${formatUsd(reading.costUsd)}+`
				: formatUsd(reading.costUsd);
	}
}

/** The full explanation, shown as the chip's title and to assistive tech. */
export function readingDetail(reading: CostReading): string {
	switch (reading.kind) {
		case "pending":
			return "The cost read has not returned yet. No amount is known.";
		case "refused":
			return "This principal may not read cost for this workspace. That is an authorization state, not an outage — nothing here is zero.";
		case "broken":
			return `The cost read failed: ${reading.message}. No amount is known; this is not zero spend.`;
		case "absent":
			return ABSENT_DETAIL[reading.reason];
		case "unpriced":
			return `${reading.tokens.toLocaleString()} tokens were recorded with no resolvable price. The spend is real and its amount is unknown — it is not zero.`;
		case "quarantined":
			return reading.costUsd !== null
				? `${formatUsd(reading.costUsd)} across ${reading.tokens.toLocaleString()} tokens was held out of spend totals. ${COST_PROVENANCE_DETAIL.quarantined}`
				: `${reading.tokens.toLocaleString()} tokens were held out of spend totals with no resolvable amount. The held-out value is unknown, not zero. ${COST_PROVENANCE_DETAIL.quarantined}`;
		case "zero":
			return `Rows exist for this window and total nothing. ${COST_PROVENANCE_DETAIL[reading.provenance]}`;
		case "priced": {
			const basis = COST_PROVENANCE_DETAIL[reading.provenance];
			const floor =
				reading.partial === null ? "" : FLOOR_DETAIL[reading.partial];
			return `${basis}${floor}`;
		}
	}
}

/**
 * Map a react-query result onto the three non-data readings, so every chip
 * distinguishes pending, refused and broken identically. Returns null once the
 * query has data and the caller should derive a data reading instead.
 */
export function queryReading(query: {
	isPending: boolean;
	isError: boolean;
	error: unknown;
}): CostReading | null {
	if (query.isPending) return { kind: "pending" };
	if (query.isError) {
		return isAuthorizationError(query.error)
			? { kind: "refused" }
			: {
					kind: "broken",
					message:
						typeof (query.error as { message?: unknown })?.message === "string"
							? (query.error as { message: string }).message
							: "the request failed",
				};
	}
	return null;
}

/**
 * Derive a reading from an already-landed rollup.
 *
 * The branch order encodes the honesty rules: no rows is an absence before any
 * arithmetic runs; a window with only held-out value reports the quarantine
 * rather than the $0 that remains after removing it; tokens without a price are
 * unpriced, never zero; and a genuine zero is reported only when rows exist,
 * none were held out, and they really do total nothing.
 */
export function rollupReading(input: {
	rowCount: number;
	costUsd: number;
	totalTokens: number;
	quarantinedCostUsd: number | null;
	quarantinedTokens: number;
	quarantinedRowCount: number;
	provenance: CostProvenance | null;
	/** Why the total is a floor, when it is. Null/omitted means it is whole. */
	partial?: CostFloorReason | null;
	/** Absence reason to report when there is nothing at all. */
	emptyReason?: AbsentReason;
}): CostReading {
	if (input.rowCount === 0) {
		return { kind: "absent", reason: input.emptyReason ?? "no_rows" };
	}
	const contributing = input.rowCount - input.quarantinedRowCount;
	if (contributing === 0) {
		return {
			kind: "quarantined",
			tokens: input.quarantinedTokens,
			costUsd: input.quarantinedCostUsd,
		};
	}
	if (input.provenance === null)
		return { kind: "unpriced", tokens: input.totalTokens };
	if (input.costUsd <= 0) {
		return input.partial || input.provenance === "unknown"
			? { kind: "unpriced", tokens: input.totalTokens }
			: { kind: "zero", provenance: input.provenance };
	}
	return {
		kind: "priced",
		costUsd: input.costUsd,
		tokens: input.totalTokens,
		provenance: input.provenance,
		partial: input.partial ?? null,
	};
}

/**
 * Reading for one kernel turn's usage, as the run set already carries it.
 *
 * `HomeRun.usage.costUsd` is produced by `computeCost(...)` over the route
 * planner's token usage (`apps/api/src/rpc/routers/kernel/turn-work.ts`), so it
 * is a pricing-table estimate with certainty — never gateway- or
 * provider-reported. It also covers the PLANNER call only, which is why the
 * conversation chip names what it measures rather than implying a total.
 */
export function kernelUsageReading(
	usages: ReadonlyArray<{
		inputTokens: number | null;
		outputTokens: number | null;
		totalTokens: number | null;
		costUsd: number | null;
		pricing: KernelPricingEvidence | null;
	}>,
): CostReading {
	if (usages.length === 0) {
		return { kind: "absent", reason: "no_rows" };
	}
	let costUsd = 0;
	let tokens = 0;
	let pricedCount = 0;
	for (const usage of usages) {
		if (usage.pricing) {
			costUsd += usage.pricing.knownSubtotalUsd;
			if (["complete", "no_usage"].includes(usage.pricing.costCompleteness))
				pricedCount++;
		} else if (usage.costUsd !== null) {
			costUsd += usage.costUsd;
			pricedCount++;
		}
		tokens +=
			usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
	}
	if (pricedCount === 0 && costUsd === 0) {
		return tokens > 0
			? { kind: "unpriced", tokens }
			: { kind: "absent", reason: "no_rows" };
	}
	if (costUsd <= 0 && pricedCount < usages.length)
		return { kind: "unpriced", tokens };
	if (costUsd <= 0) {
		return { kind: "zero", provenance: "pricing_table_estimate" };
	}
	return {
		kind: "priced",
		costUsd,
		tokens,
		provenance: "pricing_table_estimate",
		// A run whose usage was omitted contributes nothing, so any total over a
		// partially-reported set is a floor rather than the whole turn's cost.
		// Unlike an ingestion gap, this one never fills in later.
		partial: pricedCount < usages.length ? "usage_incomplete" : null,
	};
}

/**
 * Reading for a Gadget execution receipt.
 *
 * The `costs` column has one active producer plus immutable historical data
 * (`apps/api/src/rpc/routers/os-workspaces.ts`):
 *
 *   - a run-linked receipt is settled from `run.costSummary`, which is a
 *     step/attempt/tool-call/duration rollup carrying NO money and NO tokens
 *     (`SkillRunCostSummarySchema`). Rendering a dollar sign from it would be
 *     an invention, so it reports `not_priced_here`.
 *   - receipts created before governed-only dispatch may contain caller-reported
 *     JSON without runtime lineage. They remain readable audit history and
 *     report `unattested`; no current contract can create another one.
 *
 * Which one applies is decided by `runId`, a real column, not by sniffing the
 * JSON for something that looks like a price.
 */
export function gadgetCostReading(execution: {
	runId: string | null;
	costs: unknown;
}): CostReading {
	if (execution.costs === null || execution.costs === undefined) {
		return { kind: "absent", reason: "no_rows" };
	}
	return {
		kind: "absent",
		reason: execution.runId === null ? "unattested" : "not_priced_here",
	};
}

/**
 * Reading for one run, from the per-call ledger rows the runs surfaces already
 * fetch (`tediUsage.getCallCosts`).
 *
 * Uses the ONE contract-owned classifier so a run chip and the Compute surface
 * can never disagree about what a row's basis is. Rows are the tedi's whole
 * window, so the caller filters to `row.runId` first — a run with no matching
 * row has no cost recorded, which is emphatically not a run that cost nothing:
 * per-call attribution is best-effort and the ingestion cycle is 15 minutes.
 */
export function callCostRunReading(
	rows: ReadonlyArray<{
		provider: string | null;
		dataQuality: "ok" | "quarantined_no_pricing" | "quarantined_failed";
		estimatedCostUsd: number | null;
		costBasis:
			| "gateway_reported"
			| "governed_estimate"
			| "legacy_estimate"
			| "unknown";
		totalTokens: number;
	}>,
	options: { emptyReason?: AbsentReason } = {},
): CostReading {
	if (rows.length === 0) {
		return { kind: "absent", reason: options.emptyReason ?? "no_rows" };
	}
	let costUsd = 0;
	let totalTokens = 0;
	let quarantinedCostUsd: number | null = 0;
	let quarantinedTokens = 0;
	let quarantinedRowCount = 0;
	let unpricedRowCount = 0;
	const labels: CostProvenance[] = [];
	for (const row of rows) {
		const provenance = ledgerRowProvenance(row);
		if (provenance === "quarantined") {
			quarantinedRowCount++;
			quarantinedTokens += row.totalTokens;
			const amount = persistedCostAmount(row);
			quarantinedCostUsd =
				quarantinedCostUsd === null || amount === null
					? null
					: quarantinedCostUsd + amount;
			continue;
		}
		if (row.estimatedCostUsd === null || provenance === "unknown")
			unpricedRowCount++;
		else labels.push(provenance);
		costUsd += row.estimatedCostUsd ?? 0;
		totalTokens += row.totalTokens;
	}
	return rollupReading({
		rowCount: rows.length,
		costUsd,
		totalTokens,
		quarantinedCostUsd,
		quarantinedTokens,
		quarantinedRowCount,
		provenance: provenanceFloor(labels),
		partial:
			unpricedRowCount > 0 || quarantinedRowCount > 0
				? "usage_incomplete"
				: null,
		emptyReason: options.emptyReason,
	});
}

/**
 * Map ingestion freshness onto why a total is a floor. `fresh` and
 * `never_ingested` yield null for opposite reasons: the first has nothing
 * missing, the second has no total to qualify in the first place.
 */
export function ledgerFloorReason(
	state: ComputePosture["freshness"]["state"],
): CostFloorReason | null {
	switch (state) {
		case "ingestion_pending":
			return "ingestion_pending";
		case "lagging":
			return "ingestion_lagging";
		case "dark":
			return "ingestion_dark";
		case "fresh":
		case "never_ingested":
			return null;
	}
}

/**
 * Spend reading for the window. Delegates the branch order to the shared
 * rollup so the headline number obeys exactly the same rules as every chip.
 */
export function postureSpendReading(posture: ComputePosture): CostReading {
	// Carried through as the REASON, not a boolean: the chip this feeds sits in
	// the Canvas header with no freshness badge beside it, so collapsing these
	// three states here is what made a four-day-dark ledger claim its amount was
	// merely waiting on the next tick.
	const partial =
		ledgerFloorReason(posture.freshness.state) ??
		(posture.spend.costCompleteness !== "complete" ? "usage_incomplete" : null);
	if (posture.spend.rowCount === 0) {
		return {
			kind: "absent",
			reason: posture.freshness.state === "dark" ? "ingestion_dark" : "no_rows",
		};
	}
	if (posture.spend.rowCount === posture.spend.quarantinedRowCount) {
		return {
			kind: "quarantined",
			tokens: posture.spend.quarantinedTokens,
			costUsd: posture.spend.quarantinedCostUsd,
		};
	}
	if (posture.spend.provenanceFloor === null) {
		return { kind: "absent", reason: "unattested" };
	}
	if (posture.spend.knownSubtotalUsd <= 0) {
		return posture.spend.costCompleteness !== "complete"
			? { kind: "unpriced", tokens: posture.spend.totalTokens }
			: { kind: "zero", provenance: posture.spend.provenanceFloor };
	}
	return {
		kind: "priced",
		costUsd: posture.spend.knownSubtotalUsd,
		tokens: posture.spend.totalTokens,
		provenance: posture.spend.provenanceFloor,
		partial,
	};
}
