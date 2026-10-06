import type {
	HarnessInspection,
	SubmissionRecord,
} from "@earendil-works/pi-durable";
import {
	TediRuntimeRecoveryDiagnosticResponseSchema,
	TediRuntimeRecoveryQuerySchema,
	type TediRuntimeRecoveryDiagnosticResponse,
} from "@tedix/api-contract/schemas/tedi";

function submissionMetadata(row: SubmissionRecord) {
	return {
		id: row.id,
		conversationId: row.conversationId,
		operationId: row.requestId ?? null,
		type: row.type,
		status: row.status,
	};
}

/** Projection deliberately constructs each field; native task payloads never cross this boundary. */
export function projectPiRecovery(input: {
	sessionKey: string;
	conversationId: number;
	inspection: HarnessInspection;
	operation?: SubmissionRecord;
	now?: string;
}): TediRuntimeRecoveryDiagnosticResponse {
	const tasks = input.inspection.tasks.filter(
		(view) => view.record.conversationId === input.conversationId,
	);
	const submissions = input.inspection.submissions.filter(
		(row) => row.conversationId === input.conversationId,
	);
	return TediRuntimeRecoveryDiagnosticResponseSchema.parse({
		ok: true,
		runtime: "pi",
		sessionKey: input.sessionKey,
		sampledAt: input.now ?? new Date().toISOString(),
		conversationId: input.conversationId,
		scheduling: input.inspection.scheduling,
		operation: input.operation ? submissionMetadata(input.operation) : null,
		tasks: tasks.slice(0, 50).map((view) => ({
			id: view.record.id,
			conversationId: view.record.conversationId,
			kind: view.record.kind,
			owner: view.record.owner ?? null,
			background: view.record.background,
			abortRequested: view.record.abortRequested,
			status: view.record.state.status,
			view: view.state.kind,
			blockedReason: view.state.kind === "blocked" ? view.state.reason : null,
			waitingOn:
				view.state.kind === "waiting" ? view.state.on.slice(0, 20) : [],
			waitingOnTruncated:
				view.state.kind === "waiting" && view.state.on.length > 20,
		})),
		submissions: submissions.slice(0, 50).map(submissionMetadata),
		taskCount: tasks.length,
		submissionCount: submissions.length,
		truncated: tasks.length > 50 || submissions.length > 50,
	});
}

/** Lookup is gated before get(), which would otherwise register a new child. */
export async function inspectExistingPiFacet<T>(input: {
	sessionKey: string;
	operationId?: string;
	has: (name: string) => boolean;
	get: (name: string) => Promise<{
		inspectRecovery(sessionKey: string, operationId?: string): Promise<T>;
	}>;
}): Promise<T> {
	TediRuntimeRecoveryQuerySchema.parse({
		sessionKey: input.sessionKey,
		operationId: input.operationId,
	});
	const name = input.sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
	if (!input.has(name)) throw new Error("pi_recovery_session_unavailable");
	return (await input.get(name)).inspectRecovery(
		input.sessionKey,
		input.operationId,
	);
}
