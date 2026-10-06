/**
 * The aggregate rebuild must issue one skills call, not one per app.
 *
 * A cold apps/api invocation burns seconds of CPU because the `worker-app`
 * graph is evaluated per isolate, so a per-app fan-out over `skills.listByApp`
 * creates one cold isolate per app. Batching removes them.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { UPSTREAM_ATTEMPT_TIMEOUT_MS } from "../upstream";
import {
	__resetSkillSummaryBreaker,
	getCachedSkillSummariesForApps,
	SKILL_SUMMARY_BATCH_FETCH_TIMEOUT_MS,
} from "./skill-cache";

function summary(id: string) {
	return { id, title: `Skill ${id}`, successCount: 0, revision: 1 };
}

function client(summariesByApp: Record<string, unknown[]>) {
	const listSummariesByApps = vi.fn(async () => ({ summariesByApp }));
	const listByApp = vi.fn(async () => ({ summaries: [] }));
	return {
		client: { skills: { listSummariesByApps, listByApp } } as never,
		listSummariesByApps,
		listByApp,
	};
}

describe("batched skill summaries", () => {
	beforeEach(() => {
		__resetSkillSummaryBreaker();
	});

	it("makes ONE upstream call for many apps", async () => {
		const appIds = Array.from({ length: 40 }, (_, i) => `batch-app-${i}`);
		const {
			client: apiClient,
			listSummariesByApps,
			listByApp,
		} = client(Object.fromEntries(appIds.map((a) => [a, [summary(`s-${a}`)]])));

		const out = await getCachedSkillSummariesForApps({
			apiClient,
			appIds,
			orgId: "org-batch",
		});

		expect(listSummariesByApps).toHaveBeenCalledTimes(1);
		// The per-app endpoint must not be touched at all.
		expect(listByApp).not.toHaveBeenCalled();
		expect(out.size).toBe(40);
		expect(out.get("batch-app-7")).toHaveLength(1);
	});

	it("returns an entry for every requested app, including empties", async () => {
		// "no readable skills" must be distinguishable from "not asked for".
		const { client: apiClient } = client({ "has-skills": [summary("s1")] });
		const out = await getCachedSkillSummariesForApps({
			apiClient,
			appIds: ["has-skills", "no-skills"],
			orgId: "org-empty",
		});
		expect(out.get("has-skills")).toHaveLength(1);
		expect(out.get("no-skills")).toEqual([]);
	});

	it("serves a second call from cache without re-hitting upstream", async () => {
		const { client: apiClient, listSummariesByApps } = client({
			"cached-app": [summary("s1")],
		});
		const args = {
			apiClient,
			appIds: ["cached-app"],
			orgId: "org-cache",
		};
		await getCachedSkillSummariesForApps(args);
		await getCachedSkillSummariesForApps(args);
		expect(listSummariesByApps).toHaveBeenCalledTimes(1);
	});

	it("degrades to empty and never throws when the batch fails", async () => {
		const apiClient = {
			skills: {
				listSummariesByApps: vi.fn(async () => {
					throw new Error("upstream down");
				}),
			},
		} as never;
		const out = await getCachedSkillSummariesForApps({
			apiClient,
			appIds: ["a", "b"],
			orgId: "org-fail",
		});
		expect(out.get("a")).toEqual([]);
		expect(out.get("b")).toEqual([]);
	});
});

/**
 * The batch budget.
 *
 * A short fixed budget (8s) is the wrong number for a call that carries what
 * one call per app used to. The budget tracks the repo's calibrated "one apps/api call, possibly a cold
 * isolate" deadline, and a failing batch must open the breaker at once so the
 * longer budget cannot be paid over and over.
 */
describe("batched skill summary budget", () => {
	beforeEach(() => {
		__resetSkillSummaryBreaker();
	});
	afterEach(() => {
		vi.useRealTimers();
		__resetSkillSummaryBreaker();
	});

	it("gives one batched call a full cold-isolate budget, not the single-app one", () => {
		expect(SKILL_SUMMARY_BATCH_FETCH_TIMEOUT_MS).toBe(
			UPSTREAM_ATTEMPT_TIMEOUT_MS,
		);
		// 8s is too short for a large batch on a cold isolate.
		expect(SKILL_SUMMARY_BATCH_FETCH_TIMEOUT_MS).toBeGreaterThan(8_000);
	});

	it("times the batch out at that budget rather than hanging the request", async () => {
		vi.useFakeTimers();
		const listSummariesByApps = vi.fn(() => new Promise(() => {}));
		const pending = getCachedSkillSummariesForApps({
			apiClient: { skills: { listSummariesByApps } } as never,
			appIds: ["slow-a", "slow-b"],
			orgId: "org-slow",
		});
		await vi.advanceTimersByTimeAsync(SKILL_SUMMARY_BATCH_FETCH_TIMEOUT_MS + 1);
		const out = await pending;
		// Optional enrichment: degrade to empty, never throw.
		expect(out.get("slow-a")).toEqual([]);
		expect(out.get("slow-b")).toEqual([]);
	});

	it("opens the breaker on the FIRST batch failure, so the budget is paid once", async () => {
		const listSummariesByApps = vi.fn(async () => {
			throw new Error("upstream down");
		});
		const apiClient = { skills: { listSummariesByApps } } as never;

		await getCachedSkillSummariesForApps({
			apiClient,
			appIds: ["breaker-a"],
			orgId: "org-breaker",
		});
		expect(listSummariesByApps).toHaveBeenCalledTimes(1);

		// Different apps, so no negative-cache hit — only an open breaker can
		// suppress this. Pre-batching, ~40 calls per request reached the
		// 3-consecutive-failure threshold inside one request; batched, a threshold
		// of 3 would mean three requests each paying the full timeout.
		const out = await getCachedSkillSummariesForApps({
			apiClient,
			appIds: ["breaker-b", "breaker-c"],
			orgId: "org-breaker",
		});
		expect(listSummariesByApps).toHaveBeenCalledTimes(1);
		expect(out.get("breaker-b")).toEqual([]);
		expect(out.get("breaker-c")).toEqual([]);
	});
});
