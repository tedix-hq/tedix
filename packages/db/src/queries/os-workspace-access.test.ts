import { calendarCoordinatorConfigurations } from "../schema/calendar-coordinator";
import { projects } from "../schema/projects";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { skillEntries, skillSchedules } from "../schema/cognitive";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { oidcSessions } from "../schema/oidc-sessions";
import { organizationMembers } from "../schema/organization-members";
import { organizations } from "../schema/organizations";
import { principalIdentities } from "../schema/principal-identities";
import { users } from "../schema/users";
import { osWorkspaceEvents } from "../schema/os-collaborators";
import { osWorkspaceResources, osWorkspaces } from "../schema/os-workspaces";
import { tedis } from "../schema/tedis";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	grantOsWorkspaceAccess,
	searchOrganizationPeople,
	severOsWorkspaceUserAccess,
} from "./os-collaborators";
import {
	readWorkspaceRuntimeRole,
	readWorkspaceSessionRole,
	readWorkspaceUserAccessMany,
	listWorkspaceTediBuildIds,
} from "./os-workspace-access";

const migration = (name: string) =>
	readFileSync(
		new URL(`../../drizzle/${name}/migration.sql`, import.meta.url),
		"utf8",
	);

function fixture(visibility: "private" | "org" = "private") {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			{ foreignKeys: false },
			organizationMembers,
			osWorkspaces,
			osWorkspaceEvents,
			tedis,
			skillEntries,
			skillSchedules,
			projects,
			calendarCoordinatorConfigurations,
			osWorkspaceResources,
			organizations,
			principalIdentities,
			oidcSessions,
			users,
		),
	);
	sqlite.exec(
		readFileSync(
			new URL(
				"../../drizzle/20261025180038_os-workspace-collaborators/migration.sql",
				import.meta.url,
			),
			"utf8",
		),
	);
	sqlite.exec(
		readFileSync(
			new URL(
				"../../drizzle/20261119111534_workspace_tedi_principals/migration.sql",
				import.meta.url,
			),
			"utf8",
		),
	);
	// Every check below runs through the role cache and its fence, so each
	// raw UPDATE in a test must be seen by the very next check.
	sqlite.exec(migration("20261119100738_auth_context_cache"));
	sqlite.exec(migration("20261119182503_auth_cache_organization_fields"));
	sqlite.exec(migration("20261120121558_workspace_access_role_fence"));
	sqlite.exec(`
  INSERT INTO os_workspaces (id, organization_id, name, visibility, owner_user_id, created_by_kind, created_by_id, created_at, updated_at) VALUES ('workspace', 'org', 'Planning', '${visibility}', 'owner', 'user', 'owner', '2026-01-01', '2026-01-01');
  INSERT INTO organization_members (id, organization_id, descope_user_id, email, name, role, status) VALUES ('member', 'org', 'owner', 'owner@example.test', 'Robin', 'owner', 'active');
  INSERT INTO tedis (id, organization_id, name, slug, status, scope, owner_user_id) VALUES
   ('team', 'org', 'Research helper', 'research', 'active', 'organization', NULL),
   ('personal', 'org', 'Personal helper', 'personal', 'active', 'personal', 'owner'),
   ('foreign', 'other', 'Research helper', 'research-foreign', 'active', 'organization', NULL);
 `);
	const queries: string[] = [];
	const db = createDbQueryClient(
		createD1Facade({
			prepare: (sql) => {
				queries.push(sql);
				return sqlite.prepare(sql);
			},
			exec: (sql) => sqlite.exec(sql),
		}),
	);
	const scope = { organizationId: "org", workspaceId: "workspace" };
	const role = (actorId: string, actorKind = "tedi") =>
		readWorkspaceRuntimeRole(db, scope, { actorId, actorKind });
	const grant = (targetUserId: string, role: "use" | "build") =>
		grantOsWorkspaceAccess(db, {
			...scope,
			now: "2026-01-01",
			edges: [
				{
					kind: "tedi",
					targetUserId,
					targetEmail: null,
					targetName: "Helper",
					sharerUserId: "owner",
					role,
				},
			],
		});
	return { sqlite, db, scope, role, grant, queries };
}

describe("tedi workspace principals", () => {
	it.each(["private", "org"] as const)(
		"filters %s lists using the runtime role, including a personal override",
		async (visibility) => {
			const f = fixture(visibility);
			expect(await listWorkspaceTediBuildIds(f.db, "org", "team")).toEqual([]);
			await f.grant("team", "build");
			expect(await listWorkspaceTediBuildIds(f.db, "org", "team")).toEqual([
				"workspace",
			]);
			expect(await listWorkspaceTediBuildIds(f.db, "org", "personal")).toEqual([
				"workspace",
			]);
			await f.grant("personal", "use");
			expect(await listWorkspaceTediBuildIds(f.db, "org", "personal")).toEqual(
				[],
			);
			f.sqlite.exec("UPDATE tedis SET status = 'paused' WHERE id = 'team'");
			expect(await listWorkspaceTediBuildIds(f.db, "org", "team")).toEqual([]);
		},
	);
	it.each(["private", "org"] as const)(
		"backfills configured %s executors without restoring removed grants",
		async (visibility) => {
			const f = fixture(visibility);
			f.sqlite.exec(
				`INSERT INTO os_workspace_resources (id, organization_id, workspace_id, provider_id, connection_scope, resource_type, provider_resource_id, name, created_by_kind, created_by_id, created_at, updated_at) VALUES ('resource', 'org', 'workspace', 'tedix', 'tenant', 'tedi', 'team', 'Research', 'user', 'owner', '2026-01-01', '2026-01-01');`,
			);
			f.sqlite
				.exec(`INSERT INTO tedis (id, organization_id, name, slug, status, scope) VALUES ('removed', 'org', 'Removed', 'removed', 'active', 'organization');
    INSERT INTO os_workspace_collaborators (id, organization_id, workspace_id, user_id, principal_kind) VALUES ('prior-invite','org','workspace','removed','tedi');
    UPDATE os_workspaces SET default_tedi_id = 'removed';`);
			f.sqlite.exec(migration("20261126120924_workspace_executor_roles"));
			expect(await f.role("team")).toBe("build");
			expect(await f.role("removed")).toBeNull();
			await f.grant("personal", "use");
			f.sqlite.exec("UPDATE os_workspaces SET default_tedi_id = 'personal'");
			f.sqlite.exec(migration("20261126120924_workspace_executor_roles"));
			expect(await f.role("personal")).toBe("use");
		},
	);

	it("backfills calendar, factory and scheduled executors from their stored workspace bindings", async () => {
		const f = fixture("org");
		f.sqlite.exec(`
   INSERT INTO tedis (id, organization_id, name, slug, status, scope) VALUES ('calendar','org','Calendar','calendar','active','organization'), ('factory','org','Factory','factory','active','organization');
   INSERT INTO skill_entries (id, organization_id, tedi_id, title, content) VALUES ('scheduled-skill','org','team','Scheduled','Task'), ('factory-skill','org','factory','Factory','Task');
   INSERT INTO skill_schedules (id, organization_id, skill_id, tedi_id, cron, params, next_fire_at) VALUES ('schedule','org','scheduled-skill','team','0 7 * * *','{"workspaceId":"workspace"}','2026-11-01');
   INSERT INTO calendar_coordinator_configurations (id, organization_id, workspace_id, owner_user_id, revision, mode, configuration, ownership_seed, updated_at) VALUES ('calendar-config','org','workspace','owner',1,'active','{"tediId":"calendar"}','seed','2026-11-01');
   INSERT INTO projects (id, org_id, key, name, metadata, created_at) VALUES ('project','org','FACT','Factory','{"factory":{"workspaceId":"workspace","skillId":"factory-skill"}}','2026-11-01');
  `);
		f.sqlite.exec(migration("20261126120924_workspace_executor_roles"));
		for (const id of ["team", "calendar", "factory"])
			expect(await f.role(id)).toBe("build");
	});

	it.each(["private", "org"] as const)(
		"backfills linked skill executors in a %s workspace",
		async (visibility) => {
			const f = fixture(visibility);
			f.sqlite.exec(`
   ALTER TABLE os_workspace_collaborators DROP COLUMN principal_kind;
   INSERT INTO skill_entries (id, organization_id, tedi_id, title, content) VALUES ('skill', 'org', 'team', 'Research', 'Research');
   INSERT INTO os_workspace_resources (id, organization_id, workspace_id, provider_id, connection_scope, resource_type, provider_resource_id, name, created_by_kind, created_by_id, created_at, updated_at)
   VALUES ('resource', 'org', 'workspace', 'tedix', 'tenant', 'skill', 'skill', 'Research', 'user', 'owner', '2026-01-01', '2026-01-01');
  `);
			const migration = readFileSync(
				new URL(
					"../../drizzle/20261119111534_workspace_tedi_principals/migration.sql",
					import.meta.url,
				),
				"utf8",
			);
			f.sqlite.exec(migration);
			expect(await f.role("team")).toBe("build");
			expect(
				f.sqlite
					.prepare(
						"SELECT principal_kind FROM os_workspace_collaborators WHERE user_id = 'team'",
					)
					.get(),
			).toMatchObject({ principal_kind: "tedi" });
		},
	);

	it.each(["private", "org"] as const)(
		"requires a tedi edge in a %s workspace and observes its removal",
		async (visibility) => {
			const f = fixture(visibility);
			expect(await f.role("team")).toBeNull();
			await f.grant("team", "use");
			expect(await f.role("team")).toBe("use");
			await f.grant("team", "build");
			expect(await f.role("team")).toBe("build");
			await severOsWorkspaceUserAccess(f.db, {
				...f.scope,
				targetUserId: "team",
				sharerUserId: "owner",
				keepEdges: [],
				now: "2026-01-02",
			});
			expect(await f.role("team")).toBeNull();
		},
	);
	it("uses a personal tedi's own edge before its owner's role", async () => {
		const f = fixture();
		expect(await f.role("personal")).toBe("build");
		await f.grant("personal", "use");
		expect(await f.role("personal")).toBe("use");
		f.sqlite.exec(
			"UPDATE os_workspace_access_edges SET sharer_user_id = 'gone' WHERE target_user_id = 'personal'",
		);
		expect(await f.role("personal")).toBeNull();
	});
	it("does not lend a suspended owner's role, but honors the tedi's independent grant", async () => {
		const f = fixture();
		f.sqlite.exec("UPDATE organization_members SET status = 'deactivated'");
		expect(await f.role("personal")).toBeNull();
		await f.grant("personal", "use");
		expect(await f.role("personal")).toBe("use");
	});
	it("refuses inactive and foreign tedis even with stored edges", async () => {
		const f = fixture();
		await f.grant("team", "build");
		await f.grant("foreign", "build");
		expect(await f.role("foreign")).toBeNull();
		f.sqlite.exec("UPDATE tedis SET status = 'paused' WHERE id = 'team'");
		expect(await f.role("team")).toBeNull();
		expect(await f.role("team", "service")).toBeNull();
	});
	it("reuses a role only until a workspace, link or member change", async () => {
		const f = fixture("org");
		f.sqlite.exec(
			"INSERT INTO organization_members (id, organization_id, descope_user_id, email, name, role, status) VALUES ('m2', 'org', 'guest', 'guest@example.test', 'Sam', 'member', 'active')",
		);
		const session = () => readWorkspaceSessionRole(f.db, "workspace", "guest");
		const listedRole = async () =>
			(
				await readWorkspaceUserAccessMany(f.db, "org", "guest", ["workspace"])
			).get("workspace")?.role ?? null;
		expect(await listedRole()).toBe("build");
		expect(await session()).toBe("build");
		const fenceOnly = [expect.stringContaining("auth_context_cache_state")];
		let seen = f.queries.length;
		expect(await session()).toBe("build");
		expect(f.queries.slice(seen)).toEqual(fenceOnly);
		expect(await f.role("guest", "user")).toBe("build");
		seen = f.queries.length;
		expect(await f.role("guest", "user")).toBe("build");
		expect(f.queries.slice(seen)).toEqual(fenceOnly);
		expect(
			f.queries.some((sql) => sql.includes("os_workspace_collaborators")),
		).toBe(false);

		f.sqlite.exec("UPDATE os_workspaces SET visibility = 'private'");
		expect(await listedRole()).toBeNull();
		expect(await session()).toBeNull();
		expect(await f.role("guest", "user")).toBeNull();

		f.sqlite.exec(`
   INSERT INTO os_workspace_share_links (id, organization_id, workspace_id, creator_user_id, role, created_at) VALUES ('link', 'org', 'workspace', 'owner', 'use', '2026-01-01');
   INSERT INTO os_workspace_access_edges (id, organization_id, workspace_id, target_user_id, kind, edge_key, link_id, created_at) VALUES ('edge', 'org', 'workspace', 'guest', 'link', 'link:link', 'link', '2026-01-01');
  `);
		expect(await session()).toBe("use");
		expect(await session()).toBe("use");
		expect(await listedRole()).toBe("use");
		f.sqlite.exec(
			"UPDATE os_workspace_share_links SET revoked_at = '2026-01-02' WHERE id = 'link'",
		);
		expect(await listedRole()).toBeNull();
		expect(await session()).toBeNull();

		f.sqlite.exec(
			"UPDATE os_workspace_share_links SET revoked_at = NULL WHERE id = 'link'",
		);
		expect(await listedRole()).toBe("use");
		expect(await session()).toBe("use");
		f.sqlite.exec(
			"UPDATE organization_members SET status = 'deactivated' WHERE descope_user_id = 'guest'",
		);
		expect(await listedRole()).toBeNull();
		expect(await session()).toBeNull();
	});
	it("suggests active tedis only in the selected organization", async () => {
		const f = fixture();
		expect(
			await searchOrganizationPeople(f.db, {
				organizationId: "org",
				query: "Research",
				limit: 8,
			}),
		).toEqual([
			{
				userId: "team",
				name: "Research helper",
				email: "",
				principalKind: "tedi",
			},
		]);
	});
});
