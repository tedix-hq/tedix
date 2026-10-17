import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import cases from "./request-ledger-precision.json";
import replyCases from "./request-ledger-reply-precision.json";
import recorded from "./request-ledger-precision-results.json";
import {
	type LedgerRowRef,
	hasLedgerIntake,
	parseReflectedMerges,
	parseReflectedNewRows,
	parseReflectedUpdates,
	parseObservedRequests,
	REQUEST_REPLY_REFLECTOR_SYSTEM_PROMPT,
	requestReplyReflectorInput,
	REQUEST_REFLECTOR_SYSTEM_PROMPT,
	REQUEST_INTAKE_SYSTEM_PROMPT,
	requestReflectorInput,
	requestIntakeInput,
} from "./request-ledger";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

describe("request ledger precision corpus", () => {
	it("requires re-evaluation when either model prompt or its corpus input changes", () => {
		expect(hash(REQUEST_REFLECTOR_SYSTEM_PROMPT)).toBe(recorded.systemHash);
		expect(hash(REQUEST_REPLY_REFLECTOR_SYSTEM_PROMPT)).toBe(
			recorded.replySystemHash,
		);
		expect(
			hash(
				JSON.stringify(
					replyCases.map((test) =>
						requestReplyReflectorInput(
							test.message,
							test.rows as LedgerRowRef[],
							test.previousTurn,
						),
					),
				),
			),
		).toBe(recorded.replyInputHash);
		expect(recorded.replyResults.map((result) => result.id)).toEqual(
			replyCases.map((test) => test.id),
		);
		expect(hash(REQUEST_INTAKE_SYSTEM_PROMPT)).toBe(recorded.intakeSystemHash);
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
		expect(
			hash(
				JSON.stringify(
					cases.map((test) =>
						requestIntakeInput(
							test.turn,
							[...test.rows, ...test.resolved] as LedgerRowRef[],
							test.message,
						),
					),
				),
			),
		).toBe(recorded.intakeInputHash);
		expect(recorded.results.map((result) => result.id)).toEqual(
			cases.map((test) => test.id),
		);
	});
	it.each(cases)(
		"$id retains only the expected unfinished outcomes",
		(test) => {
			const result = recorded.results.find((result) => result.id === test.id)!;
			expect(hasLedgerIntake(result.intakeRaw)).toBe(true);
			const updates = parseReflectedUpdates(
				result.raw,
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
				updates
					?.filter((update) => update.status === "cancelled")
					.map((update) => update.ref)
					.sort(),
			).toEqual([...test.expected.cancelled].sort());
			expect(
				parseReflectedNewRows(result.intakeRaw, test.turn)
					.map((row) => row.kind)
					.sort(),
			).toEqual([...test.expected.new].sort());
			expect(
				parseReflectedMerges(result.raw, [
					...test.rows,
					...test.resolved,
				] as LedgerRowRef[])
					.map(({ ref, into }) => [ref, into])
					.sort(),
			).toEqual([...test.expected.merges].sort());
		},
	);
	it.each(replyCases)("$id resolves only the adopted outcome", (test) => {
		const raw = recorded.replyResults.find(
			(result) => result.id === test.id,
		)!.raw;
		const result = parseObservedRequests(
			raw,
			new Set(test.rows.map((row) => row.ref)),
		)!;
		expect(result.answered.map((row) => row.ref).sort()).toEqual(
			[...test.expected.answered].sort(),
		);
		expect(result.requests).toHaveLength(test.expected.requests);
		for (const row of result.requests) {
			expect(row.text.toLowerCase()).toContain(test.expected.term);
			expect(row.text).not.toMatch(/^(send|publish)\b/i);
		}
		for (const answer of result.answered)
			expect(test.message.toLowerCase()).toContain(
				answer.evidence.toLowerCase(),
			);
	});
});
