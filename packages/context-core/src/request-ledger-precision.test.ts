import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import cases from "./request-ledger-precision.json";
import recorded from "./request-ledger-precision-results.json";
import {
	type LedgerRowRef,
	parseReflectedMerges,
	parseReflectedNewRows,
	parseReflectedUpdates,
	REQUEST_REFLECTOR_SYSTEM_PROMPT,
	requestReflectorInput,
} from "./request-ledger";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

describe("request ledger precision corpus", () => {
	it("requires re-evaluation when the prompt or corpus input changes", () => {
		expect(hash(REQUEST_REFLECTOR_SYSTEM_PROMPT)).toBe(recorded.systemHash);
		expect(
			hash(
				JSON.stringify(
					cases.map((test) =>
						requestReflectorInput(
							test.turn,
							test.rows as LedgerRowRef[],
							"",
							test.resolved as LedgerRowRef[],
							test.message,
						),
					),
				),
			),
		).toBe(recorded.inputHash);
		expect(recorded.results.map((result) => result.id)).toEqual(
			cases.map((test) => test.id),
		);
	});
	it.each(cases)(
		"$id retains only the expected unfinished outcomes",
		(test) => {
			const raw = recorded.results.find((result) => result.id === test.id)!.raw;
			const updates = parseReflectedUpdates(
				raw,
				new Set(test.rows.map((row) => row.ref)),
				`${test.message}\n${test.turn}`,
			);
			expect(
				updates
					?.filter((update) => update.status === "done")
					.map((update) => update.ref)
					.sort(),
			).toEqual([...test.expected.done].sort());
			expect(
				parseReflectedNewRows(raw, test.turn)
					.map((row) => row.kind)
					.sort(),
			).toEqual([...test.expected.new].sort());
			expect(
				parseReflectedMerges(raw, [
					...test.rows,
					...test.resolved,
				] as LedgerRowRef[])
					.map(({ ref, into }) => [ref, into])
					.sort(),
			).toEqual([...test.expected.merges].sort());
		},
	);
});
