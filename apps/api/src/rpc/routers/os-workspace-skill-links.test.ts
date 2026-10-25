/**
 * Linking skills to a Workspace: one skill by id, unlinking it, and the
 * idempotent backfill that links what the Workspace's own data says runs it.
 * The links show in the schedule list with the tedi that runs each skill.
 */

import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { apps, appTools } from "@tedix/db/schema";
import { auditEvents } from "@tedix/db/schema/audit-events";
import {
	skillEntries,
	skillRuns,
	skillSchedules,
} from "@tedix/db/schema/cognitive";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import {
	osOutputRevisions,
	osOutputs,
	osWorkspaceProjects,
	osWorkspaceResources,
	osWorkspaces,
} from "@tedix/db/schema/os-workspaces";
import { projects } from "@tedix/db/schema/projects";
import { tedis } from "@tedix/db/schema/tedis";
import { userConfigs } from "@tedix/db/schema/user-configs";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({ skills: new Map<string, unknown>() }));

vi.mock("@tedix/db/queries/cognitive/skill-crud", () => ({
	getSkillEntry: async (_db: unknown, id: string, organizationId: string) => {
		const skill = mocks.skills.get(id) as
			| { organizationId: string }
			| undefined;
		return skill?.organizationId === organizationId ? skill : undefined;
	},
}));

const { osWorkspacesContractRouter } = await import("./os-workspaces");

const TEDI = "10000000-0000-4000-8000-0000000000aa";
const RESEARCH = "skill-research";
const WRITER = "skill-writer";

function createEnv() {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			tedis,
			osWorkspaces,
			osWorkspaceResources,
			osWorkspaceProjects,
			osOutputs,
			osOutputRevisions,
			projects,
			skillEntries,
			apps,
			appTools,
			userConfigs,
			auditEvents,
			organizationMembers,
			skillRuns,
			skillSchedules,
		),
	);
	sqlite.exec(`
		CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
		INSERT INTO organizations (id, name) VALUES ('org-1', 'Fictional Org');
		INSERT INTO organization_members (id, organization_id, descope_user_id, email, role, status)
		VALUES ('m-robin','org-1','member-robin','robin@example.test','member','active');
		INSERT INTO tedis (id, organization_id, name, slug, display_name)
		VALUES ('${TEDI}', 'org-1', 'research', 'research', 'Research Tedi');
		INSERT INTO skill_entries (id, organization_id, title, content)
		VALUES ('${RESEARCH}', 'org-1', 'Daily research', '# r'),
		       ('${WRITER}', 'org-1', 'Card writer', '# w');
	`);
	const env = {
		ENVIRONMENT: "test",
		API_URL: "https://api.tedix.test",
		DB: createD1Facade(sqlite),
	} as CloudflareEnv;
	return { env, sqlite };
}

function member(env: CloudflareEnv) {
	return createRouterClient(osWorkspacesContractRouter, {
		context: {
			authType: "user",
			db: createDbClient(env.DB) as BaseContext["db"],
			env,
			headers: new Headers(),
			organizationId: "org-1",
			url: new URL("https://api.tedix.test/rpc/os-workspaces"),
			user: {
				aud: "test",
				dct: "tenant-1",
				exp: 2,
				iat: 1,
				iss: "https://auth.tedix.test",
				permissions: ["os:read", "os:author", "os:admin"],
				roles: [],
				sub: "member-robin",
			},
		} as BaseContext,
	});
}

function skill(id: string, title: string, workflow: boolean) {
	return {
		id,
		organizationId: "org-1",
		slug: id,
		title,
		tediId: TEDI,
		revision: 1,
		content: `---\nname: ${id}\n---\n# ${title}\n`,
		files: workflow
			? { "scripts/workflow.ts": "export default { async run() {} };" }
			: null,
	};
}

async function seed() {
	const { env, sqlite } = createEnv();
	mocks.skills.clear();
	mocks.skills.set(RESEARCH, skill(RESEARCH, "Daily research", true));
	mocks.skills.set(WRITER, skill(WRITER, "Card writer", false));
	const client = member(env);
	const { workspace } = await client.workspaces.create({
		name: "Research factory",
		visibility: "private",
	});
	return { client, sqlite, workspaceId: workspace.id };
}

describe("Workspace skill links", () => {
	it("links a skill once, lists it with its tedi, unlinks it and restores the same link", async () => {
		const { client, workspaceId } = await seed();
		const first = await client.schedules.link({
			workspaceId,
			skillId: RESEARCH,
		});
		expect(first.created).toBe(true);
		expect(
			await client.schedules.link({ workspaceId, skillId: RESEARCH }),
		).toEqual({ resourceId: first.resourceId, created: false });

		const { items } = await client.schedules.list({ workspaceId });
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			resourceId: first.resourceId,
			skillId: RESEARCH,
			name: "Daily research",
			enabled: false,
			tediName: "Research Tedi",
			hasWorkflow: true,
		});

		expect(
			await client.schedules.unlink({ workspaceId, skillId: RESEARCH }),
		).toEqual({ removed: true });
		expect((await client.schedules.list({ workspaceId })).items).toEqual([]);
		expect(
			await client.schedules.unlink({ workspaceId, skillId: RESEARCH }),
		).toEqual({ removed: false });
		expect(
			await client.schedules.link({ workspaceId, skillId: RESEARCH }),
		).toEqual({ resourceId: first.resourceId, created: true });
	});

	it("refuses a skill from outside the organization", async () => {
		const { client, workspaceId } = await seed();
		mocks.skills.set("foreign", {
			...skill("foreign", "Foreign", false),
			organizationId: "org-2",
		});
		await expect(
			client.schedules.link({ workspaceId, skillId: "foreign" }),
		).rejects.toThrow(/No skill with that id/);
	});

	it("backfills factory lanes and Output writers: a dry run first, then once", async () => {
		const { client, sqlite, workspaceId } = await seed();
		sqlite
			.prepare(
				"INSERT INTO projects (id, org_id, key, name, metadata, created_at, updated_at) VALUES ('p-1', 'org-1', 'RES', 'Research', ?, '2026-10-01', '2026-10-01')",
			)
			.run(
				JSON.stringify({
					factory: { slug: "research", skillId: RESEARCH, workspaceId },
				}),
			);
		sqlite
			.prepare(
				"INSERT INTO os_outputs (id, organization_id, workspace_id, kind, title, status, created_by_kind, created_by_id, created_at, updated_at) VALUES ('out-1', 'org-1', ?, 'sheet', 'Cards', 'active', 'user', 'u', '2026-10-01', '2026-10-01')",
			)
			.run(workspaceId);
		sqlite
			.prepare(
				"INSERT INTO os_output_revisions (id, organization_id, output_id, revision, content, created_by_kind, created_by_id, created_at, skill_run_id, skill_id) VALUES ('rev-1', 'org-1', 'out-1', 1, '{}', 'tedi', 't', '2026-10-01', 'run-1', ?)",
			)
			.run(WRITER);

		const dry = await client.schedules.linkFactorySkills({ workspaceId });
		expect(dry).toEqual({
			dryRun: true,
			items: [
				{
					skillId: RESEARCH,
					name: "Daily research",
					reason: "factory_project",
					status: "would_link",
				},
				{
					skillId: WRITER,
					name: "Card writer",
					reason: "wrote_outputs",
					status: "would_link",
				},
			],
		});
		expect((await client.schedules.list({ workspaceId })).items).toEqual([]);

		const applied = await client.schedules.linkFactorySkills({
			workspaceId,
			dryRun: false,
		});
		expect(applied.items.map((item) => item.status)).toEqual([
			"linked",
			"linked",
		]);
		const again = await client.schedules.linkFactorySkills({
			workspaceId,
			dryRun: false,
		});
		expect(again.items.map((item) => item.status)).toEqual([
			"already_linked",
			"already_linked",
		]);
		const listed = (await client.schedules.list({ workspaceId })).items;
		expect(listed.map((item) => [item.skillId, item.hasWorkflow])).toEqual(
			expect.arrayContaining([
				[RESEARCH, true],
				[WRITER, false],
			]),
		);
	});
});
