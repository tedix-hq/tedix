import * as z from "zod";
import { asRecord } from "../utils/is-record";
import { TediSchema } from "./tedi";

export const ExecutionCapabilitySchema = z.enum([
	"repository_read",
	"repository_edit",
	"filesystem_transform",
	"dependency_install",
	"typecheck",
	"tests",
	"lint",
	"build",
	"git_network",
	"process",
	"dev_server",
	"browser_session",
	"deploy",
	"notebook",
	"data",
	"live_verify",
]);
export type ExecutionCapability = z.infer<typeof ExecutionCapabilitySchema>;

export const ExecutionSurfaceSchema = z.enum([
	"native",
	"managed_job",
	"workstation",
]);
export type ExecutionSurface = z.infer<typeof ExecutionSurfaceSchema>;

export const ExecutionRequirementSchema = z.object({
	surface: ExecutionSurfaceSchema,
	requiredCapabilities: z.array(ExecutionCapabilitySchema),
	fallbackSurface: z.enum(["managed_job", "workstation"]).nullable(),
	prohibitedSurfaces: z.array(ExecutionSurfaceSchema),
	satisfiable: z.boolean(),
	reason: z.string(),
});
export type ExecutionRequirement = z.infer<typeof ExecutionRequirementSchema>;

export const CompletionEvidenceStatusSchema = z.enum([
	"succeeded",
	"partial",
	"failed",
	"pending",
	"canceled",
]);
export type CompletionEvidenceStatus = z.infer<
	typeof CompletionEvidenceStatusSchema
>;

export const CompletionEvidenceSchema = z.object({
	operation: z.string().min(1),
	status: CompletionEvidenceStatusSchema,
	supportedClaims: z.array(z.string()),
	unsupportedClaims: z.array(z.string()),
	evidenceRefs: z.array(z.string()),
	providerConfirmation: z.string().trim().min(1).max(500).default("unknown"),
	target: z.string().nullable(),
	instruction: z.string().min(1),
	retry: z.object({
		key: z.string().min(1),
		attempts: z.number().int().nonnegative(),
		limit: z.number().int().positive(),
		blocked: z.boolean(),
		retryable: z.boolean(),
	}),
});
export type CompletionEvidence = z.infer<typeof CompletionEvidenceSchema>;

function stringValue(
	record: Record<string, unknown> | null,
	key: string,
): string | null {
	const value = record?.[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

const EVIDENCE_REF_KEYS = new Set([
	"artifactId",
	"commitOid",
	"deploymentId",
	"executionId",
	"jobId",
	"leaseId",
	"runId",
	"traceBundleId",
	"traceId",
	"workItemId",
]);

function evidenceRefs(
	record: Record<string, unknown> | null,
	depth = 0,
): string[] {
	if (!record || depth > 6) return [];
	const refs = [
		"artifactId",
		"commitOid",
		"deploymentId",
		"executionId",
		"jobId",
		"leaseId",
		"runId",
		"traceBundleId",
		"traceId",
		"workItemId",
	]
		.map((key) => stringValue(record, key))
		.filter((value): value is string => value !== null);
	for (const key of ["artifactRefs", "evidenceRefs"]) {
		const values = record[key];
		if (Array.isArray(values)) {
			refs.push(
				...values.filter(
					(value): value is string =>
						typeof value === "string" && value.length > 0,
				),
			);
		}
	}
	for (const [key, value] of Object.entries(record)) {
		if (EVIDENCE_REF_KEYS.has(key) || key === "artifactRefs") continue;
		if (Array.isArray(value)) {
			for (const item of value) {
				refs.push(...evidenceRefs(asRecord(item), depth + 1));
			}
			continue;
		}
		refs.push(...evidenceRefs(asRecord(value), depth + 1));
	}
	return [...new Set(refs)];
}

function isWorkEvidencePreviewResult(
	operation: string,
	record: Record<string, unknown>,
): boolean {
	if (operation !== "preview_evidence") return false;
	if (record.status === "available")
		return (
			typeof record.canonicalUri === "string" &&
			record.canonicalUri.length > 0 &&
			typeof record.mediaType === "string" &&
			record.mediaType.length > 0 &&
			typeof record.digest === "string" &&
			record.digest.length > 0 &&
			typeof record.text === "string" &&
			record.text.length <= 51_200 &&
			typeof record.truncated === "boolean"
		);
	if (record.status === "unavailable")
		return typeof record.reason === "string" && record.reason.length > 0;
	if (record.status !== "external" || record.trust !== "unverified_external")
		return false;
	if (typeof record.href !== "string" || record.href.length === 0) return false;
	try {
		const url = new URL(record.href);
		return url.protocol === "https:" && !url.username && !url.password;
	} catch {
		return false;
	}
}

function inferStatus(
	operation: string,
	record: Record<string, unknown> | null,
): CompletionEvidenceStatus {
	if (!record) return "succeeded";
	// The exact typed lookup reports the entity's lifecycle, not operation
	// completion. Keep all other signals on the original record authoritative.
	const entityLookup =
		operation === "get_tedi" && TediSchema.safeParse(record).success;
	const status = entityLookup
		? null
		: stringValue(record, "status")?.toLowerCase();
	const state = stringValue(record, "state")?.toLowerCase();
	if (
		record.canceled === true ||
		status === "canceled" ||
		status === "cancelled" ||
		state === "canceled" ||
		state === "cancelled"
	)
		return "canceled";
	if (
		record.timedOut === true ||
		record.ok === false ||
		record.success === false ||
		record.isError === true ||
		record.error ||
		(typeof record.exitCode === "number" && record.exitCode !== 0) ||
		(record.terminal === true && record.exitCode == null) ||
		status === "failed" ||
		status === "failure" ||
		status === "error" ||
		status === "timeout" ||
		status === "timed_out" ||
		status === "timed-out" ||
		status === "blocked" ||
		status === "denied" ||
		state === "failed" ||
		state === "failure" ||
		state === "error" ||
		state === "timeout" ||
		state === "timed_out" ||
		state === "timed-out" ||
		state === "blocked" ||
		state === "denied"
	)
		return "failed";
	if (status === "partial" || state === "partial" || record.partial === true)
		return "partial";
	if (
		status === "pending" ||
		status === "queued" ||
		status === "running" ||
		status === "provisioning" ||
		state === "pending" ||
		state === "queued" ||
		state === "running" ||
		state === "provisioning" ||
		record.running === true ||
		record.terminal === false
	)
		return "pending";
	// `preview_evidence` reports the domain result in `status`: available bytes,
	// a current fail-closed unavailability, or an explicitly unverified external
	// link. All three mean the read operation itself completed. Keep this scoped
	// to the exact tool and complete public response shapes; globally treating an
	// arbitrary `available`/`unavailable` string as success would hide provider
	// partials and make unsafe retries look terminal.
	if (isWorkEvidencePreviewResult(operation, record)) return "succeeded";
	if (
		record.terminal === true &&
		typeof record.exitCode === "number" &&
		record.exitCode === 0
	)
		return "succeeded";
	const successStatuses = new Set([
		"complete",
		"completed",
		"healthy",
		"ok",
		"ready",
		"success",
		"succeeded",
		"valid",
	]);
	if (status && !successStatuses.has(status)) return "partial";
	if (state && !successStatuses.has(state)) return "partial";
	return "succeeded";
}

export function buildCompletionEvidence(input: {
	operation: string;
	result: unknown;
	retryKey: string;
	/**
	 * Explicit, provider-issued operation confirmation supplied by a trusted
	 * adapter. The generic builder never derives this from result IDs, status,
	 * evidence references, or a successful return.
	 */
	providerConfirmation?: string | null;
	attempts?: number;
	limit?: number;
	blocked?: boolean;
	target?: string | null;
}): CompletionEvidence {
	const record = asRecord(input.result);
	let status = inferStatus(input.operation, record);
	if (
		input.operation === "open_computer" &&
		record?.ready === false &&
		status === "succeeded"
	)
		status = "pending";
	if (
		input.operation === "read_execution" &&
		record?.found === false &&
		status === "succeeded"
	)
		status = "partial";
	const startedJob =
		input.operation === "exec" &&
		(record?.accepted === true || record?.running === true) &&
		stringValue(record, "executionId") !== null &&
		status !== "failed" &&
		status !== "canceled";
	if (startedJob) status = "pending";
	const completedJob =
		(input.operation === "exec" || input.operation === "read_execution") &&
		record?.terminal === true &&
		record?.exitCode === 0 &&
		status === "succeeded";
	const supportedClaims = startedJob
		? ["the durable job was accepted"]
		: status === "succeeded"
			? [
					completedJob
						? "the command completed successfully"
						: `${input.operation} returned successfully`,
				]
			: status === "pending"
				? [`${input.operation} is still pending`]
				: [];
	const unsupportedClaims =
		status === "failed" || status === "canceled"
			? [`${input.operation} completed successfully`]
			: startedJob
				? [
						"the job completed",
						"the build, test, validation, or deployment passed",
					]
				: status === "pending" || status === "partial"
					? [`${input.operation} fully completed`]
					: [];
	const retryable =
		(status === "failed" || status === "partial") &&
		record?.retryable !== false;
	const blocked = input.blocked ?? false;
	return CompletionEvidenceSchema.parse({
		operation: input.operation,
		status,
		supportedClaims,
		unsupportedClaims,
		evidenceRefs: evidenceRefs(record),
		providerConfirmation:
			typeof input.providerConfirmation === "string" &&
			input.providerConfirmation.trim().length > 0
				? input.providerConfirmation.trim().slice(0, 500)
				: "unknown",
		target:
			input.target ??
			stringValue(record, "executionId") ??
			stringValue(record, "jobId") ??
			stringValue(record, "workItemId") ??
			stringValue(record, "runId") ??
			null,
		instruction: blocked
			? "Do not repeat this identical call. Inspect the failure and change the arguments or execution plan."
			: status === "failed"
				? "Report the failure honestly. Retry only after changing the cause or the call arguments."
				: startedJob || status === "pending"
					? "Claim completion only after a terminal receipt. Follow the tool's completion instructions: yield for an automatic wake when provided; otherwise use its documented status check."
					: status === "partial"
						? "Label the result partial and name what remains unproven."
						: "Claim only the supported claims and cite the evidence references.",
		retry: {
			key: input.retryKey,
			attempts: input.attempts ?? 0,
			limit: input.limit ?? 2,
			blocked,
			retryable: retryable && !blocked,
		},
	});
}

/** One inner namespaced tool call a Code Mode program made. */
export interface CodeModeToolReceipt {
	operation: string;
	status: CompletionEvidenceStatus;
	/**
	 * Bounded failure detail for failed/canceled calls. Inner failures return
	 * ok:false VALUES that a program's hand-built projection routinely swallows
	 * — audits had to JSON.stringify inner envelopes to find a scope denial.
	 * Carried on the receipt so the outer result can surface failures[].
	 */
	error?: string;
}

const CODE_MODE_RECEIPT_OPERATIONS_SHOWN = 5;

/**
 * Roll the EXECUTOR's own per-call receipts into one Code Mode completion
 * evidence record.
 *
 * Every inner `namespace.tool(...)` result is already wrapped with
 * `completionEvidence`, but a program returns a hand-built PROJECTION and
 * routinely drops it — so nothing downstream of the model's return value can
 * tell a real execution from a discovery stall. This rollup travels BESIDE the
 * program's return value, which makes execution evidence independent of what
 * the model chose to project.
 *
 * It attests EXECUTION ONLY. "The tool calls returned successfully" is never
 * "the task was accomplished", so goal completion stays an unsupported claim at
 * every status. Returns null when the program made no namespaced call at all
 * (discovery-only or pure computation) — absence must stay indistinguishable
 * from the pre-receipt world so a stall can never mint evidence.
 */
export function buildCodeModeExecutionReceipt(
	receipts: readonly CodeModeToolReceipt[],
): CompletionEvidence | null {
	if (receipts.length === 0) return null;
	const total = receipts.length;
	const succeeded = receipts.filter((r) => r.status === "succeeded").length;
	const failed = receipts.some(
		(r) => r.status === "failed" || r.status === "canceled",
	);
	const status: CompletionEvidenceStatus = failed
		? "failed"
		: succeeded === total
			? "succeeded"
			: "partial";
	const shown = receipts
		.slice(0, CODE_MODE_RECEIPT_OPERATIONS_SHOWN)
		.map((r) => `${r.operation}=${r.status}`)
		.join(", ");
	const operations =
		total > CODE_MODE_RECEIPT_OPERATIONS_SHOWN
			? `${shown}, +${total - CODE_MODE_RECEIPT_OPERATIONS_SHOWN} more`
			: shown;
	return CompletionEvidenceSchema.parse({
		operation: "tedix_mcp_code",
		status,
		supportedClaims:
			status === "failed"
				? []
				: [
						`${succeeded} of ${total} Code Mode tool call(s) returned successfully (${operations})`,
					],
		unsupportedClaims:
			status === "succeeded"
				? ["the delegated task's goal was achieved"]
				: [
						"every tool call in this Code Mode program succeeded",
						"the delegated task's goal was achieved",
					],
		evidenceRefs: [],
		providerConfirmation: "unknown",
		target: null,
		instruction:
			status === "failed"
				? "Report the failure honestly. Retry only after changing the cause or the call arguments."
				: status === "partial"
					? "Label the result partial and name which calls did not succeed."
					: "These calls ran. Claim only what their results show, never that the task is complete.",
		retry: {
			key: "tedix_mcp_code",
			attempts: 0,
			limit: 2,
			blocked: false,
			retryable: status !== "succeeded",
		},
	});
}

export function withCompletionEvidence(
	operation: string,
	result: unknown,
	retry: {
		key: string;
		attempts?: number;
		limit?: number;
		blocked?: boolean;
	} = { key: operation },
): Record<string, unknown> {
	const record = asRecord(result);
	return {
		...(record ?? { value: result }),
		completionEvidence: buildCompletionEvidence({
			operation,
			result,
			retryKey: retry.key,
			attempts: retry.attempts,
			limit: retry.limit,
			blocked: retry.blocked,
		}),
	};
}
