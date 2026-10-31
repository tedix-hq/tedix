/**
 * Deterministic identities for MCP calls made by durable workflow steps.
 *
 * The idempotency identity intentionally excludes the engine attempt so a
 * retry of the same logical call presents the same key to an upstream tool.
 * The call identity includes the attempt and is therefore unique in the run's
 * audit trail. The ordinal is allocated synchronously inside each step attempt
 * before any async work begins, which keeps parallel calls deterministic.
 */

import {
	deriveHkdfHmacKey,
	hmacSha256,
	sha256Hex,
} from "@tedix/worker-kit/crypto";

/** Explicit keys may poll the same task from later steps, but never another
 * workflow or epoch. The host secret prevents pre-seeding the native run ID.
 */
export async function scopedWorkflowTediClientKey(input: {
	organizationId: string;
	runId: string;
	executionEpoch: number;
	tediId: string;
	clientKey: string;
	secret: string;
}): Promise<string> {
	const digest = await hmacSha256(
		await deriveHkdfHmacKey(input.secret, "workflow-tedi-client-key:v1"),
		JSON.stringify([
			input.organizationId,
			input.runId,
			input.executionEpoch,
			input.tediId,
			input.clientKey,
		]),
	);
	return (
		"wftedi_" +
		Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
	);
}

export interface WorkflowMcpCallContext {
	stepName: string;
	stepCount: number;
	stepType: "do";
	attempt: number;
	phase: "run" | "rollback";
	ordinal: number;
}

export interface WorkflowMcpCallIdentity {
	stepId: string;
	idempotencyKey: string;
	callId: string;
}

function frame(parts: Array<string | number>): string {
	return parts
		.map((part) => {
			const value = String(part);
			return `${value.length}:${value}`;
		})
		.join("|");
}

export async function buildWorkflowMcpCallIdentity(input: {
	runId: string;
	executionEpoch: number;
	namespace: string;
	method: string;
	context: WorkflowMcpCallContext;
}): Promise<WorkflowMcpCallIdentity> {
	const { runId, executionEpoch, namespace, method, context } = input;
	const stepHash = await sha256Hex(
		frame([
			runId,
			executionEpoch,
			context.stepType,
			context.stepName,
			context.stepCount,
		]),
	);
	const idempotencyHash = await sha256Hex(
		frame([
			runId,
			executionEpoch,
			context.stepType,
			context.stepName,
			context.stepCount,
			context.phase,
			namespace,
			method,
			context.ordinal,
		]),
	);
	const callHash = await sha256Hex(frame([idempotencyHash, context.attempt]));
	return {
		stepId: `wfstep_${stepHash}`,
		idempotencyKey: `wfidem_${idempotencyHash}`,
		callId: `wfcall_${callHash}`,
	};
}

export function isWorkflowMcpCallContext(
	value: unknown,
): value is WorkflowMcpCallContext {
	if (!value || typeof value !== "object") return false;
	const input = value as Partial<WorkflowMcpCallContext>;
	return (
		typeof input.stepName === "string" &&
		input.stepName.length > 0 &&
		input.stepType === "do" &&
		Number.isSafeInteger(input.stepCount) &&
		(input.stepCount ?? 0) >= 1 &&
		Number.isSafeInteger(input.attempt) &&
		(input.attempt ?? 0) >= 1 &&
		(input.phase === "run" || input.phase === "rollback") &&
		Number.isSafeInteger(input.ordinal) &&
		(input.ordinal ?? 0) >= 1
	);
}
