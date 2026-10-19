import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { workEvents } from "@tedix/db/schema/work-items";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { canonicalWorkFactoryDdl, schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	createWorkItem,
	getWorkItemById,
} from "@tedix/db/queries/work-items/crud";
import type { BaseContext } from "../../orpc";
import { describe, expect, it } from "vite-plus/test";
import {
	workItemSpecificationActor,
	assertSpecificationContributorGrant,
} from "./specification-policy";
import { updateSpecificationProcedure } from "./factory-lifecycle";
import { addCommentProcedure } from "./lifecycle-marketing";

const id = "11111111-1111-4111-8111-111111111111";
async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		canonicalWorkFactoryDdl() + schemaDdl(organizationMembers, workEvents),
	);
	sqlite.exec(`INSERT INTO organizations(id,name,slug) VALUES('org','Org','org');
		INSERT INTO projects(id,org_id,key,name,metadata,created_at) VALUES('project','org','P','Project','{}','2026-10-19');
		INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,role,status) VALUES('m','org','subject','member','member@example.test','member','active');`);
	const db = createDbClient(createD1Facade(sqlite));
	const item = await createWorkItem(db, {
		id,
		orgId: "org",
		title: "Task",
		projectId: "project",
		createdBy: { type: "user", id: "member" },
		createdAt: "2026-10-19T00:00:00Z",
	});
	const context = {
		db,
		organizationId: "org",
		authType: "user",
		user: { sub: "subject" },
		headers: new Headers(),
	} as BaseContext;
	return { sqlite, db, item, context };
}

describe("member specification policy", () => {
	it("records ordinary comments without entering specification authorization, and denies explicit delegation", async () => {
		const { context, sqlite } = await fixture();
		const post = (input: {
			id: string;
			body: string;
			requestDelegation?: boolean;
		}) =>
			addCommentProcedure["~orpc"].handler!({
				context,
				input,
				path: [],
				procedure: addCommentProcedure,
				signal: undefined,
				lastEventId: undefined,
			});
		const body = "Delegated to Codex yesterday; no assignment requested here.";
		await expect(post({ id, body })).resolves.toMatchObject({
			body,
			authorType: "user",
			authorId: "member",
		});
		await expect(
			post({ id, body, requestDelegation: true }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(
			sqlite.prepare("SELECT metadata FROM work_items WHERE id=?").get(id),
		).toMatchObject({ metadata: "{}" });
		await expect(post({ id: "missing", body })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		sqlite.exec("UPDATE organization_members SET status='deactivated'");
		await expect(post({ id, body })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
	it("uses trusted creation attribution and persists an allowed edit with the version fence", async () => {
		const { context, db, item } = await fixture();
		const input = {
			id,
			title: "Edited",
			description: "Details",
			priority: "high" as const,
			expectedWorkItemVersion: item.version,
		};
		expect(await workItemSpecificationActor(context, item, input)).toEqual({
			type: "user",
			id: "member",
		});
		await updateSpecificationProcedure["~orpc"].handler!({
			context,
			input,
			path: [],
			procedure: updateSpecificationProcedure,
			signal: undefined,
			lastEventId: undefined,
		});
		expect(await getWorkItemById(db, id, "org")).toMatchObject({
			title: "Edited",
			description: "Details",
			priority: "high",
		});
		await expect(
			updateSpecificationProcedure["~orpc"].handler!({
				context,
				input,
				path: [],
				procedure: updateSpecificationProcedure,
				signal: undefined,
				lastEventId: undefined,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
	it.each([
		"riskLevel",
		"requiredAuthorities",
		"requiredCapabilities",
		"accountableOwnerId",
		"stewardId",
		"executor",
		"laneDispatch",
		"budgets",
		"reviewerId",
		"acceptanceContract",
		"disposition",
		"completion",
		"workClass",
		"dueDate",
		"addEvidenceKinds",
	])("denies reserved field %s even to the creator", async (field) => {
		const { context, item } = await fixture();
		await expect(
			workItemSpecificationActor(context, item, { id, [field]: "change" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("allows the assignee and explicit project contributor, but denies metadata spoofing and revoked grants", async () => {
		const { context, sqlite, item } = await fixture();
		sqlite.exec("DELETE FROM work_events");
		await expect(
			workItemSpecificationActor(
				context,
				{ ...item, metadata: { createdBy: "member", contributor: true } },
				{ id, title: "x" },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(
			await workItemSpecificationActor(
				context,
				{ ...item, accountableOwnerType: "user", accountableOwnerId: "member" },
				{ id, title: "x" },
			),
		).toMatchObject({ id: "member" });
		sqlite.prepare("UPDATE projects SET metadata=?").run(
			JSON.stringify({
				workSpecificationContributors: { version: 1, userIds: ["member"] },
			}),
		);
		expect(
			await workItemSpecificationActor(context, item, { id, title: "x" }),
		).toMatchObject({ id: "member" });
		sqlite.exec("UPDATE projects SET metadata='{}'");
		await expect(
			workItemSpecificationActor(context, item, { id, title: "x" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("denies inactive, viewer and foreign-organization identities", async () => {
		const { context, sqlite, item } = await fixture();
		await expect(
			workItemSpecificationActor(
				{ ...context, organizationId: "foreign" },
				item,
				{ id, title: "x" },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		sqlite.exec("UPDATE organization_members SET role='viewer'");
		await expect(
			workItemSpecificationActor(context, item, { id, title: "x" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		sqlite.exec("UPDATE organization_members SET status='deactivated'");
		await expect(
			workItemSpecificationActor(context, item, { id, title: "x" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("only lets active owners/admins install contributor grants", async () => {
		const { context, sqlite } = await fixture();
		const grant = { version: 1, userIds: ["member"] };
		await expect(
			assertSpecificationContributorGrant(context, "org", undefined, grant),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		sqlite.exec("UPDATE organization_members SET role='owner'");
		await expect(
			assertSpecificationContributorGrant(context, "org", undefined, grant),
		).resolves.toBeUndefined();
		await expect(
			assertSpecificationContributorGrant(context, "org", undefined, {
				version: 2,
				userIds: ["member"],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});
