import type { ErrorClass, HealthStatus } from "@tedix/db/schema/catalog";

export interface SuccessfulMcpScanDiagnosticsInput {
	partialAuth?: boolean;
	listsTruncated?: Partial<McpScanListTruncation>;
	connectTimeMs: number;
	methodErrors?: Record<string, string>;
	toolCount: number;
	resourceCount: number;
	resourceTemplateCount: number;
	promptCount: number;
	skillCount?: number;
}

export type McpScanInventoryList =
	| "tools"
	| "resources"
	| "resourceTemplates"
	| "prompts"
	| "skills";

export type McpScanListTruncation = Record<McpScanInventoryList, boolean>;

export const MCP_SCAN_WORKFLOW_LIST_LIMITS: Record<
	McpScanInventoryList,
	number
> = {
	tools: 200,
	resources: 200,
	resourceTemplates: 100,
	prompts: 100,
	skills: 100,
};

/**
 * Workflow step payloads deliberately cap each retained list. A list cut by
 * either the MCP client or this projection limit cannot authoritatively replace
 * prior catalog inventory, while unaffected lists remain independently usable.
 */
export function getMcpScanWorkflowListTruncation(
	itemCounts: Partial<Record<McpScanInventoryList, number>>,
	upstreamTruncated: Partial<McpScanListTruncation> = {},
): McpScanListTruncation {
	return {
		tools:
			upstreamTruncated.tools === true ||
			(itemCounts.tools ?? 0) > MCP_SCAN_WORKFLOW_LIST_LIMITS.tools,
		resources:
			upstreamTruncated.resources === true ||
			(itemCounts.resources ?? 0) > MCP_SCAN_WORKFLOW_LIST_LIMITS.resources,
		resourceTemplates:
			upstreamTruncated.resourceTemplates === true ||
			(itemCounts.resourceTemplates ?? 0) >
				MCP_SCAN_WORKFLOW_LIST_LIMITS.resourceTemplates,
		prompts:
			upstreamTruncated.prompts === true ||
			(itemCounts.prompts ?? 0) > MCP_SCAN_WORKFLOW_LIST_LIMITS.prompts,
		skills:
			upstreamTruncated.skills === true ||
			(itemCounts.skills ?? 0) > MCP_SCAN_WORKFLOW_LIST_LIMITS.skills,
	};
}

export interface SuccessfulMcpScanDiagnostics {
	status: HealthStatus;
	authState: "none" | "required";
	errorMessage?: string;
	errorClass?: ErrorClass;
	hasInventory: boolean;
	methodErrorCount: number;
	authGatedLists: boolean;
	logSuffix: string;
}

const EMPTY_INVENTORY_MESSAGE =
	"Endpoint initialized but did not report MCP tools, resources, resource templates, prompts, or skills.";

export function isAuthLikeMcpListError(message: string): boolean {
	const lower = message.toLowerCase();
	return (
		lower.includes("oauth") ||
		lower.includes("unauthorized") ||
		lower.includes("forbidden") ||
		lower.includes("authentication required") ||
		lower.includes("authorization required") ||
		lower.includes("invalid_token") ||
		lower.includes("missing token") ||
		/\b40[13]\b/.test(lower)
	);
}

export function compactMcpListError(message: string): string {
	const compact = message
		.replace(/\s+/g, " ")
		.replace(
			/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
			"session-id",
		)
		.trim();
	const statusMatch = compact.match(/^(HTTP \d+:\s*[^-{]+)/);
	const rpcMatch = compact.match(/^(RPC error [^:]+:\s*[^-{]+)/);
	const jsonMessageMatch = compact.match(/"message"\s*:\s*"([^"]+)"/);
	const summary =
		statusMatch?.[1]?.trim() ??
		rpcMatch?.[1]?.trim() ??
		compact.split(" - {")[0]?.trim() ??
		compact;
	const detail = jsonMessageMatch?.[1]?.trim();
	const withDetail = detail ? `${summary} (${detail})` : summary;
	return withDetail.length > 240
		? `${withDetail.slice(0, 237).trimEnd()}...`
		: withDetail;
}

export function summarizeMcpListErrors(
	methodErrors: Record<string, string> | undefined,
): string | undefined {
	const entries = Object.entries(methodErrors ?? {});
	if (entries.length === 0) return undefined;
	return `MCP list method errors: ${entries
		.map(([method, message]) => `${method}: ${compactMcpListError(message)}`)
		.join("; ")}`;
}

export function classifySuccessfulMcpScan(
	input: SuccessfulMcpScanDiagnosticsInput,
): SuccessfulMcpScanDiagnostics {
	const methodErrorEntries = Object.entries(input.methodErrors ?? {});
	const hasInventory =
		input.toolCount > 0 ||
		input.resourceCount > 0 ||
		input.resourceTemplateCount > 0 ||
		input.promptCount > 0 ||
		(input.skillCount ?? 0) > 0;
	const authGatedLists =
		!hasInventory &&
		methodErrorEntries.length > 0 &&
		methodErrorEntries.every(([, message]) => isAuthLikeMcpListError(message));
	const methodErrorSummary = summarizeMcpListErrors(input.methodErrors);

	let status: HealthStatus;
	if (authGatedLists) {
		status = "requires_auth";
	} else if (
		input.partialAuth ||
		Object.values(input.listsTruncated ?? {}).some(Boolean) ||
		methodErrorEntries.length > 0 ||
		!hasInventory
	) {
		status = "degraded";
	} else {
		status = input.connectTimeMs > 5000 ? "degraded" : "healthy";
	}

	const authState =
		input.partialAuth || authGatedLists ? ("required" as const) : "none";
	const errorMessage =
		methodErrorSummary ?? (!hasInventory ? EMPTY_INVENTORY_MESSAGE : undefined);
	const errorClass =
		input.partialAuth || authGatedLists
			? ("auth" as ErrorClass)
			: methodErrorEntries.length > 0
				? ("protocol" as ErrorClass)
				: undefined;
	const logSuffix =
		input.partialAuth || authGatedLists
			? " (auth-gated lists)"
			: methodErrorEntries.length > 0
				? " (list method errors)"
				: !hasInventory
					? " (empty inventory)"
					: "";

	return {
		status,
		authState,
		errorMessage,
		errorClass,
		hasInventory,
		methodErrorCount: methodErrorEntries.length,
		authGatedLists,
		logSuffix,
	};
}

/**
 * Is this scan's inventory (tools/resources/prompts) authoritative?
 *
 * A credential-starved scan is NOT evidence of absence. When `initialize`
 * succeeds but `tools/list` 401s, the MCP client returns an EMPTY list rather
 * than an error — and the catalog sync treats an empty array as "the upstream
 * removed everything", soft-removing every tool row. The sync also defaults to
 * mode `"full"`, which rewrites a missing `inputSchema` to the empty schema.
 * Either way an auth-gated scan can silently erase good tool schemas for every
 * org consuming that (global) catalog app.
 *
 * So: only let a scan mutate inventory when it was actually authorized. Health
 * columns still record `requires_auth` — we just keep the last known-good
 * inventory instead of destroying it.
 */
export function isScanInventoryAuthoritative(
	status: string | undefined,
): boolean {
	return status !== "requires_auth";
}

/**
 * A successful connection does not make each MCP list complete. Failed,
 * auth-gated, bounded, or workflow-capped lists must retain their last-known
 * inventory; other complete lists from the same scan can still reconcile.
 */
export function isScanListAuthoritative(
	status: string | undefined,
	list: McpScanInventoryList,
	listsTruncated?: Partial<McpScanListTruncation>,
): boolean {
	return (
		isScanInventoryAuthoritative(status) && listsTruncated?.[list] !== true
	);
}
