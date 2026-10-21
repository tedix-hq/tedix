/**
 * Kernel — approved-write proposal planner (v1, "propose_tool_write").
 *
 * When the route planner decides `propose_tool_write`, this module plans the
 * one concrete provider write call that a human will approve before anything
 * executes: mutating or high-impact tools must produce approval cards before
 * execution. It catalogs direct providers with `tools/list`
 * and aggregate providers with Code Mode discovery, filters to write-capable
 * tools, and selects one tool before constructing arguments against its exact input
 * schema. The caller records an audited `tedi_approval_requests` row before
 * execution in `write-executor.ts`, either approved by policy or held for a human.
 *
 * Safety model:
 *  - discovery never executes a provider tool, and the model only ever sees
 *    write-capable tools: only a declared read-only tool is filtered out, and an
 *    undeclared tool is admitted (and therefore gated) rather than silently
 *    dropped — see {@link isWriteCapable};
 *  - there is no heuristic fallback pick: a mutating call is only ever
 *    selected by Jev and constructed by the validated generative pass, never by name matching;
 *  - the pick is re-validated against the same write list (an invented
 *    toolName fails), undeclared args are dropped, verified tenant defaults
 *    override model-supplied identifiers, every required param must be
 *    present, nested input constraints are validated, and the args are size-capped;
 *  - Fail-soft: every failure returns `null`, so the orchestrator keeps
 *    the recommendation-text behavior.
 *
 * Identity (docs/engineering/product/tedix-os.md): every MCP
 * request is org-scoped service-binding (`X-Service-Binding` + `X-Tedix-Org-Id`,
 * no tediId) and carries `X-Tedix-Kernel: true` — apps/mcp maps it to the
 * `kernel` audit actor (subjectUserId = initiating human) so proposal
 * catalog calls are attributable to the kernel, not generic service.
 *
 * The write layer owns its MCP transport and provider-resolution helpers.
 */

import {
	canonicalWriteToolName,
	CREATE_OUTPUT_TOOL,
	EXTERNAL_OFFICE_PROVIDER_RE,
	matchesCanonicalWriteTool,
	OUTPUT_EDIT_CAPABILITY_RE,
	preferredToolForCapability,
	renameThisConversationArgs,
} from "./write-tool-intent";
import {
	isWriteCapable,
	MAX_CATALOG_TOOLS,
	orderWriteToolCatalog,
	renderWriteToolCatalog,
	type McpTool,
	type ToolParamDefaults,
} from "./write-tool-policy";
import {
	editTargetKind,
	readEditTargetOutput,
	normalizeOsSheetCellAddress,
	type WriteWorkspaceContext,
} from "./write-edit-target";
import { planWriteCall, validateProposedCall } from "./write-call-plan";
import {
	outputDraftSaveTarget,
	renderOutputDraftSaveRequest,
	type OutputDraftSaveTarget,
} from "./output-draft-save-intent";
import type { LanguageModel } from "ai";
import { buildMcpHost } from "../../../lib/mcp-client";
import {
	FirstPartyMcpError,
	requestFirstPartyMcp,
} from "../../../lib/first-party-mcp";
import {
	kernelSpanContext,
	type KernelGatewayContext,
	type KernelExecutionAttempt,
} from "./gateway-attribution";
import { selectJevAction, type JevActionEnv } from "./jev-action-selection";
import type { KernelWriteRiskTier } from "@tedix/api-contract/utils/approval-policy";
import type { ApprovalEditableField } from "@tedix/api-contract/schemas/approval-edits";
import { deriveApprovalEditableFields } from "@tedix/api-contract/utils/approval-edits";
import { parseToolPolicyMetadata } from "@tedix/api-contract/schemas/tools";
import { CreateFactoryResultSchema } from "@tedix/api-contract/schemas/factories";
import type { DbClient } from "@tedix/db/client";
import { getAppBySlugForOrg } from "@tedix/db/queries/apps";
import {
	readOpenWorkRequests,
	renderOpenWorkRequests,
} from "./open-work-requests";
import { safeExceptionTopology } from "../../../lib/safe-log-metadata";
import { flatAbortSignal } from "./llm-guard";
import type { KernelRouteDecision } from "./route-schema";
import { cardVerdictSheetArgs } from "./output-create-intent";
import {
	codeModeExecutionParams,
	codeModeResultData,
	codeModeCanonicalDescribeParams,
	codeModeDiscoveryParams,
	codeModeDescribeParams,
	isCodeModeCatalog,
	type KernelWriteTransport,
	parseCodeModeCatalog,
	writeDiscoveryQuery,
} from "./write-codemode";
import { planDocumentCreate } from "./document-create-plan";

export interface WriteProposalEnv extends JevActionEnv {
	MCP_SERVICE?: {
		fetch: (input: string, init?: RequestInit) => Promise<Response>;
	};
	MCP_URL?: string;
	/** Accepted by apps/mcp as the internal service-binding principal. */
	PLATFORM_SERVICE_TOKEN?: string;
	/**
	 * Gate for org-scoped service-binding catalog calls. Default off.
	 */
	KERNEL_EXECUTE?: string;
}

/** Whether write-proposal planning is enabled. */
export function kernelWriteEnabled(env: WriteProposalEnv): boolean {
	return env.KERNEL_EXECUTE === "true";
}

/** The concrete, validated write call a human is asked to approve. */
export interface KernelWriteProposal {
	/** Resolved provider slug (e.g. "globex-tedix"), not the routed alias. */
	appSlug: string;
	toolName: string;
	args: Record<string, unknown>;
	/** Canonical title, only when the validated call edits the read output. */
	outputTitle?: string;
	/** One-sentence model rationale for the operator-facing card (untrusted). */
	reasoning: string | null;
	/**
	 * Coarse risk classification of the chosen tool — drives the write-tier
	 * auto-approve gate (`decideKernelWriteApproval`). A `high`-risk write is
	 * never policy-auto-approved; see {@link classifyWriteRisk}.
	 */
	riskTier: KernelWriteRiskTier;
	/** Raw MCP tool or an aggregate Code Mode callable. */
	transport?: KernelWriteTransport;
	/** Inputs the approver may change before approving, from the tool schema. */
	editableFields?: ApprovalEditableField[];
}

async function mcpCall(
	env: WriteProposalEnv,
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
			console.warn("[kernel.writeProposal] mcp call not ok", {
				method,
				host,
				status: error.status,
			});
		} else {
			console.warn("[kernel.writeProposal] mcp call error/parse", {
				method,
				failureKind:
					error.kind === "protocol" ? "protocol_error" : "unparseable",
			});
		}
		return null;
	}
}

/** Caps for operator-configured tool param defaults (defense in depth). */
const MAX_PARAM_DEFAULTS = 8;
const MAX_PARAM_DEFAULT_VALUE_LENGTH = 200;

function parseToolParamDefaults(metadata: unknown): ToolParamDefaults | null {
	if (!metadata || typeof metadata !== "object") return null;
	const mcpConfig = (metadata as { mcpConfig?: unknown }).mcpConfig;
	if (!mcpConfig || typeof mcpConfig !== "object") return null;
	const raw = (mcpConfig as { toolParamDefaults?: unknown }).toolParamDefaults;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const defaults: ToolParamDefaults = {};
	for (const [key, value] of Object.entries(raw)) {
		if (Object.keys(defaults).length >= MAX_PARAM_DEFAULTS) break;
		if (typeof value === "number" || typeof value === "boolean") {
			defaults[key] = value;
		} else if (
			typeof value === "string" &&
			value.length <= MAX_PARAM_DEFAULT_VALUE_LENGTH
		) {
			defaults[key] = value;
		}
	}
	return Object.keys(defaults).length > 0 ? defaults : null;
}

function effectiveToolParamDefaults(
	toolName: string,
	providerSlug: string,
	configured: ToolParamDefaults | null,
): ToolParamDefaults | null {
	if (
		toolName !== "tenant.install_tenant_mcp_app" &&
		toolName !== "tenant.install_tenant_mcp_apps"
	) {
		return configured;
	}
	const enforced = {
		targetAggregatorSlug: providerSlug,
		dryRun: false,
	};
	return configured ? { ...configured, ...enforced } : enforced;
}

/**
 * Isolate-local cache of write catalogs and exact tool schemas. Listing and
 * describing cost one MCP round trip each on every write turn although they
 * change only when an app or its tools change. Keyed by acting user, because
 * tool visibility can depend on their connections. Empty results are never
 * cached; the executor validates the arguments again before anything runs.
 */
const WRITE_CATALOG_CACHE_TTL_MS = 5 * 60_000;
const WRITE_CATALOG_CACHE_MAX_ENTRIES = 256;
const writeCatalogCache = new Map<
	string,
	{ expiresAt: number; tools: McpTool[] }
>();

async function cachedWriteCatalog(
	key: string,
	read: () => Promise<McpTool[]>,
): Promise<McpTool[]> {
	const now = Date.now();
	const hit = writeCatalogCache.get(key);
	if (hit && hit.expiresAt > now) return hit.tools;
	const tools = await read();
	if (tools.length > 0) {
		if (writeCatalogCache.size >= WRITE_CATALOG_CACHE_MAX_ENTRIES)
			writeCatalogCache.clear();
		writeCatalogCache.set(key, {
			expiresAt: now + WRITE_CATALOG_CACHE_TTL_MS,
			tools,
		});
	}
	return tools;
}

/** @internal Test seam: start every test with a cold catalog cache. */
export function clearWriteCatalogCacheForTests(): void {
	writeCatalogCache.clear();
}

/** Resolve the provider app (org `-tedix` variant preferred, bare fallback). */
async function resolveProviderApp(
	db: DbClient,
	appSlug: string,
	organizationId: string,
): Promise<{ slug: string; paramDefaults: ToolParamDefaults | null } | null> {
	const candidates = appSlug.endsWith("-tedix")
		? [appSlug, appSlug.replace(/-tedix$/, "")]
		: [`${appSlug}-tedix`, appSlug];
	for (const slug of candidates) {
		// Org-scoped: a write proposal must only resolve this org's provider app —
		// applying another tenant's tool-param defaults (workspace ids / creds) to a
		// write would be a cross-tenant breach (slugs are unique per-org, not global).
		const app = await getAppBySlugForOrg(db, slug, organizationId).catch(
			() => null,
		);
		if (app?.slug) {
			return {
				slug: app.slug,
				paramDefaults: parseToolParamDefaults(app.metadata),
			};
		}
	}
	return null;
}

const WRITE_GENERATION_TIMEOUT_MS = 120_000;
/** Leading catalog entries whose schemas are fetched during selection. */
const PREFETCH_DESCRIBE_COUNT = 3;

/** Write-planning boundaries stamped on the turn's stage timings. */
export type KernelWriteProposalStage =
	| "writeCatalogReady"
	| "writeToolSelected"
	| "writeSchemaReady"
	| "writeArgumentsReady";

/** Why a write proposal was declined (persisted on the run for diagnosis). */
export interface KernelWriteProposalDeclined {
	stage:
		| "disabled"
		| "missing_inputs"
		| "no_provider"
		| "no_write_tools"
		| "planner_declined"
		| "validation_failed"
		| "live_draft_save"
		| "error";
	detail?: string;
	draftSaveTarget?: OutputDraftSaveTarget;
}

/**
 * Produce an honest one-liner when a propose_tool_write route was internally
 * declined — the write moat held, nothing was created or sent, and the
 * operator deserves an accurate message instead of the planner's optimistic
 * "Confirm and I'll prepare it for approval" text.
 *
 * Each `stage` maps to a specific, actionable line. Pure and side-effect-free.
 */
export function renderWriteDeclined(
	declined: KernelWriteProposalDeclined,
	route: {
		toolIntent?: { appSlug?: string | null; capability?: string | null } | null;
	},
): string {
	const appSlug = route.toolIntent?.appSlug?.trim();
	const app = appSlug?.replaceAll("-", " ") || "that app";
	switch (declined.stage) {
		case "live_draft_save":
			return declined.draftSaveTarget
				? renderOutputDraftSaveRequest(declined.draftSaveTarget)
				: "Open the selected file and use Save version above the editor. Nothing was saved by this chat.";
		case "disabled":
		case "no_provider":
		case "no_write_tools":
			return `I can't update ${app} from this chat yet. Ask me to delegate this to a tedi with access.`;
		case "planner_declined":
			return `I couldn't prepare that change in ${app}; nothing was created or sent. Tell me what should be added or changed, and where.`;
		case "validation_failed":
		case "missing_inputs":
			return `I need a few more specifics to update ${app}; nothing was created or sent. Tell me which item to change and the values to use.`;
		default:
			// error or any unknown future stage — safe, non-promising generic
			return `I couldn't prepare that ${app} change — nothing was created or sent.`;
	}
}

/**
 * Plan the concrete write call for a `propose_tool_write` route. Returns the
 * validated proposal (not executed), or `null` at any fail-soft gate: flag
 * off, no model, no provider, no write-capable tools, no/invalid Jev selection or generated arguments.
 * Every null path reports why through `onDecline` so the turn can persist the
 * reason (run metadata `kernelWriteProposalDeclined`) — fail-soft must never
 * mean fail-silent.
 */
export async function planKernelWriteProposal(args: {
	db: DbClient;
	env: WriteProposalEnv;
	organizationId: string;
	/** Attribution from the owning Home turn, reused by paid Jev selection. */
	gatewayContext?: KernelGatewayContext;
	onExecutionAttempts?: (attempts: readonly KernelExecutionAttempt[]) => void;
	route: KernelRouteDecision;
	/** The initiating human (descopeUserId) — forwarded for connection scoping. */
	actingUserId?: string;
	/** The user's message — the source of the write's intent and arguments. */
	content?: string;
	/** Server-validated selection from the owning Home turn. */
	workspaceContext?: WriteWorkspaceContext;
	/** Kernel LLM. Required for writes — there is no heuristic fallback. */
	model?: LanguageModel | null;
	/** Decline reporter — receives the fail-soft reason for run metadata. */
	onDecline?: (declined: KernelWriteProposalDeclined) => void;
	/** Stage marks inside the write window (turn stage timings). */
	onStage?: (stage: KernelWriteProposalStage) => void;
	/** Flat bound (ms) for the write pass. Defaults to the generous production
	 * constant; tests inject a tiny value. */
	timeoutMs?: number;
}): Promise<KernelWriteProposal | null> {
	const {
		db,
		env,
		organizationId,
		route,
		actingUserId,
		content,
		model,
		timeoutMs = WRITE_GENERATION_TIMEOUT_MS,
	} = args;
	const decline = (declined: KernelWriteProposalDeclined): null => {
		args.onDecline?.(declined);
		return null;
	};
	if (route.routeKind !== "propose_tool_write") return null;
	const draftSaveTarget = content
		? outputDraftSaveTarget(content, args.workspaceContext)
		: null;
	if (draftSaveTarget)
		return decline({ stage: "live_draft_save", draftSaveTarget });
	if (!kernelWriteEnabled(env)) return decline({ stage: "disabled" });
	const appSlug = route.toolIntent?.appSlug?.trim();
	if (!appSlug || !model || !content?.trim()) {
		return decline({
			stage: "missing_inputs",
			detail: `appSlug=${Boolean(appSlug)} model=${Boolean(model)} content=${Boolean(content?.trim())}`,
		});
	}

	try {
		const provider = await resolveProviderApp(db, appSlug, organizationId);
		if (!provider) {
			console.warn("[kernel.writeProposal] no provider app", { appSlug });
			return decline({ stage: "no_provider", detail: appSlug });
		}
		const host = buildMcpHost(provider.slug, env.MCP_URL ?? "");
		const cacheKey = `${organizationId}|${host}|${actingUserId ?? ""}`;
		// The edit target is a D1 read independent of the MCP catalog calls.
		const editTargetPromise = readEditTargetOutput({
			db,
			organizationId,
			viewer: { userIds: actingUserId ? [actingUserId] : [] },
			workspaceContext: args.workspaceContext,
			texts: [content, route.rationale],
		}).catch(() => null);
		const capability = route.toolIntent?.capability ?? null;
		const canonical = canonicalWriteToolName(capability, content);
		// A known primitive needs no catalog search and no selection pass: one
		// Code Mode call resolves and describes it. A successful authorized call
		// proves this transport works; it need not wait for a separate tools/list.
		// Anything unexpected falls through to the full catalog path.
		const canonicalPromise = canonical
			? cachedWriteCatalog(`${cacheKey}|canonical|${canonical}`, async () =>
					parseCodeModeCatalog(
						await mcpCall(
							env,
							host,
							organizationId,
							"tools/call",
							codeModeCanonicalDescribeParams(canonical),
							actingUserId,
						),
					),
				).catch(() => [] as McpTool[])
			: null;
		// An explicit document create fixes the tool, title and destination; only
		// the body needs the model, and it does not read the schema. Draft it while
		// the describe call runs (up to ~10 s on a cold isolate). The draft is
		// still validated against the described schema before anything is proposed.
		const documentDraft =
			canonical === CREATE_OUTPUT_TOOL
				? planDocumentCreate({
						content,
						toolName: CREATE_OUTPUT_TOOL,
						workspaceId: args.workspaceContext?.workspaceId,
						model,
						abortSignal: flatAbortSignal(timeoutMs),
						span: kernelSpanContext({
							organizationId,
							source: "write_proposal",
						}),
					})
				: undefined;
		// Unused when the describe falls through to another tool.
		documentDraft?.catch(() => {});
		const canonicalTool =
			canonical && canonicalPromise
				? (await canonicalPromise).find(
						(tool) =>
							matchesCanonicalWriteTool(tool.name, canonical) &&
							Boolean(tool.inputSchema) &&
							isWriteCapable(tool),
					)
				: undefined;
		const listedTools = canonicalTool
			? []
			: await cachedWriteCatalog(
					`${cacheKey}|tools/list`,
					async () =>
						(
							(await mcpCall(
								env,
								host,
								organizationId,
								"tools/list",
								{},
								actingUserId,
							)) as { tools?: McpTool[] } | null
						)?.tools ?? [],
				);
		const transport: KernelWriteTransport =
			canonicalTool || isCodeModeCatalog(listedTools) ? "codemode" : "direct";
		let writes: McpTool[];
		let exactTool: McpTool | undefined;
		if (canonicalTool) {
			writes = [canonicalTool];
			exactTool = canonicalTool;
			args.onStage?.("writeCatalogReady");
			args.onStage?.("writeToolSelected");
		} else {
			// Editing a Tedix output ("append a paragraph to this document") often
			// routes with no capability, and the request's own words rank other
			// providers' patch tools first. Search for the output's edit tools.
			const editKind = editTargetKind(await editTargetPromise);
			const discoveryQuery =
				editKind && !EXTERNAL_OFFICE_PROVIDER_RE.test(content)
					? `os output ${editKind} edit`
					: writeDiscoveryQuery({ capability, content });
			const tools =
				transport === "codemode"
					? await cachedWriteCatalog(
							`${cacheKey}|search|${discoveryQuery}`,
							async () =>
								parseCodeModeCatalog(
									await mcpCall(
										env,
										host,
										organizationId,
										"tools/call",
										codeModeDiscoveryParams(discoveryQuery),
										actingUserId,
									),
								),
						)
					: listedTools;
			// The model sees only write-capable tools — read-only tools never enter
			// the write planner's catalog.
			writes = tools.filter(isWriteCapable);
			if (writes.length === 0) {
				console.warn("[kernel.writeProposal] no write-capable tools", {
					slug: provider.slug,
					toolCount: tools.length,
				});
				return decline({
					stage: "no_write_tools",
					detail: `${provider.slug} toolCount=${tools.length}`,
				});
			}
			args.onStage?.("writeCatalogReady");
			const preferred = preferredToolForCapability(writes, capability, content);
			const catalog = orderWriteToolCatalog(writes).slice(0, MAX_CATALOG_TOOLS);
			// The exact schema comes from a second Code Mode call after selection
			// (6–8 s cold). Describe the leading candidates while the selection
			// passes run; the pick is usually among them.
			const describes = new Map<string, Promise<McpTool[]>>();
			const describe = (name: string): Promise<McpTool[]> => {
				let pending = describes.get(name);
				if (!pending) {
					pending = cachedWriteCatalog(
						`${cacheKey}|describe|${name}`,
						async () =>
							parseCodeModeCatalog(
								await mcpCall(
									env,
									host,
									organizationId,
									"tools/call",
									codeModeDescribeParams(name),
									actingUserId,
								),
							),
					).catch(() => [] as McpTool[]);
					describes.set(name, pending);
				}
				return pending;
			};
			if (transport === "codemode" && !preferred) {
				for (const tool of catalog.slice(0, PREFETCH_DESCRIBE_COUNT))
					void describe(tool.name);
			}
			let selected: { toolName: string | null; reason: string } = preferred
				? { toolName: preferred.name, reason: "selected" }
				: await selectJevAction({
						db,
						env,
						context: { ...args.gatewayContext, organizationId },
						onExecutionAttempts: args.onExecutionAttempts,
						content,
						candidates: catalog.map((tool) => ({
							id: tool.name,
							description: renderWriteToolCatalog([tool]),
						})),
						timeoutMs,
					});
			// Jev is a fast path, not a gate: live it answered none, uncertain or
			// unavailable for "create one Work item in project X" with
			// create_work_items first in the catalog. Any abstention falls through to
			// the write planner over the same bounded catalog; it can still answer
			// NONE (including for several writes), and its pick is re-validated
			// against the exact schema and approved by a human.
			if (!selected.toolName && selected.reason !== "invalid_candidates") {
				const pick = await planWriteCall({
					workspaceContext: args.workspaceContext,
					conversationId: args.gatewayContext?.sessionKey,
					editTarget: await editTargetPromise,
					content,
					capability,
					tools: catalog,
					selectionOnly: true,
					model,
					paramDefaults: provider.paramDefaults,
					timeoutMs,
					span: kernelSpanContext({
						organizationId,
						source: "write_selection",
					}),
				});
				selected = catalog.some((tool) => tool.name === pick?.toolName)
					? { toolName: pick!.toolName, reason: "planner_selected" }
					: { toolName: null, reason: `${selected.reason}, planner=none` };
			}
			if (!selected.toolName) {
				// Jev declined, was uncertain, or was unavailable — previously the
				// only fully silent gate, which made live diagnosis tail-dependent.
				console.warn("[kernel.writeProposal] planner declined", {
					slug: provider.slug,
					writeToolCount: writes.length,
				});
				return decline({
					stage: "planner_declined",
					detail: `${provider.slug} actionSelection=${selected.reason} writeToolCount=${writes.length}`,
				});
			}
			args.onStage?.("writeToolSelected");
			const candidate = writes.find((tool) => tool.name === selected.toolName);
			if (!candidate)
				return decline({
					stage: "validation_failed",
					detail: "Selected tool is not in the write catalog",
				});
			exactTool =
				transport === "codemode"
					? (await describe(candidate.name)).find(
							(tool) => tool.name === candidate.name,
						)
					: candidate;
		}
		if (!exactTool?.inputSchema || !isWriteCapable(exactTool))
			return decline({
				stage: "validation_failed",
				detail: "Selected write schema is unavailable",
			});
		args.onStage?.("writeSchemaReady");
		const editTarget = await editTargetPromise;
		const paramDefaults = effectiveToolParamDefaults(
			exactTool.name,
			provider.slug,
			provider.paramDefaults,
		);
		// A tool that answers a Work request needs its requestId and version;
		// chat names the request by title, so hand the planner the open ones.
		const answersWorkRequest = Boolean(
			exactTool.inputSchema.properties?.requestId &&
			exactTool.inputSchema.properties?.expectedRequestVersion,
		);
		const openWorkRequests =
			answersWorkRequest && actingUserId
				? renderOpenWorkRequests(
						await readOpenWorkRequests(db, {
							organizationId,
							descopeUserId: actingUserId,
						}).catch(() => []),
					)
				: null;
		let argumentFailure = "Could not construct arguments for the selected tool";
		// A plain "rename this conversation to X" needs no model: the target is
		// the current conversation and the title is the request's own words.
		const renameArgs =
			canonical === "rename_conversation" &&
			exactTool.inputSchema.properties?.conversationId &&
			exactTool.inputSchema.properties?.title
				? renameThisConversationArgs(content, args.gatewayContext?.sessionKey)
				: null;
		// A card verdict names its row and columns exactly; compute them from
		// the sheet instead of asking a model for coordinates.
		const cardArgs =
			capability === "sheets.set_range" &&
			exactTool.inputSchema.properties?.startRow &&
			exactTool.inputSchema.properties?.cells
				? cardVerdictSheetArgs(editTarget, route.rationale)
				: null;
		const planned: {
			toolName: string;
			args: Record<string, unknown>;
			reasoning: string | null;
		} | null = renameArgs
			? {
					toolName: exactTool.name,
					args: renameArgs,
					reasoning: "Rename the current conversation as asked.",
				}
			: cardArgs
				? {
						toolName: exactTool.name,
						args: cardArgs,
						reasoning:
							"Record the verdict on the card the previous answer showed.",
					}
				: await planWriteCall({
						workspaceContext: args.workspaceContext,
						conversationId: args.gatewayContext?.sessionKey,
						editTarget,
						// An output edit names its part (a card's row, a block) in the
						// router's rationale when the request itself only says "it".
						editReference:
							editTarget &&
							capability &&
							OUTPUT_EDIT_CAPABILITY_RE.test(capability)
								? route.rationale
								: null,
						openWorkRequests,
						content: capability?.startsWith("factories.")
							? `${content}\n${route.rationale}`
							: content,
						capability: route.toolIntent?.capability ?? null,
						tools: [exactTool],
						model,
						paramDefaults,
						timeoutMs,
						span: kernelSpanContext({
							organizationId,
							source: "write_proposal",
						}),
						onFailure: (reason) => {
							argumentFailure = reason;
						},
						...(exactTool.name === CREATE_OUTPUT_TOOL ? { documentDraft } : {}),
					});
		if (!planned)
			return decline({
				stage: "planner_declined",
				detail: argumentFailure,
			});
		if (canonical === "projects.create_factory") planned.args.dryRun = false;
		if (capability === "factories.run") {
			const cycleKey = `manual-${crypto.randomUUID()}`;
			delete planned.args.runId;
			planned.args.idempotencyKey = cycleKey;
			planned.args.confirmDestructive = true;
			planned.args.reason =
				"Operator-requested manual factory run, executed only after approval.";
			planned.args.params = {
				...((planned.args.params as Record<string, unknown>) ?? {}),
				cycleKey,
			};
		}
		const validated = validateProposedCall(
			{
				...planned,
				args: normalizeOsSheetCellAddress(
					content,
					exactTool.name,
					planned.args,
				),
			},
			[exactTool],
			paramDefaults,
		);
		if (!validated) {
			console.warn("[kernel.writeProposal] pick failed validation", {
				slug: provider.slug,
				planned: planned.toolName,
			});
			return decline({
				stage: "validation_failed",
				detail: `${provider.slug} planned=${planned.toolName}`,
			});
		}
		args.onStage?.("writeArgumentsReady");
		if (canonical === "projects.create_factory") {
			const preview = await mcpCall(
				env,
				host,
				organizationId,
				"tools/call",
				transport === "codemode"
					? codeModeExecutionParams(validated.tool.name, {
							...validated.args,
							dryRun: true,
						})
					: {
							name: validated.tool.name,
							arguments: { ...validated.args, dryRun: true },
						},
				actingUserId,
			);
			if (!preview || (preview as { isError?: boolean }).isError)
				return decline({
					stage: "validation_failed",
					detail: "Factory dry run failed; no creation was proposed.",
				});
			const parsed = CreateFactoryResultSchema.pick({
				dryRun: true,
				ownerTediName: true,
				projectKey: true,
				cron: true,
				output: true,
				warnings: true,
			}).safeParse(
				codeModeResultData(preview as Parameters<typeof codeModeResultData>[0]),
			);
			if (!parsed.success || !parsed.data.dryRun)
				return decline({
					stage: "validation_failed",
					detail: "Factory dry run did not return a valid preview.",
				});
			const plan = parsed.data;
			planned.reasoning = [
				`Preview: owner ${plan.ownerTediName}; project ${plan.projectKey}; schedule ${plan.cron} UTC.`,
				plan.output
					? `Output: ${plan.output.title ?? plan.output.id} (${plan.output.kind}).`
					: "No document or sheet Output selected.",
				...plan.warnings.map((warning) => `Note: ${warning}`),
			].join("\n");
		}
		console.warn("[kernel.writeProposal] proposed", {
			slug: provider.slug,
			tool: validated.tool.name,
			argKeys: Object.keys(validated.args),
		});
		const target = editTarget
			? (JSON.parse(editTarget) as { outputId: string; title: string })
			: null;
		return {
			appSlug: provider.slug,
			toolName: validated.tool.name,
			args: validated.args,
			...(target?.outputId === validated.args.outputId &&
			typeof target?.title === "string"
				? { outputTitle: target.title }
				: {}),
			reasoning: planned.reasoning,
			riskTier: /^projects\.(?:create|pause|resume|archive)_factory$/.test(
				validated.tool.name,
			)
				? "high"
				: validated.riskTier,
			transport,
			editableFields: deriveApprovalEditableFields({
				inputSchema: validated.tool.inputSchema,
				declared: parseToolPolicyMetadata(validated.tool._meta)
					?.approvalEditableFields,
				// Tenant defaults and the inputs set above stay as proposed.
				pinned: [
					...Object.keys(paramDefaults ?? {}),
					...(canonical === "projects.create_factory" ? ["dryRun"] : []),
					...(capability === "factories.run"
						? ["idempotencyKey", "confirmDestructive", "reason", "runId"]
						: []),
				],
			}),
		};
	} catch (e) {
		console.warn("[kernel.writeProposal] threw", {
			exception: safeExceptionTopology(e),
		});
		// Call decline so turn-work.ts never falls back to the optimistic
		// "Confirm and I'll prepare it for approval" text when the planner threw
		// internally — the operator must see the honest "nothing was created" line.
		return decline({
			stage: "error",
			detail: "Write proposal planning failed",
		});
	}
}
