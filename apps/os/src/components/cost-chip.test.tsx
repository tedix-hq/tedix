import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { CostReading } from "@/lib/cost-reading";
import { chipProvenance, CostChip } from "./cost-chip";

describe("chipProvenance", () => {
	it("attaches a basis only to readings that carry a number", () => {
		expect(
			chipProvenance({
				kind: "priced",
				costUsd: 1,
				tokens: 1,
				provenance: "gateway_reported",
				partial: null,
			}),
		).toBe("gateway_reported");
		expect(chipProvenance({ kind: "pending" })).toBeNull();
		expect(chipProvenance({ kind: "absent", reason: "no_rows" })).toBeNull();
		expect(chipProvenance({ kind: "unpriced", tokens: 4 })).toBeNull();
	});
});

describe("CostChip", () => {
	function render(reading: CostReading) {
		return renderToStaticMarkup(
			<CostChip reading={reading} subject="Model cost for this run" />,
		);
	}

	it("never renders a currency amount for a read that has not landed", () => {
		const html = render({ kind: "pending" });
		expect(html).not.toContain("$");
		expect(html).toContain('data-cost-kind="pending"');
		expect(html).toContain('data-tone="unavailable"');
	});

	it("says a refusal is a refusal, not an outage and not zero", () => {
		const html = render({ kind: "refused" });
		expect(html).toContain('data-cost-kind="refused"');
		expect(html).toContain("Cost not visible");
		expect(html).not.toContain("$");
	});

	it("never renders a currency amount for a broken read", () => {
		const html = render({ kind: "broken", message: "gateway 500" });
		expect(html).toContain('data-cost-kind="broken"');
		expect(html).not.toContain("$");
	});

	it("renders an absence as an absence, distinct from a zero", () => {
		const absent = render({ kind: "absent", reason: "no_rows" });
		expect(absent).toContain('data-cost-kind="absent"');
		expect(absent).toContain("No cost recorded");
		expect(absent).not.toContain("$");

		const zero = render({ kind: "zero", provenance: "pricing_table_estimate" });
		expect(zero).toContain('data-cost-kind="zero"');
		expect(zero).toContain("$0.00");
	});

	it("prints tokens and refuses a price when none resolved", () => {
		const html = render({ kind: "unpriced", tokens: 1234 });
		expect(html).toContain("price unknown");
		expect(html).toContain("1,234");
		expect(html).not.toContain("$0");
	});

	it("labels a priced reading with the basis it earned", () => {
		const html = render({
			kind: "priced",
			costUsd: 0.0421,
			tokens: 900,
			provenance: "pricing_table_estimate",
			partial: null,
		});
		expect(html).toContain("$0.0421");
		expect(html).toContain("estimate");
		expect(html).toContain('data-cost-provenance="pricing_table_estimate"');
		expect(html).not.toContain("provider-reported");
	});

	it("marks a partially-ingested amount as a floor", () => {
		const html = render({
			kind: "priced",
			costUsd: 2,
			tokens: 900,
			provenance: "gateway_reported",
			partial: "ingestion_pending",
		});
		expect(html).toContain("$2.00+");
	});

	it("carries the subject and the explanation to assistive tech, not colour alone", () => {
		const html = render({ kind: "absent", reason: "ingestion_dark" });
		expect(html).toContain("Model cost for this run");
		expect(html).toContain("aria-label=");
		expect(html).toContain("understates real spend");
	});
});
