import { describe, expect, it } from "bun:test";
import {
	defaultRoutingPolicy,
	routeLocalWork,
	executorBackoff,
	parseBudgetSignal,
	resumeThenFresh,
} from "./lane-routing";

const available = {
	codex: true,
	"claude-code": true,
	opencode: true,
	devin: true,
};
describe("local capability routing", () => {
	it("routes small mechanical work to the cheapest configured passing model", () => {
		expect(
			routeLocalWork(
				{ executor: "any-local", tags: ["mechanical"], size: "small" },
				defaultRoutingPolicy,
				available,
				{},
			).executor,
		).toBe("opencode");
	});
	it("keeps security work on strong routes even with mechanical tags", () => {
		const route = routeLocalWork(
			{
				executor: "any-local",
				tags: ["mechanical", "security"],
				size: "small",
			},
			defaultRoutingPolicy,
			available,
			{},
		);
		expect(route.executor).toBe("codex");
		expect(route.rule).toBe("hard");
	});
	it("falls back on near limits, cooldown and unavailable backends", () => {
		const now = Date.now();
		expect(
			routeLocalWork(
				{ executor: "any-local" },
				defaultRoutingPolicy,
				{ ...available, opencode: false },
				{
					codex: {
						observedAt: now,
						source: "native",
						remainingPercent: 2,
						resetAt: now + 5000,
					},
					"claude-code": {
						observedAt: now,
						source: "error",
						backoffUntil: now + 5000,
					},
				},
				now,
			).executor,
		).toBe("devin");
	});
	it("never changes a pinned assignment and never downgrades outside the rule", () => {
		expect(() =>
			routeLocalWork({ executor: "codex" }, defaultRoutingPolicy, available, {
				codex: {
					observedAt: Date.now(),
					source: "error",
					backoffUntil: Date.now() + 5000,
				},
			}),
		).toThrow("No eligible");
		expect(() =>
			routeLocalWork(
				{ executor: "any-local", risk: "high" },
				defaultRoutingPolicy,
				{ ...available, codex: false, "claude-code": false, opencode: false },
				{},
			),
		).toThrow("No eligible");
	});
	it("ignores expired native readings but preserves an explicit cooldown", () => {
		expect(
			routeLocalWork(
				{ executor: "any-local" },
				defaultRoutingPolicy,
				available,
				{ codex: { observedAt: 1, source: "native", remainingPercent: 0 } },
				1_000_000,
			).executor,
		).toBe("codex");
	});
});
describe("budget observations", () => {
	it("projects Codex windows conservatively without carrying arbitrary fields", () => {
		const snapshot = parseBudgetSignal(
			{
				primary: { used_percent: 95, resets_at: 2000 },
				secondary: { used_percent: 30 },
				secret: "never retained",
			},
			1000,
		);
		expect(snapshot.remainingPercent).toBe(5);
		expect(snapshot.resetAt).toBe(2_000_000);
		expect(JSON.stringify(snapshot)).not.toContain("secret");
	});
	it("accepts Claude utilization and Devin session cap observations", () => {
		expect(
			parseBudgetSignal({
				five_hour: { utilization: 92, resets_at: "2026-10-22T00:00:00Z" },
			}).remainingPercent,
		).toBe(8);
		expect(
			parseBudgetSignal({ sessions_used: 9, session_limit: 10 })
				.remainingPercent,
		).toBe(10);
	});
	it("does not turn estimated cost into remaining credit", () => {
		const snapshot = parseBudgetSignal({ estimatedCostUsd: 1.25 });
		expect(snapshot.estimatedCostUsd).toBe(1.25);
		expect(snapshot.remainingPercent).toBeUndefined();
	});
	it("backs off rate limits exponentially and honors retry-after", () => {
		expect(
			executorBackoff("429 rate limit; retry-after: 900", undefined, 1000)
				?.backoffUntil,
		).toBe(901000);
		const first = executorBackoff("usage limit reached", undefined, 1000)!;
		expect(
			executorBackoff("rate limit", first, 2000)!.backoffUntil,
		).toBeGreaterThan(first.backoffUntil!);
		expect(executorBackoff("file missing", undefined, 1000)).toBeUndefined();
	});
	it.each(["9".repeat(310), "10000000000000"])(
		"keeps a reportable, persistent cooldown for oversized retry-after %s",
		(retryAfter) => {
			const first = executorBackoff("429", undefined, 1000)!;
			const next = executorBackoff(
				`429 retry-after: ${retryAfter}`,
				first,
				2000,
			)!;
			expect(next.backoffUntil).toBe(122000);
			expect(new Date(next.backoffUntil!).toISOString()).toBe(
				"1970-01-01T00:02:02.000Z",
			);
			const persisted = JSON.parse(JSON.stringify(next));
			expect(persisted.backoffUntil).toBe(122000);
			expect(() =>
				routeLocalWork(
					{ executor: "codex" },
					defaultRoutingPolicy,
					available,
					{ codex: persisted },
					2000,
				),
			).toThrow("No eligible");
		},
	);
});
describe("resume recovery before admission", () => {
	it("resumes first and allocates fresh only for missing native state", async () => {
		const events: string[] = [];
		const result = await resumeThenFresh(
			async () => {
				events.push("resume");
				throw new Error("rollout not found");
			},
			async () => {
				events.push("fresh");
				return "new";
			},
		);
		expect(result).toBe("new");
		expect(events).toEqual(["resume", "fresh"]);
	});
	it("does not hide auth, rate-limit, or backend failures as a missing session", async () => {
		let fresh = false;
		await expect(
			resumeThenFresh(
				async () => {
					throw new Error("backend stopped");
				},
				async () => {
					fresh = true;
				},
			),
		).rejects.toThrow("backend stopped");
		expect(fresh).toBe(false);
	});
});
