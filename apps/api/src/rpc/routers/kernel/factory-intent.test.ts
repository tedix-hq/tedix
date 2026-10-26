import { describe, expect, it, vi } from "vite-plus/test";
import { factoryIntent, factoryChatDecision } from "./factory-intent";
import type {
	FactoryChatHealth,
	FactoryChatReader,
} from "./factory-chat-tools";
const lane: FactoryChatHealth = {
	slug: "sample-inbox",
	name: "Sample inbox",
	skillId: "skill-1",
	ownerTediId: "sample-owner",
	verdict: "paused",
	reason: "Schedule disabled",
	scheduleEnabled: false,
	nextFireAt: null,
	runs: [],
};
function reader(
	lanes = [lane],
	health: FactoryChatReader["health"] = async () => lane,
): FactoryChatReader {
	return {
		lanes: async () => ({
			lanes: lanes.map(({ slug, name }) => ({ slug, name })),
			total: lanes.length,
		}),
		health,
	};
}
const ctx = {
	apps: [{ slug: "sample-tools", codeMode: true as const }],
	history: [{ role: "assistant" as const, content: "Created sample-inbox." }],
};
describe("factory chat routing", () => {
	it.each([
		["Create a daily factory for comments", "create"],
		[
			"Every morning summarise new comments in project X into a doc here",
			"create",
		],
		["Pause that factory", "pause"],
		["Resume sample-inbox factory", "resume"],
		["Archive that factory", "archive"],
		["How is my inbox factory doing?", "health"],
		["Run it now", "run"],
		["How do I create a factory?", null],
		["Do not archive that factory", null],
		["Explain how factories work", null],
		["Create a document about a factory", null],
	])("%s", (content, expected) =>
		expect(factoryIntent(content)).toBe(expected),
	);
	it("ignores factory words inside pasted context below a long request", () => {
		const prompt = [
			'Please reconcile the "accepted" Work items in project sample-project that look finished against the code changes that landed on main, and give me a settle-or-keep table. Read-only.',
			"",
			"Commits on main:",
			"aaaa0001 fix(catalog): preserve delist count API and handle null health",
			"aaaa0002 test: advance factory cards after the verdict is saved",
			"aaaa0003 fix(deck): preserve critical factory routing in rank snapshots",
		].join("\n");
		expect(factoryIntent(prompt)).toBeNull();
	});
	it("routes creation without loading unrelated factories", async () => {
		const lanes = vi.fn();
		const health = vi.fn();
		const result = await factoryChatDecision("Create a daily factory", ctx, {
			lanes,
			health,
		});
		expect(result?.toolIntent?.capability).toBe("factories.create");
		expect(lanes).not.toHaveBeenCalled();
		expect(health).not.toHaveBeenCalled();
	});
	it("resolves a pronoun to a known factory from history", async () => {
		const result = await factoryChatDecision(
			"Pause that factory",
			ctx,
			reader(),
		);
		expect(result?.rationale).toContain("sample-inbox");
		expect(result?.toolIntent?.capability).toBe("factories.pause");
	});
	it("reads fresh health rather than history's claimed success", async () => {
		const result = await factoryChatDecision(
			"How is sample-inbox factory doing?",
			ctx,
			reader(),
		);
		expect(result?.routeKind).toBe("answer_in_home");
		expect(result?.answer).toContain("paused");
	});
	it("reads only the named factory's health after resolving it by name", async () => {
		const health = vi.fn(async () => ({
			...lane,
			verdict: "healthy" as const,
			reason: "Ran today",
			runs: [{ runId: "run-1", status: "completed" }],
		}));
		const result = await factoryChatDecision(
			"How is the Sample inbox factory doing?",
			ctx,
			reader(
				[{ ...lane, slug: "other-lane", name: "Other lane" }, lane],
				health,
			),
		);
		expect(health).toHaveBeenCalledExactlyOnceWith("sample-inbox");
		expect(result?.answer).toContain("Latest run: run-1 (completed)");
	});
	it("says it could not read health when the named factory's read fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = await factoryChatDecision(
			"How is sample-inbox factory doing?",
			ctx,
			reader([lane], async () => {
				throw new Error("Code Mode result kept behind a handle");
			}),
		);
		expect(result?.answer).toContain("could not read current factory health");
		expect(result?.toolIntent).toBeNull();
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ event: "health_read_failed" }),
		);
		warn.mockRestore();
	});
	it("names how many factories a capped list leaves out", async () => {
		const result = await factoryChatDecision(
			"How is that factory doing?",
			{ ...ctx, history: [] },
			{
				lanes: async () => ({
					lanes: [{ slug: "sample-inbox", name: "Sample inbox" }],
					total: 151,
				}),
				health: async () => lane,
			},
		);
		expect(result?.routeKind).toBe("ask_human");
		expect(result?.answer).toBe(
			"Available factories: sample-inbox and 150 more.",
		);
	});
	it("asks on an unresolved or ambiguous target", async () => {
		const result = await factoryChatDecision(
			"Archive that factory",
			{ ...ctx, history: [] },
			reader(),
		);
		expect(result?.routeKind).toBe("ask_human");
	});
});

it("grounds an immediate factory run in the lane skill and owning tedi", async () => {
	const result = await factoryChatDecision("Run it now", ctx, reader());
	expect(result?.rationale).toContain("owner tedi id: sample-owner");
});
