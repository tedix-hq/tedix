/**
 * Work Items — purpose-resolution section module: project validation, the
 * canonical purpose-context defaults, the active-purpose execution boundary,
 * and the create/update purpose resolver. Mechanical slice of the original
 * `work-items.ts`.
 */

import { and, eq, gt, inArray, isNotNull, or } from "drizzle-orm";
import type { DbClient } from "../../client";
import { projects } from "../../schema/projects";
import { tediObjectives } from "../../schema/tedi-objectives";
import {
	type WorkItem,
	type WorkItemClass,
	workItems,
} from "../../schema/work-items";

export class WorkItemProjectError extends Error {
	constructor(
		readonly code: "not_found" | "wrong_org",
		message: string,
	) {
		super(message);
		this.name = "WorkItemProjectError";
	}
}

export class WorkItemPurposeError extends Error {
	constructor(
		readonly code:
			| "context_conflict"
			| "context_required"
			| "objective_not_found"
			| "objective_wrong_org"
			| "objective_inactive"
			| "exception_invalid",
		message: string,
	) {
		super(message);
		this.name = "WorkItemPurposeError";
	}
}

export async function assertValidWorkItemProject(
	db: DbClient,
	params: { orgId: string; projectId: string },
): Promise<{ key: string; objectiveId: string | null }> {
	const rows = await db
		.select({
			orgId: projects.orgId,
			key: projects.key,
			objectiveId: projects.objectiveId,
		})
		.from(projects)
		.where(eq(projects.id, params.projectId))
		.limit(1);
	const project = rows[0];
	if (!project) {
		throw new WorkItemProjectError(
			"not_found",
			`Project ${params.projectId} not found`,
		);
	}
	if (project.orgId !== params.orgId) {
		throw new WorkItemProjectError(
			"wrong_org",
			"Project belongs to a different organization",
		);
	}
	return { key: project.key, objectiveId: project.objectiveId };
}

/** Maximum lifetime of a non-objective operational exception. */
export const WORK_ITEM_PURPOSE_EXCEPTION_MAX_MS = 30 * 24 * 60 * 60 * 1000;

/** Default lifetime of a non-objective operational exception. */
export const DEFAULT_PURPOSE_EXCEPTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Canonical purpose-context defaults for internal work-item creators. Returns
 * the exact fields a creator spreads into `createWorkItem`: the objective link
 * when one exists, otherwise the caller's operational class with a bounded
 * exception expiry (default 7 days from `now`).
 *
 * Surfaces that do not import `@tedix/db` (e.g. `apps/tedi-runtime/src/brain`)
 * mirror this policy locally with a comment pointing here.
 */
export function workItemPurposeFor(input: {
	objectiveId?: string | null;
	workClass: WorkItemClass;
	ttlMs?: number;
	now?: Date;
}):
	| { objectiveId: string }
	| { workClass: WorkItemClass; purposeExceptionExpiresAt: string } {
	if (input.objectiveId) return { objectiveId: input.objectiveId };
	const nowMs = (input.now ?? new Date()).getTime();
	return {
		workClass: input.workClass,
		purposeExceptionExpiresAt: new Date(
			nowMs + (input.ttlMs ?? DEFAULT_PURPOSE_EXCEPTION_TTL_MS),
		).toISOString(),
	};
}

/**
 * Admission boundary for purpose context. Objective work needs its objective
 * intact, and an operational exception stops being eligible when it expires.
 *
 * Undeclared purpose (`work_class IS NULL`) is NOT admissible. Nullable
 * `work_class` was a read-side migration grace period so the pre-contract board
 * stayed operable; it was never authority to schedule work nobody declared a
 * reason for. Because this predicate's only consumer is the ready-queue
 * candidate filter, that grace period silently made a closed cohort of legacy
 * rows (none created since purpose enforcement shipped) compete for admission ahead of declared work. Those rows
 * stay readable, cancellable, and completable — they simply stop being
 * scheduled.
 */
export function activePurposeContext(at: string) {
	return or(
		and(eq(workItems.workClass, "objective"), isNotNull(workItems.objectiveId)),
		and(
			inArray(workItems.workClass, ["maintenance", "incident", "hygiene"]),
			gt(workItems.purposeExceptionExpiresAt, at),
		),
	)!;
}

export function hasActivePurposeContext(
	item: Pick<
		WorkItem,
		"workClass" | "objectiveId" | "purposeExceptionExpiresAt"
	>,
	at: string,
): boolean {
	// Undeclared purpose is not an active purpose context. See
	// `activePurposeContext` for why the legacy null grace period ended.
	if (item.workClass === null) return false;
	if (item.workClass === "objective") return item.objectiveId !== null;
	return Boolean(
		item.purposeExceptionExpiresAt && item.purposeExceptionExpiresAt > at,
	);
}
/**
 * The operational purpose window an acceptance leaves behind. Acceptance is a
 * fresh owner decision that the work is wanted now, so it re-asserts the
 * default window from the acceptance instant. Without this, work filed into a
 * project more than seven days before it was accepted came out of `accept`
 * already `purpose_blocked`, and only an owner/admin specification edit could
 * free it. The window never shortens, never outlives an operational parent's,
 * and objective or undeclared purpose is left alone. Returns null when nothing
 * changes.
 */
export function acceptanceRenewedPurposeExpiry(
	item: Pick<WorkItem, "workClass" | "purposeExceptionExpiresAt">,
	parent: Pick<WorkItem, "workClass" | "purposeExceptionExpiresAt"> | null,
	acceptedAt: string,
): string | null {
	if (
		item.workClass !== "maintenance" &&
		item.workClass !== "incident" &&
		item.workClass !== "hygiene"
	)
		return null;
	const acceptedMs = Date.parse(acceptedAt);
	if (!Number.isFinite(acceptedMs)) return null;
	let renewedMs = acceptedMs + DEFAULT_PURPOSE_EXCEPTION_TTL_MS;
	const parentExpiry =
		parent?.workClass && parent.workClass !== "objective"
			? parent.purposeExceptionExpiresAt
			: null;
	if (parentExpiry) {
		const parentMs = Date.parse(parentExpiry);
		if (Number.isFinite(parentMs)) renewedMs = Math.min(renewedMs, parentMs);
	}
	const currentMs = item.purposeExceptionExpiresAt
		? Date.parse(item.purposeExceptionExpiresAt)
		: Number.NaN;
	if (renewedMs <= acceptedMs) return null;
	if (Number.isFinite(currentMs) && currentMs >= renewedMs) return null;
	return new Date(renewedMs).toISOString();
}

export type PurposeParent = Pick<
	WorkItem,
	"id" | "objectiveId" | "workClass" | "purposeExceptionExpiresAt" | "projectId"
>;

export async function resolveWorkItemPurpose(
	db: DbClient,
	params: {
		orgId: string;
		now: string;
		objectiveId?: string | null;
		workClass?: WorkItemClass | null;
		purposeExceptionExpiresAt?: string | null;
		parent?: PurposeParent | null;
		project?: { key?: string; objectiveId: string | null } | null;
		/**
		 * Accept an already-stored expiry that has lapsed, instead of re-asserting
		 * it. Set ONLY when the caller supplied no purpose field and the value is
		 * therefore the row's own, carried forward unchanged.
		 *
		 * Freshness is an assertion about work someone is presenting for admission NOW.
		 * Re-judging a value the caller never touched turns every later edit into a
		 * purpose renewal, and combined with the children-immutability rule it made
		 * a parent with a lapsed window permanently uneditable — not even
		 * `projectId` could be set on it (4 rows stranded during the org-wide
		 * project backfill: 924d699c, 219e0688, cdd862b0, 6863dd81). A lapsed
		 * window still keeps the item out of the admission queue because
		 * `activePurposeContext` is the purpose eligibility predicate.
		 */
		allowStoredExpiry?: boolean;
	},
): Promise<{
	objectiveId: string | null;
	workClass: WorkItemClass;
	purposeExceptionExpiresAt: string | null;
}> {
	const parentOperationalClass =
		params.parent?.workClass && params.parent.workClass !== "objective"
			? params.parent.workClass
			: null;
	const objectiveSources = [
		params.objectiveId,
		params.parent?.objectiveId,
		params.project?.objectiveId,
	].filter((value): value is string => Boolean(value));
	const distinctObjectives = [...new Set(objectiveSources)];
	if (distinctObjectives.length > 1) {
		throw new WorkItemPurposeError(
			"context_conflict",
			`PURPOSE_CONFLICT: objectiveId=${params.objectiveId ?? "none"}, parent ${params.parent?.id ?? "none"} objectiveId=${params.parent?.objectiveId ?? "none"}, project ${params.project?.key ?? "(unspecified)"} objectiveId=${params.project?.objectiveId ?? "none"}. Set --objective to the inherited objective, or omit --objective; parent and project must reference the same objective.`,
		);
	}

	const objectiveId = distinctObjectives[0] ?? null;
	if (objectiveId) {
		// Operational defaults yield to inherited objectives; an explicit objective
		// plus expiry or an operational parent is still a contradictory purpose.
		if (
			parentOperationalClass ||
			(params.objectiveId && params.purposeExceptionExpiresAt)
		) {
			throw new WorkItemPurposeError(
				"context_conflict",
				parentOperationalClass
					? `PURPOSE_CONFLICT: parent ${params.parent!.id} has operational class ${parentOperationalClass}, but the requested objective is ${objectiveId}. Omit --objective and use a project without an objective, or choose an objective-linked parent.`
					: `PURPOSE_CONFLICT: explicit objective ${objectiveId} cannot carry expiry ${params.purposeExceptionExpiresAt}. Omit --class and --expires for objective work.`,
			);
		}
		const rows = await db
			.select({ orgId: tediObjectives.orgId, status: tediObjectives.status })
			.from(tediObjectives)
			.where(eq(tediObjectives.id, objectiveId))
			.limit(1);
		const objective = rows[0];
		if (!objective) {
			throw new WorkItemPurposeError(
				"objective_not_found",
				`Objective ${objectiveId} not found`,
			);
		}
		if (objective.orgId !== params.orgId) {
			throw new WorkItemPurposeError(
				"objective_wrong_org",
				"Objective belongs to a different organization",
			);
		}
		if (objective.status !== "active") {
			throw new WorkItemPurposeError(
				"objective_inactive",
				`Objective ${objectiveId} is ${objective.status}; Work purpose requires an active objective`,
			);
		}
		return {
			objectiveId,
			workClass: "objective",
			purposeExceptionExpiresAt: null,
		};
	}

	if (params.workClass === "objective") {
		throw new WorkItemPurposeError(
			"context_required",
			"PURPOSE_REQUIRED: workClass=objective requires an objectiveId, objective-linked parent, or objective-linked project",
		);
	}
	if (
		parentOperationalClass &&
		params.workClass &&
		params.workClass !== parentOperationalClass
	) {
		throw new WorkItemPurposeError(
			"context_conflict",
			"PURPOSE_CONFLICT: a child operational class must agree with its parent",
		);
	}
	// A project without an objective is still a declared home for the work, so
	// filing into it defaults to bounded maintenance rather than failing
	// approval of a create that never named a class.
	const workClass =
		params.workClass ??
		parentOperationalClass ??
		(params.project ? "maintenance" : null);
	const purposeExceptionExpiresAt =
		params.purposeExceptionExpiresAt ??
		params.parent?.purposeExceptionExpiresAt ??
		(workClass
			? new Date(
					Date.parse(params.now) + DEFAULT_PURPOSE_EXCEPTION_TTL_MS,
				).toISOString()
			: null);
	if (!workClass || !purposeExceptionExpiresAt) {
		throw new WorkItemPurposeError(
			"context_required",
			"PURPOSE_REQUIRED: new work needs an objective context or a maintenance/incident/hygiene class with a bounded expiry",
		);
	}
	const nowMs = Date.parse(params.now);
	const expiryMs = Date.parse(purposeExceptionExpiresAt);
	// A malformed value is always rejected; only the WINDOW bounds are waived for
	// a carried-forward expiry, because those bounds judge a fresh assertion.
	const boundsViolated =
		!params.allowStoredExpiry &&
		(expiryMs <= nowMs ||
			expiryMs > nowMs + WORK_ITEM_PURPOSE_EXCEPTION_MAX_MS);
	if (!Number.isFinite(nowMs) || !Number.isFinite(expiryMs) || boundsViolated) {
		throw new WorkItemPurposeError(
			"exception_invalid",
			"PURPOSE_EXCEPTION_INVALID: operational work must expire in the future and no more than 30 days from the write",
		);
	}
	const parentExpiryMs = params.parent?.purposeExceptionExpiresAt
		? Date.parse(params.parent.purposeExceptionExpiresAt)
		: null;
	if (
		parentExpiryMs !== null &&
		Number.isFinite(parentExpiryMs) &&
		expiryMs > parentExpiryMs
	) {
		throw new WorkItemPurposeError(
			"context_conflict",
			"PURPOSE_CONFLICT: a child operational exception cannot outlive its parent",
		);
	}
	return { objectiveId: null, workClass, purposeExceptionExpiresAt };
}
