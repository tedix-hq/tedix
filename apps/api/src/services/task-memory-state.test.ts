const writing = vi.hoisted(() => ({ read: vi.fn(async () => "") }));
vi.mock("./decision-learning", () => ({ readDraftPreferences: writing.read }));
import { beforeEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	work: vi.fn(),
	owned: vi.fn(),
	approvals: vi.fn(),
	runtime: vi.fn(),
	preferences: vi.fn(),
	lessons: vi.fn(),
	update: vi.fn(),
}));
vi.mock("@tedix/db/queries/work-items/crud", () => ({
	getWorkItemById: mocks.work,
	listWorkItemsPage: mocks.owned,
}));
vi.mock("@tedix/db/queries/work-items/approvals", () => ({
	listWorkApprovalInbox: mocks.approvals,
}));
vi.mock("@tedix/db/queries/approvals", () => ({
	getApprovalRequestById: mocks.runtime,
}));
vi.mock("@tedix/db/queries/memory-graph/fact-search", () => ({
	searchFactsWithVisibility: mocks.preferences,
}));
vi.mock("@tedix/db/queries/memory-graph/agent-lessons", () => ({
	listApprovedAgentLessons: mocks.lessons,
}));
vi.mock("@tedix/db/queries/memory-graph/facts", () => ({
	updateFact: mocks.update,
}));
import {
	readTurnMemory,
	readTaskMemoryState,
	reconcileTaskMemory,
} from "./task-memory-state";
import type { MemoryFact } from "@tedix/db/schema/memory-graph";
const db = {} as never;
const workId = "11111111-1111-4111-8111-111111111111";
const approvalId = "22222222-2222-4222-8222-222222222222";
beforeEach(() => {
	vi.resetAllMocks();
	writing.read.mockResolvedValue("");
	mocks.work.mockResolvedValue(null);
	mocks.owned.mockResolvedValue({ data: [], total: 0 });
	mocks.approvals.mockResolvedValue({ data: [], hasMore: false });
	mocks.runtime.mockResolvedValue(undefined);
	mocks.preferences.mockResolvedValue([]);
	mocks.lessons.mockResolvedValue([]);
});
it("retains preferences verbatim and finds owned work without semantic recall", async () => {
	mocks.preferences.mockResolvedValue([
		{
			id: "pref",
			organizationId: "org-fiction",
			factType: "preference",
			content: "Mira prefers short updates.",
			visibility: "org",
			metadata: null,
		},
	]);
	mocks.lessons.mockResolvedValue([
		{ id: "lesson", content: "Read the current source." },
	]);
	mocks.owned.mockResolvedValue({
		data: [
			{
				id: workId,
				title: "Sample review",
				disposition: "accepted",
				deadline: "2026-10-18T12:00:00Z",
			},
		],
		total: 1,
	});
	const result = await readTurnMemory(db, "org-fiction", "tedi-fiction", []);
	expect(result.preferences.map((row) => row.content)).toEqual([
		"Mira prefers short updates.",
		"Read the current source.",
	]);
	expect(result.tasks[0]).toMatchObject({
		id: workId,
		state: "accepted",
		deadline: "2026-10-18T12:00:00Z",
	});
	expect(mocks.work).not.toHaveBeenCalled();
	expect(mocks.preferences).toHaveBeenCalledWith(
		db,
		expect.objectContaining({
			orgId: "org-fiction",
			visibilityTediId: "tedi-fiction",
		}),
	);
});
it("reads terminal work and expires a pending approval against the current clock", async () => {
	mocks.work.mockImplementation(async (_db, id) =>
		id === workId
			? { id, title: "Sample review", disposition: "completed" }
			: null,
	);
	mocks.runtime.mockImplementation(async (_db, id) =>
		id === approvalId
			? {
					id,
					description: "Sample approval",
					status: "pending",
					expiresAt: "2026-10-16T10:00:00Z",
				}
			: undefined,
	);
	const tasks = await readTaskMemoryState(
		db,
		"org-fiction",
		[workId, approvalId],
		"2026-10-17T10:00:00Z",
	);
	expect(tasks.map((row) => row.state)).toEqual(["completed", "expired"]);
	expect(mocks.runtime).toHaveBeenCalledWith(db, approvalId, "org-fiction");
});
it("does not turn missing source rows into completion", async () => {
	const result = await readTurnMemory(db, "org-fiction", "tedi-fiction", [
		workId,
	]);
	expect(result.tasks).toEqual([]);
	expect(result.unresolvedReferences).toEqual([workId]);
});
it("corrects old transient state from live work while preserving durable preferences", async () => {
	mocks.work.mockResolvedValue({
		id: workId,
		title: "Sample review",
		disposition: "completed",
		deadline: null,
	});
	const stale = {
		id: "fact",
		organizationId: "org-fiction",
		factType: "technical",
		content: `Work ${workId} is accepted`,
		metadata: { verifyBeforeUse: true },
	} as unknown as MemoryFact;
	await reconcileTaskMemory(db, "org-fiction", [
		stale,
		{
			...stale,
			id: "pref",
			factType: "preference",
			metadata: { verifyBeforeUse: false },
		},
		{ ...stale, id: "foreign", organizationId: "org-other" },
	]);
	expect(mocks.update).toHaveBeenCalledTimes(1);
	expect(mocks.update).toHaveBeenCalledWith(
		db,
		"fact",
		expect.objectContaining({
			content: expect.stringContaining("completed"),
			metadata: expect.objectContaining({ verifyBeforeUse: true }),
		}),
	);
});

it("reads fresh writing preferences only for a canonically assigned person's work", async () => {
	writing.read.mockResolvedValue("Prefer shorter introductions.");
	mocks.work.mockResolvedValue({
		id: workId,
		orgId: "org-fiction",
		title: "Draft support response",
		disposition: "accepted",
		metadata: {},
		accountableOwnerType: "user",
		accountableOwnerId: "mira",
		stewardType: "tedi",
		stewardId: "tedi-fiction",
	});
	const result = await readTurnMemory(db, "org-fiction", "tedi-fiction", [
		workId,
	]);
	expect(writing.read).toHaveBeenCalledWith(db, "org-fiction", "mira");
	expect(result.preferences).toContainEqual({
		id: "decision-learning:mira",
		content: "Prefer shorter introductions.",
	});
	mocks.work.mockResolvedValue({
		id: workId,
		metadata: {},
		accountableOwnerType: "user",
		accountableOwnerId: "mira",
		stewardType: "tedi",
		stewardId: "other-tedi",
	});
	writing.read.mockClear();
	await readTurnMemory(db, "org-fiction", "tedi-fiction", [workId]);
	expect(writing.read).not.toHaveBeenCalledWith(db, "org-fiction", "mira");
});
