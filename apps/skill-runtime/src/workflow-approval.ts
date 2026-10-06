/** Cloudflare Agents' canonical human-in-the-loop event contract. */
import { sha256Hex } from "@tedix/worker-kit/crypto";
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
	db: D1Database;
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
	const result = await input.db
		.prepare(
			`INSERT INTO skill_run_artifacts (
			   id, run_id, path, mime_type, size_bytes, content_inline,
			   attempt, outcome, created_at
			 )
			 SELECT ?1, ?2, ?3, 'application/json', ?4, ?5, 1, 'pending', ?6
			 WHERE EXISTS (
			   SELECT 1 FROM skill_runs
			    WHERE id = ?2
			      AND execution_epoch = ?7
			      AND restart_requested_at IS NULL
			      AND workflow_retired_at IS NULL
			      AND COALESCE(error, '') <> 'REVOKED'
			      AND COALESCE(error, '') NOT GLOB 'REVOKED:*'
			      AND status NOT IN ('completed','failed','canceled')
			 )
			 ON CONFLICT(run_id, path) DO NOTHING`,
		)
		.bind(
			crypto.randomUUID(),
			input.runId,
			path,
			new TextEncoder().encode(content).byteLength,
			content,
			receipt.updatedAt,
			input.executionEpoch,
		)
		.run();
	if ((result.meta?.changes ?? 0) > 0) {
		return {
			deduplicated: false,
			path,
			requestDigest,
			pendingContent: content,
		};
	}
	const existing = await input.db
		.prepare(
			`SELECT content_inline FROM skill_run_artifacts
			 WHERE run_id = ?1 AND path = ?2 LIMIT 1`,
		)
		.bind(input.runId, path)
		.first<{ content_inline: string | null }>();
	const runState = await input.db
		.prepare(
			`SELECT workflow_retired_at, error FROM skill_runs
			 WHERE id = ?1 LIMIT 1`,
		)
		.bind(input.runId)
		.first<{ workflow_retired_at: string | null; error: string | null }>();
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
	db: D1Database;
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
	const result = await input.db
		.prepare(
			`UPDATE skill_run_artifacts
			 SET content_inline = ?3, size_bytes = ?4, outcome = ?5
			 WHERE run_id = ?1 AND path = ?2
			   AND content_inline = ?6 AND outcome = 'pending'`,
		)
		.bind(
			input.runId,
			input.path,
			content,
			new TextEncoder().encode(content).byteLength,
			input.delivered ? "success" : "pending",
			input.pendingContent,
		)
		.run();
	if ((result.meta?.changes ?? 0) !== 1) {
		const existing = await input.db
			.prepare(
				`SELECT content_inline FROM skill_run_artifacts
				 WHERE run_id = ?1 AND path = ?2 LIMIT 1`,
			)
			.bind(input.runId, input.path)
			.first<{ content_inline: string | null }>();
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
