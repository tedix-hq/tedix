import { DatabaseSync } from "node:sqlite";
import {
	memoryFactCitations,
	memoryFactCitationBackfills,
} from "@tedix/db/schema/memory-fact-citations";
import { memoryDomains, memoryFacts } from "@tedix/db/schema/memory-graph";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { tedis } from "@tedix/db/schema/tedis";
import { osWorkspaces } from "@tedix/db/schema/os-workspaces";
import {
	osWorkspaceAccessEdges,
	osWorkspaceShareLinks,
} from "@tedix/db/schema/os-collaborators";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { expect, it } from "vite-plus/test";
import { readWorkspacePersonMemory } from "./workspace-person-memory";

it("reads a person's own memory only in a workspace nobody else can open", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		schemaDdl(
			{ foreignKeys: false },
			memoryDomains,
			memoryFacts,
			memoryFactCitations,
			memoryFactCitationBackfills,
			organizationMembers,
			tedis,
			osWorkspaces,
			osWorkspaceAccessEdges,
			osWorkspaceShareLinks,
		),
	);
	sqlite.exec(`
		INSERT INTO organization_members (id, organization_id, descope_user_id, user_id, email, role, status)
		VALUES ('m-robin', 'org-1', 'robin', 'canonical-robin', 'robin@example.test', 'member', 'active');
		INSERT INTO tedis (id, organization_id, name, slug, status, scope, owner_user_id)
		VALUES ('tedi-robin', 'org-1', 'robin', 'robin', 'active', 'personal', 'canonical-robin'),
			('tedi-sam', 'org-1', 'sam', 'sam', 'active', 'personal', 'sam');
		INSERT INTO memory_facts (id, organization_id, tedi_id, content, fact_type, visibility, priority)
		VALUES ('f-own', 'org-1', 'tedi-robin', 'Robin prefers short weekly summaries.', 'preference', 'private', 'core'),
			('f-other', 'org-1', 'tedi-sam', 'Sam keeps notes on hiring.', 'preference', 'private', 'core');
		INSERT INTO os_workspaces (id, organization_id, name, visibility, owner_user_id, created_by_kind, created_by_id, created_at, updated_at)
		VALUES ('ws-own', 'org-1', 'Mine', 'private', 'robin', 'user', 'robin', '2026-11-01', '2026-11-01'),
			('ws-shared', 'org-1', 'Team', 'org', 'robin', 'user', 'robin', '2026-11-01', '2026-11-01'),
			('ws-sam', 'org-1', 'Sam', 'private', 'sam', 'user', 'sam', '2026-11-01', '2026-11-01'),
			('ws-added', 'org-1', 'Added', 'private', 'robin', 'user', 'robin', '2026-11-01', '2026-11-01');
		INSERT INTO os_workspace_access_edges (id, organization_id, workspace_id, target_user_id, kind, edge_key, sharer_user_id, role, created_at)
		VALUES ('e1', 'org-1', 'ws-added', 'sam', 'user', 'direct', 'robin', 'use', '2026-11-01');
	`);
	const env = { DB: createD1Facade(sqlite) } as CloudflareEnv;
	const read = (workspaceId: string) =>
		readWorkspacePersonMemory(env, {
			organizationId: "org-1",
			workspaceId,
			userId: "robin",
		});

	expect(await read("ws-own")).toEqual({
		status: "memory",
		records: [
			expect.objectContaining({
				id: "f-own",
				content: "Robin prefers short weekly summaries.",
			}),
		],
	});
	// Shared with the organization, someone else's, or with another person added.
	for (const workspaceId of ["ws-shared", "ws-sam", "ws-added"])
		expect(await read(workspaceId)).toMatchObject({ status: "refused" });
	sqlite.close();
});
