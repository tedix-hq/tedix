import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";
import { OsOutputRevisionSchema } from "@tedix/api-contract/schemas/os-workspaces";
import { factoryCardRevisionRequests } from "./factory-card-revisions";

const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	record: vi.fn(),
	run: vi.fn(),
}));
vi.mock("@tedix/db/queries/skill-runs", () => ({ getSkillRun: mocks.run }));
vi.mock("@tedix/db/queries/factory-card-revisions", () => ({
	listPendingFactoryCardRevisions: mocks.list,
}));
vi.mock("./learning-interaction-recorder", () => ({
	recordObservedLearningInteraction: mocks.record,
}));
const metadata = {
	schema: "tedix.factory-card-change.v1",
	cardId: "factory:card",
	instruction: "Shorter please",
	rowIndex: 0,
	draftColumn: "Draft",
	sourceColumn: "Source",
	sourceText: "Fictional source",
	sourceRevision: 1,
	before: "Original draft",
};
const context = {
	db: {},
	organizationId: "org",
	authType: "user",
	user: { sub: "person" },
	env: { ENVIRONMENT: "test" },
} as BaseContext;
const revision = (body: string, source = "Fictional source") =>
	OsOutputRevisionSchema.parse({
		id: "11111111-1111-4111-8111-111111111111",
		organizationId: "org",
		outputId: "22222222-2222-4222-8222-222222222222",
		revision: 2,
		content: {
			kind: "sheet",
			columns: ["Source", "Draft"],
			rows: [[source, body]],
		},
		note: "Shorter please",
		producedBy: null,
		accessEnvelope: null,
		createdByKind: "user",
		createdById: "person",
		createdAt: "2026-10-19T20:00:00.000Z",
	});
beforeEach(() => {
	vi.clearAllMocks();
	mocks.list.mockResolvedValue([
		{ id: "request-event", actorId: "person", runId: "rewrite-run", metadata },
	]);
	mocks.run.mockResolvedValue({ status: "running" });
	mocks.record.mockResolvedValue(true);
});
it("joins a person's exact instruction to its source-row rewrite and records provenance", async () => {
	expect(
		await factoryCardRevisionRequests(context, revision("Short draft")),
	).toEqual([]);
	expect(mocks.list).toHaveBeenCalledWith(
		context.db,
		"org",
		"22222222-2222-4222-8222-222222222222",
		"person",
	);
	expect(mocks.record).toHaveBeenCalledWith(
		context,
		expect.objectContaining({
			clientEventId: "factory-card-rewrite:request-event",
			metadata: expect.objectContaining({
				before: "Original draft",
				after: "Short draft",
				instruction: "Shorter please",
				cause: "human_edit",
				rewrittenBy: "person",
			}),
		}),
	);
});
it("keeps unchanged drafts pending and refuses to attribute another source row", async () => {
	expect(
		await factoryCardRevisionRequests(context, revision("Original draft")),
	).toHaveLength(1);
	expect(
		await factoryCardRevisionRequests(
			context,
			revision("Different draft", "Another source"),
		),
	).toEqual([]);
	expect(mocks.record).not.toHaveBeenCalled();
});
it("stops showing a request as pending once its rewrite run has ended or never started", async () => {
	mocks.run.mockResolvedValue({ status: "failed" });
	expect(
		await factoryCardRevisionRequests(context, revision("Original draft")),
	).toEqual([]);
	mocks.list.mockResolvedValue([
		{ id: "request-event", actorId: "person", runId: null, metadata },
	]);
	expect(
		await factoryCardRevisionRequests(context, revision("Original draft")),
	).toEqual([]);
});
