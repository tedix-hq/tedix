import { expect, it, vi } from "vite-plus/test";
import { dispatchMaintenanceDue } from "./work-maintenance-due";

const calls = vi.hoisted(() => ({
	lane: vi.fn().mockResolvedValue(1),
	outbound: vi.fn().mockResolvedValue({ timedOut: 1 }),
	stale: vi.fn().mockResolvedValue({ cancelled: 1 }),
	child: vi.fn().mockResolvedValue({ cancelled: 1 }),
	repository: vi.fn().mockResolvedValue({ settled: 1 }),
}));
vi.mock("@tedix/db/core-store/scope", () => ({ coreQueryDb: () => "db" }));
vi.mock("@tedix/db/queries/work-items/lane-lifecycle", () => ({
	recordStaleLanes: calls.lane,
}));
vi.mock("@tedix/db/queries/work-items/outbound", () => ({
	sweepStuckOutboundReviews: calls.outbound,
}));
vi.mock("@tedix/db/queries/work-items/stale-delegation-sweep", () => ({
	sweepStaleFailedDelegationWorkItems: calls.stale,
	sweepUncontractedChildWorkItems: calls.child,
}));
vi.mock("./repository-observer", () => ({
	maintainRepositoryObservers: calls.repository,
}));

it("keeps canonical maintenance lookups scoped to each claimed organization and its IDs", async () => {
	const env = {} as CloudflareEnv;
	const now = Date.now();
	for (const [kind, call] of [
		["lane-stale", calls.lane],
		["outbound-review", calls.outbound],
		["stale-delegation", calls.stale],
		["uncontracted-child", calls.child],
		["repository-observer", calls.repository],
	] as const) {
		await dispatchMaintenanceDue(env, kind, now, [
			{
				orgId: "orchard",
				objectId: "one",
				kind,
				dueAt: "",
				status: "pending",
				leaseUntil: "",
			},
			{
				orgId: "river",
				objectId: "two",
				kind,
				dueAt: "",
				status: "pending",
				leaseUntil: "",
			},
			{
				orgId: "orchard",
				objectId: "three",
				kind,
				dueAt: "",
				status: "pending",
				leaseUntil: "",
			},
		]);
		expect(call).toHaveBeenCalledTimes(2);
		for (const [index, scope] of [
			{ orgId: "orchard", ids: ["one", "three"] },
			{ orgId: "river", ids: ["two"] },
		].entries()) {
			const args = call.mock.calls[index] as unknown[];
			expect(args.at(-1)).toEqual(
				kind === "lane-stale" || kind === "repository-observer"
					? scope
					: {
							now: new Date(now).toISOString(),
							limit: scope.ids.length,
							scope,
						},
			);
		}
	}
});
