import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { apps } from "../schema/apps";
import { appTools } from "../schema/tools";
import { organizations } from "../schema/organizations";
import { connectionInstances } from "../schema/connection-instances";
import { providerInstallations } from "../schema/provider-installations";
import { skillEntries } from "../schema/cognitive";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	filterAppConnectionResourceTools,
	getAggregateConnectionSourceTool,
} from "./app-records";
import { resolveSkillMcpAppBindings } from "./cognitive/skill-mcp-bindings";
import {
	getOrganizationConnectionAllowedResources,
	setOrganizationConnectionAllowedResources,
} from "./connection-instances";

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
const policy = [
	{ resourceType: "github_repository" as const, resourceId: "example/repo-x" },
];

async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			apps,
			appTools,
			organizations,
			connectionInstances,
			providerInstallations,
			skillEntries,
		),
	);
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(organizations).values([
		{ id: "org-a", name: "Example", slug: "example" },
		{ id: "org-b", name: "Other", slug: "other" },
	]);
	const [app] = await db
		.insert(apps)
		.values({
			id: "github-app",
			slug: "github",
			name: "GitHub",
			organizationId: "org-a",
			metadata: {
				mcpConfig: {
					connectionProviderId: "github",
					connectionScope: "tenant",
				},
			},
		})
		.returning();
	for (const mcpToolName of ["issue_write", "transfer_issue"])
		await db.insert(appTools).values({
			id: mcpToolName,
			appId: app!.id,
			toolId: mcpToolName,
			title: mcpToolName,
			toolTypeId: "mcp",
			enabled: true,
			config: {
				transport: "mcp",
				mcpServerUrl: "https://api.githubcopilot.com/mcp/",
				mcpToolName,
				auth: { type: "connection", connectionId: "github" },
			},
			createdAt: "now",
			updatedAt: "now",
		});
	return { db, app: app!, tools: await db.select().from(appTools) };
}

it("persists exact provider limits without affecting other providers or tenants", async () => {
	const { db } = await fixture();
	await setOrganizationConnectionAllowedResources(
		db,
		"org-a",
		"github",
		policy,
	);
	await setOrganizationConnectionAllowedResources(
		db,
		"org-a",
		'github".other',
		[],
	);
	expect(
		await getOrganizationConnectionAllowedResources(db, "org-a", "github"),
	).toEqual(policy);
	expect(
		await getOrganizationConnectionAllowedResources(
			db,
			"org-a",
			'github".other',
		),
	).toEqual([]);
	expect(
		await getOrganizationConnectionAllowedResources(db, "org-b", "github"),
	).toBeNull();
	expect(
		await getOrganizationConnectionAllowedResources(db, "org-a", "other"),
	).toBeNull();
	await setOrganizationConnectionAllowedResources(db, "org-a", "github", []);
	expect(
		await getOrganizationConnectionAllowedResources(db, "org-a", "github"),
	).toEqual([]);
});

it("uses one decision for discovery and skill binding and observes revocation", async () => {
	const { db, app, tools } = await fixture();
	await setOrganizationConnectionAllowedResources(
		db,
		"org-a",
		"github",
		policy,
	);
	expect(
		(await filterAppConnectionResourceTools(db, app, tools)).map(
			(t) => t.toolId,
		),
	).toEqual(["issue_write"]);
	const content = (method: string) =>
		`---\nname: update\ncapabilities:\n  mcp:\n    github: [${method}]\n---\nUpdate the repository.`;
	expect(
		await resolveSkillMcpAppBindings(db, {
			organizationId: "org-a",
			content: content("issue_write"),
		}),
	).toEqual({ github: app.id });
	await expect(
		resolveSkillMcpAppBindings(db, {
			organizationId: "org-a",
			content: content("transfer_issue"),
		}),
	).rejects.toThrow("Connection resource limits");
	await setOrganizationConnectionAllowedResources(db, "org-a", "github", []);
	expect(await filterAppConnectionResourceTools(db, app, tools)).toEqual([]);
	await expect(
		resolveSkillMcpAppBindings(db, {
			organizationId: "org-a",
			content: content("issue_write"),
		}),
	).rejects.toThrow("Connection resource limits");
});

it("resolves shared source tools through the aggregate ownership rule and refuses another tenant", async () => {
	const { db, app } = await fixture();
	await db
		.insert(organizations)
		.values({ id: "platform", name: "Platform", slug: "tedix" });
	await db.update(apps).set({ organizationId: "platform" });
	expect(
		(
			await getAggregateConnectionSourceTool(db, {
				organizationId: "org-a",
				appId: app.id,
				toolId: "issue_write",
			})
		)?.toolId,
	).toBe("issue_write");
	await db.update(apps).set({ organizationId: "org-b" });
	expect(
		await getAggregateConnectionSourceTool(db, {
			organizationId: "org-a",
			appId: app.id,
			toolId: "issue_write",
		}),
	).toBeUndefined();
});
