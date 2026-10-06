import type { BodyExecutionResult } from "@tedix/api-contract/schemas/body-certification";
import type {
	HarnessSubjectTraceBundle,
	HarnessSubjectVersion,
} from "@tedix/api-contract/schemas/harness-version";
import { buildHarnessSubjectTraceBundle } from "@tedix/api-contract/utils/trace-bundle";
import { traceReferenceEventIds } from "@tedix/context-core/harness-version";
import type { KernelResult } from "./index";
import type { KernelTraceBundleEvidence } from "./kernel-trace-bundle-writer";

interface RecordKernelTraceEvidenceInput {
	kernelHarnessVersion: HarnessSubjectVersion;
	traceBundleId: string;
	recordKernelTraceBundle: (bundle: HarnessSubjectTraceBundle) => Promise<void>;
	writeKernelTraceBundle?: (
		evidence: KernelTraceBundleEvidence,
	) => Promise<string | null>;
	errorMessage: (value: unknown) => string;
	organizationId: string;
	conversationId: string;
	runId: string;
	createdAt: string;
	assistantEventId: string;
	terminalEventId: string;
	runRowMetadata: Record<string, unknown>;
	kernelResult: KernelResult | null;
	assistantContent: string;
	bodyExecutionResult: BodyExecutionResult;
	outcome: "success" | "escalated";
	routerVersion: string | null;
	contextManifest: Record<string, unknown>;
}

function summaryExcerpt(value: string, max = 500): string {
	const normalized = value.trim().replace(/\s+/g, " ");
	return normalized.length <= max
		? normalized
		: `${normalized.slice(0, max - 1)}…`;
}

/** Persist the raw redacted folder first, then index its URI in the D1 bundle. */
export async function recordKernelTraceEvidence(
	input: RecordKernelTraceEvidenceInput,
): Promise<void> {
	const linked = input.runRowMetadata.rationaleRecordIds;
	const linkedRationaleIds = Array.isArray(linked)
		? linked.filter((id): id is string => typeof id === "string")
		: [];
	const routeRationale = input.kernelResult?.route.rationale?.trim() || null;
	let bundleUri: string | null = null;
	if (input.kernelResult?.traceInput && input.writeKernelTraceBundle) {
		try {
			bundleUri = await input.writeKernelTraceBundle({
				organizationId: input.organizationId,
				conversationId: input.conversationId,
				runId: input.runId,
				harnessVersionId: input.kernelHarnessVersion.id,
				createdAt: input.createdAt,
				traceInput: input.kernelResult.traceInput,
				assistantText: input.assistantContent,
				route: input.kernelResult.route,
				contextManifest: input.contextManifest,
				bodyExecutionResult: input.bodyExecutionResult,
				outcome: input.outcome,
			});
		} catch (error) {
			console.warn(
				"[kernelRuntime] kernel raw trace bundle write failed",
				input.errorMessage(error),
			);
		}
	}
	try {
		await input.recordKernelTraceBundle(
			buildHarnessSubjectTraceBundle({
				id: input.traceBundleId,
				subjectKind: input.kernelHarnessVersion.subjectKind,
				subjectId: input.kernelHarnessVersion.subjectId,
				tediId: null,
				orgId: input.organizationId,
				conversationId: input.conversationId,
				runId: input.runId,
				harnessVersionId: input.kernelHarnessVersion.id,
				createdAt: input.createdAt,
				eventIds: traceReferenceEventIds(
					input.assistantEventId,
					input.terminalEventId,
				),
				rationaleRecordIds: linkedRationaleIds,
				artifactIds: [],
				bundleUri,
				summary: summaryExcerpt(input.assistantContent),
				outcome: input.outcome,
				bodyExecutionResult: input.bodyExecutionResult,
				metadata: {
					routerVersion: input.routerVersion,
					...(routeRationale
						? {
								kernelRationale: {
									routeKind: input.kernelResult?.route.routeKind ?? null,
									rationale: summaryExcerpt(routeRationale),
									capabilityRequirement:
										input.kernelResult?.route.effortClass ?? null,
									confidence:
										typeof input.kernelResult?.route.confidence === "number"
											? input.kernelResult.route.confidence
											: null,
									routerVersion: input.routerVersion,
									persistedAsRationaleRecord: false,
								},
							}
						: {}),
				},
			}),
		);
	} catch (error) {
		console.warn(
			"[kernelRuntime] kernel trace bundle record failed",
			input.errorMessage(error),
		);
	}
}
