import type { z } from "zod";
/** Immutable provider estimates. This service never settles customer usage. */
import { reportedCostDecimalToMicros } from "@tedix/api-contract/schemas/provider-cost-evidence";
import { isPlatformPrincipal } from "@tedix/auth/types";
import { ORPCError } from "@orpc/server";
import {
	computeCostMicros,
	type ProviderTokenRates,
	type ProviderTokenUsage,
} from "@tedix/db/utils/model-pricing";

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const refuse = (message: string): never => {
	throw new ORPCError("CONFLICT", { message });
};

/** Exact canonical USD decimal, rounded UP to microUSD without IEEE754. */
export function reportedEstimateMicros(decimal: string): number {
	try {
		return reportedCostDecimalToMicros(decimal);
	} catch {
		return refuse("Unsupported or unsafe reported estimate decimal");
	}
}

export function rateEstimateMicros(
	rates: ProviderTokenRates,
	usage: ProviderTokenUsage,
): number {
	const micros = computeCostMicros(rates, usage);
	if (micros === null)
		return refuse("Rate estimate facts are incomplete or unsafe");
	return Number(micros);
}

/** Validate the WHOLE approved finite manifest before any per-record append. */
export function assertManifestCostCaps(
	records: readonly {
		calculatedMicros: number;
		expectedCostMicros: number;
		maxMicros: number;
	}[],
	maximum: number,
): number {
	if (
		records.length === 0 ||
		records.length > 20 ||
		!Number.isSafeInteger(maximum) ||
		maximum < 0
	)
		return refuse("Invalid finite estimate manifest cap");
	let total = 0n;
	for (const row of records) {
		if (
			![row.calculatedMicros, row.expectedCostMicros, row.maxMicros].every(
				(x) => Number.isSafeInteger(x) && x >= 0,
			) ||
			row.calculatedMicros !== row.expectedCostMicros ||
			row.calculatedMicros > row.maxMicros
		)
			return refuse("Estimate does not match approved record cap");
		total += BigInt(row.calculatedMicros);
	}
	if (total > MAX_SAFE || total > BigInt(maximum))
		return refuse("Estimate manifest exceeds complete cap");
	return Number(total);
}

import {
	RecordProviderCostEvidenceResponseSchema,
	ProviderCostFinancialManifestSchema,
	RecordProviderCostEvidenceInputSchema,
	providerCostEvidenceDigest,
	type RecordProviderCostEvidenceInput,
} from "@tedix/api-contract/schemas/provider-cost-evidence";
import { createDbClient } from "@tedix/db/client";
import {
	getProviderCostEvidenceApproval,
	getProviderCostEvidenceAuthorityBundle,
	getProviderCostEvidenceSource,
	getProviderCostEvidenceCurrent,
	getProviderCostEvidenceByIdempotency,
	getProviderCostEvidenceRelationships,
	providerCostEvidenceIdentityDigest,
	buildAppendProviderCostEvidenceStatement,
	executeProviderCostEvidenceBatch,
	type NewProviderCostEvidenceRow,
} from "@tedix/db/queries/billing/provider-cost-evidence";
import type { BaseContext } from "../rpc/orpc";
import { resolveFleetAuthorityBinding } from "../lib/fleet-authority";
import { verifiedExternalAgent } from "../rpc/routers/work-items-principal";

const finiteFuture = (value: string | null | undefined, now: number) =>
	typeof value === "string" &&
	Number.isFinite(Date.parse(value)) &&
	Date.parse(value) > now;

/** Authority verification and atomic INSERT share one explicit co-located D1. */
export async function recordProviderCostEvidence(
	context: BaseContext,
	supplied: RecordProviderCostEvidenceInput,
) {
	if (context.authType === "tedi" || !isPlatformPrincipal(context))
		throw new ORPCError("FORBIDDEN", {
			message: "Non-tedi platform billing authority is required",
		});
	const input = RecordProviderCostEvidenceInputSchema.parse(supplied);
	const started = Date.now();
	const bounded = () => {
		if (Date.now() - started >= 30_000)
			refuse("Evidence request deadline exceeded");
	};
	const db = createDbClient(resolveFleetAuthorityBinding(context.env));
	const organizationId = context.organizationId;
	if (!organizationId)
		throw new ORPCError("FORBIDDEN", {
			message: "Original organization is required",
		});
	// The request may use a session wrapper; verify the credential on the same
	// concrete binding as the canonical financial reads and INSERT instead.
	const external = await verifiedExternalAgent(
		{ ...context, db },
		organizationId,
	);
	if (!external)
		throw new ORPCError("FORBIDDEN", {
			message: "Verified external agent is required",
		});
	const approval = await getProviderCostEvidenceApproval(
		db,
		organizationId,
		input.approvalProposalId,
		input.approvalDecisionId,
	);
	if (!approval) return refuse("Canonical financial approval is missing");
	const { proposal, decision } = approval;
	const manifest = ProviderCostFinancialManifestSchema.parse(proposal.proposal);
	const bundle = await getProviderCostEvidenceAuthorityBundle(
		db,
		organizationId,
		input.financialWorkItemId,
		input.attemptId,
	);
	const work = bundle.work;
	if (
		!work ||
		work.orgId !== organizationId ||
		work.id !== manifest.financialWorkItemId ||
		work.id !== input.financialWorkItemId ||
		work.version !== manifest.workVersion ||
		work.admissionSpecRevision !== manifest.specRevision ||
		work.disposition !== "accepted" ||
		proposal.workItemId !== work.id ||
		proposal.workItemVersion !== work.version ||
		proposal.action !== manifest.action ||
		proposal.status !== "approved" ||
		decision.decision !== "approved" ||
		decision.resolvedProposalVersion !== proposal.version ||
		decision.deciderId !== proposal.approverId ||
		decision.deciderType !== proposal.approverType ||
		proposal.approverId !== manifest.designatedApproverId ||
		!work.requiredAuthorities.includes(proposal.authorityKey) ||
		manifest.organizationId !== organizationId ||
		context.env.GIT_SHA !== manifest.deliveredSourceSha
	)
		return refuse(
			"Canonical financial authority or delivered source does not match",
		);
	const calculated = manifest.records.map((record) => {
		const f = record.facts;
		return f.pricingBasis === "reported_estimate"
			? reportedEstimateMicros(f.reportedCostDecimal)
			: rateEstimateMicros(
					{
						inputMicrousdPerMillion: f.inputPriceMicrosPerMillion,
						outputMicrousdPerMillion: f.outputPriceMicrosPerMillion,
						cacheReadMicrousdPerMillion: f.cacheReadPriceMicrosPerMillion,
						cacheWriteMicrousdPerMillion: f.cacheWritePriceMicrosPerMillion,
					},
					f.usage,
				);
	});
	assertManifestCostCaps(
		manifest.records.map((r, i) => ({
			calculatedMicros: calculated[i]!,
			expectedCostMicros: r.expectedCostMicros,
			maxMicros: r.maxCostMicros,
		})),
		manifest.manifestMaxMicros,
	);
	for (const record of manifest.records)
		if (
			(await providerCostEvidenceDigest("basis", record.facts)) !==
			record.basisFactsDigest
		)
			refuse("Approved basis digest differs from complete facts");
	// Preflight the complete response budget before allowing any partial append.
	if (new TextEncoder().encode(JSON.stringify(manifest)).length > 900_000)
		refuse("Approved facts exceed bounded response budget");
	if (input.mode === "append") {
		const { attempt, admission } = bundle;
		const now = Date.now();
		if (
			!finiteFuture(proposal.expiresAt, now) ||
			!finiteFuture(manifest.expiresAt, now) ||
			!attempt ||
			!admission ||
			attempt.id !== input.attemptId ||
			attempt.runtimeState !== "running" ||
			attempt.outcome !== null ||
			attempt.finishedAt !== null ||
			!finiteFuture(attempt.expiresAt, now) ||
			attempt.executorType !== "external_agent" ||
			attempt.executorId !== external.executor.id ||
			attempt.executorSessionId !== external.executor.sessionId ||
			attempt.externalSessionKey !== external.externalSessionKey ||
			admission.decision !== "admitted" ||
			admission.workItemId !== work.id ||
			admission.workItemVersion !== work.version ||
			admission.admissionSpecRevision !== work.admissionSpecRevision ||
			!finiteFuture(admission.expiresAt, now) ||
			bundle.requirements.some(
				(required) =>
					!bundle.resources.some(
						(resource) =>
							resource.resourceKey === required.resourceKey &&
							resource.quantity === required.quantity &&
							resource.state === "active" &&
							finiteFuture(resource.expiresAt, now),
					),
			)
		)
			return refuse(
				"Fresh matching financial admission and resources are required",
			);
	}
	const manifestDigest = await providerCostEvidenceDigest("manifest", manifest);
	type ResultRecord = z.infer<
		typeof RecordProviderCostEvidenceResponseSchema
	>["records"][number];
	const records: ResultRecord[] = [];
	const prepared: Array<{
		statement: ReturnType<typeof buildAppendProviderCostEvidenceStatement>;
		row: NewProviderCostEvidenceRow;
		result: ResultRecord;
	}> = [];
	let writes = 0;
	for (const request of input.records) {
		try {
			bounded();
			const index = manifest.records.findIndex(
				(r) => r.facts.sourceCallId === request.sourceCallId,
			);
			const approved = manifest.records[index];
			if (
				!approved ||
				approved.expectedParentEvidenceVersionId !==
					request.expectedParentEvidenceVersionId ||
				approved.facts.sourceSnapshotDigest !== request.expectedSourceDigest
			)
				return refuse(
					"Requested scope is absent from complete financial manifest",
				);
			const facts = approved.facts;
			const source = await getProviderCostEvidenceSource(
				db,
				organizationId,
				request.sourceCallId,
			);
			const current = await getProviderCostEvidenceCurrent(
				db,
				organizationId,
				request.sourceCallId,
			);
			const existing = await getProviderCostEvidenceByIdempotency(
				db,
				organizationId,
				request.idempotencyDigest,
			);
			const payloadDigest = await providerCostEvidenceDigest("payload", {
				manifestDigest,
				basisFactsDigest: approved.basisFactsDigest,
				sourceSnapshotDigest: request.expectedSourceDigest,
				parent: request.expectedParentEvidenceVersionId,
			});
			if (existing && existing.payloadDigest !== payloadDigest)
				return refuse("Idempotency key conflicts with immutable evidence");
			const result = (
				status: "validated" | "appended" | "existing" | "refused",
				persisted: { id: string; providerEstimatedCostMicros: number } | null,
				retired = false,
				reason: string | null = null,
			) => ({
				sourceCallId: request.sourceCallId,
				status,
				versionId: persisted?.id ?? null,
				reason,
				basisFacts: facts,
				basisFactsDigest: approved.basisFactsDigest,
				calculatedMicros: calculated[index]!,
				persistedMicros: persisted?.providerEstimatedCostMicros ?? null,
				sourceRetired: retired,
			});
			if (!source) {
				if (
					input.mode !== "validate_only" ||
					!current ||
					current.originalSourceDigest !== request.expectedSourceDigest ||
					current.basisFactsDigest !== approved.basisFactsDigest
				)
					return refuse("Retired source cannot be appended");
				records.push(result("existing", current, true));
				continue;
			}
			if (
				source.orgId !== facts.originalOrgId ||
				source.gatewayId !== facts.sourceGatewayId ||
				source.gatewayLogId !== facts.gatewayLogId ||
				source.model !== facts.nativeModel ||
				source.provider !== facts.provider ||
				source.snapshotAt !== facts.occurredAt ||
				(await providerCostEvidenceDigest("source", source)) !==
					request.expectedSourceDigest ||
				(await providerCostEvidenceDigest(
					"source",
					facts.originalSourceSnapshot,
				)) !== request.expectedSourceDigest
			)
				return refuse(
					"Complete original source changed or native identity differs",
				);
			if (existing) {
				records.push(result("existing", existing));
				continue;
			}
			if ((current?.id ?? null) !== request.expectedParentEvidenceVersionId)
				return refuse("Current evidence leaf changed");
			if (input.mode === "validate_only") {
				records.push(result("validated", current));
				continue;
			}
			const relationships = await getProviderCostEvidenceRelationships(
				db,
				source,
			);
			const row: NewProviderCostEvidenceRow = {
				id: crypto.randomUUID(),
				originalOrgId: organizationId,
				sourceGatewayId: facts.sourceGatewayId,
				gatewayLogId: facts.gatewayLogId,
				sourceCallId: source.id,
				scopeDigest: await providerCostEvidenceIdentityDigest(
					organizationId,
					facts.sourceGatewayId,
					facts.gatewayLogId,
					source.id,
				),
				originalSourceDigest: request.expectedSourceDigest,
				occurredAt: facts.occurredAt,
				recordedAt: new Date().toISOString(),
				provider: facts.provider,
				nativeModel: facts.nativeModel,
				nativeFactsReceiptDigest: facts.nativeSourceFingerprint,
				basisFactsDigest: approved.basisFactsDigest,
				financialManifestDigest: manifestDigest,
				financialWorkId: work.id,
				financialWorkVersion: work.version,
				financialSpecRevision: work.admissionSpecRevision,
				approvalProposalId: proposal.id,
				approvalDecisionId: decision.id,
				attemptId: bundle.attempt!.id,
				admissionId: bundle.admission!.id,
				createdByActorType: "external_agent",
				createdByActorId: external.executor.id,
				createdBySessionId: external.executor.sessionId,
				idempotencyDigest: request.idempotencyDigest,
				payloadDigest,
				originalTediId: source.tediId,
				originalRunId: source.runId,
				originalWorkId: source.workItemId,
				originalExecutionId: source.executionId,
				originalReservationId: source.billingReservationId,
				originalSourceSnapshot: facts.originalSourceSnapshot,
				deploymentScope: { deliveredSourceSha: manifest.deliveredSourceSha },
				originalSourceVersion: 1,
				inputTokens: facts.usage.inputTokens,
				outputTokens: facts.usage.outputTokens,
				cacheReadTokens: facts.usage.cacheReadTokens,
				cacheWriteTokens: facts.usage.cacheWriteTokens,
				providerEstimatedCostMicros: calculated[index]!,
				nativeUsageKnown: true,
				kind: "provider_estimate",
				currency: "USD",
				pricingBasis: facts.pricingBasis,
				rateCertificateDigest:
					facts.pricingBasis === "rate_estimated"
						? facts.rateCertificateDigest
						: null,
				rateCertificateSnapshot:
					facts.pricingBasis === "rate_estimated" ? facts : null,
				reportedEstimateSnapshot:
					facts.pricingBasis === "reported_estimate" ? facts : null,
				reportedCostDecimal:
					facts.pricingBasis === "reported_estimate"
						? facts.reportedCostDecimal
						: null,
				reportedReporter:
					facts.pricingBasis === "reported_estimate" ? facts.reporter : null,
				inputPriceMicrosPerMillion:
					facts.pricingBasis === "rate_estimated"
						? facts.inputPriceMicrosPerMillion
						: null,
				outputPriceMicrosPerMillion:
					facts.pricingBasis === "rate_estimated"
						? facts.outputPriceMicrosPerMillion
						: null,
				cacheReadPriceMicrosPerMillion:
					facts.pricingBasis === "rate_estimated"
						? facts.cacheReadPriceMicrosPerMillion
						: null,
				cacheWritePriceMicrosPerMillion:
					facts.pricingBasis === "rate_estimated"
						? facts.cacheWritePriceMicrosPerMillion
						: null,
				financialManifestSnapshot: manifest,
				approvalDecisionSnapshot: JSON.parse(JSON.stringify(decision)),
				supersedesEvidenceVersionId: request.expectedParentEvidenceVersionId,
			};
			bounded();
			const statement = buildAppendProviderCostEvidenceStatement(db, {
				row,
				...relationships,
				source,
				rawProposal: approval.rawProposal,
				proposalVersion: proposal.version,
				requestDeadlineAt: new Date(started + 30_000).toISOString(),
				authorityKey: proposal.authorityKey,
				designatedApproverType: proposal.approverType,
				designatedApproverId: proposal.approverId,
				clientRecordId: external.clientRecordId,
				externalSessionKey: external.externalSessionKey,
			});
			prepared.push({ statement, row, result: result("validated", null) });
		} catch {
			records.push({
				sourceCallId: request.sourceCallId,
				status: "refused" as const,
				versionId: null,
				reason:
					"Evidence/source/authority could not be confirmed; prior confirmed writes are retained",
				basisFacts: null,
				basisFactsDigest: null,
				calculatedMicros: null,
				persistedMicros: null,
				sourceRetired: false,
			});
		}
	}
	// Construct every eligible statement before executing the single bounded D1
	// batch. No asynchronous application callback runs between SQL statements.
	if (prepared.length > 0) {
		try {
			bounded();
			await executeProviderCostEvidenceBatch(
				db,
				prepared.map((item) => item.statement),
			);
		} catch {
			/* Transport failure is not rollback proof: read back each key. */
		}
		for (const item of prepared) {
			try {
				const persisted = await getProviderCostEvidenceByIdempotency(
					db,
					organizationId,
					item.row.idempotencyDigest,
				);
				if (!persisted || persisted.payloadDigest !== item.row.payloadDigest) {
					records.push({
						...item.result,
						status: "refused",
						reason:
							"Atomic authority/source fence or batch outcome could not be confirmed",
					});
					continue;
				}
				if (persisted.id === item.row.id) writes++;
				records.push({
					...item.result,
					status: persisted.id === item.row.id ? "appended" : "existing",
					versionId: persisted.id,
					persistedMicros: persisted.providerEstimatedCostMicros,
				});
			} catch {
				records.push({
					...item.result,
					status: "refused",
					reason:
						"Batch may have persisted evidence; scoped readback unavailable",
				});
			}
		}
	}
	records.sort(
		(a, b) =>
			input.records.findIndex((r) => r.sourceCallId === a.sourceCallId) -
			input.records.findIndex((r) => r.sourceCallId === b.sourceCallId),
	);

	return { mode: input.mode, writes, records };
}
