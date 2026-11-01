import { createDbClient } from "@tedix/db/client";
import { getSkillRun } from "@tedix/db/queries/skill-runs";
import { getAuthoritativeWorkItemAttempt } from "@tedix/db/queries/work-items/attempts";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import * as z from "zod";
import type { EvaluationRequest } from "@tedix/api-contract/schemas/evaluation-context";
import { skillWorkflowRunId } from "./mcp-authorization";
import { AGENT_RUNTIME_PROMPT } from "./runtime-tool-guidance";
import { readIdentityFilesWithDiagnostics } from "./workspace";
import { TEDIX_ARTIFACTS_NAMESPACE_PRODUCTION } from "./artifacts-contract";

export interface EvaluationAdmission extends EvaluationRequest {
	workflowRunId: string;
	workItemId: string;
	workAttemptId: string;
	workExternalSessionKey?: string;
	skillId: string;
	skillRevision: number;
	workflowSourceSha256: string;
	executionEpoch: number;
	agents: string;
}

export const EVALUATION_SYSTEM =
	"You are an independent evaluator. Evaluate only the explicitly supplied workflow rules and case evidence. Do not infer labels, earlier decisions or examples from outside this input. Return the requested evaluation directly. You have no tools or conversation history.";

export function evaluationSessionKey(runId: string): string {
	return `workflow:synth:evaluation:${runId}`;
}

export function evaluationSystem(admission: EvaluationAdmission): string {
	return `${EVALUATION_SYSTEM}${AGENT_RUNTIME_PROMPT}\n\n## Reviewed organization instructions (AGENTS.md)\n\n${admission.agents}`;
}

/** Pi's instructions section is tagged by its native prompt renderer. */
export function evaluationNativeSystem(admission: EvaluationAdmission): string {
	return `<instructions>\n${evaluationSystem(admission)}\n</instructions>`;
}

/** Authority comes from the canonical owner/admin certification, never params alone. */
export function authorizeEvaluation(input: {
	request: EvaluationRequest;
	run: Awaited<ReturnType<typeof getSkillRun>>;
	orgId: string;
	tediId: string;
	workflowRunId: string;
	executionEpoch: number;
}): Omit<EvaluationAdmission, "agents"> {
	const { run, request } = input;
	const pinned = run?.params?.evaluationAdmission as
		| Record<string, unknown>
		| undefined;
	if (
		!run ||
		run.id !== input.workflowRunId ||
		run.organizationId !== input.orgId ||
		run.tediId !== input.tediId ||
		run.executionEpoch !== input.executionEpoch ||
		!run.certification ||
		!run.workItemId ||
		!["running", "queued"].includes(run.status) ||
		run.workflowRetiredAt ||
		run.skillRevision == null ||
		!run.workflowSourceHash ||
		!/^[a-f0-9]{64}$/.test(run.workflowSourceHash) ||
		typeof pinned?.workAttemptId !== "string" ||
		!z.uuid().safeParse(pinned.workAttemptId).success ||
		pinned?.policy !== request.policy ||
		pinned?.reviewedAgentsSha256 !== request.reviewedAgentsSha256 ||
		pinned?.skillRevision !== run.skillRevision
	) {
		throw new Error(
			"Evaluation requires an active, certified, Work-bound pinned workflow admission",
		);
	}
	return {
		...request,
		workflowRunId: run.id,
		workItemId: run.workItemId,
		workAttemptId: pinned.workAttemptId as string,
		...(typeof pinned.workExternalSessionKey === "string"
			? { workExternalSessionKey: pinned.workExternalSessionKey }
			: {}),
		skillId: run.skillId,
		skillRevision: run.skillRevision,
		workflowSourceSha256: run.workflowSourceHash,
		executionEpoch: run.executionEpoch,
	};
}

export async function admitEvaluation(input: {
	request: Request;
	evaluation: EvaluationRequest;
	orgId: string;
	tediId: string;
	env: Cloudflare.Env;
}): Promise<EvaluationAdmission> {
	const workflowRunId = skillWorkflowRunId(input.request);
	const epoch = input.request.headers.get("X-Tedix-Workflow-Execution-Epoch");
	if (!workflowRunId || epoch === null || !/^\d+$/.test(epoch))
		throw new Error("Evaluation requires authenticated workflow provenance");
	const run = await getSkillRun(
		createDbClient(input.env.DB),
		workflowRunId,
		input.orgId,
		input.env.ENVIRONMENT === "production" ? "production" : "development",
	);
	const admission = authorizeEvaluation({
		...input,
		request: input.evaluation,
		run,
		workflowRunId,
		executionEpoch: Number(epoch),
	});
	if (input.request.headers.get("X-Tedix-Skill-Id") !== admission.skillId)
		throw new Error(
			"Evaluation workflow provenance does not match its canonical admission",
		);
	await assertEvaluationWork(input.env, input.orgId, admission);
	const instructions = await readEvaluationInstructions(
		input.env,
		input.tediId,
	);
	if (instructions.sha256 !== admission.reviewedAgentsSha256)
		throw new Error(
			"Evaluation organization instructions differ from the reviewed digest",
		);
	return { ...admission, agents: instructions.content };
}

/** Preflight and admission use the same effective identity source and bytes. */
export async function readEvaluationInstructions(
	env: Cloudflare.Env,
	tediId: string,
) {
	const identity = await readIdentityFilesWithDiagnostics({
		bucket: env.TEDI_STORAGE,
		tediId,
		files: ["AGENTS.md"],
		artifacts: env.ARTIFACTS,
		artifactsAccountId: env.CF_ACCOUNT_ID,
		artifactsNamespace: TEDIX_ARTIFACTS_NAMESPACE_PRODUCTION,
	});
	const agents = identity.files.find((file) =>
		file.key.endsWith("AGENTS.md"),
	)?.text;
	if (agents === undefined)
		throw new Error(
			"Effective evaluation organization instructions are unavailable",
		);
	const source = identity.diagnostics.files.find(
		(file) => file.path === "AGENTS.md",
	);
	return {
		content: agents,
		sha256: await sha256Hex(agents),
		provenance: {
			backend: source?.source ?? "missing",
			key: source?.key ?? null,
		},
		runtimeSource: env.GIT_SHA ?? null,
	};
}

export async function assertEvaluationWork(
	env: Cloudflare.Env,
	orgId: string,
	admission: Pick<
		EvaluationAdmission,
		"workItemId" | "workAttemptId" | "workExternalSessionKey"
	>,
): Promise<void> {
	const db = createDbClient(env.DB);
	const work = await getWorkItemById(db, admission.workItemId, orgId);
	if (work?.disposition !== "accepted")
		throw new Error("Evaluation Work is not accepted");
	await getAuthoritativeWorkItemAttempt(db, {
		orgId,
		workItemId: admission.workItemId,
		attemptId: admission.workAttemptId,
		externalSessionKey: admission.workExternalSessionKey,
	});
}

export async function assertEvaluationWorkflow(
	env: Cloudflare.Env,
	orgId: string,
	tediId: string,
	admission: EvaluationAdmission,
): Promise<void> {
	const run = await getSkillRun(
		createDbClient(env.DB),
		admission.workflowRunId,
		orgId,
		env.ENVIRONMENT === "production" ? "production" : "development",
	);
	const current = authorizeEvaluation({
		request: {
			policy: admission.policy,
			reviewedAgentsSha256: admission.reviewedAgentsSha256,
		},
		run,
		orgId,
		tediId,
		workflowRunId: admission.workflowRunId,
		executionEpoch: admission.executionEpoch,
	});
	const { agents: _agents, ...pinned } = admission;
	if (JSON.stringify(current) !== JSON.stringify(pinned))
		throw new Error("Evaluation admission changed before inference");
	await assertEvaluationWork(env, orgId, admission);
}
