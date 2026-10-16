import { describe, expect, it, vi } from "vite-plus/test";
import { factoryIntent, factoryChatDecision } from "./factory-intent";
import type { FactoryHealth } from "@tedix/api-contract/schemas/factories";
const lane = {
	slug: "sample-inbox",
	name: "Sample inbox",
	skillId: "skill-1",
	ownerTediId: "sample-owner",
	verdict: "paused",
	reason: "Schedule disabled",
	scheduleEnabled: false,
	nextFireAt: null,
	runs: [],
} as unknown as FactoryHealth;
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
	it("routes creation without loading unrelated factories", async () => {
		const load = vi.fn();
		const result = await factoryChatDecision(
			"Create a daily factory",
			ctx,
			load,
		);
		expect(result?.toolIntent?.capability).toBe("factories.create");
		expect(load).not.toHaveBeenCalled();
	});
	it("resolves a pronoun to a known factory from history", async () => {
		const result = await factoryChatDecision(
			"Pause that factory",
			ctx,
			async () => [lane],
		);
		expect(result?.rationale).toContain("sample-inbox");
		expect(result?.toolIntent?.capability).toBe("factories.pause");
	});
	it("reads fresh health rather than history's claimed success", async () => {
		const result = await factoryChatDecision(
			"How is sample-inbox factory doing?",
			ctx,
			async () => [lane],
		);
		expect(result?.routeKind).toBe("answer_in_home");
		expect(result?.answer).toContain("paused");
	});
	it("asks on an unresolved or ambiguous target", async () => {
		const result = await factoryChatDecision(
			"Archive that factory",
			{ ...ctx, history: [] },
			async () => [lane],
		);
		expect(result?.routeKind).toBe("ask_human");
	});
});

it("grounds an immediate factory run in the lane skill and owning tedi", async () => {
	const result = await factoryChatDecision("Run it now", ctx, async () => [
		lane,
	]);
	expect(result?.rationale).toContain("owner tedi id: sample-owner");
});
