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
	agentsProof?: EvaluationAbsenceProof;
}

export interface EvaluationAbsenceProof {
	version: 1;
	tediId: string;
	path: "AGENTS.md";
	artifacts: {
		configured: true;
		repoFound: true;
		cloneOk: true;
		attempted: true;
		fileFound: false;
	};
	r2: { attempted: true; fileFound: false };
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
}): Omit<EvaluationAdmission, "agents" | "agentsProof"> {
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
		(pinned?.reviewedAgentsPresence ?? "present") !==
			(request.reviewedAgentsPresence ?? "present") ||
		(request.reviewedAgentsPresence === "absent"
			? !request.reviewedAgentsProofSha256 ||
				pinned?.reviewedAgentsProofSha256 !== request.reviewedAgentsProofSha256
			: request.reviewedAgentsProofSha256 !== undefined ||
				pinned?.reviewedAgentsProofSha256 !== undefined) ||
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
	assertReviewedInstructions(instructions, admission);
	await assertEvaluationAuthority(
		input.env,
		input.orgId,
		input.tediId,
		admission,
	);
	return {
		...admission,
		agents: instructions.content,
		...(instructions.backendProof
			? { agentsProof: instructions.backendProof }
			: {}),
	};
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
	return evaluationInstructionsFromIdentity(identity, tediId, env.GIT_SHA);
}

/** Classifies only authoritative read observations; missing is never an error fallback. */
export async function evaluationInstructionsFromIdentity(
	identity: Awaited<ReturnType<typeof readIdentityFilesWithDiagnostics>>,
	tediId: string,
	runtimeSource?: string,
) {
	const agents = identity.files.find((file) =>
		file.key.endsWith("AGENTS.md"),
	)?.text;
	const source = identity.diagnostics.files.find(
		(file) => file.path === "AGENTS.md",
	);
	if (agents !== undefined && !agents.trim())
		throw new Error(
			"Effective evaluation organization instructions are unavailable",
		);
	let backendProof: EvaluationAbsenceProof | undefined;
	if (agents === undefined) {
		const d = identity.diagnostics;
		if (
			d.tediId !== tediId ||
			!d.artifacts.bound ||
			!d.artifacts.configured ||
			d.artifacts.repoFound !== true ||
			d.artifacts.cloneOk !== true ||
			d.artifacts.error ||
			d.lastReadError ||
			source?.source !== "missing" ||
			source.artifact.attempted !== true ||
			source.artifact.repoFound !== true ||
			source.artifact.fileFound !== false ||
			source.artifact.error ||
			source.r2.attempted !== true ||
			source.r2.fileFound !== false ||
			source.r2.error
		)
			throw new Error(
				"Effective evaluation organization instructions are unavailable",
			);
		backendProof = {
			version: 1,
			tediId,
			path: "AGENTS.md",
			artifacts: {
				configured: true,
				repoFound: true,
				cloneOk: true,
				attempted: true,
				fileFound: false,
			},
			r2: { attempted: true, fileFound: false },
		};
	}
	return {
		presence: agents === undefined ? ("absent" as const) : ("present" as const),
		content: agents ?? "",
		sha256: await sha256Hex(agents ?? ""),
		backendProof,
		backendProofSha256: backendProof
			? await sha256Hex(JSON.stringify(backendProof))
			: undefined,
		checkedAt: identity.diagnostics.checkedAt,
		provenance: {
			backend: backendProof ? "absent" : (source?.source ?? "missing"),
			key: source?.key ?? null,
		},
		runtimeSource: runtimeSource ?? null,
	};
}

function assertReviewedInstructions(
	instructions: Awaited<ReturnType<typeof readEvaluationInstructions>>,
	admission: Pick<
		EvaluationAdmission,
		| "reviewedAgentsSha256"
		| "reviewedAgentsPresence"
		| "reviewedAgentsProofSha256"
	>,
) {
	if (
		instructions.sha256 !== admission.reviewedAgentsSha256 ||
		instructions.presence !== (admission.reviewedAgentsPresence ?? "present") ||
		instructions.backendProofSha256 !== admission.reviewedAgentsProofSha256
	)
		throw new Error(
			"Evaluation organization instructions differ from the reviewed digest or presence proof",
		);
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

/** Recheck canonical workflow and Work authority without repeating backend reads. */
export async function assertEvaluationAuthority(
	env: Cloudflare.Env,
	orgId: string,
	tediId: string,
	admission: Omit<EvaluationAdmission, "agents" | "agentsProof"> &
		Partial<Pick<EvaluationAdmission, "agents" | "agentsProof">>,
) {
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
			...(admission.reviewedAgentsPresence
				? { reviewedAgentsPresence: admission.reviewedAgentsPresence }
				: {}),
			...(admission.reviewedAgentsProofSha256
				? { reviewedAgentsProofSha256: admission.reviewedAgentsProofSha256 }
				: {}),
		},
		run,
		orgId,
		tediId,
		workflowRunId: admission.workflowRunId,
		executionEpoch: admission.executionEpoch,
	});
	const { agents: _agents, agentsProof: _proof, ...pinned } = admission;
	if (JSON.stringify(current) !== JSON.stringify(pinned))
		throw new Error("Evaluation admission changed before inference");
	await assertEvaluationWork(env, orgId, admission);
}

export async function assertEvaluationWorkflow(
	env: Cloudflare.Env,
	orgId: string,
	tediId: string,
	admission: EvaluationAdmission,
) {
	await assertEvaluationAuthority(env, orgId, tediId, admission);
	const instructions = await readEvaluationInstructions(env, tediId);
	assertReviewedInstructions(instructions, admission);
	if (
		instructions.content !== admission.agents ||
		JSON.stringify(instructions.backendProof ?? null) !==
			JSON.stringify(admission.agentsProof ?? null)
	)
		throw new Error(
			"Evaluation organization instructions changed before inference",
		);
	await assertEvaluationAuthority(env, orgId, tediId, admission);
	return instructions;
}
