import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import cases from "../src/request-ledger-precision.json";
import {
	type LedgerRowRef,
	parseReflectedNewRows,
	parseReflectedMerges,
	parseReflectedUpdates,
	REQUEST_REFLECTOR_SYSTEM_PROMPT,
	requestReflectorInput,
} from "../src/request-ledger";

// Run explicitly against a Responses-compatible deployment; unit tests stay offline.
const url = process.env.LEDGER_EVAL_URL;
const authorization = process.env.LEDGER_EVAL_AUTHORIZATION;
if (!url || !authorization)
	throw new Error("Set LEDGER_EVAL_URL and LEDGER_EVAL_AUTHORIZATION");
let failures = 0;
const results: Array<{ id: string; raw: string | null }> = [];
for (const test of cases) {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"cf-aig-authorization": authorization,
			authorization,
		},
		body: JSON.stringify({
			model: process.env.LEDGER_EVAL_MODEL ?? "gpt-6-astra",
			instructions: REQUEST_REFLECTOR_SYSTEM_PROMPT,
			input: requestReflectorInput(
				test.turn,
				test.rows as LedgerRowRef[],
				"",
				test.resolved as LedgerRowRef[],
				test.message,
			),
			reasoning: { effort: "low" },
			max_output_tokens: 6000,
		}),
		signal: AbortSignal.timeout(25_000),
	});
	if (!response.ok) throw new Error(`Evaluation HTTP ${response.status}`);
	const result = (await response.json()) as {
		status?: string;
		output?: Array<{
			type: string;
			content?: Array<{ type: string; text?: string }>;
		}>;
	};
	const raw =
		result.output
			?.filter((item) => item.type === "message")
			.flatMap((item) => item.content ?? [])
			.filter((item) => item.type === "output_text")
			.map((item) => item.text ?? "")
			.join("\n") ?? null;
	const source = `${test.message}\n${test.turn}`;
	const updates = parseReflectedUpdates(
		raw,
		new Set(test.rows.map((row) => row.ref)),
		source,
	);
	const done = updates
		?.filter((update) => update.status === "done")
		.map((update) => update.ref)
		.sort();
	const newKinds = parseReflectedNewRows(raw, test.turn)
		.map((row) => row.kind)
		.sort();
	const merges = parseReflectedMerges(raw, [
		...test.rows,
		...test.resolved,
	] as LedgerRowRef[])
		.map(({ ref, into }) => [ref, into])
		.sort();
	results.push({ id: test.id, raw });
	const passed =
		result.status === "completed" &&
		JSON.stringify(done) === JSON.stringify([...test.expected.done].sort()) &&
		JSON.stringify(newKinds) ===
			JSON.stringify([...test.expected.new].sort()) &&
		JSON.stringify(merges) === JSON.stringify([...test.expected.merges].sort());
	if (!passed) failures++;
	console.log(
		JSON.stringify({
			id: test.id,
			passed,
			expected: test.expected,
			done,
			newKinds,
			merges,
			raw,
		}),
	);
}
console.log(JSON.stringify({ cases: cases.length, failures }));
if (!failures && process.env.LEDGER_EVAL_RESULTS) {
	const hash = (text: string) =>
		createHash("sha256").update(text).digest("hex");
	writeFileSync(
		process.env.LEDGER_EVAL_RESULTS,
		JSON.stringify(
			{
				model: process.env.LEDGER_EVAL_MODEL ?? "gpt-6-astra",
				systemHash: hash(REQUEST_REFLECTOR_SYSTEM_PROMPT),
				inputHash: hash(
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
				results,
			},
			null,
			"\t",
		) + "\n",
	);
}
process.exitCode = failures ? 1 : 0;
