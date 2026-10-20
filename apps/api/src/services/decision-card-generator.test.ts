import { beforeEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	preferences: vi.fn(),
	model: vi.fn(),
}));
vi.mock("./decision-learning", () => ({
	readDraftPreferences: mocks.preferences,
}));
vi.mock("./decision-card-copy-model", () => ({
	runDecisionCardCopyModel: mocks.model,
}));
import { generateDecisionCard } from "./decision-card-generator";
import copySpec from "@tedix/api-contract/assets/decision-card-copy.v2.json";
const request = {
	orgId: "fictional",
	targetId: "robin",
	kind: "question",
	subject: "Sign-in proof",
	prompt: "Review a fictional sign-in; no approval exists.",
	metadata: {},
};
const copy = {
	version: 2,
	title: "Let the assistant sign in with a test account?",
	context: "The owner is waiting on this review.",
	body: "Checks the sample profile page using a separate browser.",
	recommendation: "The owner needs proof that sign-in works.",
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.preferences.mockResolvedValue("Prefer shorter proposals.");
	mocks.model.mockResolvedValue(JSON.stringify(copy));
});
it("uses the recipient's style and configured model without generating authority", async () => {
	expect(
		await generateDecisionCard({ db: {}, env: {} } as never, request),
	).toMatchObject({ ...copy, model: copySpec.modelRef });
	expect(mocks.preferences).toHaveBeenCalledWith(
		{},
		"fictional",
		"robin",
		undefined,
	);
	expect(mocks.model.mock.calls[0]?.[2]).toMatchObject({
		model: copySpec.modelRef,
		orgId: "fictional",
	});
	expect(mocks.model.mock.calls[0]?.[1]).toContain("Prefer shorter proposals.");
});
it("loads the versioned spec with a plain-English rewriter and Adriana rubric", async () => {
	await generateDecisionCard({ db: {}, env: {} } as never, request);
	const system = mocks.model.mock.calls[0]?.[2].system;
	expect(system).toContain(copySpec.system);
	expect(system).toContain(copySpec.effectAvailabilityInstruction);
	expect(system).toContain("Adriana test");
	for (const word of copySpec.bannedWords) expect(system).toContain(word);
});
it.each([
	{ ...copy, title: "x".repeat(81) },
	{ ...copy, body: "x".repeat(121) },
	{ ...copy, recommendation: "x".repeat(121) },
	{ ...copy, version: 1 },
	{ ...copy, options: [{ intent: "approve" }] },
	{ ...copy, title: "Approve the sign-in" },
	{ ...copy, body: "One line.\nAnother." },
	{ ...copy, body: "Review the canonical workflow." },
	{
		...copy,
		title: "Use a simpler purpose statement?",
		body: "Use the simpler purpose statement.",
		recommendation: "The purpose statement should be simpler.",
	},
	{ ...copy, body: "Review ticket 11111111-2222-4333-8444-555555555555." },
	{ ...copy, body: "Read work_abcd1234." },
	{ ...copy, body: "Read [reference]." },
	{ ...copy, body: "Read 96c05a17." },
])(
	"rejects invalid or overlapping copy and retries with the failed draft",
	async (invalid) => {
		mocks.model.mockResolvedValue(JSON.stringify(invalid));
		expect(
			await generateDecisionCard({ db: {}, env: {} } as never, request),
		).toBeNull();
		expect(mocks.model).toHaveBeenCalledTimes(2);
	},
);
it("repairs rejected wording rather than truncating it", async () => {
	mocks.model.mockResolvedValueOnce(
		JSON.stringify({ ...copy, body: "Review this workflow." }),
	);
	expect(
		await generateDecisionCard({ db: {}, env: {} } as never, request),
	).toMatchObject(copy);
	expect(mocks.model.mock.calls[1]?.[1]).toBe(mocks.model.mock.calls[0]?.[1]);
	expect(mocks.model.mock.calls[1]?.[2].validationFeedback).toContain(
		"banned_words",
	);
	expect(mocks.model.mock.calls[1]?.[2].validationFeedback).toContain(
		"Review this workflow.",
	);
	expect(mocks.model.mock.calls[1]?.[2].system).toContain(copySpec.repair);
});
it.each(copySpec.bannedWords)(
	"rejects banned card vocabulary: %s",
	async (word) => {
		mocks.model.mockResolvedValue(
			JSON.stringify({
				...copy,
				recommendation: `The current ${word} needs a review.`,
			}),
		);
		expect(
			await generateDecisionCard({ db: {}, env: {} } as never, request),
		).toBeNull();
	},
);
it("allows supported optional stakes and supplies version outside model prose", async () => {
	const { version: _, ...prose } = copy;
	mocks.model.mockResolvedValue(
		JSON.stringify({ ...prose, stakes: "The test account expires on Friday." }),
	);
	expect(
		await generateDecisionCard({ db: {}, env: {} } as never, {
			...request,
			prompt: "Check sign-in with the test account, which expires on Friday.",
		}),
	).toMatchObject({ ...copy, stakes: "The test account expires on Friday." });
});
it("does not repeat an unchanged provider failure", async () => {
	mocks.model.mockResolvedValue(null);
	expect(
		await generateDecisionCard({ db: {}, env: {} } as never, request),
	).toBeNull();
	expect(mocks.model).toHaveBeenCalledTimes(1);
});
it("preserves measured feedback, bounds context, and omits unrelated operational lessons", async () => {
	mocks.preferences.mockResolvedValue(
		JSON.stringify({
			purpose: "Writing context only",
			preferences: [{ text: "Keep my voice." }],
			summaryImprovements: [
				{ instruction: "Only 50% decided from the card alone." },
			],
			lessons: [
				{ text: "x".repeat(5000) },
				{ text: "Keep proposals short." },
				{ text: "Retry provider outages after checking deployments." },
			],
		}),
	);
	await generateDecisionCard({ db: {}, env: {} } as never, request);
	const prefs = JSON.parse(
		JSON.parse(mocks.model.mock.calls[0]?.[1]).preferences,
	);
	expect(JSON.stringify(prefs).length).toBeLessThanOrEqual(3000);
	expect(prefs.preferences).toEqual([{ text: "Keep my voice." }]);
	expect(prefs.summaryImprovements).toEqual([
		{ instruction: "Only 50% decided from the card alone." },
	]);
	expect(prefs.lessons).toEqual([{ text: "Keep proposals short." }]);
});
it("omits opaque source identifiers", async () => {
	const id = "11111111-2222-4333-8444-555555555555";
	await generateDecisionCard({ db: {}, env: {} } as never, {
		...request,
		prompt: `Review ticket ${id}.`,
	});
	expect(mocks.model.mock.calls[0]?.[1]).not.toContain(id);
});
it.each([
	"Keep this filing because the request needs approval.",
	"Approve because it is explicitly authorized in the prompt.",
])("rejects wrong-kind or invented authority", async (recommendation) => {
	mocks.model.mockResolvedValue(JSON.stringify({ ...copy, recommendation }));
	const failure = vi.fn();
	expect(
		await generateDecisionCard({ db: {}, env: {} } as never, request, failure),
	).toBeNull();
	expect(failure).toHaveBeenCalledWith(
		"invalid_copy:wrong_card_kind_or_authority",
	);
});
it("keeps repairs within the native call budget", async () => {
	const clock = vi
		.spyOn(Date, "now")
		.mockReturnValueOnce(0)
		.mockReturnValueOnce(0)
		.mockReturnValueOnce(8000);
	mocks.model.mockResolvedValueOnce(
		JSON.stringify({ ...copy, body: "Review the workflow." }),
	);
	try {
		await generateDecisionCard({ db: {}, env: {} } as never, request);
		expect(mocks.model.mock.calls[0]?.[2].timeoutMs).toBe(10000);
		expect(mocks.model.mock.calls[1]?.[2].timeoutMs).toBe(4000);
	} finally {
		clock.mockRestore();
	}
});
it("reserves a full repair call for background faces and repairs missing context", async () => {
	const clock = vi
		.spyOn(Date, "now")
		.mockReturnValueOnce(0)
		.mockReturnValueOnce(0)
		.mockReturnValueOnce(8000);
	const { context: _, ...contextless } = copy;
	const face = { ...copy, context: "A separate test account is ready." };
	mocks.model
		.mockResolvedValueOnce(JSON.stringify(contextless))
		.mockResolvedValueOnce(JSON.stringify(face));
	try {
		expect(
			await generateDecisionCard(
				{ db: {}, env: {} } as never,
				request,
				undefined,
				{ timeoutMs: 20000, requireContext: true },
			),
		).toMatchObject(face);
		expect(mocks.model.mock.calls[1]?.[2].timeoutMs).toBe(10000);
		expect(
			JSON.parse(mocks.model.mock.calls[1]?.[2].validationFeedback)
				.failedChecks,
		).toContain("context");
	} finally {
		clock.mockRestore();
	}
});
it("treats null optional fields as omitted without changing checked copy", async () => {
	mocks.model.mockResolvedValueOnce(
		JSON.stringify({
			...copy,
			stakes: null,
			actionLabels: null,
			effectStatus: null,
		}),
	);
	const result = await generateDecisionCard(
		{ db: {}, env: {} } as never,
		request,
	);
	expect(result).toMatchObject(copy);
	expect(result).not.toHaveProperty("actionLabels");
	expect(result).not.toHaveProperty("stakes");
	expect(result).not.toHaveProperty("effectStatus");
	expect(mocks.model).toHaveBeenCalledTimes(1);
});
it.each([[], "Approve", { approve: 123 }, { approve: "x".repeat(51) }])(
	"omits malformed optional labels while preserving valid summary text",
	async (actionLabels) => {
		mocks.model.mockResolvedValueOnce(
			JSON.stringify({ ...copy, actionLabels }),
		);
		const result = await generateDecisionCard(
			{ db: {}, env: {} } as never,
			request,
		);
		expect(result).toMatchObject(copy);
		expect(result).not.toHaveProperty("actionLabels");
		expect(mocks.model).toHaveBeenCalledTimes(1);
	},
);
it("repairs a malformed required field with the actual schema type error", async () => {
	mocks.model.mockResolvedValueOnce(
		JSON.stringify({ ...copy, body: 123, actionLabels: [] }),
	);
	expect(
		await generateDecisionCard({ db: {}, env: {} } as never, request),
	).toMatchObject(copy);
	const feedback = JSON.parse(
		mocks.model.mock.calls[1]?.[2].validationFeedback,
	);
	expect(feedback.schemaIssues).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				code: "invalid_type",
				path: "body",
				message: expect.stringContaining("string"),
			}),
		]),
	);
});
it("keeps filing facts separate from executing the task and repairs a wrong topic", async () => {
	const filingCopy = {
		...copy,
		title: "File the profile panel request here?",
		body: "Keeps the request under the Account project.",
		recommendation: "That team owns sign-in problems.",
	};
	mocks.model
		.mockResolvedValueOnce(
			JSON.stringify({
				...filingCopy,
				title: "File the Feed cleanup request here?",
			}),
		)
		.mockResolvedValueOnce(JSON.stringify(filingCopy));
	const result = await generateDecisionCard({ db: {}, env: {} } as never, {
		...request,
		subject: "File to Account?",
		prompt: "Fix the profile panel.\n\nFiled automatically: matching team.",
		metadata: {
			decisionDeck: {
				classId: "filing.project",
				reasoning: "Account owns sign-in.",
				confidence: 0.6,
			},
		},
	});
	expect(result?.title).toBe(filingCopy.title);
	const source = JSON.parse(mocks.model.mock.calls[0]?.[1]);
	expect(source.filingReview.requestText).toBe("Fix the profile panel.");
	expect(source).not.toHaveProperty("decision");
	expect(mocks.model.mock.calls[1]?.[2].validationFeedback).toContain(
		"title changed the request topic",
	);
	expect(mocks.model.mock.calls[0]?.[2].system).toContain(
		"filing does not execute",
	);
});
it.each([
	"No supplied project fits; reuse existing Work.",
	"The source project is only a filing hint.",
])(
	"preserves an explicit project mismatch in the source",
	async (reasoning) => {
		await generateDecisionCard({ db: {}, env: {} } as never, {
			...request,
			prompt: "Create a project",
			metadata: { decisionDeck: { classId: "filing.project", reasoning } },
		});
		expect(
			JSON.parse(mocks.model.mock.calls[0]?.[1]).filingReview.requiredChoice,
		).toBe("Return this filing for correction");
		expect(mocks.model.mock.calls[0]?.[2].system).toContain(
			"WHY must explain the mismatch",
		);
	},
);
it("rejects a WHY that contradicts an explicit filing mismatch", async () => {
	const filing = {
		...request,
		prompt: "Create an account project",
		metadata: {
			decisionDeck: {
				classId: "filing.project",
				reasoning: "No supplied project fits; reuse existing Work.",
			},
		},
	};
	const candidate = {
		...copy,
		title: "File the account project request here?",
		body: "Keeps the request with the Account team.",
		recommendation: "An existing task proves this is the right place.",
	};
	mocks.model
		.mockResolvedValueOnce(JSON.stringify(candidate))
		.mockResolvedValueOnce(
			JSON.stringify({
				...candidate,
				recommendation: "No supplied project fits this request.",
			}),
		);
	const failure = vi.fn();
	expect(
		(await generateDecisionCard({ db: {}, env: {} } as never, filing, failure))
			?.recommendation,
	).toBe("No supplied project fits this request.");
	expect(failure).toHaveBeenCalledWith("invalid_copy:filing_mismatch");
});
it("uses the source's unconfirmed fit when two drafts contradict it", async () => {
	mocks.model.mockResolvedValue(
		JSON.stringify({
			...copy,
			title: "File the account project request here?",
			body: "Keeps the request with the Account team.",
			recommendation: "An existing task proves this is the right place.",
		}),
	);
	const result = await generateDecisionCard({ db: {}, env: {} } as never, {
		...request,
		prompt: "Create an account project",
		metadata: {
			decisionDeck: {
				classId: "filing.project",
				reasoning: "No supplied project fits; reuse existing Work.",
			},
		},
	});
	expect(mocks.model).toHaveBeenCalledTimes(2);
	expect(result?.recommendation).toBe(copySpec.unconfirmedFilingReason);
});
it("allows a plain-English replacement when the source topic is a banned technical word", async () => {
	const candidate = {
		...copy,
		title: "File the steps cleanup here?",
		body: "Keeps the request under the Account project.",
		recommendation: "That team owns sign-in problems.",
	};
	mocks.model.mockResolvedValue(JSON.stringify(candidate));
	expect(
		await generateDecisionCard({ db: {}, env: {} } as never, {
			...request,
			prompt: "Fix workflow",
			metadata: { decisionDeck: { classId: "filing.project" } },
		}),
	).toMatchObject(candidate);
});
it("accepts an asset translation as the filing topic without restoring jargon", async () => {
	const candidate = {
		...copy,
		title: "File the company-control idea here?",
		body: "Keeps the request under the Account project.",
		recommendation: "The brief covers how AI helpers make choices.",
	};
	mocks.model.mockResolvedValue(JSON.stringify(candidate));
	expect(
		await generateDecisionCard({ db: {}, env: {} } as never, {
			...request,
			prompt: "Explore confidence layer for governance optimization.",
			metadata: { decisionDeck: { classId: "filing.project" } },
		}),
	).toMatchObject(candidate);
});
it("keeps an ordinary topic word when only a compound technical phrase is banned", async () => {
	const candidate = {
		...copy,
		title: "File the memory question here?",
		body: "Keeps it under the Account project.",
		recommendation: "That team owns profile display.",
	};
	mocks.model.mockResolvedValue(JSON.stringify(candidate));
	expect(
		await generateDecisionCard({ db: {}, env: {} } as never, {
			...request,
			prompt: "Recall account memory.",
			metadata: { decisionDeck: { classId: "filing.project" } },
		}),
	).toMatchObject(candidate);
});
it("rejects opaque mixed-case account identifiers as well as UUIDs", async () => {
	mocks.model.mockResolvedValue(
		JSON.stringify({
			...copy,
			body: "Checks account AbCdEf0123456789GhIjKlMn.",
		}),
	);
	expect(
		await generateDecisionCard({ db: {}, env: {} } as never, request),
	).toBeNull();
});
it.each([
	{
		stakes: "Approval needed before changing official purpose statement",
		prompt: request.prompt,
	},
	{ stakes: "The test account expires on Friday.", prompt: request.prompt },
	{
		stakes: "Today keeps showing the current purpose until it is published.",
		prompt: "Today shows the company purpose. Approval does not publish it.",
	},
	{
		stakes: "Costs $500 in paid credits.",
		prompt: "This test costs $100 in paid credits.",
	},
])(
	"omits a generic or unsupported stakes line: $stakes",
	async ({ stakes, prompt }) => {
		mocks.model.mockResolvedValue(JSON.stringify({ ...copy, stakes }));
		mocks.preferences.mockResolvedValue("The style review is due Friday.");
		const result = await generateDecisionCard({ db: {}, env: {} } as never, {
			...request,
			prompt,
		});
		expect(result).toMatchObject(copy);
		expect(result).not.toHaveProperty("stakes");
	},
);
it("keeps source-supported people affected in the optional stakes line", async () => {
	const stakes = "Notifies 3 team members.";
	mocks.model.mockResolvedValue(JSON.stringify({ ...copy, stakes }));
	expect(
		await generateDecisionCard({ db: {}, env: {} } as never, {
			...request,
			prompt: "Check sign-in and notify 3 team members.",
		}),
	).toMatchObject({ ...copy, stakes });
});
it("removes repeated field labels before checking the three displayed texts", async () => {
	mocks.model.mockResolvedValue(
		JSON.stringify({
			...copy,
			title: `ASK: ${copy.title}`,
			body: `IF YES: ${copy.body}`,
			recommendation: `WHY: ${copy.recommendation}`,
		}),
	);
	expect(
		await generateDecisionCard({ db: {}, env: {} } as never, request),
	).toMatchObject(copy);
});
it("allows Keep when the question still names the actual filing topic", async () => {
	const candidate = {
		...copy,
		title: "Keep the profile-picture request here?",
		body: "Files it under the Account project.",
		recommendation: "That team owns profile display.",
	};
	mocks.model.mockResolvedValue(JSON.stringify(candidate));
	expect(
		await generateDecisionCard({ db: {}, env: {} } as never, {
			...request,
			prompt: "Add profile pictures.",
			metadata: { decisionDeck: { classId: "filing.project" } },
		}),
	).toMatchObject(candidate);
});

it.each([
	{
		prompt: "Create a work board for the ABC challenge.",
		title: "Keep the ABC setup request here?",
		reason: "This project covers shared planning.",
		recommendation: "This team handles shared planning.",
	},
	{
		prompt: "Create a demo video.",
		title: "Keep the video request here?",
		reason:
			"No supplied project brief fits video production; this is only a filing hint.",
		recommendation: "This project does not cover video production.",
	},
])(
	"accepts a short company name or a plain negative coverage statement",
	async (facts) => {
		const candidate = {
			...copy,
			title: facts.title,
			body: "Files it under the Account project.",
			recommendation: facts.recommendation,
		};
		mocks.model.mockResolvedValue(JSON.stringify(candidate));
		expect(
			await generateDecisionCard({ db: {}, env: {} } as never, {
				...request,
				prompt: facts.prompt,
				metadata: {
					decisionDeck: { classId: "filing.project", reasoning: facts.reason },
				},
			}),
		).toMatchObject(candidate);
	},
);
it("does not accept a grammar word as the filing topic", async () => {
	mocks.model.mockResolvedValue(
		JSON.stringify({ ...copy, title: "File the request here?" }),
	);
	const failure = vi.fn();
	expect(
		await generateDecisionCard(
			{ db: {}, env: {} } as never,
			{
				...request,
				prompt: "Create THE ABC work board.",
				metadata: { decisionDeck: { classId: "filing.project" } },
			},
			failure,
		),
	).toBeNull();
	expect(failure).toHaveBeenCalledWith("invalid_copy:title_source");
});
it("reports actual field lengths separately from source facts when repairing", async () => {
	mocks.model.mockResolvedValueOnce(
		JSON.stringify({ ...copy, body: "x".repeat(121) }),
	);
	expect(
		await generateDecisionCard({ db: {}, env: {} } as never, request),
	).toMatchObject(copy);
	expect(mocks.model.mock.calls[1]?.[1]).toBe(mocks.model.mock.calls[0]?.[1]);
	expect(
		JSON.parse(mocks.model.mock.calls[1]?.[2].validationFeedback).lengths.body,
	).toEqual({ actual: 121, limit: 120 });
});

it("reports the rejected field and forbidden keys instead of an empty union error", async () => {
	mocks.model.mockResolvedValueOnce(
		JSON.stringify({ ...copy, body: "x".repeat(121), options: [] }),
	);
	expect(
		await generateDecisionCard({ db: {}, env: {} } as never, request),
	).toMatchObject(copy);
	const feedback = JSON.parse(
		mocks.model.mock.calls[1]?.[2].validationFeedback,
	);
	expect(feedback.failedChecks).toContain("body");
	expect(feedback.failedChecks).toContain("unknown_field:options");
	expect(feedback.failedChecks).not.toContain("");
});

it("identifies rejected vocabulary and gives the writer the complete face budget", async () => {
	mocks.model.mockResolvedValueOnce(
		JSON.stringify({ ...copy, body: "Review the member session." }),
	);
	await generateDecisionCard({ db: {}, env: {} } as never, request);
	const repair = mocks.model.mock.calls[1]?.[2];
	expect(JSON.parse(repair.validationFeedback).bannedTerms).toEqual([
		"session",
	]);
	expect(repair.rewriteInstruction).toContain(copySpec.faceInstruction);
	for (const instruction of [
		copySpec.system,
		copySpec.repair,
		copySpec.rewritePass,
	]) {
		expect(instruction).toContain("context");
		expect(instruction).not.toMatch(
			/exactly (?:these|the) three (?:distinct )?texts|as three distinct card lines/i,
		);
	}
});

it("reports the full word count and reserved chrome when repairing an overlong face", async () => {
	const draft = {
		...copy,
		context: "The workshop organizer needs your choice today.",
		body: "Keeps the proposed room and lunch plan ready for your review before confirming anything outside the company.",
		recommendation:
			"Review first because several guests have changed their travel plans and cannot attend the earlier workshop date.",
		actionLabels: { approve: "Review the plan", later: "Wait until later" },
	};
	mocks.model.mockResolvedValueOnce(JSON.stringify(draft));
	await generateDecisionCard({ db: {}, env: {} } as never, request);
	const feedback = JSON.parse(
		mocks.model.mock.calls[1]?.[2].validationFeedback,
	);
	const words = [
		draft.title,
		draft.context,
		draft.body,
		draft.recommendation,
		...Object.values(draft.actionLabels),
	]
		.join(" ")
		.match(/\S+/gu)!.length;
	expect(feedback.failedChecks).toContain("face_word_limit");
	expect(feedback.wordBudget).toMatchObject({
		actual: words,
		limit: 46,
		target: 40,
	});
	expect(mocks.model.mock.calls[0]?.[1]).toBe(mocks.model.mock.calls[1]?.[1]);
});

it("retains the model's structured unknown-effect signal without inventing an action", async () => {
	mocks.model.mockResolvedValue(
		JSON.stringify({ ...copy, effectStatus: "unknown" }),
	);
	expect(
		await generateDecisionCard({ db: {}, env: {} } as never, request),
	).toMatchObject({ effectStatus: "unknown" });
});

it("keeps secrets out of model inputs and never resubmits secret-bearing output for repair", async () => {
	const secret = "fc-" + "fictional".repeat(5);
	const context = { db: {}, env: {} } as never;
	expect(
		await generateDecisionCard(context, { ...request, prompt: secret }),
	).toBeNull();
	expect(mocks.model).not.toHaveBeenCalled();
	mocks.preferences.mockResolvedValue(secret);
	expect(await generateDecisionCard(context, request)).toBeNull();
	expect(mocks.model).not.toHaveBeenCalled();
	mocks.preferences.mockResolvedValue("");
	mocks.model.mockResolvedValue(JSON.stringify({ ...copy, body: secret }));
	expect(await generateDecisionCard(context, request)).toBeNull();
	expect(mocks.model).toHaveBeenCalledTimes(1);
});

it("repairs frozen relative dates and instructs both face and story writing to keep absolute dates", async () => {
	mocks.model
		.mockResolvedValueOnce(
			JSON.stringify({ ...copy, context: "The workshop is tomorrow." }),
		)
		.mockResolvedValueOnce(
			JSON.stringify({ ...copy, context: "The workshop is on 2026-10-20." }),
		);
	const result = await generateDecisionCard({ db: {}, env: {} } as never, {
		...request,
		prompt: `${request.prompt} The workshop is tomorrow.`,
		createdAt: "2026-10-19T09:00:00.000Z",
	});
	expect(result?.version === 2 && result.context).toBe(
		"The workshop is on 2026-10-20.",
	);
	expect(mocks.model.mock.calls[0]?.[2].rewriteInstruction).toContain(
		"Store dates as absolute YYYY-MM-DD",
	);
	expect(mocks.model.mock.calls[1]?.[2].validationFeedback).toContain(
		"relative_date_use_absolute_source_date",
	);
});

it("repairs, then falls back to source text, when the face invents a date or amount", async () => {
	mocks.model.mockResolvedValue(
		JSON.stringify({
			...copy,
			body: "Checks the sample profile page by 24 October for 300 euros.",
		}),
	);
	expect(
		await generateDecisionCard({ db: {}, env: {} } as never, request),
	).toBeNull();
	expect(mocks.model.mock.calls[1]?.[2].validationFeedback).toContain(
		"unsupported_fact",
	);
	mocks.model.mockResolvedValue(
		JSON.stringify({
			...copy,
			body: "Checks the sample profile page within 2 tries.",
		}),
	);
	expect(
		await generateDecisionCard({ db: {}, env: {} } as never, {
			...request,
			prompt: `${request.prompt} Allow 2 tries.`,
		}),
	).toMatchObject({ body: "Checks the sample profile page within 2 tries." });
});
it("repairs a decision face that drops what waiting and yes cost, quoting the source facts", async () => {
	const decision = {
		costOfWaiting: "The vendor quote of EUR 1,200 expires on 2026-11-01.",
		options: [
			{ id: "buy", intent: "approve", cost: "EUR 1,200 per year." },
			{ id: "skip", intent: "reject", cost: "None" },
		],
	};
	const vague = {
		...copy,
		title: "Buy the yearly vendor plan?",
		context: "The vendor sent a quote.",
		body: "Buys the plan for the team.",
		recommendation: "It replaces three monthly tools.",
	};
	const complete = {
		...vague,
		context: "The vendor quote expires on 2026-11-01.",
		body: "Buys the plan for EUR 1,200 a year.",
	};
	mocks.model
		.mockResolvedValueOnce(JSON.stringify(vague))
		.mockResolvedValueOnce(JSON.stringify(complete));
	expect(
		await generateDecisionCard({ db: {}, env: {} } as never, {
			...request,
			prompt: "Buy the vendor plan for EUR 1,200 per year before 2026-11-01.",
			metadata: { decisionDeck: decision },
		}),
	).toMatchObject(complete);
	expect(mocks.model.mock.calls[0]?.[2].system).toContain(copySpec.faceFacts);
	const feedback = JSON.parse(
		mocks.model.mock.calls[1]?.[2].validationFeedback,
	);
	expect(feedback.failedChecks).toEqual(["cost_of_waiting", "option_cost"]);
	expect(feedback.missingFaceFacts.facts).toEqual([
		{ check: "cost_of_waiting", source: decision.costOfWaiting },
		{ check: "option_cost", source: "EUR 1,200 per year." },
	]);
});
