import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { createDbClient } from "../client";
import { kernelRuntimeRuns } from "../schema/cognitive-runtime";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	readLatestRunAwaitingApproval,
	readLatestRunAwaitingDelegationApproval,
} from "./kernel-runtime-runs";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(kernelRuntimeRuns));
	const db = createDbClient(createD1Facade(sqlite));
	const row = (
		id: string,
		overrides: Partial<typeof kernelRuntimeRuns.$inferInsert> = {},
	) => ({
		id,
		organizationId: "org-fixture",
		conversationId: "home:main",
		status: "requires_approval" as const,
		createdAt: "2026-10-21T18:00:00.000Z",
		updatedAt: "2026-10-21T18:00:00.000Z",
		...overrides,
	});
	const target = {
		organizationId: "org-fixture",
		conversationId: "home:main",
		excludeRunId: "current",
	};
	return { db, row, target };
}

const delegation = {
	homeDelegation: {
		decision: { mode: "needs_approval" },
		workOrder: { targetTediId: "worker" },
	},
};

describe("conversation pending approval lookups", () => {
	it("finds parked cards behind more than five newer completed replies", async () => {
		const { db, row, target } = fixture();
		await db.insert(kernelRuntimeRuns).values([
			row("write", { metadata: { approvalRequestId: "approval-1" } }),
			row("delegation", { metadata: delegation }),
			...Array.from({ length: 8 }, (_, index) =>
				row(`reply-${index}`, {
					status: "completed",
					updatedAt: "2026-10-21T18:05:00.000Z",
				}),
			),
		]);
		expect(await readLatestRunAwaitingApproval(db, target)).toEqual({
			runId: "write",
			approvalRequestId: "approval-1",
		});
		expect(
			(await readLatestRunAwaitingDelegationApproval(db, target))?.id,
		).toBe("delegation");
	});

	it("finds the requested worker behind another pending delegation", async () => {
		const { db, row, target } = fixture();
		await db.insert(kernelRuntimeRuns).values([
			row("worker-card", { metadata: delegation }),
			row("newer-card", {
				updatedAt: "2026-10-21T18:05:00.000Z",
				metadata: {
					homeDelegation: {
						...delegation.homeDelegation,
						workOrder: { targetTediId: "other-worker" },
					},
				},
			}),
		]);
		expect(
			(
				await readLatestRunAwaitingDelegationApproval(db, {
					...target,
					targetTediId: "worker",
				})
			)?.id,
		).toBe("worker-card");
		expect(
			await readLatestRunAwaitingDelegationApproval(db, {
				...target,
				targetTediId: "missing",
			}),
		).toBeNull();
	});

	it("filters tenant, conversation, caller run and malformed or resolved targets before limiting", async () => {
		const { db, row, target } = fixture();
		const newer = { updatedAt: "2026-10-21T18:05:00.000Z" };
		await db.insert(kernelRuntimeRuns).values([
			row("write-a", { metadata: { approvalRequestId: "approval-a" } }),
			row("write-z", { metadata: { approvalRequestId: "approval-z" } }),
			row("delegation-a", { metadata: delegation }),
			row("delegation-z", { metadata: delegation }),
			row("other-org", {
				...newer,
				organizationId: "org-other",
				metadata: { ...delegation, approvalRequestId: "other" },
			}),
			row("other-conversation", {
				...newer,
				conversationId: "home:other",
				metadata: { ...delegation, approvalRequestId: "other" },
			}),
			row("current", {
				...newer,
				metadata: { ...delegation, approvalRequestId: "current" },
			}),
			row("invalid-write", {
				...newer,
				metadata: { approvalRequestId: 123 },
			}),
			row("empty-write", { ...newer, metadata: { approvalRequestId: "" } }),
			row("invalid-delegation", {
				...newer,
				metadata: {
					homeDelegation: {
						decision: { mode: "needs_approval" },
						workOrder: {},
					},
				},
			}),
			row("resolved-delegation", {
				...newer,
				metadata: {
					homeDelegation: {
						...delegation.homeDelegation,
						resolutionStatus: "approved",
					},
				},
			}),
			row("already-dispatched", {
				...newer,
				childRunId: "child",
				metadata: delegation,
			}),
		]);
		expect(await readLatestRunAwaitingApproval(db, target)).toEqual({
			runId: "write-z",
			approvalRequestId: "approval-z",
		});
		expect(
			(await readLatestRunAwaitingDelegationApproval(db, target))?.id,
		).toBe("delegation-z");
	});
});
