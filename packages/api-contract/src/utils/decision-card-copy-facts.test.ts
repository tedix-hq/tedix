import { strict as assert } from "node:assert";
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

	it("keeps numeric punctuation, single digits and email facts in source order", () => {
		expect(
			unsupportedCopyFacts(
				{
					...copy,
					body: "7, 12:30 / 9-- billing+2@mail.example.com 42...",
					title: "",
					recommendation: "",
				},
				"",
			),
		).toEqual(["7", "12:30", "9", "billing+2@mail.example.com", "42"]);
	});

	it("does not consume the next address when trimming numeric punctuation", () => {
		expect(
			unsupportedCopyFacts(
				{
					...copy,
					title: "",
					body: "1,--billing@example.com",
					recommendation: "",
				},
				"",
			),
		).toEqual(["1", "--billing@example.com"]);
	});

	it("handles long failed email candidates and numeric punctuation runs", () => {
		const body = `${"+".repeat(100_000)} ${"a".repeat(100_000)}@${"b".repeat(100_000)} 1${"-".repeat(100_000)}! 23`;
		const started = performance.now();
		expect(
			unsupportedCopyFacts(
				{ ...copy, body, title: "", recommendation: "" },
				"",
			),
		).toEqual(["1", "23"]);
		expect(performance.now() - started).toBeLessThan(1000);
	});
});

it("preserves the bounded regex's facts on generated and overlapping candidates", () => {
	const oldFacts = (text: string) => {
		const pattern = /[\w.+-]{1,64}@[\w-]{1,63}\.[\w.]{1,253}|\d[\d.,:/-]*/g;
		const facts: string[] = [];
		for (let match; (match = pattern.exec(text));) {
			let fact = match[0];
			if (!fact.includes("@")) {
				let end = fact.length;
				while (end > 1 && !/\d/.test(fact[end - 1]!)) end--;
				fact = fact.slice(0, end);
				pattern.lastIndex = match.index + end;
			}
			facts.push(fact);
		}
		return [...new Set(facts)];
	};
	const parts = [
		"a",
		"2",
		"@",
		".",
		"+",
		"-",
		" ",
		"1,--",
		"9/",
		"mail.example.com",
		"_",
		"b".repeat(65),
	];
	let state = 7;
	for (let i = 0; i < 5000; i++) {
		let body = "";
		for (let j = 0; j < 12; j++) {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			body += parts[state % parts.length];
		}
		assert.deepEqual(
			unsupportedCopyFacts({ title: "", body, recommendation: "" }, ""),
			oldFacts(body),
			body,
		);
	}
});
