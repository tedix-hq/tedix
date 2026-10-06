import { evaluateAndRecordWorkAdmission } from "@tedix/db/queries/work-items/admissions";
import { getWorkAdmissionSpecification } from "@tedix/db/queries/work-items/admissions";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import { listWorkItemAttempts } from "@tedix/db/queries/work-items/attempts";
import {
	readFactoryCycle,
	requireFactoryAcceptance,
	requireFactoryAdmission,
} from "../../../services/factory-cycle";
import type { BaseContext } from "../../orpc";
import { createError, ErrorCodes } from "../../orpc";
import { ORPCError } from "@orpc/server";

export const WORK_ATTEMPT_ADMISSION_TTL_MS = 5 * 60_000;

type AttemptAdmissionParams = {
	workItem: {
		id: string;
		orgId: string;
		version: number;
		admissionSpecRevision: string;
	};
	leaseTtlMs: number;
	now: string;
} & (
	| {
			executor: { type: "tedi"; id: string };
			externalSessionKey?: never;
	  }
	| {
			executor: {
				type: "external_agent";
				id: string;
				sessionId: string;
			};
			externalSessionKey: string;
	  }
);

/**
 * Mint a fresh immutable admission receipt from the current Work Item and
 * credential-derived executor. Callers never select or replay a receipt id.
 */
export async function admitWorkAttempt(
	db: BaseContext["db"],
	params: AttemptAdmissionParams,
): Promise<{ id: string; expiresAt: string }> {
	// Kernel delegation and direct starts resolve the same persisted policy.
	const current = await getWorkItemById(
		db,
		params.workItem.id,
		params.workItem.orgId,
	);
	if (
		!current ||
		current.version !== params.workItem.version ||
		current.admissionSpecRevision !== params.workItem.admissionSpecRevision
	) {
		throw createError(
			ErrorCodes.CONFLICT,
			"Work changed before admission; reload the current specification",
		);
	}
	if (readFactoryCycle(current.metadata)) {
		if (!current.acceptanceContract)
			throw createError(
				ErrorCodes.CONFLICT,
				"Factory Work requires acceptance before admission",
			);
		requireFactoryAcceptance(current.metadata, current.acceptanceContract);
		const [specification, attempts] = await Promise.all([
			getWorkAdmissionSpecification(db, {
				orgId: current.orgId,
				workItemId: current.id,
			}),
			listWorkItemAttempts(db, {
				orgId: current.orgId,
				workItemId: current.id,
				limit: 5,
			}),
		]);
		requireFactoryAdmission({
			metadata: current.metadata,
			specification: {
				resources: specification.resources,
				budget: specification.budget,
			},
			attemptCount: attempts.data.length,
			execution: {
				workKind: current.workKind,
				riskLevel: current.riskLevel,
				requiredCapabilities: current.requiredCapabilities,
				requiredAuthorities: current.requiredAuthorities,
			},
		});
	}
	const admission = await evaluateAndRecordWorkAdmission(db, {
		id: crypto.randomUUID(),
		orgId: params.workItem.orgId,
		workItemId: params.workItem.id,
		expectedWorkItemVersion: params.workItem.version,
		expectedAdmissionSpecRevision: params.workItem.admissionSpecRevision,
		executorType: params.executor.type,
		executorId: params.executor.id,
		executorSessionId:
			params.executor.type === "external_agent"
				? params.executor.sessionId
				: undefined,
		externalSessionKey: params.externalSessionKey,
		leaseTtlMs: params.leaseTtlMs,
		now: params.now,
	});
	if (admission.decision !== "admitted") {
		const reason =
			admission.rejectionReason ?? "Work Item is not eligible for admission";
		throw new ORPCError(ErrorCodes.CONFLICT, {
			message: reason,
			data: admission.rejectionCode
				? { rejectionCode: admission.rejectionCode, reason }
				: undefined,
		});
	}
	return { id: admission.id, expiresAt: admission.expiresAt };
}
