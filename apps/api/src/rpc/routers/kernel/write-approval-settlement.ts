import type { KernelRuntimeEvent } from "@tedix/api-contract/schemas/kernel-runtime";
import {
	renderActionReceipt,
	type ActionReceipt,
} from "@tedix/api-contract/utils/action-receipt";
import type { TediRunStatus } from "@tedix/api-contract/schemas/cognitive-runtime";
import {
	OsOutputSchema,
	OsOutputRevisionSchema,
} from "@tedix/api-contract/schemas/os-workspaces";
import type { KernelWriteApprovalDecision } from "@tedix/api-contract/utils/approval-policy";
import { resolveApprovalRequest } from "@tedix/db/queries/approvals";
import type { CreateApprovalRequestParams } from "@tedix/db/queries/approvals";
import type { InsertAuditEventParams } from "@tedix/db/queries/audit";
import { admitKernelAutoWrite } from "@tedix/db/queries/approvals";
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
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import { roleImpliesPermission } from "@tedix/auth/rbac";
import type { tediApprovalRequests } from "@tedix/db/schema/approvals";
import { toJsonRecord } from "@tedix/db/utils/json";
import { canonicalDigest } from "../../../lib/blueprint-digest";
import { retainKernelToolResult } from "../../../services/kernel-tool-result-retention";
import type { BaseContext } from "../../orpc";
import { settleRepoCommitApprovalIfNeeded } from "./repo-commit-approval-settle";
import {
	insertKernelRuntimeEvent,
	persistKernelTurnSettlement,
} from "./run-store";
import {
	boundedArgsJson,
	errorMessage,
	homeRunProgress,
	nonNullRecord,
	nowIso,
} from "./runtime-shared";
import {
	approvingUserId,
	executeApprovedKernelWrite,
	parseHomeToolWritePayload,
	type KernelWriteExecutorTimings,
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

const editedOutputReceiptSchema = OsOutputSchema.pick({
	id: true,
	kind: true,
	title: true,
});

/** OS output edits whose result is `{ output, revision }`, by bare tool name. */
const OUTPUT_EDIT_RECEIPT_VERBS: ReadonlyMap<string, string> = new Map([
	["patch_os_document", "Updated"],
	["patch_os_slides", "Updated"],
	["set_os_sheet_range", "Updated"],
	["revise_os_output", "Updated"],
	["rename_os_output", "Renamed to"],
]);

/** The title is tool-authored text: keep it plain so it cannot become markup. */
function plainReceiptTitle(title: string): string {
	return title
		.replace(/[[\]()<>`*_~#|\\!]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80);
}

export function renderKernelWriteReceipt(input: {
	toolName: string;
	appSlug: string;
	data: unknown;
}): string {
	const actionReceipt = nonNullRecord(nonNullRecord(input.data)?.actionReceipt);
	if (actionReceipt && typeof actionReceipt.verified === "boolean")
		return renderActionReceipt(actionReceipt as unknown as ActionReceipt);
	if (/^kernel(?:\.|__)rename_conversation$/.test(input.toolName)) {
		const conversation = nonNullRecord(nonNullRecord(input.data)?.conversation);
		if (typeof conversation?.title === "string" && conversation.title.trim()) {
			return `Renamed this conversation to “${plainReceiptTitle(conversation.title)}”.`;
		}
	}
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
	const bareOsTool = /^os(?:\.|__)(.+)$/.exec(input.toolName)?.[1];
	const verb = bareOsTool ? OUTPUT_EDIT_RECEIPT_VERBS.get(bareOsTool) : null;
	if (verb) {
		const parsed = editedOutputReceiptSchema.safeParse(
			nonNullRecord(input.data)?.output,
		);
		if (parsed.success) {
			const { id, kind, title } = parsed.data;
			const name = plainReceiptTitle(title);
			return `${verb} ${name ? `“${name}”` : `your ${kind}`}. [Open ${kind}](/outputs/${id}).`;
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

export function kernelWriteSummary(
	proposal: Pick<
		KernelWriteProposal,
		"args" | "toolName" | "outputTitle" | "destinationTitle" | "additionalArgs"
	>,
): string {
	const { args, toolName, outputTitle, destinationTitle } = proposal;
	const tool = /^os(?:\.|__)(.+)$/.exec(toolName)?.[1];
	const name = outputTitle
		? `“${plainReceiptTitle(outputTitle)}”`
		: "your output";
	let summary: string;
	if (tool === "create_os_output") {
		const kind =
			typeof args.kind === "string" ? plainReceiptTitle(args.kind) : "document";
		const title =
			typeof args.title === "string"
				? ` “${plainReceiptTitle(args.title)}”`
				: "";
		summary = `Create ${kind}${title}`;
	} else if (
		tool === "set_os_sheet_range" &&
		typeof args.startRow === "number" &&
		typeof args.startColumn === "number" &&
		Array.isArray(args.cells)
	) {
		const cell = (row: number, column: number) => {
			let letters = "";
			for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26)) {
				letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
			}
			return `${letters}${row + 1}`;
		};
		const start = cell(args.startRow, args.startColumn);
		const width = Math.max(
			...args.cells.map((row) => (Array.isArray(row) ? row.length : 0)),
		);
		const end = cell(
			args.startRow + args.cells.length - 1,
			args.startColumn + width - 1,
		);
		summary = `Update cells ${start === end ? start : `${start}:${end}`} in ${outputTitle ? name : "your sheet"}`;
	} else if (
		(toolName.split(/\.|__/).at(-1) ?? toolName) === "create_work_items" &&
		typeof args.title === "string"
	) {
		// Say what is created and where, never the tool's name: a Work item
		// titled after an approval problem read as an unrelated policy card.
		const where = destinationTitle
			? ` in ${plainReceiptTitle(destinationTitle)}`
			: "";
		const titles = [args, ...(proposal.additionalArgs ?? [])].map((item) =>
			typeof item.title === "string"
				? `“${plainReceiptTitle(item.title)}”`
				: "an untitled item",
		);
		summary = `Create ${titles.length} Work ${titles.length === 1 ? "item" : "items"}${where}: ${titles.join(", ")}`;
	} else if (tool === "rename_os_gadget" && typeof args.name === "string") {
		summary = `Rename the app to “${plainReceiptTitle(args.name)}”`;
	} else if (tool && OUTPUT_EDIT_RECEIPT_VERBS.has(tool)) {
		summary =
			tool === "rename_os_output" && typeof args.title === "string"
				? `Rename ${name} to “${plainReceiptTitle(args.title)}”`
				: `Update ${name}`;
	} else {
		const action = plainReceiptTitle(
			(toolName.split(/\.|__/).at(-1) ?? toolName).replace(/_/g, " "),
		);
		const details = ["title", "name", "to", "subject", "amount"].flatMap(
			(key) => {
				const value = args[key];
				return typeof value === "string" || typeof value === "number"
					? [`${key}: ${plainReceiptTitle(String(value))}`]
					: [];
			},
		);
		summary = `${action.charAt(0).toUpperCase()}${action.slice(1)}${details.length ? ` — ${details.join("; ")}` : ""}`;
	}
	return summary;
}

/** Operator-facing confirmation card for a parked Kernel write. */
export function kernelWriteCardContent(input: {
	approvalRequestId: string;
	proposal: Pick<
		KernelWriteProposal,
		| "appSlug"
		| "args"
		| "toolName"
		| "outputTitle"
		| "destinationTitle"
		| "additionalArgs"
	> & { reasoning?: string | null };
}): string {
	const { args, toolName } = input.proposal;
	return [
		`${kernelWriteSummary(input.proposal)}.`,
		...(toolName === "projects.create_factory" && input.proposal.reasoning
			? [input.proposal.reasoning]
			: []),
		"The write runs with your connection, or your organization’s connection if you have none.",
		"Nothing has been executed. Reply “approve” or “yes” to proceed, or “reject” to cancel.",
		"### Details",
		`Tool: \`${toolName}\` on ${input.proposal.appSlug}`,
		`Request: ${input.approvalRequestId}`,
		`Arguments: ${boundedArgsJson(args)}`,
	].join("\n\n");
}

/**
 * Whether the human a parked Home write acts for may still act in the
 * organization: an active member whose current role or grants include the
 * permission that admitted them (`os:run` for the initiator of a Home turn,
 * `os:approve` for the approver of an agent-started run).
 */
async function principalMayStillAct(
	context: BaseContext,
	organizationId: string,
	descopeUserId: string,
	permission: "os:run" | "os:approve",
): Promise<boolean> {
	const member = await getMemberByUserId(
		context.db,
		organizationId,
		descopeUserId,
	);
	if (member?.status !== "active") return false;
	if (roleImpliesPermission([member.role], permission)) return true;
	// Both permissions are tenant-grantable, so a member override counts.
	return (
		Array.isArray(member.customPermissions) &&
		member.customPermissions.includes(permission)
	);
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
		onSettledMessage?: (event: KernelRuntimeEvent) => void;
		onSettledTerminal?: (event: KernelRuntimeEvent) => void;
		holdAfterSettle?: (work: Promise<void>) => void;
	},
	admittedMetadata?: Record<string, unknown>,
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
		const run = admittedMetadata
			? { metadata: admittedMetadata }
			: await getKernelRuntimeRun(context.db, {
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
		if (!admittedMetadata && runMetadata.kernelWriteExecutedAt) {
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

		// Close the parked run without executing. Conditional on
		// requires_approval so terminal runs (canceled mid-flight, already
		// settled) are untouched.
		const closeWithoutExecuting = async (close: {
			preview: string;
			content: string;
			approvalStatus: string;
		}): Promise<"closed" | "unknown"> => {
			const progress = homeRunProgress({ eventCount: 0, status: "canceled" });
			const preview = close.preview;
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
						approvalStatus: close.approvalStatus,
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
					content: close.content,
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
					approvalStatus: close.approvalStatus,
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
					approvalStatus: close.approvalStatus,
				},
				createdAt: settledAt,
			});
			return "closed";
		};

		if (input.status !== "approved") {
			return closeWithoutExecuting({
				preview: "Kernel write rejected — nothing was executed.",
				content: `The proposed write \`${payload.toolName}\` on ${payload.appSlug} was rejected — nothing was executed.`,
				approvalStatus: input.status,
			});
		}

		// The approval authorizes this one stored call on behalf of the person
		// who asked for it, never with the approver's authority. A deferred
		// approval can land after that person left the organization or lost Home
		// access, so re-check their current membership before acting for them.
		// The admitted path runs inside the initiator's own authenticated turn.
		if (
			!admittedMetadata &&
			payload.initiatedByUserId &&
			!(await principalMayStillAct(
				context,
				payload.organizationId,
				payload.initiatedByUserId,
				"os:run",
			))
		) {
			console.warn("[kernelRuntime] kernel write initiator lost access", {
				approvalRequestId: input.approval.id,
				homeRunId: payload.homeRunId,
			});
			return closeWithoutExecuting({
				preview:
					"Kernel write not executed — the person who asked for it no longer has access.",
				content: `The approved write \`${payload.toolName}\` on ${payload.appSlug} was not executed: the person who asked for it no longer has access to this organization.`,
				approvalStatus: "initiator_revoked",
			});
		}
		// An agent-started run has no initiator. Its receipt is bound to the
		// approving human instead, so the same apply-time re-check applies to
		// them: still an active member who may approve. Their personal
		// credential and scopes are never used; the write carries only the
		// approved tool's authority on the tenant credential. An approver
		// resolving in their own authenticated request just passed the resolve
		// guard; a deferred settlement re-reads their membership.
		const approvedByUserId = approvingUserId(input.approval.resolvedBy);
		const approverActsNow =
			approvedByUserId !== undefined &&
			approvedByUserId ===
				(context.gatewayEndUserId ?? context.user?.sub ?? context.authType);
		if (
			!admittedMetadata &&
			!payload.initiatedByUserId &&
			approvedByUserId &&
			!approverActsNow &&
			!(await principalMayStillAct(
				context,
				payload.organizationId,
				approvedByUserId,
				"os:approve",
			))
		) {
			console.warn("[kernelRuntime] kernel write approver lost access", {
				approvalRequestId: input.approval.id,
				homeRunId: payload.homeRunId,
			});
			return closeWithoutExecuting({
				preview:
					"Kernel write not executed — the person who approved it no longer has access.",
				content: `The approved write \`${payload.toolName}\` on ${payload.appSlug} was not executed: the person who approved it no longer has access to this organization.`,
				approvalStatus: "approver_revoked",
			});
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
		const claimed = admittedMetadata
			? true
			: await transitionKernelRuntimeRunStatus(context.db, {
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

		const executeStartedAt = Date.now();
		const executorTimings: KernelWriteExecutorTimings = {};
		const result = await activeKernelWriteExecutor({
			env: context.env as unknown as WriteExecutorEnv,
			payload,
			approvalRequestId: input.approval.id,
			approvedWorkResponderUserId:
				input.approval.resolvedBy === "policy"
					? (payload.initiatedByUserId ?? undefined)
					: (input.approval.resolvedBy ?? undefined),
			approvedByUserId,
			timings: executorTimings,
		}).catch((error) => ({
			ok: false as const,
			error: errorMessage(error),
		}));
		const finishedAt = nowIso();
		const executeEndedAt = Date.now();

		const status = result.ok ? ("completed" as const) : ("failed" as const);
		const progress = homeRunProgress({ eventCount: 0, status });
		const kernelWriteExecutionId = result.ok
			? extractKernelWriteExecutionId(result.data)
			: null;
		const retainedResult = result.ok
			? await activeKernelToolResultRetainer({
					db: context.db,
					bucket: context.env.TEDI_R2_BUCKET,
					organizationId: payload.organizationId,
					conversationId: payload.conversationId,
					runId: payload.homeRunId,
					sourceKind: "approved_write",
					sourceId: input.approval.id,
					value: result.data,
					freshSource: true,
				})
			: null;
		const evidence = result.ok
			? boundKernelWriteEvidence({
					appSlug: payload.appSlug,
					toolName: payload.toolName,
					args: payload.args,
					data: result.data,
				})
			: null;
		const outputReceipt = result.ok
			? kernelOutputReceipt({ toolName: payload.toolName, data: result.data })
			: null;
		const content = result.ok
			? renderKernelWriteReceipt({
					toolName: payload.toolName,
					appSlug: payload.appSlug,
					data: result.data,
				})
			: `Approved write ${payload.toolName} on ${payload.appSlug} failed: ${result.error}`;
		const completedPatch = {
			status,
			...(admittedMetadata ? { outputMessageId: assistantMessageId } : {}),
			progressValue: progress.current,
			progressLabel: progress.label,
			progressDetail: progress.detail,
			latestEventKind: result.ok
				? ("run.completed" as const)
				: ("run.failed" as const),
			latestEventAt: finishedAt,
			preview: content,
			completedAt: finishedAt,
			updatedAt: finishedAt,
			metadata: toJsonRecord({
				...claimMetadata,
				kernelRoute: {
					...nonNullRecord(runMetadata.kernelRoute),
					answer: content,
				},
				kernelEvidence: evidence,
				...(retainedResult
					? { kernelToolResultReference: retainedResult }
					: {}),
				kernelOutputReceipt: outputReceipt,
				...(result.ok && !content.startsWith(`Executed ${payload.toolName} on `)
					? { kernelWriteReceipt: content.slice(0, 600) }
					: {}),
				...(kernelWriteExecutionId ? { kernelWriteExecutionId } : {}),
				...(!result.ok ? { kernelWriteError: result.error } : {}),
				kernelWriteSettleTimings: {
					executeMs: executeEndedAt - executeStartedAt,
					...executorTimings,
					retainMs: Date.now() - executeEndedAt,
				},
			}),
			outputRevisionId: outputReceipt?.revisionId ?? null,
		};
		const receiptFields = {
			approvalRequestId: input.approval.id,
			canonicalInputHash,
			baselineFenceOutcome: "not_checked" as const,
			...(result.ok
				? {
						outcome: "succeeded" as const,
						observedResult: toJsonRecord({ evidence }),
					}
				: {
						outcome: "failed" as const,
						observedError: {
							code: "provider_write_failed",
							message: result.error.slice(0, 500),
							retryable: false,
						},
					}),
			providerReceiptRefs: [],
			executedAt: finishedAt,
		};
		const approvalReceipt = {
			id: crypto.randomUUID(),
			organizationId: payload.organizationId,
			idempotencyKey: `home-tool-write:${input.approval.id}`,
			recordHash: `sha256:${await canonicalDigest(receiptFields)}`,
			createdAt: finishedAt,
			...receiptFields,
		};
		const eventRuntimeMetadata = {
			source: "kernelRuntime.settleHomeToolWriteApproval",
			approvalRequestId: input.approval.id,
			approvalStatus: "approved",
			...(kernelWriteExecutionId ? { kernelWriteExecutionId } : {}),
		};
		const settled = await persistKernelTurnSettlement(context, {
			holdAfterSettle: input.holdAfterSettle,
			approvalReceipt: admittedMetadata ? approvalReceipt : undefined,
			run: {
				id: payload.homeRunId,
				organizationId: payload.organizationId,
				fromStatus: "running",
				patch: completedPatch,
			},
			events: [
				{
					organizationId: payload.organizationId,
					kind: "message.completed",
					conversationId: payload.conversationId,
					runId: payload.homeRunId,
					messageId: assistantMessageId,
					createdAt: finishedAt,
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
							...(!result.ok ? { error: result.error } : {}),
						},
					},
					runtimeMetadata: eventRuntimeMetadata,
				},
				{
					organizationId: payload.organizationId,
					kind: result.ok ? "run.completed" : "run.failed",
					conversationId: payload.conversationId,
					runId: payload.homeRunId,
					messageId: assistantMessageId,
					createdAt: new Date(Date.parse(finishedAt) + 1).toISOString(),
					payload: {
						status,
						approvalRequestId: input.approval.id,
						kernelEvidence: evidence,
						...(kernelWriteExecutionId ? { kernelWriteExecutionId } : {}),
						error: result.ok ? null : result.error,
					},
					runtimeMetadata: eventRuntimeMetadata,
				},
			],
		});
		if (!settled.runTransitioned)
			await updateKernelRuntimeRunForOrg(context.db, {
				id: payload.homeRunId,
				organizationId: payload.organizationId,
				patch: completedPatch,
			});
		if (!admittedMetadata)
			await recordApprovalExecutionReceipt(context.db, approvalReceipt);
		input.onSettledTerminal?.(settled.terminalEvent);
		input.onSettledMessage?.(settled.assistantEvent);
		return result.ok ? "succeeded" : "failed";
	} catch (error) {
		console.warn("[kernelRuntime] kernel write settle failed", {
			approvalRequestId: input.approval.id,
			error: errorMessage(error),
		});
		return "unknown";
	}
}

export interface DirectKernelWriteInput {
	holdAfterSettle?: (work: Promise<void>) => void;
	approval: CreateApprovalRequestParams;
	requestedAudit: InsertAuditEventParams;
	decision: KernelWriteApprovalDecision;
	runId: string;
	conversationId: string;
	metadata: Record<string, unknown>;
}

/** The turn owns execution already. Persist its policy admission and audits
 * before calling the executor; a batch failure must propagate without a write. */
export async function executeDirectKernelWrite(
	context: BaseContext,
	input: DirectKernelWriteInput,
): Promise<{
	executed: boolean;
	finalStatus: TediRunStatus | null;
	assistantEvent: KernelRuntimeEvent | null;
	terminalEvent: KernelRuntimeEvent | null;
}> {
	if (!input.decision.autoResolve)
		throw new Error("Direct write was not auto-approved");
	const resolvedAt = nowIso();
	const metadata = {
		...input.metadata,
		approvalStatus: "approved",
		approvalResolvedAt: resolvedAt,
		kernelWriteExecutedAt: resolvedAt,
	};
	const admissionStartedAt = Date.now();
	const admitted = await admitKernelAutoWrite(context.db, {
		approval: input.approval,
		requestedAudit: input.requestedAudit,
		approvedAudit: {
			organizationId: input.approval.orgId,
			actorId: "policy",
			actorType: "service",
			action: "approval.approved",
			resourceType: "approval_request",
			resourceId: input.approval.id,
			metadata: {
				source: "kernelRuntime.autoResolveKernelWrite",
				resolverProvenance: "policy",
				autoResolveSource: input.decision.source,
				autoResolveReason: input.decision.reason.slice(0, 200),
				homeRunId: input.runId,
				conversationId: input.conversationId,
				actionType: input.approval.actionType,
				tediId: input.approval.tediId,
			},
		},
		runId: input.runId,
		metadata: toJsonRecord(metadata),
		resolvedAt,
		resolution: input.decision.reason.slice(0, 200),
	});
	if (!admitted) throw new Error("Direct write run is no longer executable");
	let assistantEvent: KernelRuntimeEvent | null = null;
	let terminalEvent: KernelRuntimeEvent | null = null;
	const outcome = await settleHomeToolWriteApproval(
		context,
		{
			approval: {
				...input.approval,
				workflowId: input.approval.workflowId ?? null,
				status: "approved",
				resolvedBy: "policy",
				resolvedAt,
				resolution: input.decision.reason.slice(0, 200),
			},
			status: "approved",
			holdAfterSettle: input.holdAfterSettle,
			onSettledMessage: (event) => {
				assistantEvent = event;
			},
			onSettledTerminal: (event) => {
				terminalEvent = event;
			},
		},
		{ ...metadata, kernelWriteAdmissionMs: Date.now() - admissionStartedAt },
	);
	if (outcome !== "succeeded" && outcome !== "failed")
		throw new Error(
			"Direct write settlement is unknown; execution must not retry",
		);
	return {
		executed: true,
		finalStatus:
			outcome === "succeeded" ? ("completed" as const) : ("failed" as const),
		assistantEvent,
		terminalEvent,
	};
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
): Promise<{
	executed: boolean;
	finalStatus: TediRunStatus | null;
	assistantEvent: KernelRuntimeEvent | null;
} | null> {
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
	let assistantEvent: KernelRuntimeEvent | null = null;
	// Execute through the canonical settle hook (run-claim guarded, exactly-once).
	const outcome = await settleHomeToolWriteApproval(context, {
		approval: resolved,
		status: "approved",
		onSettledMessage: (event) => {
			assistantEvent = event;
		},
	});
	// A settled write wrote this status itself; read only when it is unknown.
	const finalStatus: TediRunStatus | null =
		outcome === "succeeded"
			? "completed"
			: outcome === "failed"
				? "failed"
				: (((
						await getKernelRuntimeRun(context.db, {
							id: input.runId,
							organizationId: input.organizationId,
						})
					)?.status as TediRunStatus | undefined) ?? null);
	return { executed: true, assistantEvent, finalStatus };
}
