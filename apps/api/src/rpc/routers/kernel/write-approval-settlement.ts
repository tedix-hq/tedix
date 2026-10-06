import type { TediRunStatus } from "@tedix/api-contract/schemas/cognitive-runtime";
import {
	OsOutputSchema,
	OsOutputRevisionSchema,
} from "@tedix/api-contract/schemas/os-workspaces";
import type { KernelWriteApprovalDecision } from "@tedix/api-contract/utils/approval-policy";
import { resolveApprovalRequest } from "@tedix/db/queries/approvals";
import {
	listApprovalExecutionReceipts,
	recordApprovalExecutionReceipt,
} from "@tedix/db/queries/approval-simulations";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import {
	getKernelRuntimeRun,
	transitionKernelRuntimeRunStatus,
	updateKernelRuntimeRunForOrg,
} from "@tedix/db/queries/kernel-runtime-runs";
import { getTedisByOrganization } from "@tedix/db/queries/tedis";
import type { tediApprovalRequests } from "@tedix/db/schema/approvals";
import { toJsonRecord } from "@tedix/db/utils/json";
import { canonicalDigest } from "../../../lib/blueprint-digest";
import { retainKernelToolResult } from "../../../services/kernel-tool-result-retention";
import type { BaseContext } from "../../orpc";
import { settleRepoCommitApprovalIfNeeded } from "./repo-commit-approval-settle";
import { insertKernelRuntimeEvent } from "./run-store";
import {
	boundedArgsJson,
	errorMessage,
	homeRunProgress,
	nonNullRecord,
	nowIso,
} from "./runtime-shared";
import {
	executeApprovedKernelWrite,
	parseHomeToolWritePayload,
	type WriteExecutorEnv,
} from "./write-executor";
import type { KernelWriteProposal } from "./write-proposal";

// The executor leg of the approved-write layer is indirected for tests: the
// real implementation makes the live MCP `tools/call`, so kernel-runtime tests
// stub it through `kernelRuntimeTestHooks.setKernelWriteExecutorForTest` (which
// delegates here). The real implementation is fail-soft.
let activeKernelWriteExecutor: typeof executeApprovedKernelWrite =
	executeApprovedKernelWrite;
let activeKernelToolResultRetainer: typeof retainKernelToolResult =
	retainKernelToolResult;

const savedOutputReceiptSchema = OsOutputSchema.pick({ id: true, kind: true });

const savedRevisionReceiptSchema = OsOutputRevisionSchema.pick({
	id: true,
	outputId: true,
});

/** Keep exact authoring identity outside the size-bounded result preview. */
export function kernelOutputReceipt(input: {
	toolName: string;
	data: unknown;
}): {
	outputId: string;
	revisionId: string;
} | null {
	if (
		input.toolName !== "os.create_os_output" &&
		input.toolName !== "os__create_os_output"
	)
		return null;
	const data = nonNullRecord(input.data);
	const output = savedOutputReceiptSchema.safeParse(data?.output);
	const revision = savedRevisionReceiptSchema.safeParse(data?.revision);
	if (
		!output.success ||
		!revision.success ||
		revision.data.outputId !== output.data.id
	)
		return null;
	return { outputId: output.data.id, revisionId: revision.data.id };
}

export function renderKernelWriteReceipt(input: {
	toolName: string;
	appSlug: string;
	data: unknown;
}): string {
	if (
		input.toolName === "tenant.install_tenant_mcp_app" ||
		input.toolName === "tenant.install_tenant_mcp_apps"
	) {
		const data = nonNullRecord(input.data);
		const summary =
			typeof data?.summary === "string"
				? data.summary
				: "Catalog installation completed.";
		const results = Array.isArray(data?.results) ? data.results : [];
		const details = results.slice(0, 10).flatMap((value) => {
			const result = nonNullRecord(value);
			if (!result) return [];
			const name =
				typeof result.catalogAppName === "string"
					? result.catalogAppName
					: typeof result.query === "string"
						? result.query
						: "Catalog app";
			const status =
				typeof result.status === "string" ? result.status : "unknown";
			const reason =
				typeof result.reason === "string" ? ` — ${result.reason}` : "";
			return [`- ${name}: ${status}${reason}`];
		});
		return [summary, ...details].join("\n");
	}
	if (
		input.toolName === "os.create_os_output" ||
		input.toolName === "os__create_os_output"
	) {
		const parsed = savedOutputReceiptSchema.safeParse(
			nonNullRecord(input.data)?.output,
		);
		if (parsed.success) {
			const { id, kind } = parsed.data;
			return `Saved your ${kind}. [Open ${kind}](/outputs/${id}).`;
		}
	}
	const preview = boundedArgsJson({ result: input.data }, 300);
	return `Executed ${input.toolName} on ${input.appSlug}: ${preview}`;
}

export function setKernelWriteExecutorForTest(
	fn: typeof executeApprovedKernelWrite | null,
): void {
	activeKernelWriteExecutor = fn ?? executeApprovedKernelWrite;
}

export function setKernelToolResultRetainerForTest(
	fn: typeof retainKernelToolResult | null,
): void {
	activeKernelToolResultRetainer = fn ?? retainKernelToolResult;
}

/**
 * Bounded structured evidence for approved Home writes. Persist a size-capped
 * projection on the run metadata (alongside `kernelRoute`) so the Tedix OS transcript /
 * right rail can render it as a table/widget instead of only the text receipt —
 * without bloating D1. Arrays cap at 10 items, long strings truncate, and an
 * 8KB ceiling backstops any shape.
 */
export function boundKernelWriteEvidence(
	evidence:
		| {
				appSlug: string;
				toolName: string;
				args?: Record<string, unknown>;
				data: unknown;
				attempts?: Array<{
					toolName: string;
					args?: Record<string, unknown>;
					status: "completed" | "failed";
					data?: unknown;
					error?: string;
				}>;
				hops?: Array<{ toolName: string; args?: Record<string, unknown> }>;
				layoutSpec?: Record<string, unknown>;
		  }
		| null
		| undefined,
): {
	appSlug: string;
	toolName: string;
	args?: unknown;
	data: unknown;
	hops?: unknown;
	layoutSpec?: unknown;
} | null {
	if (!evidence) return null;
	const cap = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.slice(0, 10).map(cap);
		if (value && typeof value === "object") {
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
				out[k] = cap(v);
			}
			return out;
		}
		if (typeof value === "string" && value.length > 500) {
			return `${value.slice(0, 500)}…`;
		}
		return value;
	};
	let data = cap(evidence.data);
	const json = JSON.stringify(data ?? null);
	if (json.length > 8000) {
		data = { truncated: true, preview: `${json.slice(0, 8000)}…` };
	}
	// Generative-rendering installment 1: the DETERMINISTIC json-render
	// layoutSpec the kernel projected from `data`. Already bounded by the mapper
	// (≤10 rows, ≤6 cols, ≤80-char cells), but cap defensively + drop it if it
	// somehow blows the size ceiling — evidence without a spec just text-renders.
	let layoutSpec: unknown;
	if (evidence.layoutSpec) {
		const capped = cap(evidence.layoutSpec);
		const specJson = JSON.stringify(capped ?? null);
		layoutSpec = specJson.length <= 8000 ? capped : undefined;
	}
	return {
		appSlug: evidence.appSlug,
		toolName: evidence.toolName,
		...(evidence.args ? { args: cap(evidence.args) } : {}),
		// Chronological attempted-call timeline (successful + failed). This is
		// what Tedix OS uses for durable/live parity when retries or fallback reads
		// happen mid-turn.
		...(evidence.attempts?.length ? { attempts: cap(evidence.attempts) } : {}),
		// Multi-hop reads: the earlier discovery calls (bounded; ≤2 entries by
		// construction).
		...(evidence.hops?.length ? { hops: cap(evidence.hops) } : {}),
		...(layoutSpec ? { layoutSpec } : {}),
		data,
	};
}

function extractKernelWriteExecutionId(data: unknown): string | undefined {
	const keys = new Set([
		"id",
		"draftId",
		"messageId",
		"resourceId",
		"threadId",
	]);
	const seen = new Set<unknown>();
	const search = (value: unknown, depth: number): string | undefined => {
		if (depth > 4 || !value || typeof value !== "object") return undefined;
		if (seen.has(value)) return undefined;
		seen.add(value);
		if (Array.isArray(value)) {
			for (const item of value) {
				const found = search(item, depth + 1);
				if (found) return found;
			}
			return undefined;
		}
		for (const [key, child] of Object.entries(value)) {
			if (keys.has(key) && typeof child === "string" && child.length > 0) {
				return child;
			}
		}
		for (const child of Object.values(value)) {
			const found = search(child, depth + 1);
			if (found) return found;
		}
		return undefined;
	};
	return search(data, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Home approved-write layer (v1): propose_tool_write → approval card → execute
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic, RFC-4122-shaped approval id for a Home tool write, derived
 * from the runId (an idempotent re-enqueue reuses the same approval row, like
 * the workstation attachment id). `tediApprovals.getById/resolve` validate
 * `z.uuid()` on the row id, so the raw `${runId}:home-write` composite cannot
 * be used — hash it into a v5-style UUID instead.
 */
export async function homeToolWriteApprovalRequestId(
	runId: string,
): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(`home-tool-write:${runId}`),
		),
	);
	const bytes = digest.slice(0, 16);
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50; // version nibble (v5-style)
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
		"",
	);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Resolves the deterministic executor for a Home action that has no explicit
 * tedi owner. Baseline (org-owned) skills are intentionally visible to Home;
 * their run still needs a real tedi identity for runtime policy, MCP identity,
 * submissions, and rationale. The smallest org tedi id is a stable fallback
 * until Home grows an explicit per-conversation execution-tedi selection.
 *
 * Home tool writes use the same fallback only to satisfy the approval row's
 * non-null tedi foreign key. Their true attribution remains the Home run,
 * conversation, and initiating user in the payload. Returns `null` when the
 * organization has no tedis.
 */
export async function resolveKernelFallbackTediId(
	context: BaseContext,
	organizationId: string,
): Promise<string | null> {
	try {
		const rows = await getTedisByOrganization(context.db, organizationId);
		return (
			rows
				.map((row) => row.id)
				.filter(Boolean)
				.sort()[0] ?? null
		);
	} catch (error) {
		console.warn(
			"[kernelRuntime] fallback tedi read failed",
			errorMessage(error),
		);
		return null;
	}
}

/** Operator-facing confirmation card for a parked Kernel write. */
export function kernelWriteCardContent(input: {
	approvalRequestId: string;
	proposal: Pick<KernelWriteProposal, "appSlug" | "args" | "toolName">;
}): string {
	return [
		`Approval required before I change anything: \`${input.proposal.toolName}\` on ${input.proposal.appSlug}.`,
		`Arguments: ${boundedArgsJson(input.proposal.args)}`,
		`Nothing has been executed. Approve request ${input.approvalRequestId} to run this write exactly once, or reject it to cancel.`,
	].join("\n");
}

/**
 * Settle a resolved "home_tool_write" approval: execute the SERVER-STORED
 * call exactly once on approve, or close the Home run without executing on
 * reject/cancel. No-op for any other approval payload kind.
 *
 * CALLED BY tediApprovals.resolve/cancel AFTER the approval row transitioned
 * out of "pending" — that pending→resolved conditional update is the primary
 * exactly-once latch (a second resolve throws before reaching this hook). As
 * defense in depth this function also claims the Home run with a conditional
 * requires_approval→running update carrying a `kernelWriteExecutedAt` marker,
 * so a re-settle, a concurrent settle, or a canceled run can never execute
 * (or re-execute) the stored call.
 *
 * SECURITY: only `approval.payload` (server-stored at proposal time) reaches
 * the executor — the resolver's client input never does. Fail-soft: errors
 * are logged, never thrown back into the resolve response (the approval row
 * is already resolved at this point).
 */
export async function settleHomeToolWriteApproval(
	context: BaseContext,
	input: {
		approval: typeof tediApprovalRequests.$inferSelect;
		status: "approved" | "rejected" | "cancelled";
	},
): Promise<"succeeded" | "failed" | "closed" | "unknown" | "not_applicable"> {
	// repo_commit_write payloads execute in the tedi DO, never through the MCP
	// executor on this path. The API approval row is the exactly-once latch; once
	// it resolves, trigger the owning DO to drain its local changeset ledger.
	if (await settleRepoCommitApprovalIfNeeded(context, input))
		return "not_applicable";
	const payload = parseHomeToolWritePayload(input.approval.payload);
	if (!payload) return "not_applicable";
	if (payload.organizationId !== input.approval.orgId) {
		console.warn("[kernelRuntime] kernel write payload org mismatch", {
			approvalRequestId: input.approval.id,
		});
		return "unknown";
	}
	const canonicalInputHash = `sha256:${await canonicalDigest(payload)}`;
	const settledAt = nowIso();
	try {
		const run = await getKernelRuntimeRun(context.db, {
			id: payload.homeRunId,
			organizationId: payload.organizationId,
		});
		if (!run) {
			console.warn("[kernelRuntime] kernel write run not found", {
				approvalRequestId: input.approval.id,
				homeRunId: payload.homeRunId,
			});
			return "unknown";
		}
		const runMetadata = nonNullRecord(run.metadata) ?? {};
		// Idempotency marker: once a write executed (or started executing), no
		// resolution path may execute again.
		if (runMetadata.kernelWriteExecutedAt) {
			const existingReceipts = await listApprovalExecutionReceipts(context.db, {
				organizationId: input.approval.orgId,
				approvalRequestId: input.approval.id,
			});
			const existingReceipt = existingReceipts.find(
				(receipt) => receipt.canonicalInputHash === canonicalInputHash,
			);
			return existingReceipt
				? existingReceipt.outcome === "succeeded"
					? "succeeded"
					: "failed"
				: "unknown";
		}

		const assistantMessageId = `${payload.homeRunId}:home-write:assistant`;
		const proposalSummary = {
			appSlug: payload.appSlug,
			toolName: payload.toolName,
			args: payload.args,
		};

		if (input.status !== "approved") {
			// Rejection/cancellation: NEVER execute; close the run. Conditional on
			// requires_approval so terminal runs (canceled mid-flight, already
			// settled) are untouched.
			const progress = homeRunProgress({ eventCount: 0, status: "canceled" });
			const preview = "Kernel write rejected — nothing was executed.";
			const closed = await transitionKernelRuntimeRunStatus(context.db, {
				id: payload.homeRunId,
				organizationId: payload.organizationId,
				fromStatus: "requires_approval",
				patch: {
					status: "canceled",
					progressValue: progress.current,
					progressLabel: progress.label,
					progressDetail: progress.detail,
					latestEventKind: "run.canceled",
					latestEventAt: settledAt,
					preview,
					completedAt: settledAt,
					updatedAt: settledAt,
					metadata: toJsonRecord({
						...runMetadata,
						approvalStatus: input.status,
						approvalResolvedAt: settledAt,
					}),
				},
			});
			if (!closed) return "unknown";
			await insertKernelRuntimeEvent(context, {
				organizationId: payload.organizationId,
				kind: "message.completed",
				conversationId: payload.conversationId,
				runId: payload.homeRunId,
				messageId: assistantMessageId,
				payload: {
					role: "assistant",
					content: `The proposed write \`${payload.toolName}\` on ${payload.appSlug} was rejected — nothing was executed.`,
					channel: "home",
					metadata: {
						homeSubject: true,
						approvalRequestId: input.approval.id,
						kernelWriteProposal: proposalSummary,
					},
				},
				runtimeMetadata: {
					source: "kernelRuntime.settleHomeToolWriteApproval",
					approvalRequestId: input.approval.id,
					approvalStatus: input.status,
				},
				createdAt: settledAt,
			});
			await insertKernelRuntimeEvent(context, {
				organizationId: payload.organizationId,
				kind: "run.canceled",
				conversationId: payload.conversationId,
				runId: payload.homeRunId,
				messageId: assistantMessageId,
				payload: {
					status: "canceled",
					approvalRequestId: input.approval.id,
					resolution: input.approval.resolution ?? null,
					error: null,
				},
				runtimeMetadata: {
					source: "kernelRuntime.settleHomeToolWriteApproval",
					approvalStatus: input.status,
				},
				createdAt: settledAt,
			});
			return "closed";
		}

		// Approved: claim the run exactly once (requires_approval → running with
		// the executed-marker). A re-settle or a cancel-race loses this update
		// and never executes.
		const claimMetadata = {
			...runMetadata,
			approvalStatus: "approved",
			approvalResolvedAt: settledAt,
			kernelWriteExecutedAt: settledAt,
		};
		const runningProgress = homeRunProgress({
			eventCount: 0,
			status: "running",
		});
		const claimed = await transitionKernelRuntimeRunStatus(context.db, {
			id: payload.homeRunId,
			organizationId: payload.organizationId,
			fromStatus: "requires_approval",
			patch: {
				status: "running",
				progressValue: runningProgress.current,
				progressLabel: runningProgress.label,
				progressDetail: runningProgress.detail,
				updatedAt: settledAt,
				metadata: claimMetadata,
			},
		});
		if (!claimed) {
			console.warn("[kernelRuntime] kernel write already settled — skipping", {
				approvalRequestId: input.approval.id,
				homeRunId: payload.homeRunId,
			});
			return "unknown";
		}

		const result = await activeKernelWriteExecutor({
			env: context.env as unknown as WriteExecutorEnv,
			payload,
		}).catch((error) => ({
			ok: false as const,
			error: errorMessage(error),
		}));
		const finishedAt = nowIso();

		if (result.ok) {
			const progress = homeRunProgress({ eventCount: 0, status: "completed" });
			const kernelWriteExecutionId = extractKernelWriteExecutionId(result.data);
			const retainedResult = await activeKernelToolResultRetainer({
				db: context.db,
				bucket: context.env.TEDI_R2_BUCKET,
				organizationId: payload.organizationId,
				conversationId: payload.conversationId,
				runId: payload.homeRunId,
				sourceKind: "approved_write",
				sourceId: input.approval.id,
				value: result.data,
			});
			const evidence = boundKernelWriteEvidence({
				appSlug: payload.appSlug,
				toolName: payload.toolName,
				args: payload.args,
				data: result.data,
			});
			const content = renderKernelWriteReceipt({
				toolName: payload.toolName,
				appSlug: payload.appSlug,
				data: result.data,
			});
			await updateKernelRuntimeRunForOrg(context.db, {
				id: payload.homeRunId,
				organizationId: payload.organizationId,
				patch: {
					status: "completed",
					progressValue: progress.current,
					progressLabel: progress.label,
					progressDetail: progress.detail,
					latestEventKind: "run.completed",
					latestEventAt: finishedAt,
					preview: `Executed ${payload.toolName} on ${payload.appSlug}.`,
					completedAt: finishedAt,
					updatedAt: finishedAt,
					metadata: toJsonRecord({
						...claimMetadata,
						kernelEvidence: evidence,
						...(retainedResult
							? { kernelToolResultReference: retainedResult }
							: {}),
						kernelOutputReceipt: kernelOutputReceipt({
							toolName: payload.toolName,
							data: result.data,
						}),
						...(kernelWriteExecutionId ? { kernelWriteExecutionId } : {}),
					}),
				},
			});
			await insertKernelRuntimeEvent(context, {
				organizationId: payload.organizationId,
				kind: "message.completed",
				conversationId: payload.conversationId,
				runId: payload.homeRunId,
				messageId: assistantMessageId,
				payload: {
					role: "assistant",
					content,
					channel: "home",
					metadata: {
						homeSubject: true,
						approvalRequestId: input.approval.id,
						kernelWriteProposal: proposalSummary,
						kernelEvidence: evidence,
						...(retainedResult
							? { kernelToolResultReference: retainedResult }
							: {}),
						...(kernelWriteExecutionId ? { kernelWriteExecutionId } : {}),
					},
				},
				runtimeMetadata: {
					source: "kernelRuntime.settleHomeToolWriteApproval",
					approvalRequestId: input.approval.id,
					approvalStatus: "approved",
					...(kernelWriteExecutionId ? { kernelWriteExecutionId } : {}),
				},
				createdAt: finishedAt,
			});
			await insertKernelRuntimeEvent(context, {
				organizationId: payload.organizationId,
				kind: "run.completed",
				conversationId: payload.conversationId,
				runId: payload.homeRunId,
				messageId: assistantMessageId,
				payload: {
					status: "completed",
					approvalRequestId: input.approval.id,
					kernelEvidence: evidence,
					...(kernelWriteExecutionId ? { kernelWriteExecutionId } : {}),
					error: null,
				},
				runtimeMetadata: {
					source: "kernelRuntime.settleHomeToolWriteApproval",
					approvalStatus: "approved",
					...(kernelWriteExecutionId ? { kernelWriteExecutionId } : {}),
				},
				createdAt: finishedAt,
			});
			const receiptFields = {
				approvalRequestId: input.approval.id,
				canonicalInputHash,
				baselineFenceOutcome: "not_checked" as const,
				outcome: "succeeded" as const,
				observedResult: toJsonRecord({ evidence }),
				// Generic tool results have no contract proving that a nested id is a
				// provider receipt. Keep the bounded result as observed evidence only.
				providerReceiptRefs: [],
				executedAt: finishedAt,
			};
			await recordApprovalExecutionReceipt(context.db, {
				id: crypto.randomUUID(),
				organizationId: payload.organizationId,
				idempotencyKey: `home-tool-write:${input.approval.id}`,
				recordHash: `sha256:${await canonicalDigest(receiptFields)}`,
				createdAt: finishedAt,
				...receiptFields,
			});
			return "succeeded";
		}

		const progress = homeRunProgress({ eventCount: 0, status: "failed" });
		const failureContent = `Approved write ${payload.toolName} on ${payload.appSlug} failed: ${result.error}`;
		await updateKernelRuntimeRunForOrg(context.db, {
			id: payload.homeRunId,
			organizationId: payload.organizationId,
			patch: {
				status: "failed",
				progressValue: progress.current,
				progressLabel: progress.label,
				progressDetail: progress.detail,
				latestEventKind: "run.failed",
				latestEventAt: finishedAt,
				preview: failureContent,
				completedAt: finishedAt,
				updatedAt: finishedAt,
				metadata: { ...claimMetadata, kernelWriteError: result.error },
			},
		});
		await insertKernelRuntimeEvent(context, {
			organizationId: payload.organizationId,
			kind: "message.completed",
			conversationId: payload.conversationId,
			runId: payload.homeRunId,
			messageId: assistantMessageId,
			payload: {
				role: "assistant",
				content: failureContent,
				channel: "home",
				metadata: {
					homeSubject: true,
					approvalRequestId: input.approval.id,
					kernelWriteProposal: proposalSummary,
					error: result.error,
				},
			},
			runtimeMetadata: {
				source: "kernelRuntime.settleHomeToolWriteApproval",
				approvalRequestId: input.approval.id,
				approvalStatus: "approved",
			},
			createdAt: finishedAt,
		});
		await insertKernelRuntimeEvent(context, {
			organizationId: payload.organizationId,
			kind: "run.failed",
			conversationId: payload.conversationId,
			runId: payload.homeRunId,
			messageId: assistantMessageId,
			payload: {
				status: "failed",
				approvalRequestId: input.approval.id,
				error: result.error,
			},
			runtimeMetadata: {
				source: "kernelRuntime.settleHomeToolWriteApproval",
				approvalStatus: "approved",
			},
			createdAt: finishedAt,
		});
		const receiptFields = {
			approvalRequestId: input.approval.id,
			canonicalInputHash,
			baselineFenceOutcome: "not_checked" as const,
			outcome: "failed" as const,
			observedError: {
				code: "provider_write_failed",
				message: result.error.slice(0, 500),
				retryable: false,
			},
			providerReceiptRefs: [],
			executedAt: finishedAt,
		};
		await recordApprovalExecutionReceipt(context.db, {
			id: crypto.randomUUID(),
			organizationId: payload.organizationId,
			idempotencyKey: `home-tool-write:${input.approval.id}`,
			recordHash: `sha256:${await canonicalDigest(receiptFields)}`,
			createdAt: finishedAt,
			...receiptFields,
		});
		return "failed";
	} catch (error) {
		console.warn("[kernelRuntime] kernel write settle failed", {
			approvalRequestId: input.approval.id,
			error: errorMessage(error),
		});
		return "unknown";
	}
}

/**
 * Auto-resolve a trusted Home tool-write approval through the SAME canonical
 * latch a human approval uses — but attributed to `resolvedBy:'policy'`. Called
 * by `runKernelTurnWork` (via the `autoResolveKernelWrite` dep) ONLY when
 * {@link decideKernelWriteApproval} returned `autoResolve:true`; the gating
 * decision itself is the pure, fail-closed function — this is the execution arm.
 *
 * The audit row is NEVER skipped: the proposal path already created the
 * `tedi_approval_requests` row + `approval.requested` event; this resolves that
 * same row (pending→approved conditional update = the exactly-once latch),
 * records the symmetric `approval.approved` audit event with policy provenance,
 * then executes via `settleHomeToolWriteApproval` (the same settle a human
 * approval drives — run-claim guarded, exactly-once). Fail-soft: a non-pending
 * row (already resolved/cancelled/expired) returns null and the run stays a
 * human gate.
 */
export async function autoResolveKernelWriteApproval(
	context: BaseContext,
	input: {
		approvalRequestId: string;
		organizationId: string;
		runId: string;
		conversationId: string;
		decision: KernelWriteApprovalDecision;
	},
): Promise<{ executed: boolean; finalStatus: TediRunStatus | null } | null> {
	// Canonical exactly-once latch: pending→approved conditional update. A row
	// that is not pending (human already resolved, cancelled, expired) loses here.
	const resolved = await resolveApprovalRequest(
		context.db,
		input.approvalRequestId,
		{
			status: "approved",
			resolvedBy: "policy",
			resolution: input.decision.reason.slice(0, 200),
		},
	);
	if (!resolved) {
		console.warn(
			"[kernelRuntime] kernel write auto-resolve: approval not pending",
			{ approvalRequestId: input.approvalRequestId },
		);
		return null;
	}
	// Symmetric audit event (mirrors respondApproval's `approval.${status}`),
	// stamped with policy provenance so the trail shows WHO/WHY auto-approved.
	await insertAuditEvent(context.db, {
		organizationId: input.organizationId,
		actorId: "policy",
		actorType: "service",
		action: "approval.approved",
		resourceType: "approval_request",
		resourceId: input.approvalRequestId,
		metadata: {
			source: "kernelRuntime.autoResolveKernelWrite",
			resolverProvenance: "policy",
			autoResolveSource: input.decision.source,
			autoResolveReason: input.decision.reason.slice(0, 200),
			homeRunId: input.runId,
			conversationId: input.conversationId,
			actionType: resolved.actionType,
			tediId: resolved.tediId,
		},
	});
	// Execute through the canonical settle hook (run-claim guarded, exactly-once).
	await settleHomeToolWriteApproval(context, {
		approval: resolved,
		status: "approved",
	});
	const run = await getKernelRuntimeRun(context.db, {
		id: input.runId,
		organizationId: input.organizationId,
	});
	return {
		executed: true,
		finalStatus: (run?.status as TediRunStatus | undefined) ?? null,
	};
}
