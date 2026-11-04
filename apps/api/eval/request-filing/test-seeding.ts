import { DatabaseSync } from "node:sqlite";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	agentSessionEvents,
	agentSessionRequests,
	type AgentSessionRequestRow,
} from "@tedix/db/schema/agent-session-requests";
import { projects } from "@tedix/db/schema/projects";
import { organizations } from "@tedix/db/schema/organizations";
import { tediObjectives } from "@tedix/db/schema/tedi-objectives";
import { workEvents, workItems } from "@tedix/db/schema/work-items";
import { workAgentSessions } from "@tedix/db/schema/work-agent-sessions";
import {
	osWorkspaces,
	osWorkspaceProjects,
} from "@tedix/db/schema/os-workspaces";
import { learningInteractionEvents } from "@tedix/db/schema/learning-feedback";
import { recordAgentSessionRequests } from "@tedix/db/queries/agent-session-requests";
import {
	FILING_HARNESS,
	FILING_NOW,
	FILING_ORG,
	FILING_OWNER,
	FILING_PORTFOLIO,
	FILING_SESSION_KEY,
	type FilingCase,
} from "./fixtures";

export async function seedFilingCase(test: FilingCase) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	for (const table of [
		organizations,
		agentSessionEvents,
		agentSessionRequests,
		projects,
		tediObjectives,
		workItems,
		workEvents,
		workAgentSessions,
		osWorkspaces,
		osWorkspaceProjects,
		learningInteractionEvents,
	])
		sqlite.exec(schemaDdl(table));
	const db = createDbQueryClient(createD1Facade(sqlite));
	for (let i = 0; i < (test.extraProjects ?? 0); i++)
		await db.insert(projects).values({
			id: `filler-${i}`,
			orgId: FILING_ORG,
			key: `FIL${i}`,
			name: `Filler portfolio entry ${i} covering unrelated topics`,
			description: "Fictional filler project covering unrelated ledger topics",
			createdAt: FILING_NOW,
		});
	for (const project of FILING_PORTFOLIO)
		await db.insert(projects).values({
			id: project.id,
			orgId: FILING_ORG,
			key: project.key,
			name: project.name,
			description: project.description,
			createdAt: FILING_NOW,
		});
	await db.insert(tediObjectives).values({
		id: "objective-ops",
		tediId: "tedi-holdout",
		orgId: FILING_ORG,
		title: "Operations",
		description: "Keep recurring operations reliable",
		createdAt: FILING_NOW,
	});
	for (const work of test.work ?? [])
		await db.insert(workItems).values({
			id: work.id,
			orgId: FILING_ORG,
			title: work.title,
			projectId: work.projectId,
			disposition: work.disposition ?? "accepted",
			createdAt: FILING_NOW,
		});
	if (test.session)
		await db.insert(workAgentSessions).values({
			id: "session",
			organizationId: FILING_ORG,
			userId: FILING_OWNER,
			harness: FILING_HARNESS,
			sessionKey: FILING_SESSION_KEY,
			projectId: test.session.projectId,
			label: test.session.label,
			summary: test.session.summary ?? "",
			state: "working",
			stateSince: FILING_NOW,
			lastEventAt: FILING_NOW,
		});
	const [row] = await recordAgentSessionRequests(db, {
		organizationId: FILING_ORG,
		userId: FILING_OWNER,
		harness: FILING_HARNESS,
		sessionKey: FILING_SESSION_KEY,
		sourceKey: `holdout-${test.id}`,
		sourceAt: FILING_NOW,
		now: FILING_NOW,
		repository: "example/holdout",
		requests: [{ kind: test.kind, text: test.text }],
	});
	return { db, row: row as AgentSessionRequestRow };
}
