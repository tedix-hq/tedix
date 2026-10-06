/**
 * The point of these tests is a single assertion repeated in many shapes: the
 * only input that produces "$0.00" is rows that exist and really do total
 * nothing. Every other shape — no rows, a read in flight, a refused read, a
 * broken read, tokens with no price, held-out value — must be visibly something
 * else.
 *
 * Fixture discipline: every row shape here matches its producer. Ledger rows
 * carry the exact `provider`/`dataQuality` values `ingestGatewayLogCosts`
 * writes; kernel usages carry the exact nullable
 * `inputTokens`/`outputTokens`/`totalTokens`/`costUsd` shape `extractRunUsage`
 * emits (`apps/api/src/kernel/kernel-state.ts`), including its "omit the
 * whole field" behaviour, which is why the caller filters before calling.
 */

import { describe, expect, it } from "vite-plus/test";
import {
	callCostRunReading,
	type CostReading,
	formatUsd,
	gadgetCostReading,
	kernelUsageReading,
	postureSpendReading,
	queryReading,
	readingDetail,
	readingLabel,
	readingTone,
	rollupReading,
} from "./cost-reading";

type LedgerRow = Parameters<typeof callCostRunReading>[0][number];

function ledgerRow(overrides: Partial<LedgerRow> = {}): LedgerRow {
	return {
		costBasis: "governed_estimate",

		provider: "azure-openai",
		dataQuality: "ok",
		estimatedCostUsd: 0.02,
		totalTokens: 1_000,
		...overrides,
	};
}

describe("formatUsd", () => {
	it("keeps four decimals under a dime so a real cost never renders as $0.00", () => {
		expect(formatUsd(0.0007)).toBe("$0.0007");
		expect(formatUsd(0)).toBe("$0.0000");
		expect(formatUsd(12.5)).toBe("$12.50");
	});

	// Four decimals was still one decade short of live data: a single cheap
	// Workers AI call lands around $0.00004, and `toFixed(4)` printed it as
	// "$0.0000" — the exact fabricated zero this module exists to prevent,
	// reintroduced by the formatter itself.
	it("never renders a nonzero amount as all zeros", () => {
		expect(formatUsd(0.00004)).toBe("<$0.0001");
		expect(formatUsd(0.000001)).toBe("<$0.0001");
		// The boundary still formats normally — it is representable.
		expect(formatUsd(0.0001)).toBe("$0.0001");
	});

	it("reserves an exact zero render for an exact zero", () => {
		// The one input allowed to print as zeros, so the two are never confused.
		expect(formatUsd(0)).not.toBe("<$0.0001");
	});
});

describe("queryReading", () => {
	it("is pending before the read lands", () => {
		expect(
			queryReading({ isPending: true, isError: false, error: null }),
		).toEqual({ kind: "pending" });
	});

	it("distinguishes a refusal from an outage", () => {
		expect(
			queryReading({
				isPending: false,
				isError: true,
				error: { code: "FORBIDDEN", message: "nope" },
			}),
		).toEqual({ kind: "refused" });
		expect(
			queryReading({
				isPending: false,
				isError: true,
				error: { code: "INTERNAL_SERVER_ERROR", message: "boom" },
			}),
		).toEqual({ kind: "broken", message: "boom" });
	});

	it("returns null once data is available so the caller derives a real reading", () => {
		expect(
			queryReading({ isPending: false, isError: false, error: null }),
		).toBeNull();
	});
});

describe("rollupReading", () => {
	const base = {
		rowCount: 0,
		costUsd: 0,
		totalTokens: 0,
		quarantinedCostUsd: 0,
		quarantinedTokens: 0,
		quarantinedRowCount: 0,
		provenance: null,
	};

	it("reports no rows as an absence before any arithmetic runs", () => {
		expect(rollupReading(base)).toEqual({ kind: "absent", reason: "no_rows" });
	});

	it("carries the caller's absence reason through", () => {
		expect(rollupReading({ ...base, emptyReason: "ingestion_dark" })).toEqual({
			kind: "absent",
			reason: "ingestion_dark",
		});
	});

	it("reports an all-quarantined window as held-out value, not the $0 that remains", () => {
		expect(
			rollupReading({
				...base,
				rowCount: 3,
				quarantinedRowCount: 3,
				quarantinedTokens: 900,
				quarantinedCostUsd: 1.25,
			}),
		).toEqual({ kind: "quarantined", tokens: 900, costUsd: 1.25 });
	});

	it("refuses to price contributing rows that earned no label", () => {
		expect(rollupReading({ ...base, rowCount: 2, costUsd: 3 })).toEqual({
			kind: "unpriced",
			tokens: 0,
		});
	});

	it("reports tokens without a price as unpriced, never as zero", () => {
		expect(
			rollupReading({
				...base,
				rowCount: 1,
				totalTokens: 400,
				provenance: "unknown",
			}),
		).toEqual({ kind: "unpriced", tokens: 400 });
	});

	it("reports a genuine zero only when rows exist and no tokens were spent", () => {
		expect(
			rollupReading({
				...base,
				rowCount: 1,
				provenance: "pricing_table_estimate",
			}),
		).toEqual({ kind: "zero", provenance: "pricing_table_estimate" });
	});

	it("marks a partially-ingested window as a floor", () => {
		expect(
			rollupReading({
				...base,
				rowCount: 1,
				costUsd: 2,
				totalTokens: 10,
				provenance: "gateway_reported",
				partial: "ingestion_pending",
			}),
		).toEqual({
			kind: "priced",
			costUsd: 2,
			tokens: 10,
			provenance: "gateway_reported",
			partial: "ingestion_pending",
		});
	});
});

describe("callCostRunReading", () => {
	it("claims only the weakest label present across mixed rows", () => {
		const reading = callCostRunReading([
			ledgerRow({ provider: "workers-ai" }),
			ledgerRow({ provider: "azure-openai" }),
		]);
		expect(reading.kind).toBe("priced");
		expect(reading.kind === "priced" && reading.provenance).toBe(
			"pricing_table_estimate",
		);
	});

	it("never labels anything provider-reported", () => {
		for (const provider of ["workers-ai", "azure-openai", "anthropic", null]) {
			const reading = callCostRunReading([ledgerRow({ provider })]);
			if (reading.kind === "priced" || reading.kind === "zero") {
				expect(reading.provenance).not.toBe("provider_reported");
			}
		}
	});

	it("holds quarantined rows out of the priced total", () => {
		const reading = callCostRunReading([
			ledgerRow({ estimatedCostUsd: 0.05 }),
			ledgerRow({ dataQuality: "quarantined_failed", estimatedCostUsd: 0 }),
		]);
		expect(reading).toEqual({
			kind: "priced",
			costUsd: 0.05,
			tokens: 1_000,
			provenance: "pricing_table_estimate",
			partial: "usage_incomplete",
		});
	});

	it("keeps an unreported Workers AI amount unknown", () => {
		expect(
			callCostRunReading([
				ledgerRow({
					provider: "workers-ai",
					costBasis: "unknown",
					estimatedCostUsd: null,
				}),
			]),
		).toEqual({ kind: "unpriced", tokens: 1_000 });
	});
});

describe("kernelUsageReading", () => {
	it("is an absence for a conversation with no recorded usage", () => {
		expect(kernelUsageReading([])).toEqual({
			kind: "absent",
			reason: "no_rows",
		});
	});

	it("labels kernel planning cost a pricing-table estimate, never gateway-reported", () => {
		const reading = kernelUsageReading([
			{
				pricing: null,

				inputTokens: 900,
				outputTokens: 100,
				totalTokens: 1_000,
				costUsd: 0.004,
			},
		]);
		expect(reading).toEqual({
			kind: "priced",
			costUsd: 0.004,
			tokens: 1_000,
			provenance: "pricing_table_estimate",
			partial: null,
		});
	});

	it("marks the total a floor when some runs reported no cost", () => {
		const reading = kernelUsageReading([
			{
				pricing: null,

				inputTokens: 900,
				outputTokens: 100,
				totalTokens: 1_000,
				costUsd: 0.004,
			},
			{
				pricing: null,

				inputTokens: 500,
				outputTokens: 50,
				totalTokens: 550,
				costUsd: null,
			},
		]);
		expect(reading.kind === "priced" && reading.partial).toBe(
			"usage_incomplete",
		);
	});

	it("reports tokens with no cost at all as unpriced", () => {
		expect(
			kernelUsageReading([
				{
					pricing: null,

					inputTokens: 200,
					outputTokens: 50,
					totalTokens: null,
					costUsd: null,
				},
			]),
		).toEqual({ kind: "unpriced", tokens: 250 });
	});
});

describe("gadgetCostReading", () => {
	it("reads a run-settled receipt as effort with no money attributed", () => {
		expect(
			gadgetCostReading({
				runId: "run-1",
				costs: {
					schemaVersion: 1,
					steps: 4,
					attempts: 5,
					retries: 1,
					toolCalls: 9,
					toolCallsByNamespace: { unknown: 9 },
					stepDurationMs: 1200,
					wallMs: 4300,
				},
			}),
		).toEqual({ kind: "absent", reason: "not_priced_here" });
	});

	it("reads a historical receipt without runtime lineage as unattested, never as a dollar figure", () => {
		expect(gadgetCostReading({ runId: null, costs: { usd: 4.25 } })).toEqual({
			kind: "absent",
			reason: "unattested",
		});
	});

	it("reports no cost recorded when the column is null", () => {
		expect(gadgetCostReading({ runId: "run-1", costs: null })).toEqual({
			kind: "absent",
			reason: "no_rows",
		});
	});
});

describe("postureSpendReading", () => {
	function posture(
		spend: Partial<Parameters<typeof postureSpendReading>[0]["spend"]>,
		state: Parameters<
			typeof postureSpendReading
		>[0]["freshness"]["state"] = "fresh",
	) {
		return {
			freshness: { state },
			spend: {
				knownSubtotalUsd: spend.costUsd ?? 0,
				pricedRowCount: spend.rowCount ?? 0,
				unpricedRowCount: 0,
				unpricedTokens: 0,
				costCompleteness: "complete",
				quarantinedKnownSubtotalUsd: 0,
				rowCount: 0,
				totalTokens: 0,
				costUsd: 0,
				quarantinedCostUsd: 0,
				quarantinedTokens: 0,
				quarantinedRowCount: 0,
				provenanceFloor: null,
				...spend,
			},
		} as Parameters<typeof postureSpendReading>[0];
	}

	it("reports an empty window as an absence, not a clean zero", () => {
		expect(postureSpendReading(posture({}))).toEqual({
			kind: "absent",
			reason: "no_rows",
		});
	});

	it("names a dark ledger as the reason there is nothing to show", () => {
		expect(postureSpendReading(posture({}, "dark"))).toEqual({
			kind: "absent",
			reason: "ingestion_dark",
		});
	});

	it("marks spend a floor while ingestion is behind", () => {
		const reading = postureSpendReading(
			posture(
				{
					rowCount: 5,
					costUsd: 1.5,
					totalTokens: 500,
					provenanceFloor: "pricing_table_estimate",
				},
				"ingestion_pending",
			),
		);
		expect(reading.kind === "priced" && reading.partial).toBe(
			"ingestion_pending",
		);
	});

	// A boolean `partial` made these three states render byte-identically —
	// including the reassuring "not ingested yet" sentence on a ledger that had
	// been dark for days. The chip this feeds sits in the Canvas header with no
	// freshness badge next to it, so this field is the ONLY thing carrying the
	// difference between "cheap workspace" and "ingestion stopped".
	it("distinguishes why the floor exists, not merely that it does", () => {
		const priced = {
			rowCount: 5,
			costUsd: 1.5,
			totalTokens: 500,
			provenanceFloor: "pricing_table_estimate" as const,
		};
		const reasonFor = (
			state: Parameters<typeof postureSpendReading>[0]["freshness"]["state"],
		) => {
			const reading = postureSpendReading(posture(priced, state));
			return reading.kind === "priced" ? reading.partial : "not-priced";
		};
		expect(reasonFor("ingestion_pending")).toBe("ingestion_pending");
		expect(reasonFor("lagging")).toBe("ingestion_lagging");
		expect(reasonFor("dark")).toBe("ingestion_dark");
		expect(reasonFor("fresh")).toBeNull();
		// All four render differently to a reader.
		const sentences = new Set(
			(["ingestion_pending", "lagging", "dark", "fresh"] as const).map(
				(state) => readingDetail(postureSpendReading(posture(priced, state))),
			),
		);
		expect(sentences.size).toBe(4);
		// A dark ledger must never wear the "resolves itself shortly" wording.
		const dark = readingDetail(postureSpendReading(posture(priced, "dark")));
		expect(dark).toContain("DARK");
		expect(dark).not.toContain("not been ingested yet");
	});
});

describe("quarantined value with no resolvable amount", () => {
	// `quarantined_no_pricing` is written precisely BECAUSE pricing returned
	// nothing, so the row stores cost 0. Rendering that 0 as "$0.0000
	// quarantined" states the unknown as an amount — and it is the dominant
	// quarantine cause, so this was the common case, not the edge case.
	it("reports tokens and an unknown amount, never $0.0000", () => {
		const reading = {
			kind: "quarantined" as const,
			tokens: 5000,
			costUsd: null,
		};
		expect(readingLabel(reading)).toBe(
			"5,000 tokens quarantined · amount unknown",
		);
		expect(readingLabel(reading)).not.toContain("$0.0000");
		const detail = readingDetail(reading);
		expect(detail).toContain("unknown, not zero");
		expect(detail).not.toContain("$0.0000");
	});

	it("still reports a known held-out amount when one exists", () => {
		const reading = {
			kind: "quarantined" as const,
			tokens: 5000,
			costUsd: 0.42,
		};
		expect(readingLabel(reading)).toBe("$0.42 quarantined");
	});
});

describe("readingLabel / readingDetail / readingTone", () => {
	const readings: CostReading[] = [
		{ kind: "pending" },
		{ kind: "refused" },
		{ kind: "broken", message: "boom" },
		{ kind: "absent", reason: "no_rows" },
		{ kind: "absent", reason: "ingestion_pending" },
		{ kind: "absent", reason: "ingestion_dark" },
		{ kind: "absent", reason: "not_priced_here" },
		{ kind: "absent", reason: "unattested" },
		{ kind: "absent", reason: "no_attribution_path" },
		{ kind: "unpriced", tokens: 10 },
		{ kind: "quarantined", tokens: 10, costUsd: 1 },
		{ kind: "zero", provenance: "pricing_table_estimate" },
		{
			kind: "priced",
			costUsd: 1,
			tokens: 10,
			provenance: "gateway_reported",
			partial: null,
		},
	];

	it("gives every reading a non-empty label and explanation", () => {
		for (const reading of readings) {
			expect(readingLabel(reading).length).toBeGreaterThan(0);
			expect(readingDetail(reading).length).toBeGreaterThan(0);
		}
	});

	it("renders a BARE currency amount only for the two readings that are one", () => {
		// The invariant is not "no dollar sign" — a quarantined chip does print an
		// amount — it is that an unqualified amount, the thing a reader takes as
		// settled spend, appears only where spend was actually settled.
		const bareAmountKinds = readings
			.filter((reading) => /^\$[\d.,]+\+?$/.test(readingLabel(reading)))
			.map((reading) => reading.kind);
		expect(new Set(bareAmountKinds)).toEqual(new Set(["zero", "priced"]));
		expect(readingLabel({ kind: "quarantined", tokens: 1, costUsd: 1 })).toBe(
			"$1.00 quarantined",
		);
	});

	it("never gives an unavailable or caution reading a confident tone", () => {
		expect(readingTone({ kind: "pending" })).toBe("unavailable");
		expect(readingTone({ kind: "refused" })).toBe("unavailable");
		expect(readingTone({ kind: "broken", message: "x" })).toBe("unavailable");
		expect(readingTone({ kind: "absent", reason: "no_rows" })).toBe("caution");
		expect(readingTone({ kind: "unpriced", tokens: 1 })).toBe("caution");
		expect(readingTone({ kind: "quarantined", tokens: 1, costUsd: 1 })).toBe(
			"caution",
		);
	});

	it("tones an estimate differently from a gateway-reported number", () => {
		expect(
			readingTone({
				kind: "priced",
				costUsd: 1,
				tokens: 1,
				provenance: "pricing_table_estimate",
				partial: null,
			}),
		).toBe("estimate");
		expect(
			readingTone({
				kind: "priced",
				costUsd: 1,
				tokens: 1,
				provenance: "gateway_reported",
				partial: null,
			}),
		).toBe("known");
	});
});

describe("nullable cost evidence", () => {
	it("distinguishes an authoritative held zero from an old no-pricing placeholder", () => {
		const known = callCostRunReading([
			ledgerRow({
				dataQuality: "quarantined_failed",
				costBasis: "gateway_reported",
				estimatedCostUsd: 0,
			}),
		]);
		const historical = callCostRunReading([
			ledgerRow({
				dataQuality: "quarantined_no_pricing",
				costBasis: "legacy_estimate",
				estimatedCostUsd: 0,
			}),
		]);
		expect(known).toEqual({ kind: "quarantined", tokens: 1000, costUsd: 0 });
		expect(readingLabel(known)).toContain("$0.0000");
		expect(historical).toEqual({
			kind: "quarantined",
			tokens: 1000,
			costUsd: null,
		});
		expect(readingLabel(historical)).toContain("unknown");
	});
	it.each([0, 0.05])(
		"keeps a known %s subtotal incomplete beside an unpriced quarantined row",
		(amount) => {
			const reading = callCostRunReading([
				ledgerRow({ estimatedCostUsd: amount }),
				ledgerRow({
					dataQuality: "quarantined_no_pricing",
					costBasis: "unknown",
					estimatedCostUsd: null,
				}),
			]);
			expect(reading).toEqual(
				amount === 0
					? { kind: "unpriced", tokens: 1000 }
					: {
							kind: "priced",
							costUsd: 0.05,
							tokens: 1000,
							provenance: "pricing_table_estimate",
							partial: "usage_incomplete",
						},
			);
		},
	);
	it("does not render a mixed known-zero and missing kernel cost as a complete zero", () => {
		expect(
			kernelUsageReading([
				{
					inputTokens: 1,
					outputTokens: 1,
					totalTokens: 2,
					costUsd: 0,
					pricing: null,
				},
				{
					inputTokens: 1,
					outputTokens: 1,
					totalTokens: 2,
					costUsd: null,
					pricing: null,
				},
			]),
		).toEqual({ kind: "unpriced", tokens: 4 });
	});
});
