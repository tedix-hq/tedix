import { verifyAction } from "@tedix/api-contract/utils/action-receipt";

/**
 * Kernel — approved-write executor (v1).
 *
 * Executes the ONE provider write call that a human approved. The call is
 * taken EXCLUSIVELY from the server-stored approval payload
 * ({@link HomeToolWritePayload}) — client input from the resolve request
 * never reaches this module. Exactly-once semantics are owned by the caller
 * (kernel-runtime.ts `settleHomeToolWriteApproval`): the approval row's
 * pending→approved conditional update plus a run-level claim guard this
 * executor from ever running twice for the same run.
 *
 * Safety order of operations:
 *   1. `tools/list` for direct providers, or exact Code Mode description,
 *      re-validates the stored tool still exists upstream AND is still not
 *      read-only-annotated (a provider that re-published the tool as something
 *      else between proposal and approval aborts the write). The catalog is
 *      walked under the shared pagination bounds; a walk that hit a bound
 *      reports the tool unverified, never missing. An aggregate descriptor
 *      may supply an authorized native wire name, avoiding sandbox execution;
 *   2. one `tools/call` with the stored args — user-first credential
 *      (X-Tedix-Acting-User = initiatedByUserId), tenant fallback when the
 *      personal connection is missing (the approved hybrid credential model);
 *   3. structured `{ok}` result — the caller persists evidence/transcript.
 *
 * IDENTITY (docs/engineering/product/tedix-os.md): every MCP request is org-scoped
 * service-binding (`X-Service-Binding` + `X-Tedix-Org-Id`, NO tediId) and
 * carries `X-Tedix-Kernel: true` — apps/mcp maps it to the
 * `kernel` audit actor (subjectUserId = initiating human), so the
 * approved write executes attributable to the kernel, not generic service.
 * The executor sends no scopes. After apps/mcp verifies the Home approval
 * receipt for the exact call, it delegates only that tool's required scopes
 * on the API hop; revalidation and read-back calls get none. An agent-started
 * run has no initiating user: the receipt then names the approving human
 * (`X-Tedix-Approved-Home-User`) on the tenant credential, so the write still
 * carries only the approved tool's authority, never the approver's scopes.
 *
 * NOTE: the MCP call helpers (mcpHost/mcpCall and the credential-missing
 * sniff) are frozen copies of the ones in write-proposal.ts; both send through
 * the shared SDK v2 client in `lib/first-party-mcp.ts`. They were forked from the kernel's direct-read layer
 * (`execute.ts`), which was deleted — there is no read classifier
 * left to consult, so do not "reunify" these against a module that is gone.
 */

import { isWorkCreateTool, MAX_ADDITIONAL_WORK_ITEMS } from "./write-call-plan";
import {
	FirstPartyMcpError,
	requestFirstPartyMcp,
} from "../../../lib/first-party-mcp";
import {
	CODE_MODE_TOOL_NAME,
	codeModeCanonicalDescribeParams,
	codeModeExecutionParams,
	type CodeModeCatalogTool,
	codeModeReplayLookupParams,
	codeModeResultData,
	type KernelWriteTransport,
	parseCodeModeCatalog,
} from "./write-codemode";
import { unwrapCallToolResult } from "@tedix/mcp-shared/tool-result";
import {
	type BoundedMcpList,
	collectBoundedMcpList,
} from "@tedix/mcp-shared/bounded-list";
import { errorMessage } from "@tedix/worker-kit/error-message";
import {
	type ApprovalEditableField,
	type ApproverEditsRecord,
	ApproverEditsRecordSchema,
} from "@tedix/api-contract/schemas/approval-edits";
import { deriveApprovalEditableFields } from "@tedix/api-contract/utils/approval-edits";
import { parseToolPolicyMetadata } from "@tedix/api-contract/schemas/tools";
import * as z from "zod";

export interface WriteExecutorEnv {
	OS_URL?: string;
	MCP_SERVICE?: {
		fetch: (input: string, init?: RequestInit) => Promise<Response>;
	};
	MCP_URL?: string;
	/** Accepted by apps/mcp as the internal service-binding principal. */
	PLATFORM_SERVICE_TOKEN?: string;
}

export const HOME_TOOL_WRITE_KIND = "home_tool_write";

/**
 * Server-stored approval payload for a Home tool write. Created by the
 * proposal side (kernel-runtime.ts) and the ONLY input the executor accepts.
 */
export interface HomeToolWritePayload {
	kind: typeof HOME_TOOL_WRITE_KIND;
	/** Resolved provider slug (e.g. "globex-tedix"). */
	appSlug: string;
	toolName: string;
	args: Record<string, unknown>;
	organizationId: string;
	homeRunId: string;
	conversationId: string;
	initiatedByUserId: string | null;
	/** Starting agent for apply-time access checks; the receipt stays approver-bound. */
	initiatedByAgentPrincipalId?: string;
	/** Missing on pre-Code-Mode approvals and therefore normalized to direct. */
	transport?: KernelWriteTransport;
	/**
	 * Inputs the approver may change. An approval with changes rewrites `args`
	 * in the same update that approves it, so execution still reads only the
	 * stored payload.
	 */
	editableFields?: ApprovalEditableField[];
	approverEdits?: ApproverEditsRecord;
	/**
	 * Further Work items the same approval creates, each as its own call after
	 * `args`. Only the Work-creation tool carries them.
	 */
	additionalArgs?: Record<string, unknown>[];
}

/** Structural guard for an approval payload of kind "home_tool_write". */
export function parseHomeToolWritePayload(
	value: unknown,
): HomeToolWritePayload | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const payload = value as Record<string, unknown>;
	if (payload.kind !== HOME_TOOL_WRITE_KIND) return null;
	const appSlug = payload.appSlug;
	const toolName = payload.toolName;
	const organizationId = payload.organizationId;
	const homeRunId = payload.homeRunId;
	const conversationId = payload.conversationId;
	if (
		typeof appSlug !== "string" ||
		appSlug.length === 0 ||
		typeof toolName !== "string" ||
		toolName.length === 0 ||
		typeof organizationId !== "string" ||
		organizationId.length === 0 ||
		typeof homeRunId !== "string" ||
		homeRunId.length === 0 ||
		typeof conversationId !== "string" ||
		conversationId.length === 0
	) {
		return null;
	}
	const args = payload.args;
	if (!args || typeof args !== "object" || Array.isArray(args)) return null;
	const initiatedByUserId =
		typeof payload.initiatedByUserId === "string" &&
		payload.initiatedByUserId.length > 0
			? payload.initiatedByUserId
			: null;
	const initiatedByAgentPrincipalId =
		!initiatedByUserId &&
		typeof payload.initiatedByAgentPrincipalId === "string" &&
		payload.initiatedByAgentPrincipalId.length > 0
			? payload.initiatedByAgentPrincipalId
			: undefined;
	const transport = payload.transport;
	if (
		transport !== undefined &&
		transport !== "direct" &&
		transport !== "codemode"
	) {
		return null;
	}
	const edits = ApproverEditsRecordSchema.safeParse(payload.approverEdits);
	if (payload.approverEdits !== undefined && !edits.success) return null;
	const extras = payload.additionalArgs;
	if (
		extras !== undefined &&
		(!Array.isArray(extras) ||
			extras.length > MAX_ADDITIONAL_WORK_ITEMS ||
			!isWorkCreateTool(toolName) ||
			extras.some(
				(extra) => !extra || typeof extra !== "object" || Array.isArray(extra),
			))
	)
		return null;
	return {
		...(edits.success ? { approverEdits: edits.data } : {}),
		...(extras?.length
			? { additionalArgs: extras as Record<string, unknown>[] }
			: {}),
		kind: HOME_TOOL_WRITE_KIND,
		appSlug,
		toolName,
		args: args as Record<string, unknown>,
		organizationId,
		homeRunId,
		conversationId,
		initiatedByUserId,
		...(initiatedByAgentPrincipalId ? { initiatedByAgentPrincipalId } : {}),
		...(transport ? { transport } : {}),
	};
}

/**
 * The human who resolved an approval, or undefined for a policy or machine
 * resolution. `resolvedBy` stores either `user:<sub>` or a bare subject.
 */
export function approvingUserId(
	resolvedBy: string | null | undefined,
): string | undefined {
	if (!resolvedBy || resolvedBy === "policy") return undefined;
	const userId = resolvedBy.replace(/^user:/, "");
	return userId.length > 0 ? userId : undefined;
}

export type KernelWriteExecutionResult =
	| { ok: true; data: unknown }
	| {
			ok: false;
			error: string;
			/**
			 * The call never reached its target because of the platform itself
			 * (catalog lookup, transport), not because the target refused it or
			 * changed; an owner may try the same approved call once more.
			 */
			retryable?: boolean;
	  };

/** Where an approved write's execution time went, filled as each step ends. */
export type KernelWriteExecutorTimings = {
	/** Live tool revalidation (exact describe or catalog list). */
	revalidateMs?: number;
	/** The provider tool call(s), including a tenant-credential retry. */
	callMs?: number;
	/** Action-receipt read-back. */
	verifyMs?: number;
};

interface McpTool {
	name: string;
	inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
	_meta?: Record<string, unknown>;
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

type ToolCallResult = {
	structuredContent?: unknown;
	content?: unknown;
	isError?: boolean;
};

function mcpHost(mcpUrl: string, slug: string): string {
	// MCP_URL = https://mcp.tedix.dev -> {slug}.mcp.tedix.dev
	const host = new URL(mcpUrl).hostname;
	return `${slug}.${host}`;
}

async function mcpCall(
	env: WriteExecutorEnv,
	host: string,
	organizationId: string,
	method: string,
	params: Record<string, unknown>,
	actingUserId?: string,
	approvedWorkResponderUserId?: string,
	approvedFactoryRequestId?: string,
	approvedHomeUserId?: string,
): Promise<unknown | null> {
	if (!env.MCP_SERVICE || !env.MCP_URL) return null;
	const service = env.MCP_SERVICE;
	try {
		return await requestFirstPartyMcp(
			{
				url: `${env.MCP_URL}/mcp`,
				fetch: (url, init) => service.fetch(url, init),
				clientName: "tedix-home",
				headers: {
					"X-Service-Binding": "true",
					"X-Tedix-Org-Id": organizationId,
					"X-Tedix-Host": host,
					// Tenant control-plane audit marker → "kernel" actor in apps/mcp.
					"X-Tedix-Kernel": "true",
					...(approvedFactoryRequestId
						? { "X-Tedix-Approved-Factory-Request": approvedFactoryRequestId }
						: {}),
					...(actingUserId ? { "X-Tedix-Acting-User": actingUserId } : {}),
					...(approvedHomeUserId
						? { "X-Tedix-Approved-Home-User": approvedHomeUserId }
						: {}),
					...(approvedWorkResponderUserId
						? { "X-Tedix-Approved-Work-Responder": approvedWorkResponderUserId }
						: {}),
					...(env.PLATFORM_SERVICE_TOKEN
						? { Authorization: `Bearer ${env.PLATFORM_SERVICE_TOKEN}` }
						: {}),
				},
			},
			method,
			params,
		);
	} catch (error) {
		if (!(error instanceof FirstPartyMcpError)) throw error;
		if (error.kind === "http") {
			console.warn("[kernel.writeExec] mcp call not ok", {
				method,
				host,
				status: error.status,
			});
		} else {
			console.warn("[kernel.writeExec] mcp call error/parse", {
				method,
				host,
				error: JSON.stringify(error.rpcError ?? error.message).slice(0, 200),
			});
		}
		return null;
	}
}

/**
 * Read the provider's full live tool catalog under the shared pagination
 * bounds. apps/mcp mints a `tools/list` cursor at 200 entries and the aggregate
 * surface serves several hundred merged tools, so a single page is a partial
 * catalog: reading only page one refused already-approved writes as "no longer
 * available" whenever the tool happened to sort past the cut.
 */
function listUpstreamTools(
	env: WriteExecutorEnv,
	host: string,
	organizationId: string,
	actingUserId?: string,
): Promise<BoundedMcpList<McpTool>> {
	return collectBoundedMcpList<McpTool>(async (cursor) => {
		const result = (await mcpCall(
			env,
			host,
			organizationId,
			"tools/list",
			cursor === undefined ? {} : { cursor },
			actingUserId,
		)) as { tools?: McpTool[]; nextCursor?: unknown } | null;
		// A page that never arrived is not an empty page: letting it read as one
		// would abort the approved write as "no longer available upstream".
		if (result === null) {
			throw new Error("Provider tool catalog could not be listed (transport)");
		}
		return { items: result.tools, nextCursor: result.nextCursor };
	});
}

/**
 * Whether a tool result signals a MISSING/unconnected provider credential (vs
 * a genuine tool error) — drives the user-first → tenant credential fallback.
 */
function isCredentialMissing(result: ToolCallResult | null): boolean {
	if (!result?.isError) return false;
	const text = JSON.stringify(result.content ?? result).toLowerCase();
	return (
		text.includes("credential not found") ||
		text.includes("not connected") ||
		text.includes("provider is connected")
	);
}

/** The text of an MCP content array, so chat shows words, not wire JSON. */
function mcpContentText(content: unknown): string | null {
	if (!Array.isArray(content)) return null;
	const texts = content.flatMap((part) =>
		part &&
		typeof part === "object" &&
		(part as { type?: unknown }).type === "text" &&
		typeof (part as { text?: unknown }).text === "string"
			? [(part as { text: string }).text]
			: [],
	);
	return texts.length > 0 ? texts.join("\n") : null;
}

/** Bounded upstream-error text for the run/transcript record. */
function boundedError(value: unknown): string {
	try {
		const text =
			typeof value === "string" ? value : JSON.stringify(value ?? null);
		return text.length > 300 ? `${text.slice(0, 300)}…` : text;
	} catch {
		return "[unserializable upstream error]";
	}
}

/**
 * The error a successful-looking tool result carries when the write did not
 * happen, or null. Code Mode returns an inner tool failure as a successful
 * `code` call whose value is `{ ok: false, error }`, and a provider can answer
 * HTTP 200 with `{ success: false }` or a bare `{ error }` body; recording any
 * of these as executed would report a false "Executed".
 */
function reportedWriteFailure(data: unknown): unknown {
	if (!data || typeof data !== "object" || Array.isArray(data)) return null;
	const record = data as Record<string, unknown>;
	const error = record.error ?? record.message ?? data;
	if (
		record.ok === false ||
		record.success === false ||
		record.isError === true
	)
		return error;
	if (record.ok !== true && record.success !== true && record.error) {
		return record.error;
	}
	return null;
}

/** The stored call behind an owner tool approval (`mcp.tool_call` rows). */
export interface OwnerToolCallReplay {
	/** Gateway host to replay on (the organization's own gateway for `connect`). */
	appSlug: string;
	/** Native wire name of the tool on that gateway. */
	toolId: string;
	target?: Record<string, unknown>;
	args: Record<string, unknown>;
	organizationId: string;
	initiatedByUserId: string;
}

/**
 * Execute the one gateway call an owner approved, exactly as stored. The
 * gateway re-checks the approval receipt for this exact call on the way
 * (`com.tedix/approvalRequestId`), the requester's and approver's membership,
 * and consumes the approval; here the tool is re-validated upstream first.
 *
 * Re-validation reads the gateway's own catalog. A programmatic caller's
 * `tools/list` on a Code Mode gateway is the compact surface, so the stored
 * native tool is looked up through Code Mode discovery there and matched by
 * the wire name the gateway reports (`native.name`): the same name for a call
 * parked on that gateway, or its source-qualified suffix for a `connect`
 * request replayed on the organization gateway. A gateway without Code Mode
 * lists its whole catalog, where the stored name is matched directly.
 * Never throws.
 */
export async function executeApprovedOwnerToolCall(args: {
	env: WriteExecutorEnv;
	payload: OwnerToolCallReplay;
	approvalRequestId: string;
	timings?: KernelWriteExecutorTimings;
}): Promise<KernelWriteExecutionResult> {
	const { env, payload } = args;
	const timings = args.timings ?? {};
	const since = (startedAt: number) => Date.now() - startedAt;
	if (!env.MCP_SERVICE || !env.MCP_URL) {
		return {
			ok: false,
			error: "MCP service binding is not configured",
			retryable: true,
		};
	}
	try {
		const host = mcpHost(env.MCP_URL, payload.appSlug);
		const revalidateStartedAt = Date.now();
		const listed = await listUpstreamTools(
			env,
			host,
			payload.organizationId,
			payload.initiatedByUserId,
		);
		let tool:
			| { name: string; annotations?: McpTool["annotations"] }
			| undefined = resolveReplayTool(listed.items, payload.toolId);
		if (!tool && listed.items.some((t) => t.name === CODE_MODE_TOOL_NAME)) {
			const catalog = parseCodeModeCatalog(
				await mcpCall(
					env,
					host,
					payload.organizationId,
					"tools/call",
					codeModeReplayLookupParams(replayToolBaseName(payload.toolId)),
					payload.initiatedByUserId,
				),
			);
			const entry = resolveReplayCatalogEntry(
				catalog,
				payload.toolId,
				payload.target,
			);
			if (entry?.wire)
				tool = { name: entry.wire.name, annotations: entry.annotations };
		}
		timings.revalidateMs = since(revalidateStartedAt);
		if (!tool) {
			return {
				ok: false,
				error: listed.truncated
					? `Tool "${payload.toolId}" could not be verified on ${payload.appSlug}: its tool catalog exceeded the pagination bound`
					: `Tool "${payload.toolId}" is no longer available on ${payload.appSlug}`,
				retryable: true,
			};
		}
		if (tool.annotations?.readOnlyHint === true) {
			return {
				ok: false,
				error: `Tool "${payload.toolId}" was re-published as read-only; aborting the approved call`,
			};
		}
		const callStartedAt = Date.now();
		const result = (await mcpCall(
			env,
			host,
			payload.organizationId,
			"tools/call",
			{
				name: tool.name,
				arguments: payload.args,
				_meta: { "com.tedix/approvalRequestId": args.approvalRequestId },
			},
			payload.initiatedByUserId,
		)) as ToolCallResult | null;
		timings.callMs = since(callStartedAt);
		if (!result) {
			return {
				ok: false,
				error: "Provider tool call failed (transport)",
				retryable: true,
			};
		}
		if (result.isError) {
			const text = mcpContentText(result.content);
			return {
				ok: false,
				error: boundedError(text ?? result.content ?? result),
				// The gateway's own refusals (approval match, rate limiter) end with
				// this sentence: the approval stays unconsumed and nothing ran.
				...(text && /No side effect was executed/.test(text)
					? { retryable: true }
					: {}),
			};
		}
		const data = unwrapCallToolResult(result, tool.name);
		const failure = reportedWriteFailure(data);
		if (failure !== null) return { ok: false, error: boundedError(failure) };
		return { ok: true, data };
	} catch (error) {
		return {
			ok: false,
			error: boundedError(errorMessage(error)),
			retryable: true,
		};
	}
}

/**
 * The stored tool on the replay gateway: its exact name, or, for a tool the
 * request reached through a mount (`<mount>_<source>__<tool>`), the one
 * mounted tool whose source-qualified name ends the stored one.
 */
export function resolveReplayTool<T extends { name: string }>(
	tools: readonly T[],
	storedToolId: string,
): T | undefined {
	const exact = tools.find((tool) => tool.name === storedToolId);
	if (exact) return exact;
	const matches = tools.filter(
		(tool) =>
			tool.name.includes("__") && storedToolId.endsWith(`_${tool.name}`),
	);
	return matches.length === 1 ? matches[0] : undefined;
}

/** The tool's own name behind every mount prefix: `a_b__tool` → `tool`. */
export function replayToolBaseName(storedToolId: string): string {
	const index = storedToolId.lastIndexOf("__");
	return index === -1 ? storedToolId : storedToolId.slice(index + 2);
}

/**
 * The one catalog entry whose gateway wire name is the stored tool, directly
 * or by source-qualified suffix (see {@link resolveReplayTool}). The Code Mode
 * namespace is not consulted because it varies across mounts. For connected
 * MCP tools whose mount names differ, require one provider-and-tool match;
 * the gateway still checks the approved target and arguments before dispatch.
 */
export function resolveReplayCatalogEntry<
	T extends Pick<CodeModeCatalogTool, "wire" | "_meta">,
>(
	entries: readonly T[],
	storedToolId: string,
	target?: Record<string, unknown>,
): T | undefined {
	const bound = entries.flatMap((entry) =>
		entry.wire ? [{ name: entry.wire.name, entry }] : [],
	);
	const exact = resolveReplayTool(bound, storedToolId)?.entry;
	if (
		exact ||
		target?.transport !== "mcp" ||
		typeof target.providerId !== "string" ||
		typeof target.mcpToolName !== "string" ||
		target.mcpToolName !== replayToolBaseName(storedToolId)
	)
		return exact;
	const matches = entries.filter((entry) => {
		const metadata = entry._meta?.["com.tedix/connectedTool"];
		return (
			entry.wire &&
			replayToolBaseName(entry.wire.name) === target.mcpToolName &&
			metadata &&
			typeof metadata === "object" &&
			"providerId" in metadata &&
			"toolName" in metadata &&
			metadata.providerId === target.providerId &&
			metadata.toolName === target.mcpToolName
		);
	});
	return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Execute the approved, server-stored write call exactly as recorded.
 * Never throws — every failure returns `{ok:false}` with a bounded error.
 */
export async function executeApprovedKernelWrite(args: {
	env: WriteExecutorEnv;
	payload: HomeToolWritePayload;
	approvalRequestId?: string;
	/** Human from the resolved approval, distinct from the initiating user. */
	approvedWorkResponderUserId?: string;
	/**
	 * Human who approved the call. An agent-started run has no initiator, so
	 * the approval receipt is matched against this person instead. It names the
	 * receipt's principal only: the call runs on the tenant credential, never
	 * on the approver's personal credential or user scopes.
	 */
	approvedByUserId?: string;
	timings?: KernelWriteExecutorTimings;
}): Promise<KernelWriteExecutionResult> {
	const { env, payload } = args;
	const timings = args.timings ?? {};
	const since = (startedAt: number) => Date.now() - startedAt;
	if (!env.MCP_SERVICE || !env.MCP_URL) {
		return { ok: false, error: "MCP service binding is not configured" };
	}

	try {
		const host = mcpHost(env.MCP_URL, payload.appSlug);

		// Re-validate the stored tool still exists upstream before calling — the
		// provider catalog may have changed between proposal and approval.
		const transport = payload.transport ?? "direct";
		const revalidateStartedAt = Date.now();
		// A successful exact describe verifies the Code Mode surface itself.
		const listed =
			transport === "direct"
				? await listUpstreamTools(
						env,
						host,
						payload.organizationId,
						payload.initiatedByUserId ?? undefined,
					)
				: { items: [], truncated: false };
		const described =
			transport === "codemode"
				? parseCodeModeCatalog(
						await mcpCall(
							env,
							host,
							payload.organizationId,
							"tools/call",
							codeModeCanonicalDescribeParams(payload.toolName),
							payload.initiatedByUserId ?? undefined,
						),
					).find((candidate) => candidate.name === payload.toolName)
				: undefined;
		const tool =
			described ??
			listed.items.find((candidate) => candidate.name === payload.toolName);
		timings.revalidateMs = since(revalidateStartedAt);
		if (!tool) {
			return {
				ok: false,
				error:
					listed.truncated && transport !== "codemode"
						? `Tool "${payload.toolName}" could not be verified on ${payload.appSlug}: its tool catalog exceeded the pagination bound`
						: `Tool "${payload.toolName}" is no longer available on ${payload.appSlug}`,
			};
		}
		if (tool.annotations?.readOnlyHint === true) {
			// The approval was for a write; a tool republished as read-only means
			// the stored call no longer matches what was approved.
			return {
				ok: false,
				error: `Tool "${payload.toolName}" was re-published as read-only; aborting the approved write`,
			};
		}

		if (payload.approverEdits?.changes.length) {
			const editable = deriveApprovalEditableFields({
				inputSchema: tool.inputSchema,
				declared: parseToolPolicyMetadata(tool._meta)?.approvalEditableFields,
			});
			const disallowed = payload.approverEdits.changes.find(
				(change) => !editable.some((field) => field.name === change.field),
			);
			if (disallowed)
				return {
					ok: false,
					error: `Edited field "${disallowed.field}" is not editable under the live tool policy`,
				};
			try {
				if (!tool.inputSchema) throw new Error("missing schema");
				const schema = { type: "object", ...tool.inputSchema };
				const checked = z
					.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0])
					.safeParse(payload.args);
				if (!checked.success) {
					const path = checked.error.issues[0]?.path.join(".") || "arguments";
					return {
						ok: false,
						error: `Edited arguments do not match the live tool schema at ${path}; request a new approval`,
					};
				}
			} catch {
				return {
					ok: false,
					error:
						"Edited arguments could not be validated against the live tool schema; request a new approval",
				};
			}
		}

		// One tools/call with the STORED args — user-first credential, tenant
		// fallback when the personal connection is missing.
		// A Code Mode receipt is bound to the projected callable, which its
		// approval gate supplies independently of the native wire name.
		const callStored = async (
			callArgs: Record<string, unknown>,
		): Promise<KernelWriteExecutionResult> => {
			const nativeName = described?.native?.name;
			const params = nativeName
				? { name: nativeName, arguments: callArgs }
				: transport === "codemode"
					? codeModeExecutionParams(payload.toolName, callArgs)
					: { name: payload.toolName, arguments: callArgs };
			if (args.approvalRequestId)
				params._meta = {
					"com.tedix/homeApprovalRequestId": args.approvalRequestId,
					...(nativeName
						? { "com.tedix/homeApprovalToolName": payload.toolName }
						: {}),
				};
			const callStartedAt = Date.now();
			let result = (await mcpCall(
				env,
				host,
				payload.organizationId,
				"tools/call",
				params,
				payload.initiatedByUserId ?? undefined,
				/(?:^|\.|__)respond_work_interaction$/.test(payload.toolName)
					? args.approvedWorkResponderUserId
					: undefined,
				/^projects\.(?:create|pause|resume|archive)_factory$/.test(
					payload.toolName,
				)
					? args.approvalRequestId
					: undefined,
				// An agent-started run has no initiator: the receipt names the
				// approver, and the call already runs on the tenant credential.
				!payload.initiatedByUserId && args.approvalRequestId
					? args.approvedByUserId
					: undefined,
			)) as ToolCallResult | null;
			if (payload.initiatedByUserId && isCredentialMissing(result)) {
				console.warn(
					"[kernel.writeExec] personal cred missing — tenant fallback",
					{ appSlug: payload.appSlug, tool: payload.toolName },
				);
				// Tenant credential, but the approval receipt still names its member.
				result = (await mcpCall(
					env,
					host,
					payload.organizationId,
					"tools/call",
					params,
					undefined,
					undefined,
					undefined,
					args.approvalRequestId ? payload.initiatedByUserId : undefined,
				)) as ToolCallResult | null;
			}
			timings.callMs = (timings.callMs ?? 0) + since(callStartedAt);
			if (!result) {
				return { ok: false, error: "Provider tool call failed (transport)" };
			}
			if (result.isError) {
				return {
					ok: false,
					error: boundedError(
						mcpContentText(result.content) ?? result.content ?? result,
					),
				};
			}
			const data =
				transport === "codemode" && !nativeName
					? codeModeResultData(result)
					: unwrapCallToolResult(result, nativeName ?? payload.toolName);
			const failure = reportedWriteFailure(data);
			if (failure !== null) return { ok: false, error: boundedError(failure) };
			const verifyStartedAt = Date.now();
			const actionReceipt = await verifyAction({
				operation: payload.toolName,
				args: callArgs,
				result: data,
				actor: payload.initiatedByUserId
					? `kernel on behalf of user:${payload.initiatedByUserId}`
					: "kernel",
				origin: env.OS_URL ?? "",
				read: async (name, input) => {
					const readName =
						transport === "codemode"
							? `${payload.toolName.split(/\.|__/)[0]}.${name}`
							: `${payload.toolName.split(/\.|__/)[0]}__${name}`;
					if (
						transport === "direct" &&
						listed.items.find((candidate) => candidate.name === readName)
							?.annotations?.readOnlyHint !== true
					)
						throw new Error("Read-back tool is not verified read-only");
					const readResult = (await mcpCall(
						env,
						host,
						payload.organizationId,
						"tools/call",
						transport === "codemode"
							? codeModeExecutionParams(readName, input)
							: { name: readName, arguments: input },
						payload.initiatedByUserId ?? undefined,
					)) as ToolCallResult | null;
					if (!readResult || readResult.isError)
						throw new Error("Read-back unavailable");
					return transport === "codemode"
						? codeModeResultData(readResult)
						: unwrapCallToolResult(readResult, readName);
				},
			});
			timings.verifyMs = (timings.verifyMs ?? 0) + since(verifyStartedAt);
			return {
				ok: true,
				data:
					data && typeof data === "object" && !Array.isArray(data)
						? { ...data, actionReceipt }
						: { result: data, actionReceipt },
			};
		};
		const first = await callStored(payload.args);
		const extras = payload.additionalArgs ?? [];
		if (!first.ok || extras.length === 0) return first;
		// A batch of Work items: each further item is its own call with its own
		// receipt. A later failure says exactly what was already created.
		const created: unknown[] = [];
		for (const [index, extra] of extras.entries()) {
			const next = await callStored(extra);
			if (!next.ok)
				return {
					ok: false,
					error: boundedError(
						`Created ${index + 1} of ${extras.length + 1} Work items; item ${index + 2} failed: ${next.error}`,
					),
				};
			created.push(next.data);
		}
		return {
			ok: true,
			data: { ...(first.data as Record<string, unknown>), batch: created },
		};
	} catch (error) {
		return { ok: false, error: boundedError(errorMessage(error)) };
	}
}
