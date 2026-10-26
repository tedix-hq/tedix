import { beforeEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	advance: vi.fn(),
	save: vi.fn(),
	generate: vi.fn(),
	current: vi.fn(),
	bind: vi.fn(),
}));
vi.mock("@tedix/db/queries/work-items/card-presentation", () => ({
	listMissingCardSummaries: mocks.list,
	advanceCardSummaryBackfill: mocks.advance,
	saveDecisionCardPresentation: mocks.save,
}));
vi.mock("./decision-card-generator", () => ({
	generateDecisionCard: mocks.generate,
}));
vi.mock("./card-presentation-source", () => ({
	bindCardPresentationSource: mocks.bind,
}));
vi.mock("@tedix/db/queries/work-items/decision-sources", () => ({
	decisionSourcesCurrent: mocks.current,
}));
import { backfillCardSummaries } from "./card-summary-backfill";
const context = { db: {}, env: {} } as never;
const now = "2026-10-26T12:00:00.000Z";
const card = (id: string) => ({
	id,
	orgId: "fictional-org",
	version: 2,
	targetId: "robin",
	prompt: "Original",
	metadata: { cardContent: "Revised" },
});
beforeEach(() => {
	vi.resetAllMocks();
	mocks.current.mockResolvedValue(true);
	mocks.generate.mockResolvedValue({ title: "Review?" });
	mocks.bind.mockImplementation((copy) => copy);
	mocks.save.mockResolvedValue({});
});
it("continues past a failed generation, saves only missing current copy, and advances for a later retry pass", async () => {
	mocks.list.mockResolvedValue({
		previous: null,
		rows: [card("a"), card("b"), card("c")],
	});
	mocks.generate.mockRejectedValueOnce(new Error("temporary failure"));
	mocks.current
		.mockResolvedValueOnce(true)
		.mockResolvedValueOnce(false)
		.mockResolvedValueOnce(true);
	expect(await backfillCardSummaries(context, now)).toEqual({
		summaryBackfillScanned: 3,
		summaryBackfillSaved: 1,
		summaryBackfillFailed: 1,
	});
	expect(mocks.generate).toHaveBeenLastCalledWith(
		context,
		expect.objectContaining({ id: "c", prompt: "Revised" }),
		undefined,
		{ timeoutMs: 8000 },
	);
	expect(mocks.save).toHaveBeenCalledTimes(1);
	expect(mocks.save).toHaveBeenCalledWith(
		{},
		expect.objectContaining({
			requestId: "c",
			expectedVersion: 2,
			personId: "robin",
			onlyMissing: true,
		}),
	);
	expect(mocks.advance).toHaveBeenCalledWith({}, null, "fictional-org:c");
});
it("restarts an exhausted pass so transient failures are retried", async () => {
	mocks.list.mockResolvedValue({ previous: "fictional-org:z", rows: [] });
	await backfillCardSummaries(context, now);
	expect(mocks.advance).toHaveBeenCalledWith({}, "fictional-org:z", "");
	expect(mocks.generate).not.toHaveBeenCalled();
});
