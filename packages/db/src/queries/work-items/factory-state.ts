import { and, eq } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	type WorkActorType,
	type WorkItem,
	workItems,
	workItemStoredColumns,
} from "../../schema/work-items";
import { normalizeWorkItemRow } from "./normalization";

export const ACTIVE_ATTEMPT_STATES = [
	"queued",
	"running",
	"waiting",
	"retrying",
] as const;

export type WorkActor = {
	type: WorkActorType;
	id: string;
	sessionId?: string;
	/**
	 * A verified owner delegation (the organization's lead-agent setting): the
	 * actor completes on behalf of this owner, fenced to the settled Attempt
	 * named by `attemptId`. Set only by the authorization layer after it
	 * re-checks the policy and the Attempt's settled commit.
	 */
	delegatedCompletion?: {
		onBehalfOf: { type: "user" | "tedi"; id: string };
		attemptId: string;
	};
};

export type WorkExecutor = {
	type: "human" | "tedi" | "external_agent";
	id: string;
};

export class WorkFactoryError extends Error {
	constructor(
		readonly code:
			| "NOT_FOUND"
			| "NOT_READY"
			| "STALE_ATTEMPT"
			| "ACCEPTANCE_REQUIRED"
			| "EVIDENCE_REQUIRED"
			| "INDEPENDENT_REVIEW_REQUIRED"
			| "EVIDENCE_CONFLICT",
		message: string,
	) {
		super(`${code}: ${message}`);
		this.name = "WorkFactoryError";
	}
}

export async function getScopedWorkItem(
	db: DbQueryClient,
	orgId: string,
	workItemId: string,
): Promise<WorkItem> {
	const item = (
		await db
			.select(workItemStoredColumns)
			.from(workItems)
			.where(and(eq(workItems.orgId, orgId), eq(workItems.id, workItemId)))
			.limit(1)
	)[0];
	if (!item) {
		throw new WorkFactoryError(
			"NOT_FOUND",
			`Work Item ${workItemId} was not found`,
		);
	}
	return normalizeWorkItemRow(item);
}
