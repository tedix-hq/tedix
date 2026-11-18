import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { osOutputs } from "../../schema/os-workspaces";
import { workspaceOutputIndex } from "../../schema/workspace-feed";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { getWorkspaceOutputLocation } from "./read";

const params = { organizationId: "org-1", outputId: "out-1" };

function indexRow(revision: number, workspaceId: string, isCurrent = 0) {
	return {
		id: `out-1:${revision}`,
		...params,
		workspaceId,
		revision,
		revisionId: `rev-${revision}`,
		isCurrent,
		outputKind: "document" as const,
		title: "Plan",
		status: "active" as const,
		outputCreatedByKind: "user" as const,
		outputCreatedById: "user-1",
		outputCreatedAt: "2026-11-07",
		revisionCreatedByKind: "user" as const,
		revisionCreatedById: "user-1",
		revisionCreatedAt: "2026-11-07",
		updatedAt: "2026-11-07",
	};
}

describe("getWorkspaceOutputLocation", () => {
	let sqlite: DatabaseSync;
	let db: ReturnType<typeof createDbQueryClient>;

	beforeEach(() => {
		sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = OFF");
		sqlite.exec(schemaDdl(workspaceOutputIndex));
		db = createDbQueryClient(createD1Facade(sqlite));
	});

	afterEach(() => sqlite.close());

	it("returns undefined for a missing index entry without a shared table", async () => {
		expect(await getWorkspaceOutputLocation(db, params)).toBeUndefined();
	});

	it("ignores a shared-only output", async () => {
		sqlite.exec(schemaDdl(osOutputs));
		await db.insert(osOutputs).values({
			id: params.outputId,
			organizationId: params.organizationId,
			workspaceId: "shared-ws",
			kind: "document",
			title: "Shared plan",
			status: "active",
			currentRevisionId: "shared-rev",
			createdByKind: "user",
			createdById: "user-1",
			createdAt: "2026-11-07",
			updatedAt: "2026-11-07",
		});
		expect(await getWorkspaceOutputLocation(db, params)).toBeUndefined();
	});

	it("prefers a current index entry over a higher retired revision", async () => {
		await db
			.insert(workspaceOutputIndex)
			.values([indexRow(1, "current-ws", 1), indexRow(2, "retired-ws")]);
		expect(await getWorkspaceOutputLocation(db, params)).toEqual({
			workspaceId: "current-ws",
		});
	});

	it("locates a retired output using its latest indexed revision", async () => {
		await db
			.insert(workspaceOutputIndex)
			.values([indexRow(1, "old-ws"), indexRow(2, "latest-ws")]);
		expect(await getWorkspaceOutputLocation(db, params)).toEqual({
			workspaceId: "latest-ws",
		});
	});

	it("does not locate another organization's output", async () => {
		await db
			.insert(workspaceOutputIndex)
			.values({ ...indexRow(1, "other-ws", 1), organizationId: "org-2" });
		expect(await getWorkspaceOutputLocation(db, params)).toBeUndefined();
	});

	it("does not locate a different output in the same organization", async () => {
		await db
			.insert(workspaceOutputIndex)
			.values({ ...indexRow(1, "other-ws", 1), outputId: "out-2" });
		expect(await getWorkspaceOutputLocation(db, params)).toBeUndefined();
	});
});
