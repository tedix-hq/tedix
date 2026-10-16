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
