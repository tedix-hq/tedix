import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import { readWorkspaceRuntimeRole } from "@tedix/db/queries/os-workspace-access";
import { createDbQueryClient } from "@tedix/db/query-client";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import {
	osWorkspaceAccessEdges,
	osWorkspaceCollaborators,
	osWorkspaceEvents,
	osWorkspaceShareLinks,
} from "@tedix/db/schema/os-collaborators";
import { osWorkspaces } from "@tedix/db/schema/os-workspaces";
import { tedis } from "@tedix/db/schema/tedis";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";
import { ensureWorkspaceTediRole } from "./os-workspace-tedi-role";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			tedis,
			osWorkspaces,
			osWorkspaceCollaborators,
			osWorkspaceAccessEdges,
			osWorkspaceShareLinks,
			osWorkspaceEvents,
			organizationMembers,
		),
	);
	sqlite.exec(`
		INSERT INTO organization_members (id, organization_id, descope_user_id, email, role, status)
		VALUES ('m-robin','org-1','member-robin','robin@example.test','member','active'),
		       ('m-kim','org-1','member-kim','kim@example.test','owner','active');
		INSERT INTO tedis (id, organization_id, name, slug, display_name, status, scope)
		VALUES ('tedi-research', 'org-1', 'research', 'research', 'Research Tedi', 'active', 'organization');
		INSERT INTO os_workspaces (id, organization_id, name, visibility, owner_user_id, created_by_kind, created_by_id, created_at, updated_at)
		VALUES ('ws-private', 'org-1', 'Private', 'private', 'member-robin', 'user', 'member-robin', '2026-11-01', '2026-11-01'),
		       ('ws-org', 'org-1', 'Shared', 'org', NULL, 'user', 'member-robin', '2026-11-01', '2026-11-01');
	`);
	const env = { DB: createD1Facade(sqlite) } as CloudflareEnv;
	const base = {
		db: createDbClient(env.DB) as BaseContext["db"],
		env,
		headers: new Headers(),
		organizationId: "org-1",
	};
	const edge = (workspaceId: string) =>
		sqlite
			.prepare(
				"SELECT kind, sharer_user_id AS sharer, role FROM os_workspace_access_edges WHERE workspace_id = ? AND target_user_id = 'tedi-research'",
			)
			.all(workspaceId);
	const role = (workspaceId: string) =>
		readWorkspaceRuntimeRole(
			createDbQueryClient(env.DB),
			{ organizationId: "org-1", workspaceId },
			{ actorKind: "tedi", actorId: "tedi-research" },
		);
	return { base, edge, role };
}

describe("ensureWorkspaceTediRole", () => {
	it("gives the tedi a build role shared by the person who set it to work", async () => {
		const { base, edge, role } = fixture();
		const context = {
			...base,
			authType: "user",
			user: { sub: "member-robin" },
		} as BaseContext;
		const params = {
			organizationId: "org-1",
			workspaceId: "ws-private",
			tediId: "tedi-research",
			note: "test",
		};
		expect(await role("ws-private")).toBeNull();
		expect(await ensureWorkspaceTediRole(context, params)).toBe(true);
		expect(edge("ws-private")).toEqual([
			{ kind: "tedi", sharer: "member-robin", role: "build" },
		]);
		expect(await role("ws-private")).toBe("build");
		// Asking again leaves the one grant as it is.
		expect(await ensureWorkspaceTediRole(context, params)).toBe(false);
		expect(edge("ws-private")).toHaveLength(1);
	});

	it("uses the workspace's own root when no person is calling", async () => {
		const { base, edge, role } = fixture();
		const context = {
			...base,
			authType: "apikey",
			apiKey: { id: "key-1" },
		} as BaseContext;
		for (const workspaceId of ["ws-private", "ws-org"])
			await ensureWorkspaceTediRole(context, {
				organizationId: "org-1",
				workspaceId,
				tediId: "tedi-research",
				note: "test",
			});
		expect(edge("ws-private")).toMatchObject([{ sharer: "member-robin" }]);
		expect(edge("ws-org")).toMatchObject([{ sharer: "member-kim" }]);
		expect(await role("ws-org")).toBe("build");
	});

	it("records nothing when the calling person cannot build there", async () => {
		const { base, edge } = fixture();
		const context = {
			...base,
			authType: "user",
			user: { sub: "member-kim" },
		} as BaseContext;
		expect(
			await ensureWorkspaceTediRole(context, {
				organizationId: "org-1",
				workspaceId: "ws-private",
				tediId: "tedi-research",
				note: "test",
			}),
		).toBe(false);
		expect(edge("ws-private")).toEqual([]);
	});
});
