import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { kernelRuntimeRuns } from "../schema/cognitive-runtime";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { countActiveDelegatedRunsByTedi } from "./kernel-runtime-runs";

describe("live delegated load", () => {
	it("counts only fresh queued or running delegations in the organization", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = OFF");
		sqlite.exec(schemaDdl(kernelRuntimeRuns));
		const db = createDbClient(createD1Facade(sqlite));
		const fresh = "2026-10-21T12:00:00.000Z";
		const row = (
			id: string,
			fields: Partial<typeof kernelRuntimeRuns.$inferInsert>,
		) => ({
			id,
			organizationId: "org-globex",
			conversationId: "home:main",
			status: "running" as const,
			delegatedTediId: "tedi-builder",
			updatedAt: fresh,
			...fields,
		});
		await db.insert(kernelRuntimeRuns).values([
			row("run-1", {}),
			row("run-2", { status: "queued" }),
			// SQLite CURRENT_TIMESTAMP spelling of a fresh row still counts.
			row("run-3", { updatedAt: "2026-10-21 11:30:00" }),
			row("run-4", { delegatedTediId: "tedi-reviewer" }),
			row("run-5", { status: "completed" }),
			row("run-6", { status: "requires_approval" }),
			row("run-7", { updatedAt: "2026-10-20T01:00:00.000Z" }),
			row("run-8", { organizationId: "org-initech" }),
			row("run-9", { delegatedTediId: null }),
		]);
		const load = await countActiveDelegatedRunsByTedi(db, {
			organizationId: "org-globex",
			updatedSince: "2026-10-21T06:00:00.000Z",
		});
		expect(Object.fromEntries(load)).toEqual({
			"tedi-builder": 3,
			"tedi-reviewer": 1,
		});
	});
});
