import { describe, expect, it } from "vite-plus/test";
import {
	blockerRecoveryMessage,
	decideBlockerRecovery,
	pickRerouteTarget,
	type RerouteCandidate,
} from "./delegation-blocker-recovery";

const operator: RerouteCandidate = {
	tediId: "tedi-reddit",
	name: "Reddit Operator",
	availability: "running",
	hasRepository: false,
	apps: ["reddit"],
};
const coder: RerouteCandidate = {
	tediId: "tedi-cto",
	name: "CTO",
	availability: "running",
	hasRepository: true,
	apps: ["github"],
	webSearch: true,
};
const asleep: RerouteCandidate = {
	...coder,
	tediId: "tedi-zzz",
	availability: "sleeping",
};

const repoBlocker = {
	kind: "missing_repository" as const,
	detail: "no repository is connected for this worker yet.",
	source: "declared" as const,
};

describe("decideBlockerRecovery", () => {
	it("re-routes a missing repository to a running tedi that has one", () => {
		expect(
			decideBlockerRecovery({
				blocker: repoBlocker,
				recoveryHints: ["reroute_to_home"],
				retryCount: 0,
				currentTediId: operator.tediId,
				tediName: operator.name,
				candidates: [operator, asleep, coder],
			}),
		).toEqual({ action: "reroute", tediId: "tedi-cto", tediName: "CTO" });
	});

	it("asks exactly one question naming the thing to connect when nobody can cover the gap", () => {
		expect(
			decideBlockerRecovery({
				blocker: repoBlocker,
				recoveryHints: ["reroute_to_home"],
				retryCount: 0,
				currentTediId: operator.tediId,
				tediName: operator.name,
				candidates: [operator, asleep],
			}),
		).toEqual({
			action: "ask",
			question:
				"I can't do this yet: no repository is connected for this worker yet. Can you connect the repository Reddit Operator should work in?",
		});
	});

	it("retries a transient fault once, then asks", () => {
		const blocker = {
			kind: "transient" as const,
			detail: "the page did not load in time.",
			source: "declared" as const,
		};
		const base = {
			blocker,
			recoveryHints: ["redispatch_same_work_order" as const],
			currentTediId: operator.tediId,
			tediName: operator.name,
			candidates: [operator, coder],
		};
		expect(decideBlockerRecovery({ ...base, retryCount: 0 })).toEqual({
			action: "retry",
		});
		expect(decideBlockerRecovery({ ...base, retryCount: 1 })).toMatchObject({
			action: "ask",
			question: expect.stringContaining("a second try did not help"),
		});
	});

	it("never re-routes an access gap: access is granted per worker, so it asks", () => {
		const blocker = {
			kind: "missing_access" as const,
			detail: "I am not allowed to read the shared mailbox.",
			source: "declared" as const,
		};
		expect(
			pickRerouteTarget({
				blocker,
				currentTediId: operator.tediId,
				candidates: [coder],
			}),
		).toBeNull();
		expect(
			decideBlockerRecovery({
				blocker,
				recoveryHints: ["reroute_to_home"],
				retryCount: 0,
				currentTediId: operator.tediId,
				tediName: operator.name,
				candidates: [coder],
			}),
		).toEqual({
			action: "ask",
			question:
				"I can't do this yet: i am not allowed to read the shared mailbox. Can you allow Reddit Operator access to it?",
		});
	});

	it("matches a capability gap by connected app slug or web search", () => {
		const blocker = {
			kind: "missing_capability" as const,
			detail: "I have no way to search the web for the latest version.",
			source: "declared" as const,
		};
		expect(
			pickRerouteTarget({
				blocker,
				currentTediId: operator.tediId,
				candidates: [operator, coder],
			}),
		).toBe(coder);
		expect(
			pickRerouteTarget({
				blocker: {
					...blocker,
					detail: "the github app is not connected for me.",
				},
				currentTediId: operator.tediId,
				candidates: [operator, coder],
			}),
		).toBe(coder);
	});

	it("writes one plain sentence per decision, with no tool names", () => {
		expect(
			blockerRecoveryMessage({
				decision: { action: "reroute", tediId: "tedi-cto", tediName: "CTO" },
				blocker: repoBlocker,
				tediName: "Reddit Operator",
			}),
		).toBe(
			"Reddit Operator couldn't do this: no repository is connected for this worker yet. I've handed it to CTO, who has what's needed.",
		);
		expect(
			blockerRecoveryMessage({
				decision: { action: "retry" },
				blocker: {
					kind: "transient",
					detail: "The page timed out.",
					source: "declared",
				},
				tediName: "Reddit Operator",
			}),
		).toBe(
			"Reddit Operator hit a temporary problem: the page timed out. Trying once more.",
		);
	});
});
