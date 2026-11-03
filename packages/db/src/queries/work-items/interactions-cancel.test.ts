import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { cancelWorkInteraction } from "./interactions";

const now = "2026-11-03T17:00:00.000Z";

// Build the migration template before timing lifecycle operations.
createMigratedSqlite({ foreignKeys: false }).close();

function fixture() {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	sqlite.exec(`INSERT INTO organizations(id,name,slug) VALUES ('org','Org','org');
		INSERT INTO projects(id,org_id,key,name,created_at) VALUES ('project','org','P','Project','${now}');
		INSERT INTO work_items(id,org_id,project_id,title,created_at,disposition,admission_spec_revision) VALUES ('work','org','project','Work','${now}','accepted','revision-1');
		INSERT INTO organization_members(id,organization_id,user_id,descope_user_id,email,status) VALUES
			('m-person','org','person','person','person@example.test','active'),
			('m-other','org','other','other','other@example.test','active');
		INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at,metadata)
		VALUES ('ask','org','work','question','Sign in','Run the sign-in','system','tedix','user','person','${now}','{}');`);
	const db = createDbQueryClient(createD1Facade(sqlite));
	const cancel = (
		actorId: string,
		options: { expectedVersion?: number; actorIsAdmin?: boolean } = {},
	) =>
		cancelWorkInteraction(db, {
			orgId: "org",
			interactionId: "ask",
			expectedVersion: options.expectedVersion ?? 1,
			actor: { type: "user", id: actorId },
			actorIsAdmin: options.actorIsAdmin,
			now,
		});
	return { sqlite, cancel };
}

it("lets the person a question asks withdraw it", async () => {
	const { sqlite, cancel } = fixture();
	try {
		await expect(cancel("person")).resolves.toMatchObject({
			status: "cancelled",
		});
	} finally {
		sqlite.close();
	}
});

it("refuses anyone else unless they are an owner or admin", async () => {
	const { sqlite, cancel } = fixture();
	try {
		await expect(cancel("other")).rejects.toMatchObject({
			message: expect.stringContaining("only its creator, the one it asks"),
		});
		await expect(
			cancel("other", { actorIsAdmin: true }),
		).resolves.toMatchObject({ status: "cancelled" });
	} finally {
		sqlite.close();
	}
});

it("says when the question changed or is already closed", async () => {
	const { sqlite, cancel } = fixture();
	try {
		await expect(
			cancel("person", { expectedVersion: 7 }),
		).rejects.toMatchObject({ message: expect.stringContaining("changed") });
		await cancel("person");
		await expect(
			cancel("person", { expectedVersion: 2 }),
		).rejects.toMatchObject({
			message: "CONFLICT: Interaction is already cancelled",
		});
	} finally {
		sqlite.close();
	}
});
