import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ApiClient } from "../lib/api-client";
import { StepBudgetExceededError } from "../lib/step-budget";
import {
	__resetSkillSummaryBreaker,
	fetchSkillListWithBudget,
	getCachedSkillSummaries,
} from "./skill-cache";

/**
 * Regression: the skill-summary cache must be org-partitioned. Shared base
 * apps (one appId aggregated by many orgs) previously collided on an
 * (appId, tediId) key, serving one org's listByApp result to another org's
 * tool enrichment from L1/L2.
 */

function stubApiClient(summariesByCall: { id: string; title: string }[]) {
	return {
		skills: {
			listByApp: async () => ({
				summaries: summariesByCall.map((s) => ({
					...s,
					successCount: 0,
					revision: 1,
				})),
			}),
		},
	} as unknown as ApiClient;
}

describe("getCachedSkillSummaries org partitioning", () => {
	it("does not serve one org's cached summaries to another org for the same appId", async () => {
		const sharedAppId = "00000000-0000-4000-8000-00000000shared";

		const orgASkills = [{ id: "skill-a", title: "Org A Procedure" }];
		const orgBSkills = [{ id: "skill-b", title: "Org B Procedure" }];

		const first = await getCachedSkillSummaries({
			apiClient: stubApiClient(orgASkills),
			appId: sharedAppId,
			orgId: "org-a",
		});
		expect(first.map((s) => s.id)).toEqual(["skill-a"]);

		// Same appId, different org — a colliding key would return org A's
		// cached rows without ever consulting org B's apiClient.
		const second = await getCachedSkillSummaries({
			apiClient: stubApiClient(orgBSkills),
			appId: sharedAppId,
			orgId: "org-b",
		});
		expect(second.map((s) => s.id)).toEqual(["skill-b"]);
	});

	it("still caches within one org (same key hits L1, apiClient not consulted)", async () => {
		const appId = "00000000-0000-4000-8000-000000same01";
		const initial = [{ id: "skill-1", title: "Cached" }];

		const first = await getCachedSkillSummaries({
			apiClient: stubApiClient(initial),
			appId,
			orgId: "org-c",
		});
		expect(first.map((s) => s.id)).toEqual(["skill-1"]);

		// Different stub result — a cache hit must return the original rows.
		const second = await getCachedSkillSummaries({
			apiClient: stubApiClient([{ id: "skill-2", title: "Fresh" }]),
			appId,
			orgId: "org-c",
		});
		expect(second.map((s) => s.id)).toEqual(["skill-1"]);
	});
});

/**
 * `registerAppSkills` calls `skills.listByApp`/`listByOrg` directly; without a
 * budget, a stalled apps/api skills endpoint would hang every tools/list
 * silently on the request path. `fetchSkillListWithBudget` puts those direct calls under the
 * same discipline as the summary cache.
 */
describe("fetchSkillListWithBudget", () => {
	afterEach(() => {
		__resetSkillSummaryBreaker();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("returns a healthy result and leaves the breaker closed", async () => {
		await expect(
			fetchSkillListWithBudget("test_step", "app-1", async () => ({
				skills: [{ id: "s1" }],
			})),
		).resolves.toEqual({ skills: [{ id: "s1" }] });
	});

	it("fails a NEVER-settling list call within the skill-fetch budget with the diagnosis line", async () => {
		vi.useFakeTimers();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const pending = fetchSkillListWithBudget(
			"register_app_skills_list",
			"app-wedged",
			() => new Promise<never>(() => {}),
		).catch((error: unknown) => error);

		await vi.advanceTimersByTimeAsync(2_501);
		expect(await pending).toBeInstanceOf(StepBudgetExceededError);
		const line = errorSpy.mock.calls
			.map(([entry]) => entry as Record<string, unknown>)
			.find((entry) => entry?.step === "register_app_skills_list");
		expect(line).toMatchObject({
			component: "mcp.step_budget",
			event: "step_budget.exceeded",
			step: "register_app_skills_list",
			resourceKey: "app-wedged",
		});
	});

	it("opens the shared breaker after consecutive trips and then skips the round-trip entirely", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "error").mockImplementation(() => {});
		for (let i = 0; i < 3; i++) {
			const pending = fetchSkillListWithBudget(
				"test_step",
				`app-${i}`,
				() => new Promise<never>(() => {}),
			).catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(2_501);
			expect(await pending).toBeInstanceOf(StepBudgetExceededError);
		}

		// Breaker open: the thunk is never invoked, the caller degrades instantly.
		let invoked = 0;
		await expect(
			fetchSkillListWithBudget("test_step", "app-after", async () => {
				invoked++;
				return { skills: [] };
			}),
		).resolves.toBeNull();
		expect(invoked).toBe(0);
	});
});
