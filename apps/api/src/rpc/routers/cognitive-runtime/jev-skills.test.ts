import { it, expect, vi, beforeEach } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	tedi: vi.fn(),
	skills: vi.fn(),
	rank: vi.fn(),
	factory: vi.fn(),
}));
vi.mock("@tedix/db/queries/tedis", () => ({ getTediById: mocks.tedi }));
vi.mock("@tedix/db/queries/cognitive/skill-crud", () => ({
	listRankableSkillEntries: mocks.skills,
}));
vi.mock("../../../services/jev-judgment", () => ({
	JevUsagePersistenceError: class extends Error {},
}));
vi.mock("../kernel/jev-context-ranking", () => ({
	createJevContextRanker: mocks.factory,
}));
import { rankRuntimeSkills } from "./jev-skills";
const input = {
	tediId: "tedi",
	runId: "run",
	query: "Find accounting procedures",
	skillIds: ["a", "b"],
};
function context(
	headers: Record<string, string> = {
		"X-Tedix-Tedi-Id": "tedi",
		"X-Tedix-Org-Id": "org",
	},
) {
	return { headers: new Headers(headers), db: {}, env: {} } as never;
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.tedi.mockResolvedValue({ id: "tedi", organizationId: "org" });
	mocks.skills.mockResolvedValue([
		{ id: "a", title: "Canonical A" },
		{ id: "b", title: "Canonical B" },
	]);
	mocks.rank.mockResolvedValue(["b", "a"]);
	mocks.factory.mockReturnValue(mocks.rank);
});
it("requires tedi attribution and matching canonical tenant before reading candidates", async () => {
	await expect(rankRuntimeSkills(context({}), input)).rejects.toThrow();
	await expect(
		rankRuntimeSkills(
			context({ "X-Tedix-Tedi-Id": "other", "X-Tedix-Org-Id": "org" }),
			input,
		),
	).rejects.toThrow();
	mocks.tedi.mockResolvedValue({ id: "tedi", organizationId: "other" });
	await expect(rankRuntimeSkills(context(), input)).rejects.toThrow();
	expect(mocks.skills).not.toHaveBeenCalled();
	expect(mocks.rank).not.toHaveBeenCalled();
});
it("does not dispatch when even one candidate is not currently eligible", async () => {
	mocks.skills.mockResolvedValue([{ id: "a" }]);
	expect((await rankRuntimeSkills(context(), input)).skillIds).toBeNull();
	expect(mocks.rank).not.toHaveBeenCalled();
});
it("uses canonical summaries and carries runtime identity into the shared billing owner", async () => {
	expect((await rankRuntimeSkills(context(), input)).skillIds).toEqual([
		"b",
		"a",
	]);
	expect(mocks.factory).toHaveBeenCalledWith(
		expect.anything(),
		expect.anything(),
		expect.objectContaining({
			organizationId: "org",
			tediId: "tedi",
			runId: "run",
		}),
		undefined,
		undefined,
		"skillRanking",
	);
	expect(mocks.rank).toHaveBeenCalledWith({
		kind: "skill",
		query: input.query,
		candidates: [
			{ id: "a", description: "Canonical A" },
			{ id: "b", description: "Canonical B" },
		],
	});
});

it("returns known paid usage when the canonical receipt write fails", async () => {
	const { JevUsagePersistenceError } =
		await import("../../../services/jev-judgment");
	mocks.factory.mockImplementation((_db, _env, ctx) => async () => {
		ctx.executionAttempts.push({
			identity: { provider: "typesafe", requestModel: "jev-1.13.0" },
			executionId: "exec",
			occurredAt: "now",
			usage: {
				inputTokens: 20,
				outputTokens: 3,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			},
		});
		throw new JevUsagePersistenceError("exec");
	});
	const result = await rankRuntimeSkills(context(), input);
	expect(result.skillIds).toBeNull();
	expect(result.usagePersistence).toBe("failed");
	expect(result.executionAttempts[0]?.usage?.inputTokens).toBe(20);
});
