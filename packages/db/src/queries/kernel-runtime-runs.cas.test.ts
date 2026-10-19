import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { kernelRuntimeRuns } from "../schema/cognitive-runtime";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	compareAndTouchKernelRuntimeRun,
	getKernelRuntimeRun,
	transitionKernelRuntimeRunStatus,
} from "./kernel-runtime-runs";

const READ_AT = "2026-09-26T10:00:01.000Z";

async function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(kernelRuntimeRuns));
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(kernelRuntimeRuns).values({
		id: "run-1",
		organizationId: "org-1",
		conversationId: "home:main",
		status: "requires_approval",
		createdAt: "2026-09-26T10:00:00.000Z",
		updatedAt: READ_AT,
	});
	return db;
}

describe("guarded Home run transitions", () => {
	it("does not close an approval that another resolver has touched", async () => {
		const db = await setup();
		await compareAndTouchKernelRuntimeRun(db, {
			id: "run-1",
			organizationId: "org-1",
			status: "requires_approval",
			expectedUpdatedAt: READ_AT,
			updatedAt: "2026-09-26T10:00:02.000Z",
		});
		expect(
			await transitionKernelRuntimeRunStatus(db, {
				id: "run-1",
				organizationId: "org-1",
				fromStatus: "requires_approval",
				expectedUpdatedAt: READ_AT,
				patch: { status: "failed" },
			}),
		).toBe(false);
		expect((await getKernelRuntimeRun(db, { id: "run-1" }))?.status).toBe(
			"requires_approval",
		);
	});
	it("closes the matching snapshot once and keeps the organization boundary", async () => {
		const db = await setup();
		const close = (organizationId: string) =>
			transitionKernelRuntimeRunStatus(db, {
				id: "run-1",
				organizationId,
				fromStatus: "requires_approval",
				expectedUpdatedAt: READ_AT,
				patch: { status: "failed" },
			});
		expect(await close("org-2")).toBe(false);
		expect(await close("org-1")).toBe(true);
		expect(await close("org-1")).toBe(false);
	});
	it("lets exactly one resolver holding the same read win", async () => {
		const db = await setup();
		const claim = (updatedAt: string) =>
			compareAndTouchKernelRuntimeRun(db, {
				id: "run-1",
				organizationId: "org-1",
				status: "requires_approval",
				expectedUpdatedAt: READ_AT,
				updatedAt,
			});
		expect(await claim("2026-09-26T10:00:02.000Z")).toBe(true);
		expect(await claim("2026-09-26T10:00:03.000Z")).toBe(false);
		expect((await getKernelRuntimeRun(db, { id: "run-1" }))?.updatedAt).toBe(
			"2026-09-26T10:00:02.000Z",
		);
	});

	it("refuses a run whose status or organization changed", async () => {
		const db = await setup();
		expect(
			await compareAndTouchKernelRuntimeRun(db, {
				id: "run-1",
				organizationId: "org-1",
				status: "queued",
				expectedUpdatedAt: READ_AT,
				updatedAt: "2026-09-26T10:00:02.000Z",
			}),
		).toBe(false);
		expect(
			await compareAndTouchKernelRuntimeRun(db, {
				id: "run-1",
				organizationId: "org-2",
				status: "requires_approval",
				expectedUpdatedAt: READ_AT,
				updatedAt: "2026-09-26T10:00:02.000Z",
			}),
		).toBe(false);
	});
});
