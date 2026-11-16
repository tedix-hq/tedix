import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { workEvents } from "@tedix/db/schema/work-items";
import { workInteractions } from "@tedix/db/schema/work-factory";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { canonicalWorkFactoryDdl, schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	createWorkItem,
	getWorkItemById,
} from "@tedix/db/queries/work-items/crud";
import type { BaseContext } from "../../orpc";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { assertWorkOperatorGrant } from "./operator-policy";
import {
	workItemAcceptanceActor,
	workItemStewardActor,
	verifiedWorkFactoryMutator,
} from "./policy-helpers";
import {
	acceptProcedure,
	completeProcedure,
	cancelFactoryWorkItemProcedure,
} from "./factory-lifecycle";
import { projectsContractRouter } from "../projects";
import { projectMetadataForUpdate } from "../../../lib/project-metadata";

// Analytics is outside lifecycle authorization and is tested by its own service.
vi.mock("../../../services/learning-interaction-recorder", () => ({
	recordObservedLearningInteraction: vi.fn(),
}));

const id = "11111111-1111-4111-8111-111111111111";
const grant = {
	version: 1,
	userIds: ["member"],
	actions: ["acceptance", "completion", "cancellation"],
};
const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		canonicalWorkFactoryDdl() +
			schemaDdl(organizationMembers, workEvents, workInteractions),
	);
	sqlite.exec(`INSERT INTO organizations(id,name,slug) VALUES('org','Org','org');
		INSERT INTO projects(id,org_id,key,name,metadata,created_at) VALUES('project','org','P','Project','{}','2026-10-19');
		INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,role,status) VALUES('m','org','subject','member','member@example.test','member','active');`);
	const db = createDbClient(createD1Facade(sqlite));
	const item = await createWorkItem(db, {
		id,
		orgId: "org",
		title: "Routine task",
		projectId: "project",
		accountableOwnerType: "user",
		accountableOwnerId: "member",
		createdBy: { type: "user", id: "member" },
		createdAt: "2026-10-19T00:00:00Z",
	});
	const context = {
		db,
		organizationId: "org",
		authType: "user",
		user: { sub: "subject", permissions: ["tedis:update"] },
		headers: new Headers(),
	} as BaseContext;
	const setGrant = (value: unknown = grant) =>
		sqlite
			.prepare("UPDATE projects SET metadata=?")
			.run(JSON.stringify({ workOperators: value }));
	return { sqlite, db, item, context, setGrant };
}
const lifecycleActions = ["acceptance", "completion", "cancellation"] as const;
function authorize(
	context: BaseContext,
	item: Awaited<ReturnType<typeof createWorkItem>>,
	action: (typeof lifecycleActions)[number],
) {
	return action === "acceptance"
		? workItemAcceptanceActor(context, item.orgId, item)
		: workItemStewardActor(context, item, action);
}

describe("project member Work operators", () => {
	it.each(lifecycleActions)(
		"requires explicit %s authority and attributes the member's own identity",
		async (action) => {
			const { context, item, setGrant } = await fixture();
			await expect(authorize(context, item, action)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			setGrant();
			await expect(authorize(context, item, action)).resolves.toEqual({
				type: "user",
				id: "member",
			});
			setGrant({
				...grant,
				actions: grant.actions.filter((value) => value !== action),
			});
			await expect(authorize(context, item, action)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		},
	);
	it.each([
		"no project",
		"other project",
		"other organization",
		"inactive membership",
		"viewer",
		"archived project",
		"paused project",
		"revoked grant",
		"other user",
		"malformed grant",
	])("denies all lifecycle actions: %s", async (boundary) => {
		const { context, item, setGrant, sqlite } = await fixture();
		setGrant();
		if (boundary === "no project") item.projectId = null;
		if (boundary === "other project") item.projectId = "other";
		if (boundary === "other organization") context.organizationId = "other";
		if (boundary === "inactive membership")
			sqlite.exec("UPDATE organization_members SET status='deactivated'");
		if (boundary === "viewer")
			sqlite.exec("UPDATE organization_members SET role='viewer'");
		if (boundary === "archived project")
			sqlite.exec("UPDATE projects SET status='archived'");
		if (boundary === "paused project")
			sqlite.exec("UPDATE projects SET status='paused'");
		if (boundary === "revoked grant") setGrant(null);
		if (boundary === "other user") setGrant({ ...grant, userIds: ["other"] });
		if (boundary === "malformed grant") setGrant({ ...grant, actions: ["*"] });
		for (const action of lifecycleActions)
			await expect(authorize(context, item, action)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
	});
	it.each(["owner", "admin"])(
		"preserves %s lifecycle and factory authority without project grants",
		async (role) => {
			const { context, item, sqlite } = await fixture();
			sqlite.prepare("UPDATE organization_members SET role=?").run(role);
			item.projectId = null;
			for (const action of lifecycleActions)
				await expect(authorize(context, item, action)).resolves.toMatchObject({
					type: "user",
					id: "member",
				});
			await expect(
				verifiedWorkFactoryMutator(context, "org"),
			).resolves.toMatchObject({ id: "member" });
		},
	);
	it("does not delegate specification governance, factory mutation or grant management", async () => {
		const { context, item, setGrant } = await fixture();
		setGrant();
		await expect(
			workItemStewardActor(context, item, "specification"),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			verifiedWorkFactoryMutator(context, "org"),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			assertWorkOperatorGrant(context, "org", null, grant),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("does not let machine credentials use or issue human member grants", async () => {
		const { context, item, setGrant, sqlite } = await fixture();
		setGrant();
		context.authType = "apikey";
		for (const action of lifecycleActions)
			await expect(authorize(context, item, action)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		sqlite.exec("UPDATE organization_members SET role='owner'");
		await expect(
			assertWorkOperatorGrant(context, "org", null, grant),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it.each(["complete", "cancel"] as const)(
		"keeps active Attempt protection on member %s",
		async (finish) => {
			const { context, db, sqlite, setGrant } = await fixture();
			setGrant();
			sqlite.exec(`UPDATE work_items SET disposition='accepted';
			INSERT INTO work_attempts(id,work_item_id,org_id,executor_type,executor_id,runtime_state,attempt_number,started_at,heartbeat_at)
			VALUES('attempt','${id}','org','user','other','running',1,'2026-11-16','2026-11-16');`);
			const procedure =
				finish === "complete"
					? completeProcedure
					: cancelFactoryWorkItemProcedure;
			await expect(
				procedure["~orpc"].handler!({
					context,
					input: { id },
					path: [],
					procedure,
					signal: undefined,
					lastEventId: undefined,
				}),
			).rejects.toMatchObject({ code: "CONFLICT" });
			expect(await getWorkItemById(db, id, "org")).toMatchObject({
				disposition: "accepted",
			});
		},
	);
	it("reserves delegation and revocation to active owners, validates policy and preserves omitted grants", async () => {
		const { context, sqlite } = await fixture();
		for (const role of ["member", "admin"]) {
			sqlite.prepare("UPDATE organization_members SET role=?").run(role);
			for (const [oldValue, newValue] of [
				[undefined, grant],
				[grant, null],
			])
				await expect(
					assertWorkOperatorGrant(context, "org", oldValue, newValue),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
		sqlite.exec("UPDATE organization_members SET role='owner'");
		await expect(
			assertWorkOperatorGrant(context, "org", null, grant),
		).resolves.toBeUndefined();
		await expect(
			assertWorkOperatorGrant(context, "org", grant, null),
		).resolves.toBeUndefined();
		await expect(
			assertWorkOperatorGrant(context, "org", null, {
				...grant,
				actions: ["approve"],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(
			projectMetadataForUpdate({ workOperators: grant }, { label: "new" }),
		).toEqual({ workOperators: grant, label: "new" });
		expect(
			projectMetadataForUpdate(
				{ workOperators: grant },
				{ workOperators: null },
			),
		).toEqual({ workOperators: null });
		sqlite.exec("UPDATE organization_members SET status='deactivated'");
		await expect(
			assertWorkOperatorGrant(context, "org", null, grant),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("enforces delegation through project create and update handlers", async () => {
		const { context, sqlite, setGrant } = await fixture();
		const update = projectsContractRouter.update;
		const create = projectsContractRouter.create;
		await expect(
			update["~orpc"].handler!({
				context,
				input: { id: "project", metadata: { workOperators: grant } },
				path: [],
				procedure: update,
				signal: undefined,
				lastEventId: undefined,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			create["~orpc"].handler!({
				context,
				input: { key: "New", name: "New", metadata: { workOperators: grant } },
				path: [],
				procedure: create,
				signal: undefined,
				lastEventId: undefined,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		sqlite.exec("UPDATE organization_members SET role='owner'");
		await expect(
			update["~orpc"].handler!({
				context,
				input: { id: "project", metadata: { workOperators: grant } },
				path: [],
				procedure: update,
				signal: undefined,
				lastEventId: undefined,
			}),
		).resolves.toMatchObject({ metadata: { workOperators: grant } });
		sqlite.exec("UPDATE organization_members SET role='member'");
		setGrant();
		await expect(
			update["~orpc"].handler!({
				context,
				input: { id: "project", metadata: { workOperators: null } },
				path: [],
				procedure: update,
				signal: undefined,
				lastEventId: undefined,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it.each(["complete", "cancel"] as const)(
		"persists member acceptance and %s with member attribution",
		async (finish) => {
			const { context, db, setGrant, sqlite } = await fixture();
			setGrant();
			await expect(
				acceptProcedure["~orpc"].handler!({
					context,
					input: {
						id,
						acceptanceContract: {
							version: 1,
							doneLooksLike: "Routine task done",
						},
					},
					path: [],
					procedure: acceptProcedure,
					signal: undefined,
					lastEventId: undefined,
				}),
			).resolves.toMatchObject({ disposition: "accepted" });
			const procedure =
				finish === "complete"
					? completeProcedure
					: cancelFactoryWorkItemProcedure;
			await expect(
				procedure["~orpc"].handler!({
					context,
					input: { id },
					path: [],
					procedure,
					signal: undefined,
					lastEventId: undefined,
				}),
			).resolves.toMatchObject({
				disposition: finish === "complete" ? "completed" : "cancelled",
			});
			expect(await getWorkItemById(db, id, "org")).toMatchObject({
				disposition: finish === "complete" ? "completed" : "cancelled",
			});
			expect(
				sqlite
					.prepare(
						"SELECT actor_type, actor_id FROM work_events WHERE event_type IN ('work.accepted','work.completed','work.cancelled')",
					)
					.all(),
			).toEqual([
				{ actor_type: "user", actor_id: "member" },
				{ actor_type: "user", actor_id: "member" },
			]);
		},
	);
});
