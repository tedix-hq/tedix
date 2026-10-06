import { describe, expect, it } from "vite-plus/test";
import {
	activityRowKey,
	activityRowText,
	countToolResultRows,
	type ActivityRowInput,
} from "./tool-summary";

const copy = {
	checked: () => "Checked Acme",
	checking: () => "Checking Acme…",
	failed: () => "Acme could not be reached",
	results: (count: number) => `${count} results`,
	times: (count: number) => `${count}×`,
};

const call = (over: Partial<ActivityRowInput> = {}): ActivityRowInput => ({
	id: "a",
	status: "completed",
	startedAt: 1000,
	finishedAt: 1200,
	...over,
});

describe("activityRowKey", () => {
	it("keeps one identity across the in-flight and settled render", () => {
		const running = call({
			status: "running",
			displayLabel: "Checked orders",
			pendingLabel: "Checking orders…",
		});
		const settled = { ...running, status: "completed" as const };
		expect(activityRowKey(running)).toBe(activityRowKey(settled));
	});

	it("collapses every unlabelled tool onto one generic row", () => {
		expect(activityRowKey(call())).toBe(activityRowKey(call({ id: "b" })));
	});
});

describe("activityRowText", () => {
	it("says what the tenant called it, with the count and the duration", () => {
		expect(
			activityRowText(
				[
					call({
						displayLabel: "Checked orders",
						result: { orders: [1, 2, 3] },
						startedAt: 1000,
						finishedAt: 5000,
					}),
				],
				copy,
			).text,
		).toBe("✓ Checked orders · 3 results · 4s");
	});

	it("never shows a callable, its arguments or a raw result payload", () => {
		// The reducer's activity carries all three; only product language may
		// reach the transcript.
		const activity = {
			...call({ result: { note: "RAW-RESULT-PAYLOAD" } }),
			toolName: "shop.secret_callable",
			args: { token: "RAW-ARGUMENT" },
		} as ActivityRowInput;
		for (const status of ["running", "completed", "error"] as const) {
			const { text } = activityRowText([{ ...activity, status }], copy);
			expect(text).not.toMatch(
				/secret_callable|RAW-ARGUMENT|RAW-RESULT-PAYLOAD/,
			);
		}
	});

	it("falls back to the generic product line when nobody authored a label", () => {
		expect(activityRowText([call()], copy).text).toBe("✓ Checked Acme");
	});

	it("shows the tenant's present tense before the tool has answered", () => {
		const line = activityRowText(
			[
				call({
					status: "running",
					pendingLabel: "Checking orders…",
					inputChars: 12,
				}),
			],
			copy,
		);
		expect(line).toEqual({
			text: "Checking orders…",
			status: "running",
			streaming: true,
		});
	});

	it("collapses repeated calls to one row with a count", () => {
		expect(
			activityRowText(
				[
					call({ displayLabel: "Checked orders", result: { a: [1, 2] } }),
					call({ id: "b", displayLabel: "Checked orders", result: { a: [1] } }),
				],
				copy,
			).text,
		).toBe("✓ Checked orders · 2× · 3 results");
	});

	it("reports a failure with the one catalog string and no error text", () => {
		const line = activityRowText(
			[call({ status: "error", displayLabel: "Checked orders" })],
			copy,
		);
		expect(line.text).toBe("Acme could not be reached");
		expect(line.status).toBe("error");
	});
});

describe("countToolResultRows", () => {
	it("reports the size of the collection a tool returned", () => {
		expect(countToolResultRows({ orders: [1, 2, 3] })).toBe(3);
		expect(countToolResultRows([{ id: 1 }, { id: 2 }])).toBe(2);
	});

	it("finds the collection however deep the envelope wraps it", () => {
		expect(
			countToolResultRows({
				ok: true,
				data: { result: { items: [1, 2, 3, 4, 5] }, meta: { total: 99 } },
			}),
		).toBe(5);
	});

	it("prefers the largest collection, not the first", () => {
		expect(countToolResultRows({ a: [1], b: [1, 2, 3] })).toBe(3);
	});

	it("says nothing about a single record, a scalar or an error", () => {
		expect(countToolResultRows({ id: 7, status: "open" })).toBeNull();
		expect(countToolResultRows("218")).toBeNull();
		expect(countToolResultRows(null)).toBeNull();
		expect(countToolResultRows({ ok: false, error: "nope" })).toBeNull();
	});

	it("reports an empty result honestly rather than hiding it", () => {
		expect(countToolResultRows({ orders: [] })).toBe(0);
	});

	it("stays bounded on a deep or wide result", () => {
		let deep: unknown = [1, 2, 3];
		for (let i = 0; i < 12; i += 1) deep = { nested: deep };
		expect(countToolResultRows(deep)).toBeNull();
	});
});
