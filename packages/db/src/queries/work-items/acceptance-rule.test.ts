import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import {
	workAttempts,
	workEvents,
	workItemComments,
	workItems,
} from "../../schema/work-items";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { missingForAcceptance } from "./acceptance-rule";
import { acceptWorkItem } from "./crud";

function seeded(rows: Array<[string, string | null, string | null]>) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(schemaDdl(workItems, workEvents, workAttempts, workItemComments));
	for (const [id, projectId, ownerId] of rows)
		sqlite
			.prepare(
				"INSERT INTO work_items(id,org_id,title,created_at,project_id,accountable_owner_type,accountable_owner_id) VALUES(?,?,?,?,?,?,?)",
			)
			.run(
				id,
				"org-acme",
				"Fictional ask",
				"2026-11-15T00:00:00.000Z",
				projectId,
				ownerId ? "user" : null,
				ownerId,
			);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}

const accept = (
	db: ReturnType<typeof seeded>["db"],
	workItemId: string,
	doneLooksLike: string,
	systemEnvelope?: boolean,
) =>
	acceptWorkItem(db, {
		orgId: "org-acme",
		workItemId,
		actor: { type: "user", id: "fictional-owner" },
		acceptanceContract: { version: 1, doneLooksLike },
		systemEnvelope,
	});

it("names each thing a proposal still lacks", () => {
	expect(
		missingForAcceptance({ projectId: null, accountableOwnerId: null }, null),
	).toEqual([
		"a project",
		"a statement of what done looks like",
		"an accountable owner",
	]);
	expect(
		missingForAcceptance(
			{ projectId: "project", accountableOwnerId: "owner" },
			{ doneLooksLike: "Shipped" },
		),
	).toEqual([]);
});

it("refuses to accept a proposal without a project, a done-when or an owner", async () => {
	const { sqlite, db } = seeded([
		["no-project", null, "fictional-owner"],
		["no-owner", "project", null],
		["complete", "project", "fictional-owner"],
	]);
	await expect(accept(db, "no-project", "Shipped")).rejects.toThrow(
		/ACCEPTANCE_REQUIRED: .*Missing: a project\./,
	);
	await expect(accept(db, "no-owner", "Shipped")).rejects.toThrow(
		/Missing: an accountable owner\./,
	);
	await expect(accept(db, "complete", "  ")).rejects.toThrow(
		/Missing: a statement of what done looks like\./,
	);
	expect(
		sqlite
			.prepare("SELECT count(*) AS n FROM work_items WHERE disposition<>?")
			.get("proposed")?.n,
	).toBe(0);
	const accepted = await accept(db, "complete", "Shipped");
	expect(accepted.disposition).toBe("accepted");
	sqlite.close();
});

it("lets Home accept its own delegation wrapper before a project is known, but never without an owner", async () => {
	const { sqlite, db } = seeded([
		["wrapper", null, "fictional-tedi"],
		["ownerless", null, null],
	]);
	expect((await accept(db, "wrapper", "Settled", true)).disposition).toBe(
		"accepted",
	);
	await expect(accept(db, "ownerless", "Settled", true)).rejects.toThrow(
		/Missing: an accountable owner\./,
	);
	sqlite.close();
});
