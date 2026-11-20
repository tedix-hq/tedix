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

function memoryDb() {
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
	return sqlite;
}

it("reads a person's own memory only in a workspace nobody else can open", async () => {
	const sqlite = memoryDb();
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

it("finds a person's notes beyond their tedi's top facts", async () => {
	const sqlite = memoryDb();
	sqlite.exec(`
		INSERT INTO organization_members (id, organization_id, descope_user_id, user_id, email, role, status)
		VALUES ('m-avery', 'org-1', 'sign-in-avery', 'user-avery', 'avery@example.test', 'member', 'active');
		INSERT INTO tedis (id, organization_id, name, slug, status, scope, owner_user_id)
		VALUES ('tedi-avery', 'org-1', 'avery', 'avery', 'active', 'personal', 'user-avery');
		INSERT INTO os_workspaces (id, organization_id, name, visibility, owner_user_id, created_by_kind, created_by_id, created_at, updated_at)
		VALUES ('ws-avery', 'org-1', 'Mine', 'private', 'sign-in-avery', 'user', 'sign-in-avery', '2026-11-01', '2026-11-01');
		INSERT INTO memory_facts (id, organization_id, tedi_id, content, fact_type, visibility, priority, confidence, updated_at)
		VALUES ('f-pilot', 'org-1', 'tedi-avery', 'The Harbor pilot starts on Monday.', 'observation', 'private', 'background', 0.1, '2026-01-01'),
			('f-org', 'org-1', NULL, 'Harbor is a customer.', 'observation', 'org', 'core', 1, '2026-11-02');
	`);
	// Many newer, more confident notes push the pilot out of any top slice.
	const insert = sqlite.prepare(
		`INSERT INTO memory_facts (id, organization_id, tedi_id, content, fact_type, visibility, priority, confidence, updated_at)
		VALUES (?, 'org-1', 'tedi-avery', ?, 'observation', 'private', 'core', 0.9, ?)`,
	);
	for (let i = 0; i < 120; i++)
		insert.run(`f-${i}`, `Note ${i}`, `2026-11-${String(10 + (i % 10))}`);
	const env = { DB: createD1Facade(sqlite) } as CloudflareEnv;
	const read = (input: { query?: string; limit?: number }) =>
		readWorkspacePersonMemory(env, {
			organizationId: "org-1",
			workspaceId: "ws-avery",
			userId: "sign-in-avery",
			...input,
		});

	expect(await read({ query: "harbor" })).toEqual({
		status: "memory",
		records: [expect.objectContaining({ id: "f-pilot" })],
	});
	const latest = await read({});
	expect(latest.status === "memory" && latest.records).toHaveLength(10);
});
