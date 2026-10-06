/**
 * Unit tests for the promotion commitment gate + budget (promotion-runaway bound).
 *
 * Covers, in isolation from the runtime/DO:
 *   - classifyTaskIntent: confident-but-speculative -> working_memory; confident
 *     + actionable (owner / date / kind) -> external_candidate.
 *   - promoteWorkItems: per-turn budget (top-N by confidence), per-session cap
 *     via an injected counting store, and the burst class (no promotion).
 *   - stableIntentKey: kind-independent + title-normalized dedup.
 */

import type { TaskIntent } from "@tedix/context-core/types";
import { describe, expect, it } from "bun:test";
import {
	classifyTaskIntent,
	promoteWorkItems,
	resolveIntentInstant,
	stableIntentKey,
	type WorkItemPromotionRef,
	type WorkItemPromotionStore,
} from "./task-bridge.js";

function intent(overrides: Partial<TaskIntent>): TaskIntent {
	return {
		title: "Do a thing",
		kind: "follow_up",
		source: "observer",
		confidence: 0.9,
		requiresConfirmation: false,
		evidence: [],
		...overrides,
	};
}

// In-memory store that satisfies WorkItemPromotionStore (incl. countForSession).
function makeStore(): WorkItemPromotionStore & { count(): number } {
	const keys = new Set<string>();
	const bySession = new Map<string, number>();
	return {
		count: () => keys.size,
		has: async (k) => keys.has(k),
		add: async (k, _ref: WorkItemPromotionRef, sessionKey?: string) => {
			keys.add(k);
			if (sessionKey)
				bySession.set(sessionKey, (bySession.get(sessionKey) ?? 0) + 1);
		},
		countForSession: async (sessionKey) => bySession.get(sessionKey) ?? 0,
	};
}

function makePlatform() {
	const calls: { title: string }[] = [];
	let n = 0;
	const platform = {
		createWorkItem: async (params: {
			title: string;
			sourceIntentId?: string;
		}) => {
			calls.push({ title: params.title });
			return {
				id: `wi-${++n}`,
				title: params.title,
				sourceIntentId: params.sourceIntentId,
			};
		},
		// This deliberately partial platform object is a test double.
	} as any;
	return { platform, calls };
}

describe("classifyTaskIntent commitment gate", () => {
	it("confident speculation with no owner/date -> working_memory", () => {
		expect(
			classifyTaskIntent(intent({ confidence: 0.95, kind: "follow_up" }))
				.action,
		).toBe("working_memory");
		expect(
			classifyTaskIntent(intent({ confidence: 0.95, kind: "candidate" }))
				.action,
		).toBe("working_memory");
		expect(
			classifyTaskIntent(intent({ confidence: 0.95, kind: "delegation" }))
				.action,
		).toBe("working_memory");
	});

	it("confident + ownerHint -> external_candidate", () => {
		expect(
			classifyTaskIntent(intent({ confidence: 0.9, ownerHint: "cto" })).action,
		).toBe("external_candidate");
	});

	it("confident + deadlineHint or dueHint -> external_candidate", () => {
		expect(
			classifyTaskIntent(intent({ confidence: 0.9, deadlineHint: "Friday" }))
				.action,
		).toBe("external_candidate");
		expect(
			classifyTaskIntent(intent({ confidence: 0.9, dueHint: "2026-07-01" }))
				.action,
		).toBe("external_candidate");
	});

	it("kind deadline/blocker/issue -> external_candidate even without owner/date", () => {
		for (const kind of ["deadline", "blocker", "issue"] as const) {
			expect(classifyTaskIntent(intent({ confidence: 0.9, kind })).action).toBe(
				"external_candidate",
			);
		}
	});

	it("self-owned genuine commitment (ownerHint='self') -> external_candidate", () => {
		// A genuine first-person commitment the Observer guard canonicalized to
		// ownerHint="self": confident, confirmed, owned -> promotes. Boolean("self")
		// is truthy, so the existing commitment gate treats it as actionable with
		// ZERO downstream change.
		expect(
			classifyTaskIntent(
				intent({
					title: "Refactor the auth module",
					confidence: 0.8,
					requiresConfirmation: false,
					ownerHint: "self",
				}),
			).action,
		).toBe("external_candidate");
	});

	it("stripped procedural self-talk (ownerHint undefined) -> working_memory", () => {
		// A procedural self-intent whose self-owner the parser guard stripped:
		// no owner, no date, speculative kind -> degrades to memory exactly as a
		// non-self speculative candidate does. Locks the no-op claim.
		for (const kind of ["candidate", "follow_up"] as const) {
			expect(
				classifyTaskIntent(
					intent({
						title: "Inspect latest deploy run",
						confidence: 0.95,
						requiresConfirmation: false,
						kind,
						ownerHint: undefined,
					}),
				).action,
			).toBe("working_memory");
		}
	});

	it("keeps prior thresholds: low confidence / unconfirmed never reach the gate", () => {
		expect(
			classifyTaskIntent(intent({ confidence: 0.2, ownerHint: "cto" })).action,
		).toBe("ignore");
		expect(
			classifyTaskIntent(
				intent({
					confidence: 0.9,
					requiresConfirmation: true,
					ownerHint: "cto",
				}),
			).action,
		).toBe("working_memory");
	});
});

describe("promoteWorkItems budget", () => {
	it("per-turn budget promotes only the top-N by confidence", async () => {
		const store = makeStore();
		const { platform, calls } = makePlatform();
		const result = await promoteWorkItems({
			taskIntents: [
				intent({ title: "A", confidence: 0.7, ownerHint: "cto" }),
				intent({ title: "B", confidence: 0.99, ownerHint: "cto" }),
				intent({ title: "C", confidence: 0.8, ownerHint: "cto" }),
				intent({ title: "D", confidence: 0.95, ownerHint: "cto" }),
				intent({ title: "E", confidence: 0.85, ownerHint: "cto" }),
			],
			platform,
			store,
			sessionKey: "agent:main:main",
		});
		expect(result.promoted).toBe(3);
		expect(result.deferred).toBe(2);
		expect(calls.map((c) => c.title).sort()).toEqual(["B", "D", "E"]);
	});

	it("per-session cap bounds promotions across many turns", async () => {
		const store = makeStore();
		const { platform, calls } = makePlatform();
		let total = 0;
		for (let turn = 0; turn < 10; turn++) {
			const r = await promoteWorkItems({
				taskIntents: [
					intent({ title: `T${turn}-A`, confidence: 0.9, ownerHint: "cto" }),
					intent({ title: `T${turn}-B`, confidence: 0.9, ownerHint: "cto" }),
				],
				platform,
				store,
				sessionKey: "agent:main:main",
				maxPromotionsPerTurn: 5,
				sessionCap: 5,
			});
			total += r.promoted;
		}
		expect(total).toBe(5);
		expect(calls.length).toBe(5);
	});

	it("burst class: 24 high-confidence speculative candidates -> 0 promoted", async () => {
		const store = makeStore();
		const { platform, calls } = makePlatform();
		let total = 0;
		for (let turn = 0; turn < 8; turn++) {
			const r = await promoteWorkItems({
				taskIntents: [
					intent({
						title: `smoke test ${turn}`,
						confidence: 0.92,
						kind: "follow_up",
					}),
					intent({
						title: `add a fallback ${turn}`,
						confidence: 0.98,
						kind: "candidate",
					}),
					intent({
						title: `delegate later ${turn}`,
						confidence: 0.9,
						kind: "delegation",
					}),
				],
				platform,
				store,
				sessionKey: "agent:main:main",
			});
			total += r.promoted;
		}
		expect(total).toBe(0);
		expect(calls.length).toBe(0);
	});

	it("no over-correction: a single genuinely-actionable intent still promotes", async () => {
		const store = makeStore();
		const { platform, calls } = makePlatform();
		const result = await promoteWorkItems({
			taskIntents: [
				intent({
					title: "Ship the migration",
					confidence: 0.9,
					ownerHint: "cto",
				}),
			],
			platform,
			store,
			sessionKey: "agent:main:main",
		});
		expect(result.promoted).toBe(1);
		expect(result.deferred).toBe(0);
		expect(calls.map((c) => c.title)).toEqual(["Ship the migration"]);
	});

	it("a confirmed delegation intent WITH an owner promotes (commitment, not kind, gates)", async () => {
		const store = makeStore();
		const { platform, calls } = makePlatform();
		const result = await promoteWorkItems({
			taskIntents: [
				// speculative delegation, no owner/date -> NOT promoted
				intent({
					title: "delegate later",
					confidence: 0.98,
					kind: "delegation",
				}),
				// confirmed delegation WITH an owner -> promoted
				intent({
					title: "delegate the migration",
					confidence: 0.9,
					kind: "delegation",
					ownerHint: "cto",
				}),
			],
			platform,
			store,
			sessionKey: "agent:main:main",
		});
		expect(result.promoted).toBe(1);
		expect(calls.map((c) => c.title)).toEqual(["delegate the migration"]);
	});

	it("idempotent: re-running the same turn promotes 0 the second time (store.has gate)", async () => {
		const store = makeStore();
		const { platform, calls } = makePlatform();
		const intents = [
			intent({ title: "Run smoke test", confidence: 0.9, ownerHint: "cto" }),
		];
		const first = await promoteWorkItems({
			taskIntents: intents,
			platform,
			store,
			sessionKey: "agent:main:main",
		});
		const second = await promoteWorkItems({
			taskIntents: intents,
			platform,
			store,
			sessionKey: "agent:main:main",
		});
		expect(first.promoted).toBe(1);
		expect(second.promoted).toBe(0);
		expect(calls.length).toBe(1);
	});

	it("fails soft to per-turn cap when countForSession throws", async () => {
		const base = makeStore();
		const store: WorkItemPromotionStore = {
			...base,
			countForSession: async () => {
				throw new Error("count unavailable");
			},
		};
		const { platform, calls } = makePlatform();
		const r = await promoteWorkItems({
			taskIntents: [
				intent({ title: "A", confidence: 0.9, ownerHint: "cto" }),
				intent({ title: "B", confidence: 0.9, ownerHint: "cto" }),
			],
			platform,
			store,
			sessionKey: "agent:main:main",
		});
		// Per-turn cap still applies (both within budget) -> both promote.
		expect(r.promoted).toBe(2);
		expect(calls.length).toBe(2);
	});
});

describe("stableIntentKey dedup", () => {
	it("is kind-independent (restated task collapses)", () => {
		const a = stableIntentKey(
			intent({ title: "Run smoke test", kind: "follow_up" }),
			"s",
		);
		const b = stableIntentKey(
			intent({ title: "Run smoke test", kind: "candidate" }),
			"s",
		);
		expect(a).toBe(b);
	});

	it("normalizes title: case, whitespace, trailing punctuation", () => {
		const a = stableIntentKey(intent({ title: "Run smoke test" }), "s");
		const b = stableIntentKey(intent({ title: "  run   SMOKE  test.  " }), "s");
		expect(a).toBe(b);
	});

	it("still distinguishes genuinely different titles", () => {
		const a = stableIntentKey(intent({ title: "Ship the migration" }), "s");
		const b = stableIntentKey(intent({ title: "Run smoke test" }), "s");
		expect(a).not.toBe(b);
	});
});

describe("resolveIntentInstant", () => {
	it("canonicalizes a resolvable hint to an ISO-8601 instant", () => {
		expect(resolveIntentInstant("2026-08-26T09:00:00.000Z")).toBe(
			"2026-08-26T09:00:00.000Z",
		);
		expect(resolveIntentInstant("2026-05-31 15:42 UTC")).toBe(
			"2026-05-31T15:42:00.000Z",
		);
	});

	it("drops every free-text hint the observer actually produced", () => {
		for (const hint of [
			"today",
			"Today",
			"now",
			"immediately",
			"daily",
			"Friday",
			"regular Friday meeting",
			"next scheduled cycle",
			"after verified writes",
			"within 90 seconds of the echo send",
			"~10 minutes of wall clock",
			"",
			"   ",
			undefined,
		]) {
			expect(resolveIntentInstant(hint)).toBeUndefined();
		}
	});
});

describe("promoteWorkItems date handling", () => {
	function makeCapturingPlatform() {
		const created: Record<string, unknown>[] = [];
		let n = 0;
		const platform = {
			createWorkItem: async (params: Record<string, unknown>) => {
				created.push(params);
				return {
					id: `wi-${++n}`,
					title: params.title,
					sourceIntentId: params.sourceIntentId,
				};
				// Deliberately partial test double.
			},
		} as any;
		return { platform, created };
	}

	it("never sends a free-text hint as dueDate/deadline, and keeps it in metadata", async () => {
		const { platform, created } = makeCapturingPlatform();
		await promoteWorkItems({
			taskIntents: [
				intent({
					title: "Finish the echo smoke",
					kind: "deadline",
					dueHint: "today",
					deadlineHint: "within 90 seconds of the echo send",
				}),
			],
			platform,
			store: makeStore(),
			sessionKey: "s-free-text",
		});
		expect(created).toHaveLength(1);
		expect(created[0]?.dueDate).toBeUndefined();
		expect(created[0]?.deadline).toBeUndefined();
		const metadata = created[0]?.metadata as Record<string, unknown>;
		expect(metadata.dueHint).toBe("today");
		expect(metadata.deadlineHint).toBe("within 90 seconds of the echo send");
	});

	it("still forwards a resolvable hint as a canonical instant", async () => {
		const { platform, created } = makeCapturingPlatform();
		await promoteWorkItems({
			taskIntents: [
				intent({
					title: "Ship before the cutoff",
					kind: "deadline",
					dueHint: "2026-08-26T09:00:00Z",
					deadlineHint: "2026-08-27 12:00 UTC",
				}),
			],
			platform,
			store: makeStore(),
			sessionKey: "s-instants",
		});
		expect(created[0]?.dueDate).toBe("2026-08-26T09:00:00.000Z");
		expect(created[0]?.deadline).toBe("2026-08-27T12:00:00.000Z");
	});
});
