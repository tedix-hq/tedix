/** Cloudflare Agents' canonical human-in-the-loop event contract. */
import type { DbClient } from "@tedix/db/client";
import {
	compareAndSetSkillRunPendingReceipt,
	insertSkillRunApprovalReceipt,
} from "@tedix/db/queries/skill-runtime-fences";
import {
	getRuntimeArtifactInlineContent,
	getSkillRunRow,
} from "@tedix/db/queries/skill-runtime-store";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { skillRuntimeDb } from "./db";
import { encodeWorkflowArtifactPathSegment } from "./workflow-path";
import { isWorkflowRetirementError } from "./workflow-retirement";

export const WORKFLOW_APPROVAL_EVENT_TYPE = "approval";

export type WorkflowApprovalDecision = "approved" | "rejected";

export class WorkflowApprovalDecisionConflictError extends Error {
	readonly code = "WORKFLOW_APPROVAL_DECISION_CONFLICT";
}

interface WorkflowApprovalReceipt {
	approvalId: string;
	executionEpoch: number;
	decision: WorkflowApprovalDecision;
	requestDigest: string;
	status: "pending" | "delivered" | "unknown";
	updatedAt: string;
}

function approvalPath(executionEpoch: number, approvalId: string): string {
	let encodedApprovalId: string;
	try {
		encodedApprovalId = encodeWorkflowArtifactPathSegment(approvalId);
	} catch {
		throw new WorkflowApprovalDecisionConflictError(
			"approvalId is invalid or too large after URI encoding",
		);
	}
	return `epochs/${executionEpoch}/controls/approvals/${encodedApprovalId}.json`;
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (!value || typeof value !== "object") return value ?? null;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, entry]) => [key, sortJson(entry)]),
	);
}

async function approvalRequestDigest(input: {
	decision: WorkflowApprovalDecision;
	reason?: string;
	payload: Record<string, unknown>;
}): Promise<string> {
	const encoded = new TextEncoder().encode(
		JSON.stringify(
			sortJson({
				decision: input.decision,
				reason: input.reason ?? null,
				payload: input.payload,
			}),
		),
	);
	return sha256Hex(encoded);
}

/** Reserve one approval decision before sendEvent so caller retries cannot
 * enqueue the same generic `approval` event twice. */
export async function claimWorkflowApprovalDecision(input: {
	db: D1Database | DbClient;
	runId: string;
	executionEpoch: number;
	approvalId: string;
	decision: WorkflowApprovalDecision;
	reason?: string;
	payload: Record<string, unknown>;
}): Promise<{
	deduplicated: boolean;
	path: string;
	requestDigest: string;
	pendingContent: string | null;
}> {
	const path = approvalPath(input.executionEpoch, input.approvalId);
	const requestDigest = await approvalRequestDigest(input);
	const receipt: WorkflowApprovalReceipt = {
		approvalId: input.approvalId,
		executionEpoch: input.executionEpoch,
		decision: input.decision,
		requestDigest,
		status: "pending",
		updatedAt: new Date().toISOString(),
	};
	const content = JSON.stringify(receipt);
	const db = skillRuntimeDb(input.db);
	const inserted = await insertSkillRunApprovalReceipt(db, {
		id: crypto.randomUUID(),
		runId: input.runId,
		path,
		content,
		createdAt: receipt.updatedAt,
		executionEpoch: input.executionEpoch,
	});
	if (inserted) {
		return {
			deduplicated: false,
			path,
			requestDigest,
			pendingContent: content,
		};
	}
	const existing = await getRuntimeArtifactInlineContent(db, input.runId, path);
	const runState = await getSkillRunRow(db, input.runId);
	if (
		runState?.workflow_retired_at != null ||
		isWorkflowRetirementError(runState?.error)
	) {
		throw new WorkflowApprovalDecisionConflictError(
			"this Workflow instance is permanently retired; approval and rejection can no longer mutate it",
		);
	}
	let prior: WorkflowApprovalReceipt | null = null;
	try {
		prior = existing?.content_inline
			? (JSON.parse(existing.content_inline) as WorkflowApprovalReceipt)
			: null;
	} catch {}
	if (!prior) {
		throw new WorkflowApprovalDecisionConflictError(
			`approval ${input.approvalId} cannot be claimed because this execution epoch is not active`,
		);
	}
	if (prior.requestDigest !== requestDigest) {
		throw new WorkflowApprovalDecisionConflictError(
			`approval ${input.approvalId} already has a different decision, reason, or payload in execution epoch ${input.executionEpoch}`,
		);
	}
	if (prior?.status !== "delivered") {
		throw new WorkflowApprovalDecisionConflictError(
			`approval ${input.approvalId} has an ambiguous or in-flight delivery; inspect the run before taking another action`,
		);
	}
	return {
		deduplicated: true,
		path,
		requestDigest,
		pendingContent: null,
	};
}

export async function finalizeWorkflowApprovalDecision(input: {
	db: D1Database | DbClient;
	runId: string;
	path: string;
	executionEpoch: number;
	approvalId: string;
	decision: WorkflowApprovalDecision;
	requestDigest: string;
	pendingContent: string;
	delivered: boolean;
}): Promise<void> {
	const receipt: WorkflowApprovalReceipt = {
		approvalId: input.approvalId,
		executionEpoch: input.executionEpoch,
		decision: input.decision,
		requestDigest: input.requestDigest,
		status: input.delivered ? "delivered" : "unknown",
		updatedAt: new Date().toISOString(),
	};
	const content = JSON.stringify(receipt);
	const db = skillRuntimeDb(input.db);
	const updated = await compareAndSetSkillRunPendingReceipt(db, {
		runId: input.runId,
		path: input.path,
		content,
		expectedContent: input.pendingContent,
		outcome: input.delivered ? "success" : "pending",
	});
	if (!updated) {
		const existing = await getRuntimeArtifactInlineContent(
			db,
			input.runId,
			input.path,
		);
		let prior: WorkflowApprovalReceipt | null = null;
		try {
			prior = existing?.content_inline
				? (JSON.parse(existing.content_inline) as WorkflowApprovalReceipt)
				: null;
		} catch {}
		if (
			prior?.approvalId === input.approvalId &&
			prior.executionEpoch === input.executionEpoch &&
			prior.decision === input.decision &&
			prior.requestDigest === input.requestDigest &&
			prior.status === (input.delivered ? "delivered" : "unknown")
		) {
			return;
		}
		throw new WorkflowApprovalDecisionConflictError(
			`approval ${input.approvalId} receipt changed while delivery was being finalized`,
		);
	}
}

export function buildWorkflowApprovalEvent(input: {
	approved: boolean;
	reason?: string;
	approvalId?: string;
	metadata?: Record<string, unknown>;
}): {
	type: typeof WORKFLOW_APPROVAL_EVENT_TYPE;
	payload: {
		approved: boolean;
		reason?: string;
		metadata?: Record<string, unknown>;
	};
} {
	const metadata = {
		...input.metadata,
		...(input.approvalId ? { approvalId: input.approvalId } : {}),
	};
	return {
		type: WORKFLOW_APPROVAL_EVENT_TYPE,
		payload: {
			approved: input.approved,
			...(input.reason ? { reason: input.reason } : {}),
			...(Object.keys(metadata).length > 0 ? { metadata } : {}),
		},
	};
}
