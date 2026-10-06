/**
 * Fail-closed raw-evidence writer for identity-less Home Kernel turns.
 *
 * The D1 trace-bundle row remains the searchable index. This writer stores the
 * replayable, redacted evidence files in the same production R2 bucket used by
 * tedi trace bundles and returns the folder URI recorded on that row. Provider
 * hidden reasoning is never available here and is never written; only the
 * provider-reported reasoning token count inside BodyExecutionResult usage is
 * retained.
 */
import type { BodyExecutionResult } from "@tedix/api-contract/schemas/body-certification";
import type { KernelRouteDecision } from "./route-schema";
import type { KernelRouteTraceInput } from "./route-planner";
import {
	DEFAULT_TRACE_SAFETY_POLICY,
	redactBundleFile,
	traceSafetyPolicyId,
} from "@tedix/context-core/trace-safety";

export const TRACE_BUCKET_NAME = "tedix-tedi-production";
export const KERNEL_TRACE_BUNDLE_FILE_NAMES = [
	"manifest.json",
	"prompt.json",
	"context-manifest.json",
	"route.json",
	"output.md",
	"outcome.json",
] as const;
export const KERNEL_TRACE_RETENTION_DAYS = 30;

export function kernelTraceBundleRetentionExpiresAt(createdAt: string): string {
	return new Date(
		new Date(createdAt).getTime() + KERNEL_TRACE_RETENTION_DAYS * 86_400_000,
	).toISOString();
}

export interface KernelTraceBundleEvidence {
	organizationId: string;
	conversationId: string;
	runId: string;
	harnessVersionId: string;
	createdAt: string;
	traceInput: KernelRouteTraceInput;
	assistantText: string;
	route: KernelRouteDecision;
	contextManifest: Record<string, unknown>;
	bodyExecutionResult: BodyExecutionResult;
	outcome: "success" | "failure" | "partial" | "escalated";
}

interface RawFile {
	name: string;
	content: unknown;
}

export function kernelTraceBundlePrefix(
	organizationId: string,
	runId: string,
): string {
	return `kernel/${organizationId}/harness/runs/${runId}`;
}

export function assembleKernelTraceBundleFiles(
	evidence: KernelTraceBundleEvidence,
): RawFile[] {
	return [
		{
			name: "manifest.json",
			content: {
				subjectKind: "kernel",
				subjectId: `kernel:${evidence.organizationId}`,
				organizationId: evidence.organizationId,
				conversationId: evidence.conversationId,
				runId: evidence.runId,
				harnessVersionId: evidence.harnessVersionId,
				traceSafetyPolicyId: traceSafetyPolicyId(DEFAULT_TRACE_SAFETY_POLICY),
				outcome: evidence.outcome,
				createdAt: evidence.createdAt,
				retentionExpiresAt: kernelTraceBundleRetentionExpiresAt(
					evidence.createdAt,
				),
			},
		},
		{
			name: "prompt.json",
			content: {
				system: evidence.traceInput.systemPrompt,
				messages: evidence.traceInput.messages,
				request: {
					provider: evidence.traceInput.provider,
					model: evidence.traceInput.model,
					shape: evidence.traceInput.requestShape,
					truncated: evidence.traceInput.truncated,
					mediaOmitted: evidence.traceInput.mediaOmitted,
				},
			},
		},
		{ name: "context-manifest.json", content: evidence.contextManifest },
		{ name: "route.json", content: evidence.route },
		{ name: "output.md", content: `${evidence.assistantText}\n` },
		{
			name: "outcome.json",
			content: {
				outcome: evidence.outcome,
				usage: evidence.bodyExecutionResult.usage,
				cost: evidence.bodyExecutionResult.cost,
				durationMs: evidence.bodyExecutionResult.durationMs,
			},
		},
	];
}

export async function writeKernelTraceBundle(opts: {
	bucket: R2Bucket;
	evidence: KernelTraceBundleEvidence;
	knownSecrets?: readonly string[];
}): Promise<string | null> {
	const { bucket, evidence } = opts;
	const prefix = kernelTraceBundlePrefix(
		evidence.organizationId,
		evidence.runId,
	);
	const knownSecrets = (opts.knownSecrets ?? []).filter(Boolean);
	let wrote = 0;
	try {
		for (const file of assembleKernelTraceBundleFiles(evidence)) {
			const redacted = redactBundleFile(file.name, file.content, knownSecrets);
			try {
				await bucket.put(`${prefix}/${redacted.name}`, redacted.content, {
					httpMetadata: {
						contentType: file.name.endsWith(".md")
							? "text/markdown"
							: "application/json",
					},
					customMetadata: {
						organizationId: evidence.organizationId,
						runId: evidence.runId,
						producer: "kernel-runtime",
						subKind: "trace_bundle",
						traceSafetyPolicyId: traceSafetyPolicyId(
							DEFAULT_TRACE_SAFETY_POLICY,
						),
						retentionExpiresAt: kernelTraceBundleRetentionExpiresAt(
							evidence.createdAt,
						),
						redactionFailed: String(redacted.redactionFailed),
					},
				});
				wrote += 1;
			} catch {
				console.warn(`[kernel.trace] R2 put failed for ${redacted.name}`);
			}
		}
	} catch {
		console.warn("[kernel.trace] writeKernelTraceBundle failed");
	}
	// A partial folder cannot support a faithful replay. Keep it unlinked from
	// the D1 bundle index if any required evidence file failed to persist.
	return wrote === KERNEL_TRACE_BUNDLE_FILE_NAMES.length
		? `r2://${TRACE_BUCKET_NAME}/${prefix}/`
		: null;
}
