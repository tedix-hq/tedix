import { baseErrorConstructors } from "@tedix/api-contract/errors";
import {
	prepareWorkAdmission,
	WorkAdmissionError,
	previewWorkAdmission,
} from "@tedix/db/queries/work-items/admissions";
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

export const WORK_ATTEMPT_LEASE_TTL_MS = 5 * 60_000;

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
			executor: { type: "human" | "tedi"; id: string };
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

async function assertWorkAttemptPolicy(
	db: BaseContext["db"],
	params: Omit<AttemptAdmissionParams, "leaseTtlMs">,
) {
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
			maxAttempts: current.maxAttempts ?? 0,
			execution: {
				workKind: current.workKind,
				riskLevel: current.riskLevel,
				requiredCapabilities: current.requiredCapabilities,
				requiredAuthorities: current.requiredAuthorities,
			},
		});
	}
}

/** The same actor and factory checks as start, without a persisted admission. */
export async function previewWorkAttempt(
	db: BaseContext["db"],
	params: Omit<AttemptAdmissionParams, "leaseTtlMs">,
) {
	await assertWorkAttemptPolicy(db, params);
	return previewWorkAdmission(db, {
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
		now: params.now,
	});
}

/** Prepare one atomic start from the current Work and credential-derived executor. */
export async function admitWorkAttempt(
	db: BaseContext["db"],
	params: AttemptAdmissionParams,
) {
	await assertWorkAttemptPolicy(db, params);
	try {
		return await prepareWorkAdmission(db, {
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
	} catch (error) {
		if (!(error instanceof WorkAdmissionError)) throw error;
		const reason = error.message.replace(/^NOT_ELIGIBLE: /, "");
		throw baseErrorConstructors.CONFLICT({
			message: reason,
			data: { rejectionCode: error.rejectionCode, reason },
			cause: error,
		});
	}
}
