import { beforeEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	config: vi.fn(),
	preferences: vi.fn(),
	model: vi.fn(),
}));
vi.mock("@tedix/db/queries/decision-learning", () => ({
	getDecisionLearningConfig: mocks.config,
}));
vi.mock("./decision-learning", () => ({
	readDraftPreferences: mocks.preferences,
}));
vi.mock("./lesson-distiller", () => ({ runDistillModel: mocks.model }));
import { generateDecisionCard } from "./decision-card-generator";
const request = {
	orgId: "fictional",
	targetId: "robin",
	kind: "question",
	subject: "Sign-in proof",
	prompt: "Review a fictional sign-in; no approval exists.",
	metadata: {},
};
const copy = {
	version: 1,
	title: "Allow the fictional sign-in test?",
	body: "The test checks the sign-in flow. It still needs your approval.",
	recommendation:
		"Review the test scope because permission has not been granted.",
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.config.mockResolvedValue({ preferenceModel: "small-configured-model" });
	mocks.preferences.mockResolvedValue("Prefer shorter proposals.");
	mocks.model.mockResolvedValue(JSON.stringify(copy));
});
it("uses the recipient's learned preferences and configured small model without generating authority", async () => {
	const result = await generateDecisionCard(
		{ db: {}, env: {} } as never,
		request,
	);
	expect(result).toMatchObject({ ...copy, model: "small-configured-model" });
	expect(mocks.preferences).toHaveBeenCalledWith({}, "fictional", "robin");
	expect(mocks.model).toHaveBeenCalledWith(
		expect.anything(),
		expect.stringContaining("Prefer shorter proposals."),
		expect.objectContaining({ model: "small-configured-model" }),
	);
});
it.each([
	{ ...copy, title: "x".repeat(91) },
	{ ...copy, version: 2 },
	{ ...copy, body: "One. Two. Three." },
	{ ...copy, recommendation: "Approve this." },
	{ ...copy, options: [{ intent: "approve" }] },
])("rejects invalid copy or invented actions", async (invalid) => {
	mocks.model.mockResolvedValue(JSON.stringify(invalid));
	expect(
		await generateDecisionCard({ db: {}, env: {} } as never, request),
	).toBeNull();
	expect(mocks.model).toHaveBeenCalledTimes(2);
});

it("constrains model output and tells the retry which field failed", async () => {
	mocks.model.mockResolvedValueOnce(
		JSON.stringify({ ...copy, recommendation: "Do this." }),
	);
	const result = await generateDecisionCard(
		{ db: {}, env: {} } as never,
		request,
	);
	expect(result).toMatchObject(copy);
	expect(mocks.model.mock.calls[0]?.[2].jsonObject).toBe(true);
	expect(mocks.model.mock.calls[1]?.[1]).toContain(
		"failed validation in recommendation",
	);
});

it("does not repeat an unchanged provider failure", async () => {
	mocks.model.mockResolvedValue(null);
	expect(
		await generateDecisionCard({ db: {}, env: {} } as never, request),
	).toBeNull();
	expect(mocks.model).toHaveBeenCalledTimes(1);
});

it("supplies protocol metadata without asking the model to invent it", async () => {
	const { version: _, ...prose } = copy;
	mocks.model.mockResolvedValue(JSON.stringify(prose));
	expect(
		await generateDecisionCard({ db: {}, env: {} } as never, request),
	).toMatchObject(copy);
});

it("bounds learning context while preserving personal preferences and fitting lessons", async () => {
	mocks.preferences.mockResolvedValue(
		JSON.stringify({
			purpose: "Writing context only",
			preferences: [{ text: "Keep my voice." }],
			lessons: [{ text: "x".repeat(5000) }, { text: "Keep proposals short." }],
		}),
	);
	await generateDecisionCard({ db: {}, env: {} } as never, request);
	const source = JSON.parse(mocks.model.mock.calls[0]?.[1]);
	expect(source.preferences.length).toBeLessThanOrEqual(3000);
	expect(JSON.parse(source.preferences)).toMatchObject({
		preferences: [{ text: "Keep my voice." }],
		lessons: [{ text: "Keep proposals short." }],
	});
});

it("separates the captured filing request from generic legacy copy", async () => {
	await generateDecisionCard({ db: {}, env: {} } as never, {
		...request,
		subject: "File request to Fictional Project?",
		prompt:
			"Improve Feed previews.\n\nFiled automatically: Existing Feed work fits.",
		metadata: {
			decisionDeck: {
				classId: "filing.project",
				proposal: "Generic project proposal",
				recommendation: "Keep it if it fits",
				reasoning: "Existing Feed work fits.",
				confidence: 0.6,
			},
		},
	});
	const source = JSON.parse(mocks.model.mock.calls[0]?.[1]);
	expect(source.filingReview).toMatchObject({
		requestText: "Improve Feed previews.",
		destinationQuestion: "File request to Fictional Project?",
		reason: "Existing Feed work fits.",
		confidence: 0.6,
	});
	expect(source).not.toHaveProperty("decision");
	expect(JSON.stringify(source)).not.toContain("Keep it if it fits");
});

it("repairs a filing title that substitutes another task", async () => {
	mocks.model
		.mockResolvedValueOnce(
			JSON.stringify({ ...copy, title: "File the Feed cleanup request here?" }),
		)
		.mockResolvedValueOnce(
			JSON.stringify({
				...copy,
				title: "File the scheduled follow-up request here?",
				recommendation:
					"Keep this filing because the project owns scheduled cards.",
			}),
		);
	const result = await generateDecisionCard({ db: {}, env: {} } as never, {
		...request,
		prompt: "Show the scheduled follow-up only on its due date.",
		metadata: { decisionDeck: { classId: "filing.project" } },
	});
	expect(result?.title).toBe("File the scheduled follow-up request here?");
	expect(mocks.model.mock.calls[1]?.[1]).toContain(
		"title changed the request topic",
	);
});

it("does not pass unrelated operational lessons to the writing model", async () => {
	mocks.preferences.mockResolvedValue(
		JSON.stringify({
			preferences: [],
			lessons: [
				{ text: "Keep answers short." },
				{ text: "Retry provider outages after checking deployments." },
			],
		}),
	);
	await generateDecisionCard({ db: {}, env: {} } as never, request);
	const source = JSON.parse(mocks.model.mock.calls[0]?.[1]);
	expect(JSON.parse(source.preferences).lessons).toEqual([
		{ text: "Keep answers short." },
	]);
});

it("keeps repair within the native-call budget", async () => {
	const clock = vi
		.spyOn(Date, "now")
		.mockReturnValueOnce(0)
		.mockReturnValueOnce(0)
		.mockReturnValueOnce(8000);
	mocks.model.mockResolvedValueOnce(
		JSON.stringify({ ...copy, body: "One. Two. Three." }),
	);
	try {
		await generateDecisionCard({ db: {}, env: {} } as never, request);
		expect(mocks.model.mock.calls[0]?.[2].timeoutMs).toBe(10000);
		expect(mocks.model.mock.calls[1]?.[2].timeoutMs).toBe(4000);
		expect(mocks.model.mock.calls[1]?.[1]).toContain(
			"exactly one complete sentence",
		);
	} finally {
		clock.mockRestore();
	}
});

it("does not accept a generic filing verb as a topic match", async () => {
	mocks.model.mockResolvedValue(
		JSON.stringify({ ...copy, title: "Check Filing for Fictional Board" }),
	);
	expect(
		await generateDecisionCard({ db: {}, env: {} } as never, {
			...request,
			prompt: "Fix the profile panel consent check.",
			metadata: { decisionDeck: { classId: "filing.project" } },
		}),
	).toBeNull();
});

it("requires a filing recommendation to name an available choice", async () => {
	mocks.model.mockResolvedValue(
		JSON.stringify({
			...copy,
			title: "File the profile panel request here?",
			recommendation: "Check this filing because the fit is uncertain.",
		}),
	);
	const failure = vi.fn();
	expect(
		await generateDecisionCard(
			{ db: {}, env: {} } as never,
			{
				...request,
				prompt: "Fix the profile panel.",
				metadata: { decisionDeck: { classId: "filing.project" } },
			},
			failure,
		),
	).toBeNull();
	expect(failure).toHaveBeenCalledWith("invalid_copy:recommendation_choice");
});
