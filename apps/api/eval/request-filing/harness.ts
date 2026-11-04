import type { DbQueryClient } from "@tedix/db/query-client";
import { listAgentSessionRequests } from "@tedix/db/queries/agent-session-requests";
import { listRequestFilings } from "@tedix/db/queries/request-filings";
import { getWorkItemBySourceIntentId } from "@tedix/db/queries/work-items/crud";
import { autoFileRequests } from "../../src/services/request-auto-filing";
import type { LedgerModel } from "../../src/services/agent-session-request-ledger";
import { baselineAutoFileRequests, type BaselineFilingModel } from "./baseline";
import { seedFilingCase } from "./test-seeding";
import {
	FILING_NOW,
	FILING_ORG,
	FILING_OWNER,
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
	const { db, row } = await seedFilingCase(test);
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
