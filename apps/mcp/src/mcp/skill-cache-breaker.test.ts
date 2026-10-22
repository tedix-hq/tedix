/**
 * Skill-summary enrichment is optional and must never dominate request latency.
 *
 * When apps/api is slow, many `skills.listByApp(...)` calls can time out in a
 * single request. The per-app negative cache does not help — each distinct app
 * pays the timeout once — so the waits stack on top of the aggregate rebuild.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import {
	__resetSkillSummaryBreaker,
	getCachedSkillSummaries,
} from "./skill-cache";

function hangingClient(onCall: () => void) {
	return {
		skills: {
			listByApp: vi.fn(() => {
				onCall();
				// Never settles — models the unhealthy API. The fetch timeout is
				// what releases the caller.
				return new Promise(() => {});
			}),
		},
	} as never;
}

describe("skill summary circuit breaker", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		__resetSkillSummaryBreaker();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("stops calling a timing-out upstream after the threshold", async () => {
		let calls = 0;
		const apiClient = hangingClient(() => {
			calls += 1;
		});

		// 12 distinct apps: without a breaker every one pays the full timeout.
		let paidTimeout = 0;
		for (let i = 0; i < 12; i++) {
			let settled = false;
			const pending = getCachedSkillSummaries({
				apiClient,
				appId: `app-${i}`,
				orgId: "org-1",
			}).then((summaries) => {
				settled = true;
				return summaries;
			});
			// With fake time frozen, only a call that short-circuits on the open
			// breaker can settle — a live upstream call still owes the fetch
			// timeout before it can degrade.
			await vi.advanceTimersByTimeAsync(0);
			if (!settled) {
				paidTimeout += 1;
				await vi.advanceTimersByTimeAsync(2_500);
			}
			expect(await pending).toEqual([]);
		}

		// Only the first few reach the upstream; the rest settle with zero time
		// passing, so every upstream call paid exactly one fetch timeout.
		expect(calls).toBeLessThanOrEqual(3);
		expect(calls).toBeGreaterThan(0);
		expect(paidTimeout).toBe(calls);
	});

	it("always degrades to an empty list, never throws", async () => {
		const apiClient = hangingClient(() => {});
		for (let i = 0; i < 5; i++) {
			const pending = getCachedSkillSummaries({
				apiClient,
				appId: `degrade-${i}`,
				orgId: "org-1",
			});
			await vi.advanceTimersByTimeAsync(2_500);
			expect(await pending).toEqual([]);
		}
	});

	it("does not penalise a healthy upstream", async () => {
		const apiClient = {
			skills: {
				listByApp: vi.fn(async () => ({
					summaries: [
						{ id: "s1", title: "Skill", successCount: 0, revision: 1 },
					],
				})),
			},
		} as never;

		for (let i = 0; i < 6; i++) {
			const summaries = await getCachedSkillSummaries({
				apiClient,
				appId: `healthy-${i}`,
				orgId: "org-1",
			});
			expect(summaries).toHaveLength(1);
		}
		// Every call went through — a success must keep the breaker closed.
		expect(
			(
				apiClient as unknown as {
					skills: { listByApp: { mock: { calls: unknown[] } } };
				}
			).skills.listByApp.mock.calls,
		).toHaveLength(6);
	});
});
