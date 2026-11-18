import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { osOutputs } from "../../schema/os-workspaces";
import { workspaceOutputIndex } from "../../schema/workspace-feed";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	countArchivedOsOutputPurgeCandidates,
	listArchivedOsOutputPurgeCandidateIds,
} from "./archived-purge";

function indexed(outputId: string, revision = 1) {
	return {
		id: `${outputId}:${revision}`,
		organizationId: "org-1",
		workspaceId: "ws-1",
		outputId,
		revision,
		revisionId: `${outputId}-r${revision}`,
		isCurrent: 1,
		outputKind: "document" as const,
		title: outputId,
		status: "archived" as const,
		outputCreatedByKind: "user" as const,
		outputCreatedById: "u-1",
		outputCreatedAt: "2026-10-01T00:00:00.000Z",
		revisionCreatedByKind: "user" as const,
		revisionCreatedById: "u-1",
		revisionCreatedAt: "2026-10-01T00:00:00.000Z",
		updatedAt: "2026-10-02T00:00:00.000Z",
	};
}

describe("archived output purge candidates", () => {
	let sqlite: DatabaseSync;
	let db: ReturnType<typeof createDbQueryClient>;
	beforeEach(() => {
		sqlite = new DatabaseSync(":memory:");
		sqlite.exec(
			"CREATE TABLE organizations (id TEXT PRIMARY KEY); INSERT INTO organizations VALUES ('org-1'), ('org-2');",
		);
		sqlite.exec(schemaDdl(workspaceOutputIndex));
		db = createDbQueryClient(createD1Facade(sqlite));
	});
	afterEach(() => sqlite.close());

	it("pages and counts current archived index rows without shared document tables", async () => {
		for (const row of [
			indexed("b"),
			indexed("a"),
			indexed("c"),
			{ ...indexed("active"), status: "active" as const },
			{ ...indexed("retired"), isCurrent: 0 },
			{ ...indexed("foreign"), organizationId: "org-2" },
		])
			await db.insert(workspaceOutputIndex).values(row);
		const scope = { organizationId: "org-1" };
		expect(
			await listArchivedOsOutputPurgeCandidateIds(db, { ...scope, limit: 2 }),
		).toEqual(["a", "b"]);
		expect(await countArchivedOsOutputPurgeCandidates(db, scope)).toBe(3);
		const next = { ...scope, afterId: "b" };
		expect(
			await listArchivedOsOutputPurgeCandidateIds(db, { ...next, limit: 2 }),
		).toEqual(["c"]);
		expect(await countArchivedOsOutputPurgeCandidates(db, next)).toBe(1);
		expect(
			await countArchivedOsOutputPurgeCandidates(db, {
				...scope,
				afterId: "z",
			}),
		).toBe(0);
	});

	it("applies the same exclusive time cutoff to listing and counting", async () => {
		await db
			.insert(workspaceOutputIndex)
			.values([
				indexed("before"),
				{ ...indexed("equal"), updatedAt: "2026-10-03T00:00:00.000Z" },
				{ ...indexed("after"), updatedAt: "2026-10-04T00:00:00.000Z" },
			]);
		const scope = {
			organizationId: "org-1",
			archivedBefore: "2026-10-03T00:00:00.000Z",
		};
		expect(
			await listArchivedOsOutputPurgeCandidateIds(db, { ...scope, limit: 10 }),
		).toEqual(["before"]);
		expect(await countArchivedOsOutputPurgeCandidates(db, scope)).toBe(1);
	});

	it("ignores shared-only rows and stale shared status, and deduplicates indexed ids", async () => {
		sqlite.exec(schemaDdl(osOutputs));
		await db.insert(osOutputs).values({
			id: "shared-only",
			organizationId: "org-1",
			kind: "document",
			title: "Legacy",
			status: "archived",
			createdByKind: "user",
			createdById: "u-1",
		});
		await db
			.insert(workspaceOutputIndex)
			.values([
				indexed("indexed"),
				indexed("indexed", 2),
				{ ...indexed("shared-only"), status: "active" },
			]);
		const scope = { organizationId: "org-1" };
		expect(
			await listArchivedOsOutputPurgeCandidateIds(db, { ...scope, limit: 10 }),
		).toEqual(["indexed"]);
		expect(await countArchivedOsOutputPurgeCandidates(db, scope)).toBe(1);
	});
});
