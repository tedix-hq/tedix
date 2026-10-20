import { describe, expect, it } from "vite-plus/test";
import { unsupportedCopyFacts } from "./decision-card-copy";

const copy = {
	title: "Pay the supplier?",
	body: "Pays 1,200 euros to billing@example.com on 2026-10-24.",
	recommendation: "The invoice is due.",
};

describe("unsupportedCopyFacts", () => {
	it("accepts facts present in the source, ignoring thousands separators", () => {
		expect(
			unsupportedCopyFacts(
				copy,
				'{"prompt":"Invoice of 1200 EUR to billing@example.com, due 2026-10-24"}',
			),
		).toEqual([]);
	});

	it("names dates, amounts and addresses the source does not contain", () => {
		expect(unsupportedCopyFacts(copy, '{"prompt":"Invoice due soon"}')).toEqual(
			["1,200", "billing@example.com", "2026-10-24"],
		);
	});
});
