import { beforeEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({ tedi: vi.fn(), memory: vi.fn() }));
vi.mock("@tedix/db/queries/tedis", () => ({ getTediById: mocks.tedi }));
vi.mock("../../../services/task-memory-state", () => ({
	readTurnMemory: mocks.memory,
}));
import { readRuntimeTurnMemory } from "./turn-memory";
beforeEach(() => {
	vi.clearAllMocks();
	mocks.tedi.mockResolvedValue({
		id: "tedi-fiction",
		organizationId: "org-fiction",
	});
});
it("requires matching tedi and canonical organization before reading memory or Work", async () => {
	const input = { tediId: "tedi-fiction", references: [] };
	for (const headers of [
		{},
		{ "X-Tedix-Tedi-Id": "tedi-other", "X-Tedix-Org-Id": "org-fiction" },
		{ "X-Tedix-Tedi-Id": "tedi-fiction", "X-Tedix-Org-Id": "org-other" },
	]) {
		await expect(
			readRuntimeTurnMemory(
				{ db: {}, headers: new Headers(headers) } as never,
				input,
			),
		).rejects.toThrow();
	}
	expect(mocks.memory).not.toHaveBeenCalled();
	await readRuntimeTurnMemory(
		{
			db: {},
			headers: new Headers({
				"X-Tedix-Tedi-Id": "tedi-fiction",
				"X-Tedix-Org-Id": "org-fiction",
			}),
		} as never,
		input,
	);
	expect(mocks.memory).toHaveBeenCalledWith(
		{},
		"org-fiction",
		"tedi-fiction",
		[],
	);
});
