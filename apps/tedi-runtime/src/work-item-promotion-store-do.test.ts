import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { promoteWorkItems } from "./brain/task-bridge";
import { DoWorkItemPromotionStore } from "./work-item-promotion-store-do";

const db = new Database(":memory:");
const runner = {
	sql<T>(
		strings: TemplateStringsArray,
		...values: (string | number | boolean | null)[]
	): T[] {
		return db.query(strings.join("?")).all(...values) as T[];
	},
};
const originalNow = Date.now;
let now = Date.parse("2026-10-21T23:59:00Z");
Date.now = () => now;
try {
	let store = new DoWorkItemPromotionStore(runner);
	let creates = 0;
	let failCreate = false;
	const platform = {
		async createWorkItem({ title }: { title: string }) {
			creates++;
			if (failCreate) throw new Error("uncertain RPC result");
			return { id: `work-${creates}`, title };
		},
	} as Parameters<typeof promoteWorkItems>[0]["platform"];
	const promote = (runId: string, sessionKey: string, index: number) =>
		promoteWorkItems({
			platform,
			store,
			runId,
			sessionKey,
			taskIntents: [
				{
					title: `Follow up ${index}`,
					kind: "follow_up",
					source: "observer",
					confidence: 0.9,
					requiresConfirmation: false,
					ownerHint: "self",
					evidence: [],
				},
			],
			logger: { log() {}, warn() {} },
		});

	// Concurrent passes and distinct sessions still share the run's three slots.
	const burst = await Promise.all(
		Array.from({ length: 12 }, (_, i) => promote("run-1", `session-${i}`, i)),
	);
	assert.equal(
		burst.reduce((n, r) => n + r.promoted, 0),
		3,
	);
	assert.equal(creates, 3);
	store = new DoWorkItemPromotionStore(runner);
	assert.equal((await promote("run-1", "restarted", 20)).deferred, 1);

	// Midnight and new run/session identities do not reset the rolling day.
	now += 2 * 60 * 1000;
	for (let i = 0; i < 17; i++) await promote(`run-${i + 2}`, `new-${i}`, i);
	assert.equal(creates, 20);
	assert.equal((await promote("overflow", "another-session", 50)).deferred, 1);
	now += 24 * 60 * 60 * 1000 + 1;
	assert.equal((await promote("next-day", "next-session", 51)).promoted, 1);
	assert.equal((await promote("run-1", "old-run", 52)).deferred, 1);

	// Uncertain writes consume reservations even when no dedup ref was saved.
	failCreate = true;
	for (let i = 0; i < 6; i++)
		await promote("failing-run", "failure-session", i);
	assert.equal(creates, 24);
	assert.equal((await promote("failing-run", "retry", 60)).deferred, 1);
	const before = creates;
	const failedStore = {
		has: async () => false,
		add: async () => {},
		reservePromotion: async () => {
			throw new Error("storage unavailable");
		},
	};
	await promoteWorkItems({
		platform,
		store: failedStore,
		sessionKey: "broken",
		runId: "broken",
		taskIntents: [
			{
				title: "No write",
				kind: "issue",
				source: "observer",
				confidence: 1,
				requiresConfirmation: false,
				evidence: [],
			},
		],
		logger: { log() {}, warn() {} },
	});
	assert.equal(creates, before);
	console.log(
		"Work promotion reservations: run/day bounds, restart, concurrency and uncertain writes passed",
	);
} finally {
	Date.now = originalNow;
}
