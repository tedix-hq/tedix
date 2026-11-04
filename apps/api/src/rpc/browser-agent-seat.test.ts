import { DatabaseSync } from "node:sqlite";
import { call, os } from "@orpc/server";
import { eq } from "drizzle-orm";
import { createDbClient } from "@tedix/db/client";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { suspendBrowserAgentSeat } from "@tedix/db/queries/organization-members";
import { organizations } from "@tedix/db/schema/organizations";
import { projects } from "@tedix/db/schema/projects";
import { tediObjectives } from "@tedix/db/schema/tedi-objectives";
import { tedis } from "@tedix/db/schema/tedis";
import { auditEvents } from "@tedix/db/schema/audit-events";
import {
	kernelRuntimeEvents,
	kernelConversations,
} from "@tedix/db/schema/cognitive-runtime";
import {
	workItems,
	workAttempts,
	workItemComments,
	workEvents,
} from "@tedix/db/schema/work-items";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { addWorkItemComment } from "@tedix/db/queries/work-items/comments";
import { toJsonRecord } from "@tedix/db/utils/json";
import { describe, expect, it } from "vite-plus/test";
import { auditActor, emitAuditEvent } from "./audit-helpers";
import { bindBrowserAgentSeat } from "./browser-agent-seat";
import {
	AUTHZ,
	withAuth,
	withPermission,
	userHoldsPermission,
	type BaseContext,
} from "./orpc";
import { verifiedWorkItemCommentAuthor } from "./routers/work-items-principal";
import { insertKernelRuntimeEvent } from "./routers/kernel/run-store";
import { defaultHomeConversationIdForCaller } from "./routers/kernel/conversation-origin";
import { normalizeHomeMessage } from "./routers/kernel-runtime/policy-normalization";
import { resolveCreator } from "./routers/os-workspaces-shared";

const now = "2026-10-01T12:00:00.000Z";
async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		schemaDdl(
			organizations,
			organizationMembers,
			projects,
			tediObjectives,
			tedis,
			auditEvents,
			kernelRuntimeEvents,
			kernelConversations,
			workItems,
			workAttempts,
			workItemComments,
			workEvents,
		),
	);
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(organizations).values([
		{ id: "team", name: "Fictional team", slug: "fictional" },
		{ id: "other-team", name: "Other team", slug: "other" },
	]);
	await db.insert(organizationMembers).values([
		{
			id: "seat",
			organizationId: "team",
			userId: "juniper",
			descopeUserId: "juniper-provider",
			email: "juniper@example.test",
			name: "Juniper",
			kind: "browser_agent",
			representedUserId: "river",
			role: "member",
			status: "active",
			customPermissions: ["team:manage", "os:approve"],
		},
		{
			id: "owner",
			organizationId: "team",
			userId: "river",
			descopeUserId: "river-provider",
			email: "river@example.test",
			name: "River",
			kind: "human",
			role: "owner",
			status: "active",
		},
	]);
	const context = {
		db,
		authType: "user",
		userId: "juniper",
		organizationId: "team",
		userRole: "member",
		user: {
			sub: "juniper-provider",
			roles: ["admin"],
			permissions: ["team:manage", "os:approve"],
		},
		headers: new Headers(),
		env: {},
		url: new URL("https://api.example.test/rpc/test"),
	} as BaseContext;
	return { db, sqlite, context };
}

describe("browser agent seats", () => {
	it.each([null, "different-user"])(
		"rejects a conflicting or missing canonical login binding: %s",
		async (userId) => {
			const { db, context } = await fixture();
			await db
				.update(organizationMembers)
				.set({ userId })
				.where(eq(organizationMembers.id, "seat"));
			await expect(bindBrowserAgentSeat(context)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			expect(context.browserAgentSeat).toBeUndefined();
		},
	);
	it.each(["team", "approval"])(
		"denies %s management before the handler runs",
		async (operation) => {
			const { context } = await fixture();
			await bindBrowserAgentSeat(context);
			const guard =
				operation === "team" ? withPermission("team:manage") : AUTHZ.osApprove;
			let ran = false;
			const procedure = os
				.$context<BaseContext>()
				.use(withAuth)
				.use(guard)
				.handler(() => {
					ran = true;
				});
			await expect(
				call(procedure, undefined, { context }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(ran).toBe(false);
		},
	);
	it("binds its own login and denies token and override grants above member access", async () => {
		const { context } = await fixture();
		await bindBrowserAgentSeat(context);
		const procedure = os
			.$context<BaseContext>()
			.use(withAuth)
			.handler(({ context }) => context.browserAgentSeat);
		expect(await call(procedure, undefined, { context })).toMatchObject({
			userId: "juniper",
			representedUserId: "river",
			displayName: "Juniper",
		});
		expect(userHoldsPermission(context, "team:manage")).toBe(false);
		expect(userHoldsPermission(context, "os:approve")).toBe(false);
		expect(userHoldsPermission(context, "os:author")).toBe(true);
		expect(defaultHomeConversationIdForCaller(context)).toBe(
			"home:agent:browser-juniper",
		);
		expect(resolveCreator(context)).toEqual({
			kind: "external_agent",
			id: "juniper",
		});
	});

	it("persists agent comments, activity, audit and Home authors without accepting caller attribution", async () => {
		const { db, sqlite, context } = await fixture();
		await bindBrowserAgentSeat(context);
		await db.insert(workItems).values({
			id: "work",
			orgId: "team",
			title: "Fictional work",
			createdAt: now,
		});
		const author = await verifiedWorkItemCommentAuthor(context, "team", {
			browserAgentSeat: { representedUserId: "forged-owner" },
		});
		const comment = await addWorkItemComment(db, {
			id: "comment",
			orgId: "team",
			workItemId: "work",
			authorType: author.authorType,
			authorId: author.authorId,
			body: "Progress",
			metadata: toJsonRecord(author.metadata!),
			recordActivity: true,
			createdAt: now,
		});
		expect(comment).toMatchObject({
			authorType: "external_agent",
			authorId: "juniper",
			metadata: { browserAgentSeat: { representedUserId: "river" } },
		});
		const activity = sqlite
			.prepare("SELECT actor_type, actor_id, payload FROM work_events")
			.get();
		expect(activity).toMatchObject({
			actor_type: "external_agent",
			actor_id: "juniper",
		});
		expect(
			JSON.parse(activity!.payload as string).browserAgentSeat
				.representedUserId,
		).toBe("river");
		const actor = auditActor(context);
		await emitAuditEvent(db, {
			organizationId: "team",
			actorId: actor.actorId,
			actorType: actor.actorType,
			action: "output.updated",
			resourceType: "output",
			metadata: actor.actorMetadata,
		});
		const audit = sqlite
			.prepare("SELECT actor_type, actor_id, metadata FROM audit_events")
			.get();
		expect(audit).toMatchObject({
			actor_type: "external_agent",
			actor_id: "juniper",
		});
		expect(
			JSON.parse(audit!.metadata as string).browserAgentSeat.representedUserId,
		).toBe("river");
		const event = await insertKernelRuntimeEvent(context, {
			organizationId: "team",
			conversationId: "home:seat",
			kind: "message.received",
			messageId: "message",
			payload: {
				role: "user",
				content: "Hello",
				origin: "human",
				author: { id: "forged-owner" },
			},
			createdAt: now,
		});
		expect(event.payload).toMatchObject({
			origin: "agent",
			author: {
				id: "juniper",
				type: "external_agent",
				browserAgentSeat: { representedUserId: "river" },
			},
		});
		const message = normalizeHomeMessage(event, new Map());
		expect(message.metadata?.author).toEqual(event.payload?.author);
		expect(
			sqlite.prepare("SELECT origin FROM kernel_conversations").get(),
		).toMatchObject({ origin: "agent" });
	});

	it("denies a previously authenticated session on the next request after deactivation", async () => {
		const { db, context } = await fixture();
		const procedure = os
			.$context<BaseContext>()
			.use(withAuth)
			.handler(() => "allowed");
		const authenticateRequest = async () => {
			const requestContext = { ...context };
			await bindBrowserAgentSeat(requestContext);
			return call(procedure, undefined, { context: requestContext });
		};
		expect(await authenticateRequest()).toBe("allowed");
		expect(
			await suspendBrowserAgentSeat(db, {
				organizationId: "team",
				memberId: "seat",
				actorUserId: "river",
			}),
		).toMatchObject({ id: "seat", status: "deactivated" });
		await expect(authenticateRequest()).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	it.each(["absent", "seat", "inactive", "agent", "other-org"])(
		"rejects an invalid human owner: %s",
		async (mode) => {
			const { db, context } = await fixture();
			if (mode === "absent" || mode === "seat")
				await db
					.update(organizationMembers)
					.set({ representedUserId: mode === "seat" ? "juniper" : "missing" })
					.where(eq(organizationMembers.id, "seat"));
			else
				await db
					.update(organizationMembers)
					.set(
						mode === "inactive"
							? { status: "deactivated" }
							: mode === "agent"
								? { kind: "external_agent" }
								: { organizationId: "other-team" },
					)
					.where(eq(organizationMembers.id, "owner"));
			await expect(bindBrowserAgentSeat(context)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		},
	);

	it.each(["owner", "admin"] as const)(
		"rejects an elevated %s agent seat",
		async (role) => {
			const { db, context } = await fixture();
			await db
				.update(organizationMembers)
				.set({ role })
				.where(eq(organizationMembers.id, "seat"));
			await expect(bindBrowserAgentSeat(context)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		},
	);

	it("keeps a human login human and cannot select a seat with request headers", async () => {
		const { context } = await fixture();
		context.userId = "river";
		context.user!.sub = "river-provider";
		context.headers.set("X-Tedix-Browser-Agent", "juniper");
		await bindBrowserAgentSeat(context);
		expect(context.browserAgentSeat).toBeUndefined();
		expect(auditActor(context)).toMatchObject({
			actorType: "user",
			actorId: "river",
		});
	});

	it("preserves a legacy agent display label without changing its admin access or interpreting its provider owner id", async () => {
		const { db, context } = await fixture();
		await db
			.update(organizationMembers)
			.set({
				kind: "external_agent",
				role: "admin",
				representedUserId: "river-provider",
			})
			.where(eq(organizationMembers.id, "seat"));
		context.userRole = "admin";
		await bindBrowserAgentSeat(context);
		expect(context.browserAgentSeat).toBeUndefined();
		expect(userHoldsPermission(context, "os:approve")).toBe(true);
		expect(auditActor(context)).toMatchObject({
			actorType: "user",
			actorId: "juniper",
		});
	});
});
