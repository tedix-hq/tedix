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
 *   1. `tools/list` (plus Code Mode discovery for aggregate providers)
 *      re-validates the stored tool still exists upstream AND is still not
 *      read-only-annotated (a provider that re-published the tool as something
 *      else between proposal and approval aborts the write). The catalog is
 *      walked to exhaustion under the shared pagination bounds — one page is
 *      200 tools and the aggregate surface serves several hundred — and a walk
 *      that hit a bound reports the tool unverified, never missing;
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
 *
 * NOTE: the MCP call helpers (mcpHost/mcpCall and the credential-missing
 * sniff) are frozen copies of the ones in write-proposal.ts; both send through
 * the shared SDK v2 client in `lib/first-party-mcp.ts`. They were forked from the kernel's direct-read layer
 * (`execute.ts`), which was deleted — there is no read classifier
 * left to consult, so do not "reunify" these against a module that is gone.
 */

import {
	FirstPartyMcpError,
	requestFirstPartyMcp,
} from "../../../lib/first-party-mcp";
import {
	CODE_MODE_TOOL_NAME,
	codeModeDiscoveryParams,
	codeModeExecutionParams,
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

export interface WriteExecutorEnv {
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
	/** Missing on pre-Code-Mode approvals and therefore normalized to direct. */
	transport?: KernelWriteTransport;
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
	const transport = payload.transport;
	if (
		transport !== undefined &&
		transport !== "direct" &&
		transport !== "codemode"
	) {
		return null;
	}
	return {
		kind: HOME_TOOL_WRITE_KIND,
		appSlug,
		toolName,
		args: args as Record<string, unknown>,
		organizationId,
		homeRunId,
		conversationId,
		initiatedByUserId,
		...(transport ? { transport } : {}),
	};
}

export type KernelWriteExecutionResult =
	| { ok: true; data: unknown }
	| { ok: false; error: string };

interface McpTool {
	name: string;
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
					...(actingUserId ? { "X-Tedix-Acting-User": actingUserId } : {}),
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
 * Execute the approved, server-stored write call exactly as recorded.
 * Never throws — every failure returns `{ok:false}` with a bounded error.
 */
export async function executeApprovedKernelWrite(args: {
	env: WriteExecutorEnv;
	payload: HomeToolWritePayload;
}): Promise<KernelWriteExecutionResult> {
	const { env, payload } = args;
	if (!env.MCP_SERVICE || !env.MCP_URL) {
		return { ok: false, error: "MCP service binding is not configured" };
	}

	try {
		const host = mcpHost(env.MCP_URL, payload.appSlug);

		// Re-validate the stored tool still exists upstream before calling — the
		// provider catalog may have changed between proposal and approval.
		const listed = await listUpstreamTools(
			env,
			host,
			payload.organizationId,
			payload.initiatedByUserId ?? undefined,
		);
		const transport = payload.transport ?? "direct";
		const tool =
			transport === "codemode"
				? parseCodeModeCatalog(
						await mcpCall(
							env,
							host,
							payload.organizationId,
							"tools/call",
							codeModeDiscoveryParams(payload.toolName),
							payload.initiatedByUserId ?? undefined,
						),
					).find((candidate) => candidate.name === payload.toolName)
				: listed.items.find((candidate) => candidate.name === payload.toolName);
		// An absence read out of a catalog we cut short is not an absence. Both
		// checks below still abort the write — the approval is never executed on a
		// guess — but they say the catalog could not be verified rather than
		// asserting the provider dropped the tool.
		if (
			transport === "codemode" &&
			!listed.items.some((candidate) => candidate.name === CODE_MODE_TOOL_NAME)
		) {
			return {
				ok: false,
				error: listed.truncated
					? `Code Mode could not be verified on ${payload.appSlug}: its tool catalog exceeded the pagination bound`
					: `Code Mode is no longer available on ${payload.appSlug}`,
			};
		}
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

		// One tools/call with the STORED args — user-first credential, tenant
		// fallback when the personal connection is missing.
		const params =
			transport === "codemode"
				? codeModeExecutionParams(payload.toolName, payload.args)
				: { name: payload.toolName, arguments: payload.args };
		let result = (await mcpCall(
			env,
			host,
			payload.organizationId,
			"tools/call",
			params,
			payload.initiatedByUserId ?? undefined,
		)) as ToolCallResult | null;
		if (payload.initiatedByUserId && isCredentialMissing(result)) {
			console.warn(
				"[kernel.writeExec] personal cred missing — tenant fallback",
				{ appSlug: payload.appSlug, tool: payload.toolName },
			);
			result = (await mcpCall(
				env,
				host,
				payload.organizationId,
				"tools/call",
				params,
			)) as ToolCallResult | null;
		}
		if (!result) {
			return { ok: false, error: "Provider tool call failed (transport)" };
		}
		if (result.isError) {
			return {
				ok: false,
				error: boundedError(result.content ?? result),
			};
		}
		return {
			ok: true,
			data:
				transport === "codemode"
					? codeModeResultData(result)
					: unwrapCallToolResult(result, payload.toolName),
		};
	} catch (error) {
		return { ok: false, error: boundedError(errorMessage(error)) };
	}
}
