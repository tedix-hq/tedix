/**
 * Skill-summary enrichment is optional and must never dominate request latency.
 *
 * When apps/api is slow, many `skills.listByApp(...)` calls can time out in a
 * single request. The per-app negative cache does not help — each distinct app
 * pays the timeout once — so the waits stack on top of the aggregate rebuild.
 */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	__resetSkillSummaryBreaker,
	getCachedSkillSummaries,
} from "./skill-cache";

function hangingClient(onCall: () => void) {
	return {
		skills: {
			listByApp: vi.fn(async () => {
				onCall();
				// Never resolves within the fetch timeout — models the unhealthy API.
				await new Promise((r) => setTimeout(r, 10_000));
				return { summaries: [] };
			}),
		},
	} as never;
}

describe("skill summary circuit breaker", () => {
	beforeEach(() => {
		__resetSkillSummaryBreaker();
	});

	it("stops calling a timing-out upstream after the threshold", async () => {
		let calls = 0;
		const apiClient = hangingClient(() => {
			calls += 1;
		});

		// 12 distinct apps: without a breaker every one pays the full timeout.
		const started = Date.now();
		for (let i = 0; i < 12; i++) {
			await getCachedSkillSummaries({
				apiClient,
				appId: `app-${i}`,
				orgId: "org-1",
			});
		}
		const elapsed = Date.now() - started;

		// Only the first few reach the upstream; the rest short-circuit.
		expect(calls).toBeLessThanOrEqual(3);
		expect(calls).toBeGreaterThan(0);
		// 12 × 2.5s would be 30s. Bounded to roughly the threshold's worth.
		expect(elapsed).toBeLessThan(12_000);
	}, 40_000);

	it("always degrades to an empty list, never throws", async () => {
		const apiClient = hangingClient(() => {});
		for (let i = 0; i < 5; i++) {
			const summaries = await getCachedSkillSummaries({
				apiClient,
				appId: `degrade-${i}`,
				orgId: "org-1",
			});
			expect(summaries).toEqual([]);
		}
	}, 30_000);

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
