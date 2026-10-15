import { describe, expect, it, spyOn } from "bun:test";
import {
	createFactoryInput,
	type FactoryContext,
	runFactoryCommand,
} from "./factory";
import { parseOptions } from "./options";

function harness(reply: unknown, factory: FactoryContext["factory"] = {}) {
	const calls: string[] = [];
	const ctx: FactoryContext = {
		client: {
			runCode: async (source: string) => {
				calls.push(source);
				return reply;
			},
		},
		color: { enabled: false },
		json: true,
		factory,
	};
	return { calls, ctx };
}

describe("factory commands", () => {
	it("creates a factory from flags in one gateway call", async () => {
		const stdout = spyOn(console, "log").mockImplementation(() => {});
		const { calls, ctx } = harness(
			{ slug: "docs-accuracy", status: "created" },
			{
				goal: "Keep the docs accurate.",
				owner: "Nova",
				cadence: "daily",
				maxProposals: "2",
				project: "DOCS",
				dryRun: true,
			},
		);
		expect(await runFactoryCommand("create", ctx)).toBe(0);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("projects.create_factory");
		expect(calls[0]).toContain('"ownerTedi":"Nova"');
		expect(calls[0]).toContain('"maxProposals":2');
		expect(calls[0]).toContain('"projectKey":"DOCS"');
		expect(calls[0]).toContain('"dryRun":true');
		stdout.mockRestore();
	});

	it("requires a goal and an owner before any call", () => {
		expect(() => createFactoryInput({ owner: "Nova" })).toThrow(/--goal/);
		expect(() => createFactoryInput({ goal: "Keep docs right." })).toThrow(
			/--owner/,
		);
		expect(() =>
			createFactoryInput({ goal: "x", owner: "y", maxProposals: "50" }),
		).toThrow(/--max-proposals/);
	});

	it("lists every factory, or one by slug, with its verdict", async () => {
		const stdout = spyOn(console, "log").mockImplementation(() => {});
		const all = harness({
			data: [
				{ slug: "docs", verdict: "idle", reason: "ran, delivered nothing" },
			],
		});
		all.ctx.json = false;
		expect(await runFactoryCommand("status", all.ctx)).toBe(0);
		expect(all.calls[0]).toContain("projects.inspect_factory_health({})");
		expect(all.calls[0]).toContain('"verdict"');
		expect(all.calls[0]).not.toContain('"runs"');
		expect(stdout.mock.calls[0]?.[0]).toContain("idle");

		const one = harness({ data: [] }, { runs: 3 });
		expect(await runFactoryCommand("status docs", one.ctx)).toBe(0);
		expect(one.calls[0]).toContain('"factory":"docs"');
		expect(one.calls[0]).toContain('"runs":3');
		expect(one.calls[0]).not.toContain("data.map");
		stdout.mockRestore();
	});

	it("parses factory flags only for the factory command", () => {
		const parsed = parseOptions([
			"factory",
			"create",
			"--goal",
			"Keep the docs accurate.",
			"--owner",
			"Nova",
			"--cadence",
			"twice_daily",
			"--dry-run",
		]);
		expect(parsed.command).toBe("factory");
		expect(parsed.options).toMatchObject({
			factoryGoal: "Keep the docs accurate.",
			factoryOwner: "Nova",
			factoryCadence: "twice_daily",
			factoryDryRun: true,
			prompt: "create",
		});
		expect(() => parseOptions(["work", "list", "--goal", "x"])).toThrow(
			/only valid with factory/,
		);
	});
});
