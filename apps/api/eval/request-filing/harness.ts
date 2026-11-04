import { DatabaseSync } from "node:sqlite";
import {
	createDbQueryClient,
	type DbQueryClient,
} from "@tedix/db/query-client";
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
import {
	listAgentSessionRequests,
	recordAgentSessionRequests,
} from "@tedix/db/queries/agent-session-requests";
import { listRequestFilings } from "@tedix/db/queries/request-filings";
import { getWorkItemBySourceIntentId } from "@tedix/db/queries/work-items/crud";
import { autoFileRequests } from "../../src/services/request-auto-filing";
import type { LedgerModel } from "../../src/services/agent-session-request-ledger";
import { baselineAutoFileRequests, type BaselineFilingModel } from "./baseline";
import {
	FILING_HARNESS,
	FILING_NOW,
	FILING_ORG,
	FILING_OWNER,
	FILING_PORTFOLIO,
	FILING_SESSION_KEY,
	type FilingCase,
} from "./fixtures";

const owner = {
	organizationId: FILING_ORG,
	userId: FILING_OWNER,
	now: FILING_NOW,
	intakeProjectId: "proj-intake",
};

export interface ArmCalls {
	writer: number;
	chooser: number;
	scorer: number;
}

export interface ArmOutcome {
	arm: "baseline" | "candidate";
	caseId: string;
	status: "filed" | "pending" | "error";
	projectId: string | null;
	suggestedProjectId: string | null;
	confidence: number | null;
	factoryProposal: boolean | null;
	actionable: boolean | null;
	workItemId: string | null;
	createdWorkProjectId: string | null;
	error: string | null;
	calls: ArmCalls;
	/** Harness wall clock only; never a provider latency estimate. */
	elapsedMs: number;
}

async function seed(test: FilingCase) {
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

/**
 * The baseline's freeform model can only emit project ids its prompt retains;
 * outside the window it falls back to `baselineProject` (or the same id when
 * the fixture scripts an out-of-list answer, which the guard then rejects).
 */
function baselineModelFor(test: FilingCase, calls: ArmCalls) {
	const up = test.upstream;
	const model: BaselineFilingModel = async (_system, prompt) => {
		calls.writer++;
		if (up.throw) throw new Error(up.throw);
		if (up.novelRaw !== undefined) return up.novelRaw;
		const input = JSON.parse(prompt) as { projects?: string[][] };
		const visible = new Set((input.projects ?? []).map((row) => row[0]!));
		const projectId = ["NONE", "UNCLEAR"].includes(up.project)
			? null
			: up.baselineProject !== undefined && !visible.has(up.project)
				? up.baselineProject
				: up.project;
		return JSON.stringify({
			projectId,
			workItemId: up.workItemId ?? null,
			objectiveId: null,
			name: up.name ?? "Suggested scope",
			brief: up.brief ?? "Match the request to an existing project",
			container: up.container ?? "project",
			actionable: up.actionable,
			reason: up.reason ?? "Closest visible project",
		});
	};
	model.scoreProjectFit = async () => {
		calls.scorer++;
		return up.confidence;
	};
	return model;
}

function candidateModelFor(test: FilingCase, calls: ArmCalls) {
	const up = test.upstream;
	const model: LedgerModel = async () => {
		calls.writer++;
		if (up.throw) throw new Error(up.throw);
		return up.novelRaw ?? "{}";
	};
	model.chooseProject = async () => {
		calls.chooser++;
		if (up.throw) throw new Error(up.throw);
		return {
			projectId: up.project,
			confidence: up.confidence,
			workItemId: up.workItemId ?? null,
			actionable: up.actionable,
		};
	};
	return model;
}

async function runArm(
	arm: ArmOutcome["arm"],
	test: FilingCase,
	calls: ArmCalls,
	run: (db: DbQueryClient) => Promise<void>,
): Promise<ArmOutcome> {
	const started = performance.now();
	const outcome: ArmOutcome = {
		arm,
		caseId: test.id,
		status: "error",
		projectId: null,
		suggestedProjectId: null,
		confidence: null,
		factoryProposal: null,
		actionable: null,
		workItemId: null,
		createdWorkProjectId: null,
		error: null,
		calls,
		elapsedMs: 0,
	};
	const { db, row } = await seed(test);
	try {
		await run(db);
	} catch (error) {
		outcome.error = error instanceof Error ? error.message : String(error);
		outcome.elapsedMs = performance.now() - started;
		return outcome;
	}
	outcome.elapsedMs = performance.now() - started;
	const [request] = await listAgentSessionRequests(db, owner);
	const [filing] = await listRequestFilings(db, owner);
	const metadata = (filing?.metadata ?? {}) as Record<string, unknown>;
	const work = await getWorkItemBySourceIntentId(db, {
		orgId: FILING_ORG,
		sourceIntentId: `request-filing:${row.id}`,
	});
	return {
		...outcome,
		status: request?.projectId ? "filed" : "pending",
		projectId: request?.projectId ?? null,
		suggestedProjectId: (metadata.suggestedProjectId as string) ?? null,
		confidence: (metadata.confidence as number) ?? null,
		factoryProposal: (metadata.factoryProposal as boolean) ?? null,
		actionable: (metadata.actionable as boolean) ?? null,
		workItemId: (metadata.workItemId as string) ?? null,
		createdWorkProjectId: work?.projectId ?? null,
	};
}

export async function runFilingCase(test: FilingCase): Promise<ArmOutcome[]> {
	const baselineCalls: ArmCalls = { writer: 0, chooser: 0, scorer: 0 };
	const baselineModel = baselineModelFor(test, baselineCalls);
	const candidateCalls: ArmCalls = { writer: 0, chooser: 0, scorer: 0 };
	const candidateModel = candidateModelFor(test, candidateCalls);
	return [
		await runArm("baseline", test, baselineCalls, (db) =>
			baselineAutoFileRequests(db, baselineModel, owner),
		),
		await runArm("candidate", test, candidateCalls, (db) =>
			autoFileRequests(db, candidateModel, owner),
		),
	];
}
