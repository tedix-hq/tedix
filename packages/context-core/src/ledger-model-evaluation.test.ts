import { describe, expect, it } from "vite-plus/test";
import recorded from "./request-ledger-precision-results.json";
import { REQUEST_REFLECTOR_SYSTEM_PROMPT } from "./request-ledger";
import {
	getLedgerEvaluationCase,
	hashLedgerEvaluationCase,
	listLedgerEvaluationCases,
} from "./ledger-model-evaluation";

describe("fixed ledger model qualification", () => {
	it("retains every existing corpus case and independently grades the authentic reference", () => {
		for (const row of recorded.results) {
			expect(
				getLedgerEvaluationCase("status", row.id)!.grade(row.raw),
				row.id,
			).toMatchObject({ passed: true });
			expect(
				getLedgerEvaluationCase("intake", row.id)!.grade(row.intakeRaw),
				row.id,
			).toMatchObject({ passed: true });
		}
		for (const row of recorded.replyResults)
			expect(
				getLedgerEvaluationCase("reply", row.id)!.grade(row.raw),
				row.id,
			).toMatchObject({ passed: true });
		expect(listLedgerEvaluationCases()).toHaveLength(91);
	});
	it("rejects malformed response on every case, including expected empty cases", () => {
		for (const row of listLedgerEvaluationCases())
			expect(
				getLedgerEvaluationCase(row.surface, row.caseId)!.grade(null).passed,
				row.caseId,
			).toBe(false);
	});
	it("keeps candidate prompts separate and hashes exact input bytes", async () => {
		const prod = getLedgerEvaluationCase("status", "chat-acceptance")!;
		const candidate = getLedgerEvaluationCase(
			"status",
			"chat-acceptance",
			"shorter_status",
		)!;
		expect(prod.system).toBe(REQUEST_REFLECTOR_SYSTEM_PROMPT);
		expect(candidate.system.length).toBeLessThan(prod.system.length);
		expect(candidate.prompt).toBe(prod.prompt);
		expect(candidate.system).toContain(
			"Never infer approval from an agent claim",
		);
		expect(candidate.system).toContain(
			"A completion notification proves the lane returned",
		);
		expect(await hashLedgerEvaluationCase(prod)).not.toEqual(
			await hashLedgerEvaluationCase(candidate),
		);
		expect(
			getLedgerEvaluationCase("intake", "chat-acceptance", "shorter_status"),
		).toBeNull();
		expect(getLedgerEvaluationCase("status", "untrusted-input")).toBeNull();
	});
	it("does not allow baseline done-only grading to hide state, lane or scope regressions", () => {
		const test = getLedgerEvaluationCase("status", "chat-acceptance")!;
		expect(
			test.grade('{"updates":[],"lanes":[],"mentioned":{},"merges":[]}')
				.failures,
		).toContain("all status updates");
		const raw = recorded.results.find(
			(row) => row.id === "chat-acceptance",
		)!.raw;
		const wrong = JSON.parse(raw);
		wrong.lanes = [];
		expect(test.grade(JSON.stringify(wrong)).failures).toContain("lane state");
		expect(
			getLedgerEvaluationCase("intake", "selected-measured-goal")!.grade(
				'{"new":[{"kind":"promise","text":"Improve retrieval","evidence":"Here is the selected goal I\'m starting now:"}]}',
			).passed,
		).toBe(false);
	});
	it("does not accept numeric substrings as the original acceptance targets", () => {
		const result = getLedgerEvaluationCase(
			"intake",
			"selected-measured-goal",
		)!.grade(
			JSON.stringify({
				new: [
					{
						kind: "promise",
						text: "Deliver doc under 50 seconds and answer under 30 seconds on 200 requests",
						evidence: "Here is the selected goal I'm starting now:",
					},
				],
			}),
		);
		expect(result.failures).toContain("missing scope: 5");
		expect(result.failures).toContain("missing scope: 3");
		expect(result.failures).toContain("missing scope: 20");
	});
	it("rejects human approval fabricated by agent reports and answers cited outside the user reply", () => {
		expect(
			getLedgerEvaluationCase("status", "do-not-infer-human-approval")!.grade(
				'{"updates":[{"ref":"r1","status":"done","evidence":"approval was granted"}],"mentioned":{},"lanes":[],"merges":[]}',
			).passed,
		).toBe(false);
		expect(
			getLedgerEvaluationCase("reply", "selected-draft-is-not-sending")!.grade(
				'{"requests":[{"kind":"request","text":"Create private draft"}],"answered":[{"ref":"r1","evidence":"I approve sending"}],"cancelled":[]}',
			).passed,
		).toBe(false);
	});
	it("requires exact ordered lesson evidence and rejects unsupported raw lessons", () => {
		const raw = JSON.stringify({
			lessons: [
				{
					rule: "upload_report body limit → Use native upload. Why: Inline bodies exceed the limit.",
					failure: "Failed upload_report: body too large",
					fix: "Fixed upload_report by using native file upload; upload_report saved successfully.",
				},
			],
		});
		expect(
			getLedgerEvaluationCase("lesson", "same-operation-recovery")!.grade(raw),
		).toMatchObject({
			passed: true,
			parsed: [{ failureEventId: "failure", fixEventId: "fix" }],
		});
		expect(
			getLedgerEvaluationCase("lesson", "success-before-failure")!.grade(raw)
				.passed,
		).toBe(false);
		expect(
			getLedgerEvaluationCase("lesson", "unrelated-success")!.grade(raw).passed,
		).toBe(false);
		expect(
			getLedgerEvaluationCase("lesson", "planned-fix")!.grade('{"lessons":[]}')
				.passed,
		).toBe(true);
	});
});

it("grades original scopes with real activity and lane returns in both prompt variants", () => {
	const fixtures = [
		{
			id: "scope-numeric-target-in-activity",
			updates: [
				{
					ref: "r1",
					status: "in_progress",
					evidence: "The measured acceptance target is still unmet.",
				},
			],
			lanes: [],
			mentioned: {},
		},
		{
			id: "scope-sibling-send-stays-reserved",
			updates: [
				{
					ref: "r1",
					status: "done",
					evidence:
						"Saved private email draft and read it back; no message was sent.",
				},
			],
			lanes: [],
			mentioned: { r2: "Sending still needs your explicit approval." },
		},
		{
			id: "scope-failed-lane-return-is-not-deployment",
			updates: [],
			lanes: [
				{
					ref: "r1",
					running: false,
					evidence:
						"Delegated deploy lane returned its terminal failure report.",
				},
			],
			mentioned: {},
		},
		{
			id: "scope-proposal-not-new-activation",
			updates: [
				{
					ref: "r1",
					status: "done",
					evidence: "The proposed rule is saved and read back.",
				},
			],
			lanes: [],
			mentioned: {},
		},
	];
	for (const variant of ["production", "shorter_status"] as const)
		for (const fixture of fixtures) {
			const test = getLedgerEvaluationCase("status", fixture.id, variant)!;
			expect(test.prompt).not.toContain(
				"ORIGINAL REQUEST SCOPES:\n<<<\nnone recorded",
			);
			expect(test.prompt).not.toContain("ACTIVITY:\n<<<\nnone recorded");
			expect(
				test.grade(JSON.stringify({ ...fixture, merges: [] })),
				`${fixture.id}:${variant}`,
			).toMatchObject({ passed: true });
			expect(
				test.grade('{"updates":[],"lanes":[],"mentioned":{},"merges":[]}')
					.passed,
			).toBe(false);
		}
	const reserved = getLedgerEvaluationCase(
		"status",
		"scope-sibling-send-stays-reserved",
	)!;
	expect(
		reserved.grade(
			JSON.stringify({
				updates: [
					{
						ref: "r2",
						status: "done",
						evidence: "Sending still needs your explicit approval.",
					},
				],
				lanes: [],
				mentioned: {},
				merges: [],
			}),
		).passed,
	).toBe(false);
});

it("uses synthetic production-length lessons with unique evidence and chronological distractors", () => {
	const positive = getLedgerEvaluationCase(
		"lesson",
		"long-31k-unique-recovery",
	)!;
	const unsafe = getLedgerEvaluationCase(
		"lesson",
		"long-85k-unsafe-unrelated-success",
	)!;
	const reversed = getLedgerEvaluationCase(
		"lesson",
		"long-85k-reversed-chronology",
	)!;
	for (const [test, tokens] of [
		[positive, 31000],
		[unsafe, 85000],
		[reversed, 85000],
	] as const) {
		expect(Math.ceil(test.prompt.length / 4)).toBeGreaterThanOrEqual(tokens);
		expect(Math.ceil(test.prompt.length / 4)).toBeLessThan(tokens + 500);
		const sources = JSON.parse(test.prompt);
		expect(
			new Set(sources.map((source: { id: string }) => source.id)).size,
		).toBe(sources.length);
	}
	const recovery = {
		rule: "upload_report inline body limit → Use native file upload. Why: Inline bodies exceed request limits.",
		failure: "Failed upload_report: inline body exceeds request limit",
		fix: "Fixed upload_report by native file upload; upload_report saved successfully.",
	};
	expect(positive.grade(JSON.stringify({ lessons: [recovery] }))).toMatchObject(
		{
			passed: true,
			parsed: [{ failureEventId: "long-failure", fixEventId: "long-fix" }],
		},
	);
	expect(positive.grade('{"lessons":[]}').passed).toBe(false);
	expect(unsafe.grade('{"lessons":[]}').passed).toBe(true);
	expect(unsafe.grade(JSON.stringify({ lessons: [recovery] })).passed).toBe(
		false,
	);
	expect(reversed.grade('{"lessons":[]}').passed).toBe(true);
	expect(
		reversed.grade(
			JSON.stringify({
				lessons: [
					{
						...recovery,
						failure: "Failed upload_report: native upload credentials expired",
					},
				],
			}),
		).passed,
	).toBe(false);
});

it("rejects adopted delivery anywhere in draft-only replies while retaining explicit no-send constraints", () => {
	const test = getLedgerEvaluationCase(
		"reply",
		"selected-draft-is-not-sending",
	)!;
	const result = (text: string) =>
		test.grade(
			JSON.stringify({
				requests: [{ kind: "request", text }],
				answered: [{ ref: "r1", evidence: "1 and go" }],
				cancelled: [],
			}),
		);
	for (const text of [
		"Create a private draft and send it publicly",
		"Create a draft then publish it",
		"Create the draft; do not send it, but publish it online",
	])
		expect(result(text).passed, text).toBe(false);
	for (const text of [
		"Create a private draft",
		"Create a private draft; do not send it",
		"Create a private draft without sending or publishing it",
		"Create the draft; send no messages",
	])
		expect(result(text).passed, text).toBe(true);
});
