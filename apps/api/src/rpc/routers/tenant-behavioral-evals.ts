import { createRouterClient, implement } from "@orpc/server";
import { tenantBehavioralEvalsContract } from "@tedix/api-contract/contracts/tenant-behavioral-evals";
import type { TenantBehavioralEvalRunManifest } from "@tedix/api-contract/schemas/tenant-behavioral-evals";
import {
	createTenantBehavioralEval,
	getRunByIdempotency,
	getTenantBehavioralEval,
	getTenantBehavioralEvalRevision,
	getTenantBehavioralEvalRunDetail,
	listTenantBehavioralEvals,
	listTenantBehavioralEvalRuns,
	reviseTenantBehavioralEval,
	startTenantBehavioralEvalRun,
	TenantBehavioralEvalRunConflictError,
} from "@tedix/db/queries/tenant-behavioral-evals";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { advanceTenantBehavioralEvalRun } from "../../services/tenant-behavioral-evals";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";
import { kernelRuntimeContractRouter } from "./kernel-runtime";

const os = implement(tenantBehavioralEvalsContract).$context<BaseContext>();
const authed = os.use(withAuth);
function own(context: BaseContext, organizationId: string) {
	if (context.organizationId !== organizationId)
		throw createError(ErrorCodes.FORBIDDEN, "Organization access denied");
}
async function digest(value: unknown) {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
		.map((v) => v.toString(16).padStart(2, "0"))
		.join("");
}
export function tenantBehavioralEvalPublicRun(
	run: Awaited<ReturnType<typeof getRunByIdempotency>> extends infer T
		? Exclude<T, undefined>
		: never,
) {
	return {
		id: run.id,
		organizationId: run.organizationId,
		definitionId: run.definitionId,
		revisionId: run.revisionId,
		tediId: run.tediId,
		status: run.status,
		version: run.version,
		idempotencyKey: run.idempotencyKey,
		payloadDigest: run.payloadDigest,
		manifest: run.manifest,
		manifestDigest: run.manifestDigest,
		passed: run.passed,
		lastAdvanceError: run.lastAdvanceError,
		lastAdvanceErrorPhase: run.lastAdvanceErrorPhase,
		lastAdvanceErrorRetryable: run.lastAdvanceErrorRetryable,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
	};
}
export function tenantBehavioralEvalPublicDetail(
	detail: NonNullable<
		Awaited<ReturnType<typeof getTenantBehavioralEvalRunDetail>>
	>,
) {
	return {
		run: tenantBehavioralEvalPublicRun(detail.run),
		caseRuns: detail.caseRuns.map((row) => ({
			id: row.id,
			runId: row.runId,
			caseId: row.caseId,
			homeRunId: row.homeRunId,
			attemptNumber: row.attemptNumber,
			status: row.status,
			eventCursor: row.eventCursor,
			sawClosed: row.sawClosed,
			drained: row.drained,
			terminalStatus: row.terminalStatus,
			selectedRoute: row.selectedRoute,
			effectsSuppressed: row.effectsSuppressed,
			error: row.error,
			executionReceipt: row.executionReceipt,
			disposition: row.disposition,
		})),
		caseAttempts: detail.caseAttempts.map((row) => ({
			id: row.id,
			caseRunId: row.caseRunId,
			attemptNumber: row.attemptNumber,
			homeRunId: row.homeRunId,
			status: row.status,
			disposition: row.disposition,
			error: row.error,
			eventCursor: row.eventCursor,
			terminalStatus: row.terminalStatus,
			selectedRoute: row.selectedRoute,
			effectsSuppressed: row.effectsSuppressed,
			executionReceipt: row.executionReceipt,
			recordedAt: row.recordedAt,
		})),
		assertionResults: detail.assertionResults.map((row) => ({
			id: row.id,
			caseRunId: row.caseRunId,
			assertionIndex: row.assertionIndex,
			type: row.type,
			passed: row.passed,
			severity: row.severity,
			disposition: row.disposition ?? (row.passed ? "passed" : "failed"),
			detail: row.detail,
		})),
	};
}
export async function mapTenantBehavioralEvalRunConflict<T>(
	operation: () => Promise<T>,
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (error instanceof TenantBehavioralEvalRunConflictError)
			throw createError(
				ErrorCodes.CONFLICT,
				"Idempotency key already used for a different evaluation payload",
			);
		throw error;
	}
}
export const tenantBehavioralEvalsContractRouter = os.router({
	create: authed.create
		.use(AUTHZ.tedisWrite)
		.handler(async ({ input, context }) => {
			own(context, input.organizationId);
			if (
				!(await getTediByIdForOrganization(
					context.db,
					input.tediId,
					input.organizationId,
				))
			)
				throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
			const result = await createTenantBehavioralEval(context.db, {
				...input,
				id: crypto.randomUUID(),
				revisionId: crypto.randomUUID(),
			});
			return { ...result.definition, revision: result.revision };
		}),
	revise: authed.revise
		.use(AUTHZ.tedisWrite)
		.handler(async ({ input, context }) => {
			own(context, input.organizationId);
			const result = await reviseTenantBehavioralEval(context.db, {
				...input,
				id: crypto.randomUUID(),
			});
			if (!result)
				throw createError(
					ErrorCodes.CONFLICT,
					"Evaluation definition version changed",
				);
			return result;
		}),
	get: authed.get.use(AUTHZ.tedisRead).handler(async ({ input, context }) => {
		own(context, input.organizationId);
		const result = await getTenantBehavioralEval(
			context.db,
			input.organizationId,
			input.definitionId,
		);
		if (!result)
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Evaluation definition not found",
			);
		return result;
	}),
	list: authed.list.use(AUTHZ.tedisRead).handler(async ({ input, context }) => {
		own(context, input.organizationId);
		return listTenantBehavioralEvals(
			context.db,
			input.organizationId,
			input.limit,
		);
	}),
	startRun: authed.startRun
		.use(AUTHZ.tedisWrite)
		.handler(async ({ input, context }) => {
			own(context, input.organizationId);
			const revision = await getTenantBehavioralEvalRevision(
				context.db,
				input.organizationId,
				input.definitionId,
				input.revisionId,
			);
			if (!revision)
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Evaluation revision not found",
				);
			const payloadDigest = await digest({
				definitionId: input.definitionId,
				revisionId: input.revisionId,
			});
			const existing = await getRunByIdempotency(
				context.db,
				input.organizationId,
				input.idempotencyKey,
			);
			if (existing && existing.payloadDigest !== payloadDigest)
				throw createError(
					ErrorCodes.CONFLICT,
					"Idempotency key already used for a different evaluation payload",
				);
			const manifest: TenantBehavioralEvalRunManifest = {
				schemaVersion: 1,
				definitionId: input.definitionId,
				revisionId: input.revisionId,
				revisionNumber: revision.revision.revision,
				specDigest: await digest(revision.revision.spec),
				caseIds: revision.revision.spec.cases.map((item) => item.id),
				assetTediId: revision.tediId,
				lane: revision.revision.spec.lane,
				executionPolicy: "observe_only",
				modelSelection: "kernel_runtime_default",
				requestedModelRef: null,
				capturedAt: new Date().toISOString(),
			};
			const manifestDigest = await digest(manifest);
			const started = await mapTenantBehavioralEvalRunConflict(() =>
				startTenantBehavioralEvalRun(context.db, {
					id: crypto.randomUUID(),
					organizationId: input.organizationId,
					definitionId: input.definitionId,
					revisionId: input.revisionId,
					tediId: revision.tediId,
					idempotencyKey: input.idempotencyKey,
					payloadDigest,
					manifest,
					manifestDigest,
					cases: revision.revision.spec.cases,
				}),
			);
			if (started.run.payloadDigest !== payloadDigest)
				throw createError(
					ErrorCodes.CONFLICT,
					"Idempotency key already used for a different evaluation payload",
				);
			return tenantBehavioralEvalPublicRun(started.run);
		}),
	getRun: authed.getRun
		.use(AUTHZ.tedisRead)
		.handler(async ({ input, context }) => {
			own(context, input.organizationId);
			const result = await getTenantBehavioralEvalRunDetail(
				context.db,
				input.organizationId,
				input.runId,
			);
			if (!result)
				throw createError(ErrorCodes.NOT_FOUND, "Evaluation run not found");
			return tenantBehavioralEvalPublicDetail(result);
		}),
	listRuns: authed.listRuns
		.use(AUTHZ.tedisRead)
		.handler(async ({ input, context }) => {
			own(context, input.organizationId);
			return (
				await listTenantBehavioralEvalRuns(
					context.db,
					input.organizationId,
					input.definitionId,
					input.limit,
				)
			).map(tenantBehavioralEvalPublicRun);
		}),
	advanceRun: authed.advanceRun
		.use(AUTHZ.tedisWrite)
		.handler(async ({ input, context }) => {
			own(context, input.organizationId);
			const kernel = createRouterClient(kernelRuntimeContractRouter, {
				context,
			});
			try {
				return tenantBehavioralEvalPublicDetail(
					await advanceTenantBehavioralEvalRun({
						db: context.db,
						organizationId: input.organizationId,
						runId: input.runId,
						expectedVersion: input.expectedVersion,
						readRun: async (runId) => {
							try {
								return (
									await kernel.readRun({
										organizationId: input.organizationId,
										runId,
									})
								).run;
							} catch (error) {
								if (
									typeof error === "object" &&
									error !== null &&
									"code" in error &&
									error.code === "NOT_FOUND"
								)
									return null;
								throw error;
							}
						},
						enqueue: async (args) => (await kernel.enqueueMessage(args)).run,
						readEvents: (args) => kernel.readRunEvents(args),
					}),
				);
			} catch (error) {
				throw createError(
					ErrorCodes.CONFLICT,
					error instanceof Error ? error.message : "Evaluation advance failed",
				);
			}
		}),
});
