import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { tediApprovalRequests } from "../schema/approvals";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { listApprovalRequests } from "./approvals";

it("keeps another person's runtime approvals out of the personal Deck, even for an administrator", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(schemaDdl(tediApprovalRequests));
	sqlite.exec(`
		CREATE TABLE tedis(id TEXT, organization_id TEXT, scope TEXT, owner_user_id TEXT);
		CREATE TABLE kernel_conversations(organization_id TEXT, conversation_id TEXT, workspace_id TEXT);
		CREATE TABLE kernel_conversation_grants(organization_id TEXT, conversation_id TEXT, grantee_descope_user_id TEXT);
		CREATE TABLE kernel_runtime_runs(id TEXT, organization_id TEXT, conversation_id TEXT);
		CREATE TABLE os_workspaces(id TEXT, organization_id TEXT, visibility TEXT, owner_user_id TEXT);
		INSERT INTO tedis VALUES('luz-tedi','org','personal','luz'),('river-tedi','org','personal','river'),('shared-tedi','org','organization',NULL);
		INSERT INTO kernel_conversations VALUES('org','private-chat','river-space'),('org','luz-chat','luz-space');
		INSERT INTO kernel_conversation_grants VALUES('org','private-chat','river'),('org','luz-chat','luz');
		INSERT INTO kernel_runtime_runs VALUES('private-run','org','private-chat');
		INSERT INTO os_workspaces VALUES('river-space','org','private','river'),('luz-space','org','private','luz');
	`);
	const insert = sqlite.prepare(
		"INSERT INTO tedi_approval_requests(id,tedi_id,org_id,action_type,description,payload,created_at,expires_at) VALUES(?,?,'org','custom',?,?,?,?)",
	);
	for (const [id, tediId, payload] of [
		["own", "luz-tedi", {}],
		["other", "river-tedi", {}],
		["shared", "shared-tedi", {}],
		["private-home", "shared-tedi", { homeConversationId: "private-chat" }],
		["private-run", "shared-tedi", { homeRunId: "private-run" }],
		["private-workspace", "shared-tedi", { workspaceId: "river-space" }],
		["own-home", "shared-tedi", { homeConversationId: "luz-chat" }],
	] as const)
		insert.run(
			id,
			tediId,
			id,
			JSON.stringify(payload),
			"2026-10-18T01:00:00Z",
			"2026-10-19T01:00:00Z",
		);
	const db = createDbClient(createD1Facade(sqlite));
	try {
		const first = await listApprovalRequests(db, {
			orgId: "org",
			viewerUserId: "luz",
			status: "pending",
			limit: 2,
		});
		const second = await listApprovalRequests(db, {
			orgId: "org",
			viewerUserId: "luz",
			status: "pending",
			limit: 2,
			offset: 2,
		});
		expect(first.total).toBe(3);
		expect([...first.data, ...second.data].map((row) => row.id).sort()).toEqual(
			["own", "own-home", "shared"],
		);
		expect(
			(
				await listApprovalRequests(db, {
					orgId: "foreign-org",
					viewerUserId: "luz",
				})
			).data,
		).toEqual([]);
		expect(
			(await listApprovalRequests(db, { viewerUserId: "luz" })).data,
		).toEqual([]);
	} finally {
		sqlite.close();
	}
});
