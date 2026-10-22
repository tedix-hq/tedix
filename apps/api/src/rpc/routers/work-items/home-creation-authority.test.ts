import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { workEvents } from "@tedix/db/schema/work-items";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { canonicalWorkFactoryDdl, schemaDdl } from "@tedix/db/test/schema-ddl";
import { CreateWorkItemInputSchema } from "@tedix/api-contract/schemas/work-items";
import type { BaseContext } from "../../orpc";
import { afterEach, expect, it } from "vite-plus/test";
import { createProcedure } from "./creation-reads";
import { workItemSpecificationActor } from "./specification-policy";
import { updateSpecificationProcedure } from "./factory-lifecycle";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import { applyInboundTrustHeaderHygiene } from "@tedix/worker-kit/request-auth";

const org = "11111111-1111-4111-8111-111111111111";
const project = "22222222-2222-4222-8222-222222222222";
const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		canonicalWorkFactoryDdl() + schemaDdl(organizationMembers, workEvents),
	);
	sqlite.exec(`INSERT INTO organizations(id,name,slug) VALUES('${org}','Example','example');
		INSERT INTO projects(id,org_id,key,name,status,metadata,created_at) VALUES('${project}','${org}','P','Project','active','{}','2026-10-19');
		INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,role,status) VALUES('m','${org}','subject','member','member@example.test','member','active');`);
	const db = createDbClient(createD1Facade(sqlite));
	const context = {
		db,
		organizationId: org,
		authType: "service-binding",
		descopeUserId: "subject",
		headers: new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Kernel": "true",
			"X-Tedix-Acting-User": "subject",
		}),
	} as BaseContext;
	return { sqlite, db, context };
}

async function create(context: BaseContext) {
	return createProcedure["~orpc"].handler!({
		context,
		input: CreateWorkItemInputSchema.parse({
			title: "Fictional Home task",
			projectId: project,
			workClass: "hygiene",
			purposeExceptionExpiresAt: new Date(
				Date.now() + 86_400_000,
			).toISOString(),
		}),
		path: [],
		procedure: createProcedure,
		signal: undefined,
		lastEventId: undefined,
	});
}

it.each(["subject", "member"])(
	"records the initiating member (%s) in the creation ledger and permits their subsequent bounded edit",
	async (subject) => {
		const { context, sqlite, db } = fixture();
		context.headers.set("X-Tedix-Acting-User", subject);
		context.descopeUserId = subject;
		const item = await create(context);
		expect(
			sqlite
				.prepare(
					"SELECT actor_type,actor_id FROM work_events WHERE work_item_id=? AND event_type='work.created'",
				)
				.get(item.id),
		).toEqual({ actor_type: "user", actor_id: "member" });
		const member = {
			...context,
			authType: "user" as const,
			user: { sub: "subject" },
			headers: new Headers(),
		} as BaseContext;
		const input = {
			id: item.id,
			description: "Verified member update",
			expectedWorkItemVersion: item.version,
		};
		await updateSpecificationProcedure["~orpc"].handler!({
			context: member,
			input,
			path: [],
			procedure: updateSpecificationProcedure,
			signal: undefined,
			lastEventId: undefined,
		});
		expect((await getWorkItemById(db, item.id, org))?.description).toBe(
			input.description,
		);
		await expect(
			workItemSpecificationActor(
				{ ...member, user: { sub: "stranger" } } as BaseContext,
				item,
				input,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	},
);

it.each(["deactivated", "foreign", "viewer"])(
	"does not create a Work under a %s member claim",
	async (state) => {
		const { context, sqlite } = fixture();
		if (state === "deactivated")
			sqlite.exec("UPDATE organization_members SET status='deactivated'");
		if (state === "foreign")
			sqlite.exec("UPDATE organization_members SET organization_id='foreign'");
		if (state === "viewer")
			sqlite.exec("UPDATE organization_members SET role='viewer'");
		await expect(create(context)).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(
			sqlite.prepare("SELECT count(*) AS count FROM work_items").get(),
		).toEqual({ count: 0 });
	},
);

it("keeps a directly authenticated member as creator despite forged acting-user headers", async () => {
	const { context, sqlite } = fixture();
	context.authType = "user";
	context.user = { sub: "subject" } as NonNullable<BaseContext["user"]>;
	context.headers.set("X-Tedix-Acting-User", "someone-else");
	const item = await create(context);
	expect(
		sqlite
			.prepare(
				"SELECT actor_id FROM work_events WHERE work_item_id=? AND event_type='work.created'",
			)
			.get(item.id),
	).toEqual({ actor_id: "member" });
});

it("rejects conflicting trusted creator claims before writing", async () => {
	const { context, sqlite } = fixture();
	context.descopeUserId = "another-subject";
	await expect(create(context)).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect(
		sqlite.prepare("SELECT count(*) AS count FROM work_items").get(),
	).toEqual({ count: 0 });
});

it.each(["apikey", "tedi", "unmarked", "public"])(
	"does not manufacture member ownership from a %s acting-user claim",
	async (principal) => {
		const { context, sqlite } = fixture();
		if (principal === "apikey") context.authType = "apikey";
		if (principal === "tedi") context.tediId = "fictional-tedi";
		if (principal === "unmarked") context.headers.delete("X-Tedix-Kernel");
		if (principal === "public")
			applyInboundTrustHeaderHygiene(context.headers, false);
		const item = await create(context);
		expect(
			sqlite
				.prepare(
					"SELECT count(*) AS count FROM work_events WHERE work_item_id=? AND actor_type='user'",
				)
				.get(item.id),
		).toEqual({ count: 0 });
		const member = {
			...context,
			authType: "user" as const,
			user: { sub: "subject" },
			tediId: undefined,
			headers: new Headers(),
		} as BaseContext;
		await expect(
			workItemSpecificationActor(member, item, {
				id: item.id,
				description: "Unowned edit",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	},
);
