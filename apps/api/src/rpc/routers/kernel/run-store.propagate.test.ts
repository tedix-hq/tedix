import { describe, expect, it } from "vite-plus/test";
import { propagateSweptChildFailureToHomeRun } from "./run-store";

/**
 * Chainable Drizzle-shaped mock: `select().from().where().limit()` resolves the
 * seeded run row; `update().set()` captures the patch; `insert().values()`
 * captures event rows. Every other chain link returns the same builder.
 */
function makeDb(row: Record<string, unknown> | undefined) {
	const patches: Array<Record<string, unknown>> = [];
	const events: Array<Record<string, unknown>> = [];
	const builder = (terminal: () => unknown): unknown => {
		const chain: Record<string, unknown> = {};
		const handler: ProxyHandler<Record<string, unknown>> = {
			get(_target, prop) {
				if (prop === "then") {
					const value = terminal();
					return (resolve: (v: unknown) => void) => resolve(value);
				}
				if (prop === "limit") return () => Promise.resolve(terminal());
				if (prop === "returning") return () => Promise.resolve(terminal());
				return (...args: unknown[]) => {
					if (prop === "set" && args[0] && typeof args[0] === "object") {
						patches.push(args[0] as Record<string, unknown>);
					}
					if (prop === "values" && args[0] && typeof args[0] === "object") {
						events.push(args[0] as Record<string, unknown>);
					}
					return proxy;
				};
			},
		};
		const proxy = new Proxy(chain, handler);
		return proxy;
	};
	const db = {
		select: () => builder(() => (row ? [row] : [])),
		update: () => builder(() => undefined),
		insert: () => builder(() => (events.length ? [events.at(-1)] : [])),
	};
	return { db, patches, events };
}

const CHILD = {
	organizationId: "org-1",
	delegatedTediId: "tedi-cto",
	childRunId: "tedi-cto:mcp:home-1_auto_tedi-cto",
	message:
		"Runtime dropped before emitting a terminal event. Auto-failed by orphan sweep.",
	failedAt: "2026-09-01T10:00:00.000Z",
};

function homeRow(status: string) {
	return {
		id: "home-1",
		organizationId: "org-1",
		conversationId: "home:main",
		status,
		delegatedTediId: "tedi-cto",
		childRunId: CHILD.childRunId,
		metadata: { childConversationId: "agent:cto:x", source: "test" },
		preview: null,
		latestEventAt: null,
		createdAt: "2026-08-31T10:00:00.000Z",
		updatedAt: "2026-08-31T10:00:00.000Z",
	};
}

describe("propagateSweptChildFailureToHomeRun", () => {
	it("drives a still-running parent Home run terminal through the failure path", async () => {
		const { db, patches, events } = makeDb(homeRow("running"));
		const propagated = await propagateSweptChildFailureToHomeRun(
			{ db } as never,
			CHILD,
		);
		expect(propagated).toBe(true);
		expect(patches[0]).toMatchObject({
			status: "failed",
			completedAt: CHILD.failedAt,
			metadata: expect.objectContaining({
				childRunStatus: "failed",
				delegationFailure: expect.objectContaining({
					reason: "runtime_unavailable",
					error: CHILD.message,
				}),
			}),
		});
		const eventKinds = events
			.map((event) => event.kind)
			.filter((kind): kind is string => typeof kind === "string");
		expect(eventKinds).toEqual(["run.failed", "message.completed"]);
		expect(events[0]).toMatchObject({
			runId: "home-1",
			childRunId: CHILD.childRunId,
			payload: expect.objectContaining({ reason: "runtime_unavailable" }),
		});
	});

	it("is a no-op for an already-terminal parent or a child with no Home run", async () => {
		const done = makeDb(homeRow("completed"));
		expect(
			await propagateSweptChildFailureToHomeRun(
				{ db: done.db } as never,
				CHILD,
			),
		).toBe(false);
		expect(done.patches).toHaveLength(0);
		const missing = makeDb(undefined);
		expect(
			await propagateSweptChildFailureToHomeRun(
				{ db: missing.db } as never,
				CHILD,
			),
		).toBe(false);
	});

	it("is fail-soft when the lookup throws", async () => {
		const db = {
			select() {
				throw new Error("D1 unavailable");
			},
		};
		await expect(
			propagateSweptChildFailureToHomeRun({ db } as never, CHILD),
		).resolves.toBe(false);
	});
});
