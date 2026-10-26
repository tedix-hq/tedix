import { beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ generate: vi.fn(), save: vi.fn() }));
vi.mock("./decision-card-generator", () => ({
	generateDecisionCard: mocks.generate,
}));
vi.mock("@tedix/db/queries/work-items/card-presentation", () => ({
	saveDecisionCardPresentation: mocks.save,
}));
import { queueCardFaceWrite } from "./card-face-writer";

const presentation = {
	version: 2,
	title: "Send the supplier the signed quote?",
	context: "The supplier asked for it before Friday.",
	body: "Sends the quote to the supplier.",
	recommendation: "Yes — the price matches the order.",
};
const request = {
	id: "11111111-1111-4111-8111-111111111111",
	orgId: "fictional-org",
	version: 3,
	targetType: "user",
	targetId: "robin",
	subject: "Supplier quote",
	prompt: "Original ask",
	kind: "question",
	dueAt: null,
	metadata: { cardContent: "Revised ask" },
} as never;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.generate.mockResolvedValue(presentation);
	mocks.save.mockResolvedValue({ presentation });
});

it("writes and stores the summary in the background from the card's current text", async () => {
	const work: Promise<unknown>[] = [];
	queueCardFaceWrite(
		{
			db: {},
			env: {},
			waitUntil: (task: Promise<unknown>) => work.push(task),
		} as never,
		request,
	);
	expect(work).toHaveLength(1);
	await Promise.all(work);
	expect(mocks.generate).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ prompt: "Revised ask" }),
	);
	expect(mocks.save).toHaveBeenCalledWith(
		{},
		expect.objectContaining({
			orgId: "fictional-org",
			personId: "robin",
			expectedVersion: 3,
			presentation: expect.objectContaining({
				title: presentation.title,
				sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
			}),
		}),
	);
});

it("keeps the original text when the writer fails, without an error", async () => {
	mocks.generate.mockResolvedValue(null);
	const work: Promise<unknown>[] = [];
	queueCardFaceWrite(
		{
			db: {},
			env: {},
			waitUntil: (task: Promise<unknown>) => work.push(task),
		} as never,
		request,
	);
	await expect(Promise.all(work)).resolves.toBeDefined();
	expect(mocks.save).not.toHaveBeenCalled();
});

it("writes nothing for a card that is not addressed to a person", () => {
	const waitUntil = vi.fn();
	queueCardFaceWrite(
		{ db: {}, env: {}, waitUntil } as never,
		{
			...(request as object),
			targetType: "tedi",
		} as never,
	);
	expect(waitUntil).not.toHaveBeenCalled();
});
