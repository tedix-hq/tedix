import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { agentSessionRequests } from "../schema/agent-session-requests";
import { learningInteractionEvents } from "../schema/learning-feedback";
import { workEvents, workItems } from "../schema/work-items";
import {
	osWorkspaces,
	osWorkspaceProjects,
	osOutputs,
	osGadgets,
	osWorkspaceResources,
} from "../schema/os-workspaces";
import { projects } from "../schema/projects";
import {
	recordAgentSessionRequests,
	getAgentSessionRequest,
} from "./agent-session-requests";
import {
	emptyAutoCreatedProjects,
	emptyAutoCreatedWorkspaces,
	ensureFilingWorkspace,
	listSharedFilingExamples,
	recordRequestFiling,
	listRequestFilings,
	ensureFilingProject,
} from "./request-filings";
const owner = { organizationId: "org-example", userId: "user-ada" };
const now = "2026-10-10T10:00:00.000Z";
async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	for (const table of [
		agentSessionRequests,
		learningInteractionEvents,
		projects,
		workItems,
		workEvents,
		osWorkspaces,
		osWorkspaceProjects,
		osOutputs,
		osGadgets,
		osWorkspaceResources,
	])
		sqlite.exec(schemaDdl(table));
	const db = createDbQueryClient(createD1Facade(sqlite));
	const [row] = await recordAgentSessionRequests(db, {
		...owner,
		harness: "codex",
		sessionKey: "session-example",
		repository: "example/app",
		sourceKey: "prompt-example",
		sourceAt: now,
		now,
		requests: [{ kind: "request", text: "Improve installation guides" }],
	});
	const project = await ensureFilingProject(db, {
		orgId: owner.organizationId,
		key: "AUTO-DOCS",
		name: "Installation guides",
		brief: "Make installation reliable",
		now,
	});
	return { db, row: row!, project };
}
describe("request filing atomic audit", () => {
	it("records reversible attribution and rejects a stale classification after correction", async () => {
		const { db, row, project } = await fixture();
		const filed = await recordRequestFiling(db, {
			...owner,
			row,
			projectId: project.id,
			by: "auto",
			confidence: 0.9,
			reason: "Installation brief fits",
			now,
		});
		expect(filed?.row.projectId).toBe(project.id);
		expect(filed?.row.status).toBe("open");
		const corrected = await recordRequestFiling(db, {
			...owner,
			row: filed!.row,
			projectId: null,
			by: "correction",
			confidence: 1,
			reason: "Wrong project",
			now: "2026-10-10T10:01:00.000Z",
		});
		expect(corrected?.event.metadata?.previousProjectId).toBe(project.id);
		expect(
			await recordRequestFiling(db, {
				...owner,
				row: filed!.row,
				projectId: project.id,
				by: "auto",
				confidence: 1,
				reason: "Stale pick",
				now,
			}),
		).toBeNull();
		expect(
			(await getAgentSessionRequest(db, { ...owner, id: row.id }))?.projectId,
		).toBeNull();
		expect(await listRequestFilings(db, owner)).toHaveLength(2);
	});
	it("rejects foreign owners, tenants and destinations without writing audit events", async () => {
		const { db, row, project } = await fixture();
		for (const override of [
			{ userId: "user-grace" },
			{ organizationId: "org-other" },
			{ projectId: "foreign-project" },
		]) {
			expect(
				await recordRequestFiling(db, {
					...owner,
					row,
					projectId: project.id,
					by: "auto",
					confidence: 1,
					reason: "fit",
					now,
					...override,
				}),
			).toBeNull();
		}
		expect(await listRequestFilings(db, owner)).toEqual([]);
	});
	it("reuses auto-created containers within a tenant and isolates equal keys across tenants", async () => {
		const { db, project } = await fixture();
		const input = {
			orgId: owner.organizationId,
			key: "AUTO-DOCS",
			name: "Installation guides",
			brief: "Make installation reliable",
			now,
		};
		expect((await ensureFilingProject(db, input)).id).toBe(project.id);
		const other = await ensureFilingProject(db, {
			...input,
			orgId: "org-other",
		});
		expect(other.id).not.toBe(project.id);
		expect(other.metadata?.autoCreated).toBe(true);
	});
});

it("shares only explicitly chosen correction examples inside the same organization", async () => {
	const { db, row, project } = await fixture();
	const result = await recordRequestFiling(db, {
		...owner,
		row,
		projectId: project.id,
		by: "correction",
		confidence: 1,
		reason: "Correct project",
		now,
		learningOwnerId: "identity-ada",
		shareCorrection: true,
	});
	expect(result?.event.scopeKind).toBe("project");
	expect(result?.event.scopeId).toBe(project.id);
	expect(await listSharedFilingExamples(db, owner.organizationId)).toHaveLength(
		1,
	);
	expect(await listSharedFilingExamples(db, "org-other")).toEqual([]);
	expect(
		await listRequestFilings(db, { ...owner, userId: "user-grace" }),
	).toEqual([]);
	expect(await listRequestFilings(db, owner)).toHaveLength(1);
});
it("lists empty auto-created containers only after 14 days and preserves populated ones", async () => {
	const { db, row, project } = await fixture();
	expect(
		await emptyAutoCreatedProjects(
			db,
			owner.organizationId,
			"2026-10-23T10:00:00.000Z",
		),
	).toEqual([]);
	expect(
		await emptyAutoCreatedProjects(
			db,
			owner.organizationId,
			"2026-10-24T10:00:00.000Z",
		),
	).toEqual([{ id: project.id, name: project.name }]);
	const workspaceId = await ensureFilingWorkspace(db, owner, project, now);
	expect(
		await emptyAutoCreatedWorkspaces(db, owner, "2026-10-24T10:00:00.000Z"),
	).toEqual([{ id: workspaceId, name: project.name }]);
	await recordRequestFiling(db, {
		...owner,
		row,
		projectId: project.id,
		by: "auto",
		confidence: 0.9,
		reason: "Fits",
		now,
	});
	expect(
		await emptyAutoCreatedProjects(
			db,
			owner.organizationId,
			"2026-10-24T10:00:00.000Z",
		),
	).toEqual([]);
	expect(
		await emptyAutoCreatedWorkspaces(db, owner, "2026-10-24T10:00:00.000Z"),
	).toEqual([]);
});
