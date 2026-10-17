import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import { apps, appTools } from "@tedix/db/schema";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { personalAccessNeed } from "./os-workspace-schedules";

const GMAIL_SCOPES = [
	"https://www.googleapis.com/auth/gmail.readonly",
	"https://www.googleapis.com/auth/gmail.modify",
];

async function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(apps, appTools));
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(apps).values([
		{
			id: "app-mail",
			organizationId: "org-1",
			name: "Google Gmail",
			slug: "google-gmail",
		},
		{ id: "app-tedix", organizationId: "org-1", name: "Tedix", slug: "tedix" },
		{
			id: "app-calendar",
			organizationId: "org-1",
			name: "Calendar",
			slug: "google-calendar",
		},
	] as never);
	const tool = (
		id: string,
		appId: string,
		toolId: string,
		config: unknown,
	) => ({
		id,
		appId,
		toolId,
		toolTypeId: "mcp",
		title: toolId,
		description: toolId,
		inputSchema: {},
		config,
	});
	const mail = (mcpToolName: string) => ({
		transport: "mcp",
		mcpToolName,
		auth: {
			type: "connection",
			connectionId: "google-gmail",
			credentialScope: "user",
			scopes: GMAIL_SCOPES,
		},
	});
	await db.insert(appTools).values([
		tool("t1", "app-mail", "search_threads", mail("search_threads")),
		tool("t2", "app-mail", "create_draft", mail("create_draft")),
		tool("t4", "app-calendar", "list_events", {
			transport: "mcp",
			mcpToolName: "list_events",
			auth: {
				type: "connection",
				connectionId: "google-calendar",
				credentialScope: "user",
				scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
			},
		}),
		tool("t3", "app-tedix", "list_os_outputs", {
			endpoint: "osWorkspaces/outputs/list",
		}),
	] as never);
	return { db } as unknown as BaseContext;
}

function skill(frontmatterMcp: string) {
	return {
		content: `---\nname: inbox\ncapabilities:\n  mcp:\n${frontmatterMcp}\n---\n# Inbox\n`,
		files: null,
	} as never;
}

describe("a scheduled skill's personal account access", () => {
	it("selects the second declared account without granting undeclared providers", async () => {
		const context = await setup();
		const multi = skill(
			"    google_gmail: [search_threads]\n    google_calendar: [list_events]",
		);
		expect(
			await personalAccessNeed(context, "org-1", multi, "google-calendar"),
		).toMatchObject({
			providerId: "google-calendar",
			tools: [{ toolId: "list_events", operation: "read" }],
		});
		expect(
			await personalAccessNeed(context, "org-1", multi, "google-gmail"),
		).toMatchObject({ providerId: "google-gmail" });
		expect(
			await personalAccessNeed(context, "org-1", multi, "unrelated-provider"),
		).toBeNull();
	});
	it("comes from the reviewed account tools the skill declares, with their operation", async () => {
		const context = await setup();
		await expect(
			personalAccessNeed(
				context,
				"org-1",
				skill(
					"    tedix: [list_os_outputs]\n    google_gmail: [search_threads, create_draft]",
				),
			),
		).resolves.toEqual({
			providerId: "google-gmail",
			providerName: "Gmail",
			resourceType: "mailbox",
			tools: [
				{ toolId: "search_threads", operation: "read" },
				{ toolId: "create_draft", operation: "modify" },
			],
			requiredScopes: [...GMAIL_SCOPES].sort(),
		});
	});

	it("is absent for a skill that uses no personal account", async () => {
		const context = await setup();
		await expect(
			personalAccessNeed(
				context,
				"org-1",
				skill("    tedix: [list_os_outputs]"),
			),
		).resolves.toBeNull();
		await expect(
			personalAccessNeed(
				context,
				"org-2",
				skill("    google_gmail: [search_threads]"),
			),
		).resolves.toBeNull();
	});
});

it("recognizes a declared internal session activity read without a provider connection", async () => {
	const context = await setup();
	await expect(
		personalAccessNeed(
			context,
			"org-1",
			skill("    tedix: [list_agent_session_activity]"),
		),
	).resolves.toEqual({
		providerId: "tedix-session-activity",
		providerName: "session activity",
		resourceType: "session_activity",
		tools: [{ toolId: "list_agent_session_activity", operation: "read" }],
		requiredScopes: [],
	});
});

it("backfills local slots on an existing skill resource without replacing it", async () => {
	const { osWorkspaces, osWorkspaceResources } =
		await import("@tedix/db/schema/os-workspaces");
	const { ensureWorkspaceSkillLink } = await import("./os-workspaces-shared");
	const { listOsWorkspaceResources, updateOsWorkspaceResourceMetadata } =
		await import("@tedix/db/queries/os-workspaces/resources");
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		"CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL); INSERT INTO organizations VALUES ('org-1');",
	);
	sqlite.exec(schemaDdl(osWorkspaces, osWorkspaceResources));
	const binding = createD1Facade(sqlite);
	const db = createDbClient(binding);
	const context = {
		db,
		env: { DB: binding },
		authType: "user",
		user: { sub: "user-1" },
	} as unknown as BaseContext;
	await db.insert(osWorkspaces).values({
		id: "workspace",
		organizationId: "org-1",
		name: "Factory",
		createdByKind: "user",
		createdById: "user-1",
	});
	const params = {
		organizationId: "org-1",
		workspaceId: "workspace",
		skillId: "skill-1",
		name: "Daily",
	};
	await ensureWorkspaceSkillLink(context, params);
	const [original] = await listOsWorkspaceResources(db, params);
	await updateOsWorkspaceResourceMetadata(db, {
		...params,
		resourceId: original!.id,
		expectedUpdatedAt: original!.updatedAt,
		metadata: '{"purpose":"Daily report"}',
		now: "2026-01-01T00:00:00Z",
	});
	const runsAt = { timeZone: "Europe/Berlin", times: ["08:30"] };
	expect(
		await ensureWorkspaceSkillLink(context, { ...params, runsAt }),
	).toEqual({ created: false, updated: true });
	const rows = await listOsWorkspaceResources(db, params);
	expect(rows).toHaveLength(1);
	expect(rows[0]!.id).toBe(original!.id);
	expect(JSON.parse(rows[0]!.metadata)).toEqual({
		purpose: "Daily report",
		runsAt,
	});
	expect(
		await ensureWorkspaceSkillLink(context, { ...params, runsAt }),
	).toEqual({ created: false, updated: false });
});
