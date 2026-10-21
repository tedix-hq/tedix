import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { DeckCard } from "@tedix/api-contract/schemas/attention";
import type { BaseContext } from "../rpc/orpc";
const mocks = vi.hoisted(() => ({
	get: vi.fn(),
	put: vi.fn(),
	save: vi.fn(),
	generate: vi.fn(),
	preferences: vi.fn(),
}));
vi.mock("@tedix/db/queries/user-configs", () => ({
	getUserConfig: mocks.get,
	putUserConfig: mocks.put,
}));
vi.mock("@tedix/db/queries/work-items/card-presentation", () => ({
	saveDecisionCardPresentation: mocks.save,
}));
vi.mock("./decision-card-generator", () => ({
	generateDecisionCard: mocks.generate,
}));
vi.mock("./decision-learning", () => ({
	readDraftPreferences: mocks.preferences,
}));
import {
	prepareDeckCardFace,
	prepareDeckCardFaces,
	deckCardWritingSource,
	displayDeckCard,
} from "./deck-card-face";
const context = {
	organizationId: "fictional-org",
	userId: "fictional-person",
	descopeUserId: "fictional-person",
	db: {},
} as BaseContext;
const card: DeckCard = {
	id: "factory:fictional:0",
	kind: "decision",
	label: "Is this news summary useful?",
	project: "fictional-project",
	urgency: "later",
	source: "/work",
	requestedAt: "2026-10-19T00:00:00Z",
	dueAt: null,
	score: 0,
	decision: null,
	factory: {
		outputId: "10000000-0000-4000-8000-000000000001",
		sourceIndex: 0,
		rowIndex: 0,
		revision: 1,
		draft: "",
		why: "Your workshop news summary is ready for review.",
		sourceText: "Workshop notes",
	},
};
const copy = {
	version: 2,
	title: "Is this news summary useful?",
	context: "Your workshop news is ready for review.",
	body: "Records whether the suggestion helped; changes nothing outside Tedix.",
	recommendation: "Review first: usefulness depends on your workshop plans.",
	actionLabels: { approve: "Useful", reject: "Not useful" },
};
const store = new Map<
	string,
	{ revision: number; value: Record<string, unknown> }
>();
const key = (input: { userId: string; namespace: string; key: string }) =>
	JSON.stringify([input.userId, input.namespace, input.key]);
beforeEach(() => {
	vi.clearAllMocks();
	store.clear();
	mocks.preferences.mockResolvedValue("");
	mocks.generate.mockResolvedValue(copy);
	mocks.get.mockImplementation(
		async (_db, input) => store.get(key(input)) ?? null,
	);
	mocks.put.mockImplementation(async (_db, input) => {
		const old = store.get(key(input));
		if ((old?.revision ?? 0) !== input.expectedRevision) return { ok: false };
		const row = { revision: (old?.revision ?? 0) + 1, value: input.value };
		store.set(key(input), row);
		return { ok: true, row };
	});
	mocks.save.mockImplementation(async (_db, input) => ({
		presentation: input.presentation,
	}));
});
it("uses committed sample copy without model calls only in the offline demo", async () => {
	const presentation = {
		version: 1,
		title: "Review the sample reply",
		body: "A fictional buying question is ready. Nothing has been posted.",
		recommendation: "Review the reply because the question is still open.",
	};
	const sample = {
		...card,
		interaction: {
			request: {
				subject: card.label,
				prompt: "Fictional buying question",
				metadata: { sampleData: true, cardPresentation: presentation },
			},
		},
	} as DeckCard;
	const offline = {
		...context,
		env: {
			ENVIRONMENT: "development",
			TEDIX_LOCAL_DEMO_ENABLED: "true",
			TEDIX_DEMO_SENDING_OFF: "true",
		},
	} as BaseContext;
	expect(await prepareDeckCardFace(offline, sample)).toEqual(presentation);
	expect(mocks.generate).not.toHaveBeenCalled();
	expect(mocks.preferences).not.toHaveBeenCalled();
	await prepareDeckCardFace(
		{ ...context, env: { TEDIX_LOCAL_DEMO_ENABLED: "true" } } as BaseContext,
		sample,
	);
	expect(mocks.generate).toHaveBeenCalledOnce();
});
it.each([undefined, "0".repeat(64)])(
	"reads version-fenced interaction copy despite an absent or old fingerprint: %s",
	async (sourceFingerprint) => {
		const presentation = {
			...copy,
			...(sourceFingerprint ? { sourceFingerprint } : {}),
		};
		const authored = {
			...card,
			interaction: {
				request: {
					subject: card.label,
					prompt: "Workshop notes",
					metadata: { cardPresentation: presentation },
				},
			},
		} as DeckCard;
		const [displayed] = await prepareDeckCardFaces(context, [authored]);
		expect(displayed?.presentation).toEqual(presentation);
		expect(displayed?.faceText).toContain(copy.body);
		expect(mocks.generate).not.toHaveBeenCalled();
	},
);

it("generates and returns a new face when the host cannot schedule background work", async () => {
	const [displayed] = await prepareDeckCardFaces(context, [card]);
	expect(displayed?.presentation).toEqual(copy);
	expect(displayed?.faceText).not.toContain("Summary pending");
});

it("reuses checked display copy, isolates people and organizations, and invalidates changed writing preferences", async () => {
	expect(await prepareDeckCardFace(context, card)).toEqual(copy);
	expect(await prepareDeckCardFace(context, card, false)).toEqual(copy);
	expect(mocks.generate).toHaveBeenCalledTimes(1);
	expect(
		await prepareDeckCardFace(
			{ ...context, userId: "fictional-other" },
			card,
			false,
		),
	).toBeNull();
	expect(
		await prepareDeckCardFace(
			{ ...context, organizationId: "fictional-other-org" },
			card,
			false,
		),
	).toBeNull();
	mocks.preferences.mockResolvedValue("Say where we met.");
	expect(await prepareDeckCardFace(context, card, false)).toBeNull();
	await prepareDeckCardFace(context, card);
	expect(mocks.generate).toHaveBeenCalledTimes(2);
});
it("claims generation once when two tabs ask for the same card", async () => {
	const results = await Promise.all([
		prepareDeckCardFace(context, card),
		prepareDeckCardFace(context, card),
	]);
	expect(mocks.generate).toHaveBeenCalledTimes(1);
	expect(results.filter(Boolean)).toContainEqual(copy);
	expect(await prepareDeckCardFace(context, card, false)).toEqual(copy);
});

it("uses revised card text and invalidates the previous face", async () => {
	const original: DeckCard = {
		...card,
		interaction: {
			request: {
				id: "fictional-card",
				subject: "Review the draft?",
				prompt: "Original source",
				metadata: {},
			},
		} as DeckCard["interaction"],
	};
	await prepareDeckCardFace(context, original);
	const revised: DeckCard = {
		...original,
		interaction: {
			...original.interaction!,
			request: {
				...original.interaction!.request,
				metadata: { cardContent: "The recipient needs the revised story." },
			},
		},
	};
	expect(deckCardWritingSource(revised).prompt).toBe(
		"The recipient needs the revised story.",
	);
	expect(await prepareDeckCardFace(context, revised, false)).toBeNull();
	await prepareDeckCardFace(context, revised);
	expect(mocks.generate).toHaveBeenCalledTimes(2);
	expect(deckCardWritingSource(original).prompt).toBe("Original source");
});
it("withholds failed readability output from every display and fallback", async () => {
	mocks.generate.mockResolvedValue({
		...copy,
		context: "The MCP gateway needs a credential.",
	});
	expect(await prepareDeckCardFace(context, card)).toBeNull();
	expect(await prepareDeckCardFace(context, card, false)).toBeNull();
	expect(displayDeckCard(card, null)).toMatchObject({
		label: card.label,
		faceText: "Summary pending. Open Details to review the source.",
	});
});

it("never uses the placeholder as the headline: falls back to the original request", async () => {
	for (const label of [
		"Review Northwind's invoice corrections by Tuesday 14:00?",
		"Summary unavailable",
		"Summary pending",
	]) {
		for (const unavailable of [false, true]) {
			const displayed = displayDeckCard({ ...card, label }, null, unavailable);
			expect(displayed.label).not.toBe("Summary unavailable");
			expect(displayed.label).not.toBe("Summary pending");
			if (label.startsWith("Review")) expect(displayed.label).toBe(label);
		}
	}
	const long = displayDeckCard(
		{ ...card, label: `Update the connect profile ${"consent ".repeat(20)}` },
		null,
		true,
	);
	expect(long.label.length).toBeLessThanOrEqual(80);
	expect(long.label.endsWith("…")).toBe(true);
	expect(long.faceText).toBe(
		"Summary unavailable. Open Details to review the source.",
	);
});

it("shows the original request as the headline for a card whose stored face failed, then regenerates after the retry window", async () => {
	mocks.generate.mockResolvedValueOnce(null);
	await prepareDeckCardFace(context, card);
	let [displayed] = await prepareDeckCardFaces(context, [card]);
	expect(displayed?.label).toBe(card.label);
	expect(displayed?.faceText).toContain("Summary unavailable");
	vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61000);
	await prepareDeckCardFace(context, card);
	[displayed] = await prepareDeckCardFaces(context, [card]);
	expect(mocks.generate).toHaveBeenCalledTimes(2);
	expect(displayed?.label).toBe(copy.title);
	expect(displayed?.presentation).toEqual(copy);
	vi.restoreAllMocks();
});
it("tells the writer the actual factory consequence rather than promising to do the suggested work", () => {
	const source = deckCardWritingSource(card);
	expect(source.metadata.producerContext).toContain(
		"do not execute the suggestion",
	);
	expect(source.prompt).toContain(card.factory!.why);
});

it("withholds source secrets before generation and secret-bearing cached output", async () => {
	const secret = "sk-" + "fictional".repeat(5);
	expect(
		await prepareDeckCardFace(context, {
			...card,
			factory: { ...card.factory!, draft: secret },
		}),
	).toBeNull();
	expect(mocks.generate).not.toHaveBeenCalled();
	mocks.generate.mockResolvedValue({ ...copy, context: secret });
	expect(await prepareDeckCardFace(context, card)).toBeNull();
	expect(await prepareDeckCardFace(context, card, false)).toBeNull();
});

it("renders the generated story on the next read without changing the source", async () => {
	const original = structuredClone(card);
	await prepareDeckCardFace(context, card);
	const presentation = await prepareDeckCardFace(context, card, false);
	const displayed = displayDeckCard(card, presentation);
	expect(displayed.label).toBe(copy.title);
	expect(displayed.faceText).toContain(copy.context);
	expect(displayed.faceText).toContain(copy.body);
	expect(displayed.faceText).not.toContain("Summary pending");
	expect(card).toEqual(original);
});

it("distinguishes failed generation from a pending job during the retry window", async () => {
	mocks.generate.mockResolvedValue(null);
	await prepareDeckCardFace(context, card);
	const [displayed] = await prepareDeckCardFaces(context, [card]);
	expect(displayed?.label).toBe(card.label);
	expect(displayed?.faceText).toContain("Summary unavailable");
	expect(displayed?.faceText).not.toContain("Summary pending");
	expect(mocks.generate).toHaveBeenCalledTimes(1);
});

it.each([true, false])(
	"does not let three deferred writers starve a later card (failed: %s)",
	async (failed) => {
		const earlier = [0, 1, 2].map((index) => ({
			...card,
			id: `factory:earlier:${index}`,
		}));
		mocks.generate.mockResolvedValue(null);
		await Promise.all(
			earlier.map((entry) => prepareDeckCardFace(context, entry)),
		);
		for (const row of store.values()) row.value.failed = failed;
		mocks.generate.mockClear();
		mocks.generate.mockResolvedValue(copy);
		const jobs: Promise<unknown>[] = [];
		const displayed = await prepareDeckCardFaces(
			{ ...context, waitUntil: (job) => jobs.push(job) },
			[...earlier, card],
		);
		await Promise.all(jobs);
		expect(mocks.generate).toHaveBeenCalledTimes(1);
		expect(displayed[0]?.label).toBe(card.label);
		expect(displayed[0]?.faceText).toContain(
			failed ? "Summary unavailable" : "Summary pending",
		);
		expect(await prepareDeckCardFace(context, card, false)).toEqual(copy);
		for (const entry of earlier)
			expect(await prepareDeckCardFace(context, entry, false)).toBeNull();
	},
);

it("returns pending copy while a registered background writer finishes and persists its result", async () => {
	let finish!: (value: typeof copy) => void;
	mocks.generate.mockReturnValue(
		new Promise<typeof copy>((resolve) => {
			finish = resolve;
		}),
	);
	const jobs: Promise<unknown>[] = [];
	const [displayed] = await prepareDeckCardFaces(
		{
			...context,
			waitUntil: (job) => {
				jobs.push(job);
			},
		},
		[card],
	);
	expect(displayed?.faceText).toContain("Summary pending");
	expect(jobs).toHaveLength(1);
	await vi.waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
	finish(copy);
	await Promise.all(jobs);
	expect(await prepareDeckCardFace(context, card, false)).toEqual(copy);
});

it("backs off automatic retries for one, five and thirty minutes, then stops until the source changes", async () => {
	const now = vi.spyOn(Date, "now").mockReturnValue(1000000);
	try {
		mocks.generate.mockResolvedValue(null);
		await prepareDeckCardFace(context, card);
		for (const [index, delay] of [60000, 300000, 1800000].entries()) {
			const start = Date.now();
			now.mockReturnValue(start + delay - 1);
			await prepareDeckCardFace(context, card);
			expect(mocks.generate).toHaveBeenCalledTimes(index + 1);
			now.mockReturnValue(start + delay);
			await prepareDeckCardFace(context, card);
			expect(mocks.generate).toHaveBeenCalledTimes(index + 2);
		}
		now.mockReturnValue(Date.now() + 86400000);
		const jobs: Promise<unknown>[] = [];
		const [failed] = await prepareDeckCardFaces(
			{ ...context, waitUntil: (job) => jobs.push(job) },
			[card],
		);
		await Promise.all(jobs);
		expect(failed?.label).toBe(card.label);
		expect(failed?.faceText).toContain("Summary unavailable");
		expect(failed?.presentation).toBeNull();
		expect(mocks.generate).toHaveBeenCalledTimes(4);
		await prepareDeckCardFace(context, { ...card, label: "Changed source" });
		expect(mocks.generate).toHaveBeenCalledTimes(5);
	} finally {
		now.mockRestore();
	}
});

it("lets an explicit Retry recover an exhausted face while concurrent retries share a claim", async () => {
	mocks.generate.mockResolvedValue(null);
	await prepareDeckCardFace(context, card);
	for (const row of store.values()) {
		row.value.attempts = 4;
		row.value.retryAt = 0;
	}
	mocks.generate.mockResolvedValue(copy);
	const jobs: Promise<unknown>[] = [];
	await Promise.all(
		[0, 1].map(() =>
			prepareDeckCardFaces(
				{ ...context, waitUntil: (job) => jobs.push(job) },
				[card],
				undefined,
				true,
			),
		),
	);
	await Promise.all(jobs);
	expect(mocks.generate).toHaveBeenCalledTimes(2);
	expect(await prepareDeckCardFace(context, card, false)).toEqual(copy);
});
