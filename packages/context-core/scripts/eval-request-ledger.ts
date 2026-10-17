import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import cases from "../src/request-ledger-precision.json";
import replyCases from "../src/request-ledger-reply-precision.json";
import {
	type LedgerRowRef,
	hasLedgerIntake,
	parseReflectedNewRows,
	parseReflectedMerges,
	parseReflectedUpdates,
	parseObservedRequests,
	REQUEST_REPLY_REFLECTOR_SYSTEM_PROMPT,
	requestReplyReflectorInput,
	REQUEST_REFLECTOR_SYSTEM_PROMPT,
	REQUEST_INTAKE_SYSTEM_PROMPT,
	requestReflectorInput,
	requestIntakeInput,
} from "../src/request-ledger";

const url = process.env.LEDGER_EVAL_URL;
const authorization = process.env.LEDGER_EVAL_AUTHORIZATION;
if (!url || !authorization)
	throw new Error("Set LEDGER_EVAL_URL and LEDGER_EVAL_AUTHORIZATION");
async function ask(system: string, prompt: string): Promise<string | null> {
	const response = await fetch(url!, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"cf-aig-authorization": authorization!,
			authorization: authorization!,
		},
		body: JSON.stringify({
			model: process.env.LEDGER_EVAL_MODEL ?? "gpt-6-astra",
			instructions: system,
			input: prompt,
			reasoning: { effort: "low" },
			max_output_tokens: 6000,
		}),
		signal: AbortSignal.timeout(24_000),
	});
	if (!response.ok) throw new Error(`Evaluation HTTP ${response.status}`);
	const result = (await response.json()) as {
		status?: string;
		output?: Array<{
			type: string;
			content?: Array<{ type: string; text?: string }>;
		}>;
	};
	if (result.status !== "completed") return null;
	return (
		result.output
			?.filter((item) => item.type === "message")
			.flatMap((item) => item.content ?? [])
			.filter((item) => item.type === "output_text")
			.map((item) => item.text ?? "")
			.join("\n") ?? null
	);
}
const reflectorInputs = cases.map((test) =>
	requestReflectorInput(
		test.turn,
		test.rows as LedgerRowRef[],
		"",
		test.resolved as LedgerRowRef[],
		test.message,
	),
);
const intakeInputs = cases.map((test) =>
	requestIntakeInput(
		test.turn,
		[...test.rows, ...test.resolved] as LedgerRowRef[],
		test.message,
	),
);
const results: Array<{
	id: string;
	raw: string | null;
	intakeRaw: string | null;
}> = [];
let failures = 0;
for (const [index, test] of cases.entries()) {
	const [raw, intakeRaw] = await Promise.all([
		ask(REQUEST_REFLECTOR_SYSTEM_PROMPT, reflectorInputs[index]!),
		ask(REQUEST_INTAKE_SYSTEM_PROMPT, intakeInputs[index]!),
	]);
	const updates = parseReflectedUpdates(
		raw,
		new Set(test.rows.map((row) => row.ref)),
		`${test.message}\n${test.turn}`,
	);
	const done = updates
		?.filter((update) => update.status === "done")
		.map((update) => update.ref)
		.sort();
	const cancelled = updates
		?.filter((update) => update.status === "cancelled")
		.map((update) => update.ref)
		.sort();
	const newKinds = parseReflectedNewRows(intakeRaw, test.turn)
		.map((row) => row.kind)
		.sort();
	const merges = parseReflectedMerges(raw, [
		...test.rows,
		...test.resolved,
	] as LedgerRowRef[])
		.map(({ ref, into }) => [ref, into])
		.sort();
	const passed =
		hasLedgerIntake(intakeRaw) &&
		JSON.stringify(cancelled) ===
			JSON.stringify([...test.expected.cancelled].sort()) &&
		JSON.stringify(done) === JSON.stringify([...test.expected.done].sort()) &&
		JSON.stringify(newKinds) ===
			JSON.stringify([...test.expected.new].sort()) &&
		JSON.stringify(merges) === JSON.stringify([...test.expected.merges].sort());
	if (!passed) failures++;
	results.push({ id: test.id, raw, intakeRaw });
	console.log(
		JSON.stringify({
			id: test.id,
			passed,
			expected: test.expected,
			cancelled,
			done,
			newKinds,
			merges,
			raw,
			intakeRaw,
		}),
	);
}
const replyInputs = replyCases.map((test) =>
	requestReplyReflectorInput(
		test.message,
		test.rows as LedgerRowRef[],
		test.previousTurn,
	),
);
const replyResults: Array<{ id: string; raw: string | null }> = [];
for (const [index, test] of replyCases.entries()) {
	const raw = await ask(
		REQUEST_REPLY_REFLECTOR_SYSTEM_PROMPT,
		replyInputs[index]!,
	);
	const result = parseObservedRequests(
		raw,
		new Set(test.rows.map((row) => row.ref)),
	);
	const passed =
		result !== null &&
		JSON.stringify(result.answered.map((row) => row.ref).sort()) ===
			JSON.stringify([...test.expected.answered].sort()) &&
		result.requests.length === test.expected.requests &&
		result.requests.every(
			(row) =>
				row.text.toLowerCase().includes(test.expected.term) &&
				!/^(send|publish)\b/i.test(row.text),
		);
	if (!passed) failures++;
	replyResults.push({ id: test.id, raw });
	console.log(JSON.stringify({ id: test.id, passed, raw }));
}
console.log(
	JSON.stringify({ cases: cases.length + replyCases.length, failures }),
);
if (!failures && process.env.LEDGER_EVAL_RESULTS) {
	const hash = (text: string) =>
		createHash("sha256").update(text).digest("hex");
	writeFileSync(
		process.env.LEDGER_EVAL_RESULTS,
		JSON.stringify(
			{
				model: process.env.LEDGER_EVAL_MODEL ?? "gpt-6-astra",
				systemHash: hash(REQUEST_REFLECTOR_SYSTEM_PROMPT),
				replySystemHash: hash(REQUEST_REPLY_REFLECTOR_SYSTEM_PROMPT),
				replyInputHash: hash(JSON.stringify(replyInputs)),
				replyResults,
				intakeSystemHash: hash(REQUEST_INTAKE_SYSTEM_PROMPT),
				inputHash: hash(JSON.stringify(reflectorInputs)),
				intakeInputHash: hash(JSON.stringify(intakeInputs)),
				results,
			},
			null,
			"\t",
		) + "\n",
	);
}
process.exitCode = failures ? 1 : 0;
