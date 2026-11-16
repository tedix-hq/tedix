import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { kernelRuntimeRuns } from "../schema/cognitive-runtime";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	claimUnroutedKernelRunForRedrive,
	getKernelRunForRecovery,
} from "./kernel-do-storage";

type RunValues = Partial<typeof kernelRuntimeRuns.$inferInsert>;

async function setup(values: RunValues = {}) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(kernelRuntimeRuns));
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(kernelRuntimeRuns).values({
		id: "run-1",
		organizationId: "org-1",
		conversationId: "home:main",
		status: "running",
		metadata: { kernelRoute: null },
		...values,
	});
	return db;
}

function claim(
	db: Awaited<ReturnType<typeof setup>>,
	organizationId = "org-1",
) {
	return claimUnroutedKernelRunForRedrive(db, {
		id: "run-1",
		organizationId,
		expectedStatus: "running",
		patch: {
			updatedAt: "2026-11-16T22:00:00.000Z",
			metadata: { kernelRoute: null, redriveCount: 1 },
		},
	});
}

async function metadataOf(db: Awaited<ReturnType<typeof setup>>) {
	const run = await getKernelRunForRecovery(db, {
		id: "run-1",
		organizationId: "org-1",
	});
	return run?.metadata ?? null;
}

describe("claiming an unrouted Home run for a re-drive", () => {
	it("claims a running run whose route marker is null, inside its organization only", async () => {
		const db = await setup();
		expect(await claim(db, "org-2")).toBe(false);
		expect(await metadataOf(db)).toEqual({ kernelRoute: null });
		expect(await claim(db)).toBe(true);
		expect(await metadataOf(db)).toEqual({
			kernelRoute: null,
			redriveCount: 1,
		});
	});

	const refused: Array<[string, RunValues]> = [
		["was routed", { metadata: { kernelRoute: { kind: "delegate" } } }],
		["has no route marker", { metadata: { other: true } }],
		["has no metadata", { metadata: null }],
		["has a delegated tedi", { delegatedTediId: "tedi-1" }],
		["has a child run", { childRunId: "child-1" }],
		[
			"recorded a delegation decision",
			{ metadata: { kernelRoute: null, homeDelegation: { status: "held" } } },
		],
		["is waiting for approval", { status: "requires_approval" }],
		["completed", { status: "completed" }],
		["was canceled", { status: "canceled" }],
	];
	for (const [name, values] of refused) {
		it(`refuses a run that ${name} and leaves its row unchanged`, async () => {
			const db = await setup(values);
			const before = await metadataOf(db);
			expect(await claim(db)).toBe(false);
			expect(await metadataOf(db)).toEqual(before);
		});
	}
});
