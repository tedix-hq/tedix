import { TEDI_DURABLE_CODE_GATEWAY_TIMEOUT_MS } from "@tedix/api-contract/schemas/tedi-durable-code";
/**
 * Code Mode for Tedix MCP
 *
 * Collapses all app tools into a single `code` tool using
 * @cloudflare/codemode ToolProvider namespaces.
 *
 * Namespaces are auto-derived from endpoint prefixes and can be
 * overridden per-app via mcpConfig.codeModeNamespaces in D1.
 * Works for any MCP app on the platform — fully config-driven.
 *
 * MAP — banners mark PROVIDER BUILDERS (from ~1449), TOOL-NOT-FOUND
 * SUGGESTIONS, PROVIDER RESOLUTION and REGISTRATION. Everything above the
 * first banner is descriptor/schema plumbing and is not yet sectioned.
 *
 * @see docs/mcp/codemode.md
 * @module @tedix/mcp/mcp/codemode
 */

import {
	DynamicWorkerExecutor,
	type JsonSchemaToolDescriptors,
	type ResolvedProvider,
	resolveProvider,
	sanitizeToolName,
	type ToolProvider,
} from "@cloudflare/codemode";
import { tracing } from "cloudflare:workers";
import { codeModeSecurityMeta } from "./codemode-security";
import { autoFixSpec, isNonEmptySpec, validateSpec } from "@json-render/core";
import type {
	ServerContext as McpCtx,
	McpServer,
} from "@modelcontextprotocol/server";
import {
	buildCodeModeExecutionReceipt,
	buildCompletionEvidence,
	type CompletionEvidence,
	withCompletionEvidence,
} from "@tedix/api-contract/schemas/execution-evidence";
import {
	buildMcpCodeModeAnalyticsDataPoint,
	type McpCodeModeAnalyticsDataPointEvent,
} from "@tedix/api-contract/schemas/mcp-analytics";
import {
	LAYOUT_CATALOG_ACTIONS,
	LAYOUT_CATALOG_COMPONENTS,
	LAYOUT_CATALOG_JSON_SCHEMA,
	LAYOUT_CATALOG_PROMPT,
} from "@tedix/api-contract/generated/layout-catalog-prompt";
import {
	parseAdapterScope,
	resolveToolAnnotations,
	type ResultStrategy,
	type ToolJsonSchema,
} from "@tedix/api-contract/schemas/tools";
import {
	CODE_MODE_TOOL_ANNOTATIONS,
	isCodeModeAvailable,
} from "@tedix/mcp-shared/codemode";
import { resolveMcpToolNamespace } from "@tedix/mcp-shared/auth/tool-scopes";
import {
	buildCompactTypes,
	type NamespaceGroup,
} from "@tedix/mcp-shared/compact-types";
import {
	buildPaymentRequiredResult,
	getPaymentRequiredMeta,
	type TedixPaymentRequiredMeta,
	X402_PAYMENT_META_KEY,
	X402_PAYMENT_RESPONSE_META_KEY,
} from "@tedix/mcp-shared/payment";
import {
	NAMESPACE_PEER_ALIASES,
	namespaceGovernanceFor,
} from "@tedix/mcp-shared/namespace-governance";
import {
	structuredResultIdentity,
	structuredUiResultProjection,
} from "@tedix/mcp-shared/result-identity";
import {
	type CodeModeTruncationOptions,
	boundCodeModeLogs,
	shapeBoundedCodeModeResult,
} from "@tedix/tedi-codemode-core/bounded-result";
import { unwrapCallToolResult } from "@tedix/mcp-shared/tool-result";
import {
	READ_COLLECTION_META_KEY,
	READ_COLLECTIONS_META_KEY,
	READ_OBSERVATION_META_KEY,
	READ_OBSERVATIONS_META_KEY,
	parseConnectedCollectionRead,
	parseDocsFileObservationReceipt,
	type OwnedConnectedCollectionRead,
	type OwnedReadObservation,
} from "@tedix/mcp-shared/read-observation-receipt";
import {
	buildIdenticalCallKey,
	IdenticalFailureBudget,
} from "@tedix/tedi-codemode-core/failure-budget";
import { withModelAuthoredCodeIsolation } from "@tedix/tedi-codemode-core/model-authored-code-loader";
import { runStatelessCodeMode } from "@tedix/tedi-codemode-core/run-stateless-code";
import * as z from "zod";
import { configuredAggregateNamespaces } from "./aggregate-namespaces";
import {
	assertCodeModeInnerToolAuthorized,
	CodeModeAuthorizationError,
	evaluateMcpToolScopeAuthorization,
} from "./codemode-auth";
import {
	callToolResultText,
	enforceExpectedAnnotations,
	requireDestructiveToolApproval,
	stripDestructiveApprovalArgs,
	withDestructiveApprovalSchema,
} from "./governance";
import {
	attachPaymentResponseMeta,
	checkToolPayment,
	getToolPaymentPolicy,
	settleToolPayment,
} from "./payments";
import type { AppTool, ServerContext } from "./server-context";
import { resolveToolRequestMeta } from "./tool-registration";
import { executeTool } from "./tool-execution";
import {
	enforceToolRiskRateLimit,
	toolRiskAuditMetadata,
} from "./tool-risk-policy";
import {
	buildCallerAuditMetadata,
	emitMcpAuditEvent,
	getJsonSize,
	type McpEvent,
	trackMcpEvent,
	truncateErrorMessage,
} from "./utils/analytics";
import {
	getToolLayoutSpec,
	resolveToolWidgetRoute,
} from "./utils/render-widget";
import { jsonSchemaToInputSchema } from "./utils/schema";
import { isWidgetAppSlug, resolveWidgetAppSlug } from "./utils/widget-app";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import {
	rerankDiscoveryShortlist,
	type DiscoveryRanker,
} from "./jev-discovery-ranking";

// Re-export so handler.ts can import isCodeModeAvailable from this module
export { isCodeModeAvailable };

const CODEMODE_NAMESPACE = "codemode";
const CODEMODE_TOOL_COUNT = 1;
const UI_NAMESPACE = "ui";
const UI_TOOL_COUNT = 5;
const GENERATED_MCP_APP_HTML_CHAR_CAP = 4_000;
const DEFAULT_DISCOVERY_LIMIT = 25;
const MAX_DISCOVERY_LIMIT = 100;
// Schema-bearing pages carry a full input JSON Schema per row, so a naive
// includeParameters search at the normal default limit is the single largest
// discovery payload (measured ~62k est. tokens over a 223-tool namespace).

// When the caller opts into schemas but does not name a limit, default small;
// an explicit limit is always honored up to MAX_DISCOVERY_LIMIT.
const SCHEMA_DISCOVERY_DEFAULT_LIMIT = 5;
// Search rows are for ranking and callable selection; the full description
// (plus exact schemas) is one discover.describe(callable) away. Budget chosen
// so a default page of rows stays well under client-side result truncation.
const DISCOVERY_DESCRIPTION_BUDGET = 280;

/** Hard budget for the code tool description to prevent unbounded prompt growth */
const MAX_CODEMODE_DESCRIPTION_CHARS = 32_000;
const MAX_INLINE_COMPACT_TYPE_TOOLS = 300;

/**
 * Bound the model-facing `code` result without silent type degradation. An
 * oversized structured result becomes a `__tedix_truncated` envelope (see
 * `@tedix/tedi-codemode-core/bounded-result`) instead of a bare clipped JSON
 * string that downstream parsers mistake for an empty/real string. Within
 * budget the value passes through byte-identical. Exported for tests.
 */
export function shapeCodeModeResultForModel(
	result: unknown,
	options?: CodeModeTruncationOptions,
): unknown {
	return shapeBoundedCodeModeResult(serializeCodeModeResult(result), options);
}

function isSideEffectfulTool(
	annotations: CatalogToolAnnotations | null,
): boolean {
	return annotations?.readOnlyHint !== true;
}

function runSerializedSideEffect<T>(
	executionRefs: CodeModeExecutionRefs,
	fn: () => Promise<T>,
): Promise<T> {
	const run = executionRefs.sideEffectQueue.catch(() => undefined).then(fn);
	executionRefs.sideEffectQueue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

function serializeCodeModeResult(result: unknown): unknown {
	if (!isCatalogDiscoveryResult(result)) return result;
	// Model-facing single shape: `results` + `meta` only. The sandbox value
	// additionally carries the per-namespace convenience map
	// (`r.namespaces.firecrawl_tedix.firecrawl_scrape`) — useful for code, but
	// on the wire it would serialize every tool 2-3x. Sandbox compatibility is
	// untouched; only what the model re-reads every turn is deduped.
	return {
		results: result.results,
		meta: result.meta,
	};
}

function isCatalogDiscoveryResult(
	result: unknown,
): result is CatalogDiscoveryResult {
	if (!isRecord(result) || Array.isArray(result)) return false;
	return (
		Array.isArray(result.results) &&
		isRecord(result.namespaces) &&
		isRecord(result.meta)
	);
}

function stripUpstreamCodeFailurePrefix(error: string): string {
	return error.startsWith("Code execution failed: ")
		? error.slice("Code execution failed: ".length)
		: error;
}

const FLOW_NAMESPACE = "flow";
const FLOW_TOOL_COUNT = 5;

/**
 * One vocabulary for the skill-workflow lifecycle across canonical providers
 * and tedi-owned execution namespaces. Discovery collapses the equivalent tedi
 * mirrors onto these callables; flow.* uses the same registry to delegate.
 */
const SKILL_WORKFLOW_SURFACES = {
	run: {
		canonicalCallable: "flow.run",
		tediTool: "run_skill_workflow",
	},
	status: {
		canonicalCallable: "skills.run_workflow_status",
		tediTool: "get_skill_workflow_status",
	},
	inspect: {
		canonicalCallable: "skills.inspect_skill_workflow_run",
		tediTool: "inspect_skill_workflow_run",
	},
	history: {
		canonicalCallable: "skills.run_workflow_history",
		tediTool: "list_skill_workflow_history",
	},
} as const;

type SkillWorkflowSurface =
	(typeof SKILL_WORKFLOW_SURFACES)[keyof typeof SKILL_WORKFLOW_SURFACES];

const SKILL_WORKFLOW_SURFACE_BY_TEDI_TOOL = new Map<
	string,
	SkillWorkflowSurface
>(
	Object.values(SKILL_WORKFLOW_SURFACES).map((surface) => [
		surface.tediTool,
		surface,
	]),
);

const FLOW_PROVIDER_TYPES = [
	"declare namespace flow {",
	'  type WorkspaceContextRef = { kind: "file" | "resource" | "output" | "link" | "structured"; uri: string; revision?: string; label?: string };',
	"  /** Run a multi-step job OFF your context window: records `source` as an EPHEMERAL draft skill workflow (never scheduled, auto-archives unused) and starts it in one call. `source` is a Cloudflare Workflow module: export default { async run(event, step, env) { ... } } using step.do/sleep and env.MCP.<namespace>.<tool>(args) for every capability DECLARED in `capabilities.mcp`. The workflow runs durably server-side; only its RETURN VALUE ever reaches your context, so return counts/ids/verdicts and put bulk output in an artifact. Returns { skillId, runId } — poll flow.status later (the run outlives this execution; do NOT busy-wait here). */",
	"  function run(input: { source?: string; skillId?: string; name?: string; description?: string; skillDoc?: string; capabilities?: { mcp?: Record<string, string[]>; network?: boolean; reason?: { maxCalls?: number } }; params?: Record<string, unknown>; workspaceContext?: WorkspaceContextRef[]; workItemId?: string; tediSlug?: string; reason?: string }): Promise<{ skillId: string; runId: string; status: string; tediSlug: string; workItemId: string | null; workspaceContext: WorkspaceContextRef[] }>;",
	"  /** Compact lifecycle poll for a flow run: { status, output, error, durationMs }. Terminal statuses: completed | failed | canceled. */",
	"  function status(input: { runId: string; tediSlug?: string }): Promise<{ status: string | null; output: unknown; error: unknown; durationMs: number | null }>;",
	"  /** Full evidence view (steps, tool-call receipts, artifacts, warnings) — reach for it when a run FAILED, not per poll. */",
	"  function inspect(input: { runId: string; tediSlug?: string }): Promise<unknown>;",
	"  /** Recent flow-authored workflow runs for the selected tedi. Persistent and scheduled skill runs stay on the skill-workflow history surface. */",
	"  function list(input?: { limit?: number; tediSlug?: string }): Promise<unknown>;",
	"  /** List the exact env.MCP.tedi methods reachable by a workflow on this gateway. Call this before authoring a manifest instead of guessing from the broader Code Mode catalog. */",
	"  function tools(input?: { tediSlug?: string }): Promise<{ tediSlug: string; namespace: string; methods: string[]; manifest: { mcp: { tedi: string[] } } }>;",
	"}",
].join("\n");

/**
 * Built-in `flow.*` provider — one-call ephemeral workflows for GATEWAY
 * agents.
 *
 * The tedix CLI ships `tedix flow run`; gateway-native Code Mode callers
 * (ChatGPT, Claude over MCP, tedis) previously only had a preamble recipe
 * telling them to hand-compose `skills.record_skills` +
 * `<tedi>.run_skill_workflow`. This provider is that composition as a
 * first-class tool — deliberately THIN: it calls the already-mounted inner
 * tool closures, so authorization, tool-call receipts, completionEvidence,
 * and the identical-failure budget are exactly what direct calls get. No
 * second dispatch path, no new capability model.
 *
 * `flow.run` never waits for the run: workflows exist to outlive the calling
 * execution, and a busy-wait here would burn the outer request's budget on
 * exactly the polling the pattern exists to avoid.
 */
export function buildFlowProvider(
	namespaceGroups: Map<string, NamespaceGroup>,
	assertAuthorized: (namespace: string, tool: string) => void = () => {},
): ToolProvider {
	const call = async (
		ns: string,
		tool: string,
		args: Record<string, unknown>,
	): Promise<unknown> => {
		const fn = namespaceGroups.get(ns)?.fns[tool];
		if (!fn) {
			throw new Error(
				`flow.* needs ${ns}.${tool}, which is not mounted on this gateway — run flow tools on an aggregate surface that includes the skills and tedi namespaces (e.g. the org's *-unified app)`,
			);
		}
		const result = await fn(args);
		// oRPC contract errors cross Code Mode as RESULT VALUES, not throws.
		// Surface them as throws here so a failed record cannot be mistaken for
		// a recorded skill.
		if (isRecord(result)) {
			const code = typeof result.code === "string" ? result.code : undefined;
			const status =
				typeof result.status === "number" ? result.status : undefined;
			if (
				(result.ok === false && typeof result.error === "string") ||
				(code !== undefined &&
					(result.defined === true || (status !== undefined && status >= 400)))
			) {
				throw new Error(
					`${ns}.${tool} failed: ${String(result.error ?? result.message ?? code)}`,
				);
			}
		}
		return result;
	};

	const resolveTediNamespace = (
		input: Record<string, unknown>,
		tool: string,
	): string => {
		const explicit =
			typeof input.tediSlug === "string" ? input.tediSlug.trim() : "";
		if (explicit) {
			if (!/^[a-z0-9_-]{1,64}$/i.test(explicit)) {
				throw new Error(`flow: invalid tediSlug ${JSON.stringify(explicit)}`);
			}
			const namespace = sanitizeToolName(explicit);
			if (!namespaceGroups.get(namespace)?.fns[tool])
				throw new Error(
					`flow: ${namespace}.${tool} is not mounted on this gateway`,
				);
			return namespace;
		}
		if (namespaceGroups.get("cto")?.fns[tool]) return "cto";
		const candidates = [...namespaceGroups.entries()]
			.filter(([, group]) => typeof group.fns[tool] === "function")
			.map(([namespace]) => namespace);
		if (candidates.length === 1) return candidates[0]!;
		if (candidates.length === 0) {
			throw new Error(
				`flow.* needs a tedi namespace with ${tool}, but none is mounted on this gateway`,
			);
		}
		throw new Error(
			`flow.* found multiple tedi namespaces with ${tool} (${candidates.join(", ")}); pass tediSlug explicitly`,
		);
	};

	const workspaceContextFrom = (value: unknown) => {
		if (value === undefined) return [];
		if (!Array.isArray(value) || value.length > 32) {
			throw new Error(
				"flow.run workspaceContext must be an array of at most 32 references",
			);
		}
		return value.map((raw, index) => {
			const ref = recordFrom(raw);
			const kind = ref?.kind;
			const uri = typeof ref?.uri === "string" ? ref.uri.trim() : "";
			if (
				!ref ||
				!(
					["file", "resource", "output", "link", "structured"] as unknown[]
				).includes(kind) ||
				!uri ||
				uri.length > 2_000
			) {
				throw new Error(`flow.run workspaceContext[${index}] is invalid`);
			}
			return {
				kind,
				uri,
				...(typeof ref.revision === "string" && ref.revision.trim()
					? { revision: ref.revision.trim().slice(0, 300) }
					: {}),
				...(typeof ref.label === "string" && ref.label.trim()
					? { label: ref.label.trim().slice(0, 200) }
					: {}),
			};
		});
	};

	return {
		name: FLOW_NAMESPACE,
		tools: {
			tools: {
				description:
					"List the exact env.MCP.tedi methods reachable by a flow on this gateway. Use this before writing capabilities.mcp.tedi; the broader Code Mode catalog may contain tools that the workflow bridge does not project.",
				execute: async (rawInput: unknown) => {
					const input = recordFrom(rawInput) ?? {};
					const tediNs = resolveTediNamespace(
						input,
						SKILL_WORKFLOW_SURFACES.run.tediTool,
					);
					const methods = Object.keys(
						namespaceGroups.get(tediNs)?.fns ?? {},
					).sort();
					return {
						tediSlug: tediNs,
						namespace: "tedi",
						methods,
						manifest: { mcp: { tedi: methods } },
					};
				},
			},
			run: {
				description:
					"Record an ephemeral draft skill workflow from source and start it in ONE call — or rerun an existing one by passing skillId instead of source. The steps run in a durable Cloudflare Workflow off your context; only the bounded return value comes back. Returns { skillId, runId } immediately — poll flow.status later instead of waiting.",
				execute: async (rawInput: unknown) => {
					const input = recordFrom(rawInput) ?? {};
					const workspaceContext = workspaceContextFrom(input.workspaceContext);
					const source = typeof input.source === "string" ? input.source : "";
					const existingSkillId =
						typeof input.skillId === "string" && input.skillId.trim()
							? input.skillId.trim()
							: null;
					if (!existingSkillId && !source.trim()) {
						throw new Error(
							"flow.run requires `source` (a workflow module string — export default { async run(event, step, env) { ... } }) or `skillId` to rerun an existing workflow",
						);
					}
					const name =
						typeof input.name === "string" && input.name.trim()
							? input.name.trim().slice(0, 80)
							: "flow-ephemeral";
					const description =
						typeof input.description === "string" && input.description.trim()
							? input.description.trim()
							: "Ephemeral workflow authored via flow.run.";
					// The capability manifest rides SKILL.md frontmatter. JSON is
					// valid YAML, so the declared object embeds verbatim — the
					// platform validator stays the single authority on its shape.
					const capabilities = recordFrom(input.capabilities) ?? {};
					const suppliedSkillDoc =
						typeof input.skillDoc === "string" && input.skillDoc.trim()
							? input.skillDoc
							: null;
					const content =
						suppliedSkillDoc ??
						[
							"---",
							`name: ${name}`,
							`description: ${description}`,
							`capabilities: ${JSON.stringify(capabilities)}`,
							"---",
							"",
							`# ${name}`,
							"",
							description,
							"",
							"Ephemeral flow.run workflow: executes explicitly, never fires on",
							"a schedule, auto-archives after 14 days unused.",
							"",
						].join("\n");
					const tediNs = resolveTediNamespace(
						input,
						SKILL_WORKFLOW_SURFACES.run.tediTool,
					);
					if (input.params !== undefined && !isRecord(input.params))
						throw new Error("flow.run params must be an object");
					const params = recordFrom(input.params) ?? {};
					if ("__tedixWorkspaceContext" in params) {
						throw new Error(
							"flow.run params.__tedixWorkspaceContext is reserved",
						);
					}
					const pinnedParams =
						workspaceContext.length > 0
							? { ...params, __tedixWorkspaceContext: workspaceContext }
							: params;
					if (
						!existingSkillId &&
						!namespaceGroups.get("skills")?.fns.record_skills
					)
						throw new Error(
							"flow.run requires skills.record_skills on this gateway before a draft can be recorded",
						);
					assertAuthorized(tediNs, SKILL_WORKFLOW_SURFACES.run.tediTool);
					if (!existingSkillId) assertAuthorized("skills", "record_skills");
					const runnerSchema =
						namespaceGroups.get(tediNs)?.schemas[
							SKILL_WORKFLOW_SURFACES.run.tediTool
						]?.inputSchema;
					if (runnerSchema) {
						const checked = await jsonSchemaToInputSchema(
							runnerSchema as ToolJsonSchema,
							{ toolId: `${tediNs}.run_skill_workflow`, lenient: false },
						)["~standard"].validate({
							skillId:
								existingSkillId ?? "00000000-0000-4000-8000-000000000001",
							...(input.workItemId !== undefined
								? { workItemId: input.workItemId }
								: {}),
							params: pinnedParams,
							confirmDestructive: true,
							reason:
								typeof input.reason === "string" && input.reason.trim()
									? input.reason.trim()
									: `flow.run: ephemeral workflow "${name}"`,
						});
						if (checked.issues)
							throw new Error(
								`flow.run runner arguments invalid: ${checked.issues.map((issue) => issue.message).join("; ")}`,
							);
					}
					let skillId = existingSkillId ?? undefined;
					if (!skillId) {
						let recorded: unknown;
						try {
							recorded = await call("skills", "record_skills", {
								title: name,
								description,
								content,
								files: { "scripts/workflow.ts": source },
								// The adoption cohort — same tag the CLI stamps, so gateway
								// and CLI usage are one queryable population.
								tags: ["flow-ephemeral"],
								lifecycleState: "draft",
								validate: "error",
							});
						} catch (error) {
							// The library's near-duplicate gate is the wrong shape for
							// ephemeral RERUNS (a retry is a near-dupe of itself by
							// definition), but silently mutating the 90%-similar skill it
							// names would be worse — that could be a real library asset.
							// Turn the refusal into the actionable rerun path instead.
							const message =
								error instanceof Error ? error.message : String(error);
							const suggested = message.match(
								/improve_skills\(\{ id: "([0-9a-f-]{36})"/,
							)?.[1];
							if (suggested) {
								throw new Error(
									`flow.run: an equivalent skill already exists (${suggested}). Rerun it as-is with flow.run({ skillId: "${suggested}", params }), or change the workflow body if this is genuinely new. Original: ${message}`,
								);
							}
							throw error;
						}
						// Handlers nest the created row (live shape: { entry: {...} });
						// tolerate top-level and the sibling wrappers too.
						const recordedRow = recordFrom(recorded) ?? {};
						const nested =
							recordFrom(recordedRow.entry) ??
							recordFrom(recordedRow.skill) ??
							recordFrom(recordedRow.data) ??
							recordedRow;
						const foundId = nested.id ?? nested.skillId ?? recordedRow.id;
						if (typeof foundId !== "string" || !foundId) {
							throw new Error(
								"flow.run: draft was recorded without an id — inspect skills.record_skills output directly",
							);
						}
						skillId = foundId;
					}

					const started = await call(
						tediNs,
						SKILL_WORKFLOW_SURFACES.run.tediTool,
						{
							skillId,
							...(typeof input.workItemId === "string" && input.workItemId
								? { workItemId: input.workItemId }
								: {}),
							...(Object.keys(pinnedParams).length > 0
								? { params: pinnedParams }
								: {}),
							// Destructive-governed: stateless callers authorize explicitly.
							confirmDestructive: true,
							reason:
								typeof input.reason === "string" && input.reason.trim()
									? input.reason.trim()
									: `flow.run: ephemeral workflow "${name}"`,
						},
					);
					const runId = isRecord(started)
						? ((started.runId ?? started.id) as string | undefined)
						: undefined;
					if (!runId) {
						throw new Error(
							`flow.run: workflow did not return a runId (skillId ${skillId})`,
						);
					}
					return {
						skillId,
						runId,
						status: "queued",
						tediSlug: tediNs,
						workItemId:
							typeof input.workItemId === "string" ? input.workItemId : null,
						workspaceContext,
					};
				},
			},
			status: {
				description:
					"Compact lifecycle poll for a flow run: { status, output, error, durationMs }. Terminal: completed | failed | canceled.",
				execute: async (rawInput: unknown) => {
					const input = recordFrom(rawInput) ?? {};
					const runId = typeof input.runId === "string" ? input.runId : "";
					if (!runId) throw new Error("flow.status requires `runId`");
					const tediNs = resolveTediNamespace(
						input,
						SKILL_WORKFLOW_SURFACES.status.tediTool,
					);
					const row = recordFrom(
						await call(tediNs, SKILL_WORKFLOW_SURFACES.status.tediTool, {
							runId,
						}),
					);
					// Same bounded projection the CLI uses: the run's own `result`
					// field must never eat the envelope, and a poll must stay small
					// by construction.
					return {
						status:
							typeof row?.status === "string"
								? row.status
								: typeof row?.state === "string"
									? row.state
									: null,
						output: row ? (row.result ?? row.output ?? null) : null,
						error: row ? (row.error ?? null) : null,
						durationMs:
							typeof row?.durationMs === "number"
								? row.durationMs
								: typeof row?.elapsedMs === "number"
									? row.elapsedMs
									: null,
					};
				},
			},
			inspect: {
				description:
					"Full evidence view of a flow run (steps, receipts, artifacts, warnings). Use on FAILURE, not per poll — it is deliberately heavy.",
				execute: async (rawInput: unknown) => {
					const input = recordFrom(rawInput) ?? {};
					const runId = typeof input.runId === "string" ? input.runId : "";
					if (!runId) throw new Error("flow.inspect requires `runId`");
					const tediNs = resolveTediNamespace(
						input,
						SKILL_WORKFLOW_SURFACES.inspect.tediTool,
					);
					return call(tediNs, SKILL_WORKFLOW_SURFACES.inspect.tediTool, {
						runId,
					});
				},
			},
			list: {
				description:
					"Recent flow-authored workflow runs for the selected tedi. Persistent and scheduled skill runs are intentionally excluded.",
				execute: async (rawInput: unknown) => {
					const input = recordFrom(rawInput) ?? {};
					const tediNs = resolveTediNamespace(
						input,
						SKILL_WORKFLOW_SURFACES.history.tediTool,
					);
					const limit =
						typeof input.limit === "number" && input.limit > 0
							? Math.min(Math.floor(input.limit), 100)
							: 15;
					return call(tediNs, SKILL_WORKFLOW_SURFACES.history.tediTool, {
						limit,
						skillTag: "flow-ephemeral",
					});
				},
			},
		},
		types: FLOW_PROVIDER_TYPES,
	};
}

const UI_PROVIDER_TYPES = [
	"declare namespace ui {",
	"  /** Inspect the model-facing json-render catalog before authoring a custom layoutSpec. Returns component/action names, schema, and compact generation rules. */",
	"  function get_catalog(input?: { components?: string[] }): Promise<{ components: string[]; componentDefinitions: string[]; actions: string[]; schema: Record<string, unknown>; rules: string[] }>;",
	"  /** Create an inline MCP UI/json-render view from data already fetched in this Code Mode run. For a genuinely generated interface, inspect ui.get_catalog(), author layoutSpec, validate it, then return create_view directly. Omit layoutSpec only when an inferred native comparison, chart, dashboard, ranking, timeline, stats, table, or summary is sufficient. */",
	'  function create_view(input: { title?: string; appSlug?: string; appName?: string; appId?: string; logoUrl?: string; layoutId?: string; layoutSpec?: Record<string, unknown>; data: Record<string, unknown> | Array<Record<string, unknown>>; summary?: string; visualKind?: "auto" | "table" | "summary" | "comparison" | "timeline" | "stats" | "details" | "chart" | "timeSeries" | "categoricalCounts" | "rankedMetrics" }): Promise<Record<string, unknown>>;',
	"  /** Create a transient free-form HTML/CSS MCP App when the catalog cannot express the requested visual. The document is rendered in a nested sandbox with scripts, forms, navigation, popups, downloads, and network access disabled. Use the host semantic CSS variables --background, --foreground, --surface, --surface-secondary, --surface-tertiary, --card, --card-foreground, --muted, --muted-foreground, --accent, --accent-foreground, and --border so it follows light/dark theme changes. Keep a meaningful summary/data fallback and return this object directly. */",
	"  function create_mcp_app(input: { title: string; html: string; summary: string; data?: Record<string, unknown>; appSlug?: string; appName?: string; appId?: string; logoUrl?: string }): Promise<Record<string, unknown>>;",
	"  /** Create a compact visual health sweep after probing multiple MCP app/provider tools. Use this instead of returning raw probe JSON when the user asks whether several tools or namespaces work. */",
	'  function create_health_sweep(input: { title?: string; appSlug?: string; appName?: string; checks: Array<{ namespace?: string; provider?: string; tool?: string; label?: string; status: "ok" | "warning" | "error" | "blocked" | "missing" | "unknown" | string; summary?: string; error?: string; latencyMs?: number }>; summary?: string }): Promise<Record<string, unknown>>;',
	"  /** Validate and auto-fix a json-render layoutSpec before returning it from ui.create_view. */",
	"  function validate_layout(input: { layoutSpec: Record<string, unknown> }): Promise<{ valid: boolean; issues: string[]; layoutSpec?: Record<string, unknown> }>;",
	"}",
].join("\n");

const UI_CATALOG_TOOLS = {
	get_catalog: {
		name: "Inspect UI Catalog",
		description:
			"Return the current json-render component catalog, action allowlist, validation schema, and compact generation rules. Call this before authoring a custom layoutSpec instead of guessing component names.",
		parameters: {
			type: "object",
			properties: {
				components: {
					type: "array",
					items: { type: "string" },
					maxItems: 12,
					description:
						"Optional component names whose exact props/events/slots definitions should be returned. Defaults to the primary data-visualization components.",
				},
			},
		},
	},
	create_view: {
		name: "Create Visual View",
		description:
			"Create an inline MCP UI/json-render view from data already fetched in Code Mode. Use data: { items: [{ ... }] } for reliable inferred record tables, or pass a bare record array. Scalar-only objects intentionally render as stats or a summary. Use this when a visual table, chart, comparison, carousel, summary, or dashboard is clearer than plain text. Return the object from code so Tedix OS can render it.",
		parameters: {
			type: "object",
			properties: {
				title: { type: "string" },
				appSlug: {
					type: "string",
					description:
						"App slug used for theming and resource URI, for example nosana or tedix-unified.",
				},
				appName: { type: "string" },
				appId: { type: "string" },
				logoUrl: { type: "string" },
				layoutId: {
					type: "string",
					description:
						"Optional stable single-segment route id after /r/. Defaults from title.",
				},
				layoutSpec: {
					type: "object",
					description:
						"Optional json-render layout spec with root and elements. Omit for Tedix to infer a native table or summary layout from data.",
				},
				data: {
					anyOf: [
						{ type: "object" },
						{
							type: "array",
							items: { type: "object" },
						},
					],
					description:
						"Structured data consumed by layoutSpec via json-render state bindings. For inferred tables prefer { items: [{ ...record fields... }] }. Bare record arrays are accepted and normalized to { rows: [...] }. Scalar-only objects infer stats or a summary instead of a table.",
					examples: [
						{ items: [{ name: "Alpha", value: 42 }] },
						[{ name: "Alpha", value: 42 }],
					],
				},
				summary: { type: "string" },
				visualKind: {
					type: "string",
					enum: [
						"auto",
						"table",
						"summary",
						"comparison",
						"timeline",
						"stats",
						"details",
						"chart",
						"timeSeries",
						"categoricalCounts",
						"rankedMetrics",
					],
					description:
						"Optional layout hint. Defaults to auto: comparison, chart, timeline, stats, table, or summary from data shape.",
				},
			},
			required: ["data"],
		},
	},
	create_mcp_app: {
		name: "Create Generated MCP App",
		description:
			"Create a transient free-form HTML/CSS MCP App resource from this Code Mode result. Use only when json-render cannot express the visual. The host renders the generated document in a nested sandbox with scripts and external capabilities disabled. Style it with the documented host semantic CSS variables so it follows light and dark themes; include a meaningful structured fallback.",
		parameters: {
			type: "object",
			properties: {
				title: { type: "string" },
				html: {
					type: "string",
					description:
						"Self-contained semantic HTML fragment with inline CSS. Maximum 4,000 characters. Use var(--background), var(--foreground), var(--surface), var(--card), var(--muted), var(--accent), var(--border), and their foreground variants instead of fixed page colors so the result follows the MCP host theme. Do not depend on scripts, remote assets, forms, or navigation.",
				},
				summary: {
					type: "string",
					description:
						"Meaningful plain-text fallback that remains useful if the MCP App cannot mount.",
				},
				data: { type: "object" },
				appSlug: { type: "string" },
				appName: { type: "string" },
				appId: { type: "string" },
				logoUrl: { type: "string" },
			},
			required: ["title", "html", "summary"],
		},
	},
	create_health_sweep: {
		name: "Create Health Sweep",
		description:
			"Create a compact json-render health sweep from multiple provider/tool checks. Use after probing requested namespaces such as Notion, PromptWatch, Todoist, Cloudflare, Nosana, or Gmail. Return the result directly so Tedix OS renders one summary instead of many raw tool blocks.",
		parameters: {
			type: "object",
			properties: {
				title: { type: "string" },
				appSlug: {
					type: "string",
					description:
						"App slug used for theming and resource URI. Defaults to tedix-unified.",
				},
				appName: { type: "string" },
				checks: {
					type: "array",
					description:
						"One row per provider/tool probe. Keep summaries short and put raw details in error only when needed.",
					items: {
						type: "object",
						properties: {
							namespace: { type: "string" },
							provider: { type: "string" },
							tool: { type: "string" },
							label: { type: "string" },
							status: { type: "string" },
							summary: { type: "string" },
							error: { type: "string" },
							latencyMs: { type: "number" },
						},
						required: ["status"],
					},
				},
				summary: { type: "string" },
			},
			required: ["checks"],
		},
	},
	validate_layout: {
		name: "Validate Layout",
		description:
			"Validate and auto-fix a json-render layoutSpec before creating a visual view.",
		parameters: {
			type: "object",
			properties: {
				layoutSpec: {
					type: "object",
					description: "json-render layout spec with root and elements.",
				},
			},
			required: ["layoutSpec"],
		},
	},
} satisfies Record<
	string,
	{
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	}
>;

const CODEMODE_PROVIDER_TYPES = [
	"declare namespace codemode {",
	"  /** Inspect this Code Mode execution context for live proof, audit correlation, and current gateway/tool counts. */",
	'  function __runtime(): Promise<{ mode: "stateless"; surface: "mcp-gateway"; executionId: string | null; appId: string; appSlug: string; organizationId: string | null; traceId: string; actor: { authType: string; userId: string | null; tediId: string | null; clientId: string | null; externalAgentPrincipalId: string | null; externalAgentSessionId: string | null; externalAgentHarness: string | null; externalAgentModel: string | null }; toolCount: number; namespaceCount: number; modules: string[]; executionSurface: { kind: "mcp-gateway"; surfaceId: string; sessionIds: string[]; participantIds: string[] } }>; ',
	"}",
].join("\n");

const FLOW_CATALOG_TOOLS = {
	run: {
		name: "Run Ephemeral Flow Workflow",
		description:
			"Record source as an EPHEMERAL draft skill workflow and start it in one call. Use for ~10+ step jobs (sweeps, watches, migrations, fan-out judging): the steps run in a durable Cloudflare Workflow OFF your context window; only the bounded return value comes back. Returns { skillId, runId } immediately — poll flow.status later, never busy-wait in the same execution.",
		parameters: {
			type: "object",
			properties: {
				source: {
					type: "string",
					description:
						"Workflow module: export default { async run(event, step, env) { ... } } using step.do/sleep and env.MCP.<ns>.<tool>(args) for capabilities declared below.",
				},
				skillId: {
					type: "string",
					description:
						"Existing skill id to rerun without recording a new draft.",
				},
				name: { type: "string" },
				description: { type: "string" },
				skillDoc: {
					type: "string",
					description:
						"Complete SKILL.md content, including frontmatter. Use when the caller already has a manifest that must be preserved verbatim; otherwise capabilities is rendered into a minimal document.",
				},
				capabilities: {
					type: "object",
					description:
						'Capability manifest, e.g. { "mcp": { "firecrawl": ["firecrawl_scrape"] }, "reason": { "maxCalls": 4 } }. Undeclared namespaces throw CAPABILITY_NOT_DECLARED at runtime.',
				},
				params: { type: "object" },
				workItemId: {
					type: "string",
					description:
						"Canonical Work Item to pin at admission and propagate to every flow tool call and artifact receipt.",
				},
				tediSlug: {
					type: "string",
					description: "Tedi namespace that owns the run (default cto).",
				},
				reason: { type: "string" },
			},
			required: [],
		},
	},
	status: {
		name: "Poll Flow Run Status",
		description:
			"Compact lifecycle poll for a flow run: { status, output, error, durationMs }. Terminal: completed | failed | canceled.",
		parameters: {
			type: "object",
			properties: {
				runId: { type: "string" },
				tediSlug: { type: "string" },
			},
			required: ["runId"],
		},
	},
	inspect: {
		name: "Inspect Flow Run Evidence",
		description:
			"Full evidence view of a flow run (steps, receipts, artifacts, warnings). Use on FAILURE, not per poll.",
		parameters: {
			type: "object",
			properties: {
				runId: { type: "string" },
				tediSlug: { type: "string" },
			},
			required: ["runId"],
		},
	},
	list: {
		name: "List Flow Runs",
		description: "List recent workflow runs for the selected tedi.",
		parameters: {
			type: "object",
			properties: {
				limit: { type: "number" },
				tediSlug: { type: "string" },
			},
		},
	},
} satisfies Record<
	string,
	{
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	}
>;

const CODEMODE_CATALOG_TOOLS = {
	__runtime: {
		name: "Inspect Code Mode Runtime",
		description:
			"Return this Code Mode execution context: executionId, app/org, actor, traceId, tool counts, module names, and direct gateway execution-surface proof.",
		parameters: {
			type: "object",
			properties: {},
		},
	},
} satisfies Record<
	string,
	{
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	}
>;

interface CodeModeExecutionRefs {
	authorizationDenial: CodeModeAuthorizationError | undefined;
	replayUnsafeBuiltinCalls: number;
	executionId: string | undefined;
	paymentExtra: { _meta?: Record<string, unknown> } | undefined;
	paymentResponses: Record<string, unknown>[];
	rpcCallCount: number;
	rpcNamespaces: Set<string>;
	sideEffectQueue: Promise<void>;
	failureBudget: IdenticalFailureBudget;
	/** Discovery-option telemetry: how the model actually discovers. */
	discoverCalls: number;
	discoverParameterRequests: number;
	/**
	 * EXECUTION RECEIPTS the executor observed itself, one per namespaced tool
	 * call this program made. Every inner call is already wrapped with
	 * `completionEvidence`, but a program returns a hand-built PROJECTION and
	 * routinely drops it — so the receipt has to travel out-of-band, beside the
	 * program's return value, or the delegation proof gate reads execution
	 * evidence as unknown for work that demonstrably ran.
	 */
	toolReceipts: {
		operation: string;
		status: CompletionEvidence["status"];
		error?: string;
	}[];
	/** Exact inner workflow run identities, retained even if JS returns a summary. */
	skillWorkflowRunIds: Set<string>;
	readObservations: OwnedReadObservation[];
	collectionReads: OwnedConnectedCollectionRead[];
}

export function collectCodeModeReadObservation(input: {
	meta: unknown;
	executionId: string | undefined;
	innerCallOrdinal: number;
	into: OwnedReadObservation[];
}): void {
	if (!input.executionId || input.into.length >= 100) return;
	const meta =
		input.meta && typeof input.meta === "object" && !Array.isArray(input.meta)
			? (input.meta as Record<string, unknown>)
			: null;
	const receipt = parseDocsFileObservationReceipt(
		meta?.[READ_OBSERVATION_META_KEY],
	);
	if (!receipt) return;
	input.into.push({
		innerCallId: `${input.executionId}:${input.innerCallOrdinal}`,
		receipt,
	});
}

export function codeModeReadObservationMeta(
	readObservations: readonly OwnedReadObservation[],
): Record<string, unknown> {
	return readObservations.length > 0
		? { [READ_OBSERVATIONS_META_KEY]: readObservations }
		: {};
}

export function collectCodeModeCollectionRead(input: {
	meta: unknown;
	executionId: string | undefined;
	innerCallOrdinal: number;
	into: OwnedConnectedCollectionRead[];
}): void {
	if (!input.executionId || input.into.length >= 100) return;
	const meta =
		input.meta && typeof input.meta === "object" && !Array.isArray(input.meta)
			? (input.meta as Record<string, unknown>)
			: null;
	const observation = parseConnectedCollectionRead(
		meta?.[READ_COLLECTION_META_KEY],
	);
	if (!observation) return;
	input.into.push({
		innerCallId: `${input.executionId}:${input.innerCallOrdinal}`,
		observation,
	});
}

export function codeModeCollectionReadMeta(
	collectionReads: readonly OwnedConnectedCollectionRead[],
): Record<string, unknown> {
	return collectionReads.length > 0
		? { [READ_COLLECTIONS_META_KEY]: collectionReads }
		: {};
}

export function attachCodeModeReadObservations<T extends object>(
	result: T,
	readObservations: readonly OwnedReadObservation[],
	collectionReads: readonly OwnedConnectedCollectionRead[] = [],
): T {
	if (readObservations.length === 0 && collectionReads.length === 0)
		return result;
	return {
		...result,
		_meta: {
			...(result as { _meta?: Record<string, unknown> })._meta,
			...codeModeReadObservationMeta(readObservations),
			...codeModeCollectionReadMeta(collectionReads),
		},
	} as T;
}

interface UiViewInput {
	appId?: string;
	appName?: string;
	appSlug?: string;
	data?: unknown;
	layoutId?: string;
	layoutSpec?: unknown;
	logoUrl?: string;
	summary?: string;
	title?: string;
	visualKind?: UiVisualKind;
}

interface UiHealthSweepInput {
	appName?: string;
	appSlug?: string;
	checks: Record<string, unknown>[];
	summary?: string;
	title?: string;
}

interface UiMcpAppInput {
	appId?: string;
	appName?: string;
	appSlug?: string;
	data?: Record<string, unknown>;
	html: string;
	logoUrl?: string;
	summary: string;
	title: string;
}

type HealthSweepStatus =
	| "blocked"
	| "error"
	| "missing"
	| "ok"
	| "unknown"
	| "warning";

interface NormalizedHealthSweepCheck extends Record<string, unknown> {
	label: string;
	namespace: string;
	status: HealthSweepStatus;
	tone: string;
}

interface TableCandidate {
	path: string;
	rows: Record<string, unknown>[];
}

interface ChartSeriesSpec {
	key: string;
	label: string;
	color: "chart-1" | "chart-2" | "chart-3" | "chart-4" | "chart-5" | "chart-6";
}

interface ChartCandidate {
	table: TableCandidate;
	data: Record<string, unknown>[];
	variant: "area" | "bar" | "donut" | "line";
	xKey?: string;
	yKeys?: string[];
	series?: ChartSeriesSpec[];
	nameKey?: string;
	valueKey?: string;
}

interface CatalogToolAnnotations {
	destructiveHint?: boolean;
	readOnlyHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

interface CatalogToolEntry {
	callable: string;
	namespace: string;
	tool: string;
	name: string;
	displayName: string;
	description: string;
	parameters?: Record<string, unknown>;
	annotations?: CatalogToolAnnotations;
	outputSchema?: Record<string, unknown>;
	schemaFreshness?: CatalogSchemaFreshness;
	equivalentTediOwners?: Array<{ namespace: string; callable: string }>;
	/**
	 * Set on the dual-mounted peer-alias copy (SEAM B) to the canonical
	 * namespace it mirrors. Aliases resolve but never enumerate: entries with
	 * aliasOf are excluded from unfiltered search/browse and list_namespaces,
	 * and served only under an explicit { namespace } filter on the alias form.
	 */
	aliasOf?: string;
	/**
	 * Caller-relative authorization, computed per request through
	 * `evaluateMcpToolScopeAuthorization` — the same seam the dispatch gates
	 * use, so discovery and enforcement cannot drift. Absent on host-owned
	 * namespaces (ui/codemode/flow), which have no D1 scope config.
	 */
	authorized?: boolean;
	requiredScopes?: string[];
	missingScopes?: string[];
}

interface CatalogSchemaFreshness {
	dialect?: string;
	source?: string;
	sourceRef?: string;
	sourceHash?: string;
	syncedAt?: string;
	toolUpdatedAt?: string;
}

interface CatalogSearchMatch {
	score: number;
	matchedTerms: string[];
	unmatchedTerms: string[];
}

interface CatalogPageEntry {
	namespace: string;
	tool: string;
	meta: unknown;
}

type UiVisualKind =
	| "auto"
	| "categoricalCounts"
	| "chart"
	| "comparison"
	| "details"
	| "rankedMetrics"
	| "stats"
	| "summary"
	| "table"
	| "timeSeries"
	| "timeline";

interface InferredLayout {
	layoutSpec: Record<string, unknown>;
	viewData?: Record<string, unknown>;
}

function recordFrom(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}

function skillWorkflowRunId(value: unknown): string | null {
	const result = recordFrom(value);
	if (!result) return null;
	const candidates = [
		result.runId,
		recordFrom(result.data)?.runId,
		recordFrom(result.structuredContent)?.runId,
	];
	const runId = candidates.find(
		(candidate) =>
			typeof candidate === "string" &&
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
				candidate,
			),
	);
	return typeof runId === "string" ? runId : null;
}

function callerOrganizationMetadata(
	serverCtx: ServerContext,
): Record<string, string> {
	const callerOrganizationId = serverCtx.callerIdentity?.organizationId;
	if (
		!callerOrganizationId ||
		callerOrganizationId === serverCtx.app.organizationId
	) {
		return {};
	}
	return { callerOrganizationId };
}

function codeModeTailContext(
	serverCtx: ServerContext,
	executionId: string | undefined,
): Record<string, string> {
	return {
		appId: serverCtx.appId,
		appSlug: serverCtx.appSlug,
		orgId: serverCtx.app.organizationId ?? "",
		userId: serverCtx.callerIdentity?.userId ?? "",
		tediId: serverCtx.callerIdentity?.tediId ?? "",
		authType: serverCtx.callerIdentity?.authType ?? "anonymous",
		executionId: executionId ?? "",
		traceId: serverCtx.traceId,
	};
}

function writeCodeModeAnalytics(
	serverCtx: ServerContext,
	event: McpCodeModeAnalyticsDataPointEvent,
): void {
	const dataset = serverCtx.env.CODEMODE_ANALYTICS;
	if (!dataset) return;
	dataset.writeDataPoint(buildMcpCodeModeAnalyticsDataPoint(event));
}

function splitToolArgs(args: Record<string, unknown>): {
	toolArgs: Record<string, unknown>;
	inlineExtra: { _meta?: Record<string, unknown> } | undefined;
} {
	const { _meta, ...toolArgs } = args;
	return {
		toolArgs,
		inlineExtra: isRecord(_meta) ? { _meta } : undefined,
	};
}

function buildCodeModeWidgetMetadata(
	serverCtx: ServerContext,
	tool: AppTool,
	dynamicLayoutSpec?: Record<string, unknown>,
): Record<string, unknown> | null {
	const resolvedWidgetRoute = resolveToolWidgetRoute(tool);
	const widgetRoute = (resolvedWidgetRoute ?? tool.widgetRoute)?.replace(
		/^\//,
		"",
	);
	if (!widgetRoute) return null;

	const widgetApp = resolveCodeModeWidgetApp(serverCtx, tool);
	const layoutSpec = dynamicLayoutSpec ?? getToolLayoutSpec(tool);
	const resourceUri = `ui://widgets/mcp-app/${widgetApp.slug}/${widgetRoute}.html`;
	const outputTemplate =
		serverCtx.toolOutputTemplates.get(tool.toolId) ??
		tool.outputTemplate ??
		undefined;

	return {
		...(layoutSpec ? { layoutSpec } : {}),
		app: {
			id: widgetApp.id,
			slug: widgetApp.slug,
			name: widgetApp.name,
			...(widgetApp.logoUrl ? { logoUrl: widgetApp.logoUrl } : {}),
		},
		_meta: {
			...(outputTemplate ? { "openai/outputTemplate": outputTemplate } : {}),
			"openai/widgetAccessible": tool.widgetAccessible ?? true,
			ui: {
				resourceUri,
				app: {
					id: widgetApp.id,
					slug: widgetApp.slug,
					name: widgetApp.name,
					...(widgetApp.logoUrl ? { logoUrl: widgetApp.logoUrl } : {}),
				},
			},
		},
	};
}

function resolveCodeModeWidgetApp(
	serverCtx: ServerContext,
	tool: AppTool,
): { id: string; slug: string; name: string; logoUrl?: string } {
	const config = recordFrom(tool.config);
	const sourceAppId =
		typeof config?._sourceAppId === "string" ? config._sourceAppId : undefined;
	const sourceLogoUrl =
		typeof config?._sourceAppLogoUrl === "string"
			? config._sourceAppLogoUrl
			: undefined;
	const slug = resolveWidgetAppSlug(serverCtx, tool);

	return {
		id: sourceAppId ?? (slug === serverCtx.appSlug ? serverCtx.appId : slug),
		slug,
		name:
			slug === serverCtx.appSlug
				? (serverCtx.app?.name ?? humanizeSlug(slug))
				: humanizeSlug(slug),
		...(sourceLogoUrl
			? { logoUrl: sourceLogoUrl }
			: slug === serverCtx.appSlug && serverCtx.app?.logoUrl
				? { logoUrl: serverCtx.app.logoUrl }
				: {}),
	};
}

function humanizeSlug(slug: string): string {
	return slug
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[-_]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function attachCodeModeWidgetMetadata(
	data: Record<string, unknown>,
	serverCtx: ServerContext,
	tool: AppTool,
	dynamicLayoutSpec?: Record<string, unknown>,
): Record<string, unknown> {
	const widgetMetadata = buildCodeModeWidgetMetadata(
		serverCtx,
		tool,
		dynamicLayoutSpec,
	);
	if (!widgetMetadata) return data;

	const existingMeta = recordFrom(data._meta) ?? {};
	const widgetMeta = recordFrom(widgetMetadata._meta) ?? {};

	return {
		...data,
		...widgetMetadata,
		_meta: {
			...existingMeta,
			...widgetMeta,
		},
	};
}

function codeModeResultMeta(
	value: unknown,
	depth = 0,
	seen = new Set<unknown>(),
): Record<string, unknown> | undefined {
	if (depth > 5 || value == null || seen.has(value)) return undefined;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) {
			const nested = codeModeResultMeta(item, depth + 1, seen);
			if (nested) return nested;
		}
		return undefined;
	}

	const result = recordFrom(value);
	if (!result) return undefined;
	const meta = recordFrom(result?._meta);
	const ui = recordFrom(meta?.ui);
	const resourceUri =
		typeof ui?.resourceUri === "string" ? ui.resourceUri : null;
	if (resourceUri?.startsWith("ui://widgets/")) {
		return {
			...meta,
			ui: {
				...ui,
				resourceUri,
			},
		};
	}

	for (const key of [
		"view",
		"widget",
		"result",
		"data",
		"response",
		"output",
		"structuredContent",
	]) {
		const nested = codeModeResultMeta(result[key], depth + 1, seen);
		if (nested) return nested;
	}

	return undefined;
}

function findPaymentRequiredMeta(
	value: unknown,
	depth = 0,
	seen = new Set<unknown>(),
): TedixPaymentRequiredMeta | null {
	if (depth > 6) return null;
	const direct = getPaymentRequiredMeta({ result: value });
	if (direct) return direct;
	if (!isRecord(value) && !Array.isArray(value)) return null;
	if (seen.has(value)) return null;
	seen.add(value);

	if (Array.isArray(value)) {
		for (const item of value) {
			const nested = findPaymentRequiredMeta(item, depth + 1, seen);
			if (nested) return nested;
		}
		return null;
	}

	for (const nestedValue of Object.values(value)) {
		const nested = findPaymentRequiredMeta(nestedValue, depth + 1, seen);
		if (nested) return nested;
	}
	return null;
}

export function buildPaymentExtra(
	extra: { _meta?: Record<string, unknown> } | undefined,
	payment: unknown,
): { _meta?: Record<string, unknown> } | undefined {
	const meta = isRecord(extra?._meta)
		? { ...(extra._meta as Record<string, unknown>) }
		: {};
	if (payment !== undefined && meta[X402_PAYMENT_META_KEY] === undefined) {
		meta[X402_PAYMENT_META_KEY] = payment;
	}
	return Object.keys(meta).length > 0 ? { _meta: meta } : undefined;
}

function emitCodeModeAuthorizationDenied(
	serverCtx: ServerContext,
	tool: AppTool,
	namespace: string,
	args: Record<string, unknown>,
	error: CodeModeAuthorizationError,
	executionId: string | undefined,
): void {
	if (!executionId) return;

	const event: McpEvent = {
		timestamp: new Date().toISOString(),
		eventType: "tool_call",
		appId: serverCtx.appId,
		appSlug: serverCtx.appSlug,
		organizationId: serverCtx.app?.organizationId,
		toolName: tool.toolId,
		toolInputSize: getJsonSize(args),
		userId: serverCtx.callerIdentity?.userId,
		tediId: serverCtx.callerIdentity?.tediId,
		clientId: serverCtx.callerIdentity?.clientId,
		authType: serverCtx.callerIdentity?.authType,
		traceId: serverCtx.traceId,
		executionId,
		success: false,
		durationMs: 0,
		errorCode: error.name,
		errorMessage: truncateErrorMessage(error.message),
		metadata: {
			...buildCallerAuditMetadata(serverCtx.callerIdentity),
			...toolRiskAuditMetadata(tool),
			namespace,
			requiredScopes: error.requiredScopes.join(","),
			missingScopes: error.missingScopes.join(","),
		},
	};

	trackMcpEvent(serverCtx.env, event);
	emitMcpAuditEvent(
		serverCtx.env,
		event,
		serverCtx.ctx.waitUntil.bind(serverCtx.ctx),
	);
}

// =============================================================================
// PROVIDER BUILDERS
// =============================================================================

/**
 * Group tools by namespace and build executable functions + JSON Schema descriptors.
 */
function projectedToolIdentity(
	toolId: string,
	tool: AppTool,
	namespaceOverrides: Record<string, string> | undefined,
): { namespace: string; safeName: string; ownerKey: string } {
	const namespace = resolveMcpToolNamespace(tool, namespaceOverrides);
	const rawName = toolId.includes("__")
		? toolId.split("__").slice(1).join("__")
		: toolId;
	const safeName = sanitizeToolName(rawName);
	return { namespace, safeName, ownerKey: `${namespace}.${safeName}` };
}

function codeModeCollisionOwners(
	serverCtx: ServerContext,
	namespaceOverrides: Record<string, string> | undefined,
): Map<string, string[]> {
	const owners = new Map<string, string[]>();
	for (const [toolId, tool] of serverCtx.loadedTools) {
		const { ownerKey } = projectedToolIdentity(
			toolId,
			tool,
			namespaceOverrides,
		);
		const current = owners.get(ownerKey) ?? [];
		current.push(toolId);
		owners.set(ownerKey, current);
	}
	return new Map(
		[...owners.entries()]
			.filter(([, toolIds]) => toolIds.length > 1)
			.map(([ownerKey, toolIds]) => [ownerKey, toolIds.sort()]),
	);
}

function buildNamespaceGroups(
	serverCtx: ServerContext,
	namespaceOverrides: Record<string, string> | undefined,
	executionRefs: CodeModeExecutionRefs,
	collisionKeys: ReadonlySet<string> = new Set(
		codeModeCollisionOwners(serverCtx, namespaceOverrides).keys(),
	),
): Map<string, NamespaceGroup> {
	const groups = new Map<string, NamespaceGroup>();
	const toolOwners = new Map<string, string>();

	for (const [toolId, tool] of serverCtx.loadedTools) {
		const {
			namespace: ns,
			safeName,
			ownerKey,
		} = projectedToolIdentity(toolId, tool, namespaceOverrides);
		if (collisionKeys.has(ownerKey)) continue;
		toolOwners.set(ownerKey, toolId);

		if (!groups.has(ns)) {
			groups.set(ns, { fns: {}, schemas: {} });
		}
		const group = groups.get(ns)!;

		// Executable function — routes through the full ToolHandler pipeline
		group.fns[safeName] = async (args: Record<string, unknown>) => {
			const retryKey = buildIdenticalCallKey(ownerKey, args);
			const retryState = executionRefs.failureBudget.state(retryKey);
			if (retryState.blocked) {
				return withCompletionEvidence(
					safeName,
					{
						ok: false,
						error:
							"Identical call blocked after repeated failures. Change the arguments or execution plan.",
					},
					{
						key: retryKey,
						attempts: retryState.attempts,
						limit: retryState.limit,
						blocked: true,
					},
				);
			}
			const runTool = async () => {
				const { toolArgs, inlineExtra } = splitToolArgs(args);
				try {
					assertCodeModeInnerToolAuthorized(serverCtx, tool, ns, toolArgs);
				} catch (error) {
					if (error instanceof CodeModeAuthorizationError) {
						executionRefs.authorizationDenial ??= error;
						emitCodeModeAuthorizationDenied(
							serverCtx,
							tool,
							ns,
							args ?? {},
							error,
							executionRefs.executionId,
						);
					}
					throw error;
				}
				// The declared capability folded in, exactly as `buildCatalogProvider`
				// does for discovery. Passing raw `tool.annotations` here meant
				// discovery and ENFORCEMENT disagreed inside this one file: a row
				// declared `destructive` with no upstream annotations was advertised
				// by `discover.search()` as `destructiveHint: true` and then executed
				// with no approval and no elicitation, because
				// `requireDestructiveToolApproval` keys on
				// `annotations?.destructiveHint !== true`.
				//
				// That row shape is the PRIMARY PRODUCT of declared capability —
				// `updateAppTool` sets `writeCapability` while leaving `annotations`
				// untouched, for the ~52 third-party tools whose upstream never sends
				// annotations at all. So the declaration was inert on the one path
				// tedis actually execute on, which is the gateway-native default.
				const declaredAnnotations = resolveToolAnnotations({
					annotations: tool.annotations ?? null,
					writeCapability: tool.writeCapability ?? null,
					meta: tool.meta as Record<string, unknown> | null,
				});
				const annotationFailure = enforceExpectedAnnotations(
					serverCtx,
					tool,
					declaredAnnotations,
					inlineExtra,
				);
				if (annotationFailure) {
					throw new Error(callToolResultText(annotationFailure));
				}
				const riskRateLimitFailure = await enforceToolRiskRateLimit(
					serverCtx,
					tool,
				);
				if (riskRateLimitFailure) {
					throw new Error(callToolResultText(riskRateLimitFailure));
				}
				const approvalFailure = await requireDestructiveToolApproval(
					serverCtx,
					tool,
					declaredAnnotations,
					// `allowSyncMrtr: false` is intentional and load-bearing — DO NOT flip
					// it to inherit the top-level default. Sync-MRTR turns a provider
					// approval requirement into an OUTER protocol `input_required`
					// round-trip back to the client. An inner Code Mode call runs inside
					// the sandbox script with no protocol channel to the originating
					// client, so an inner provider result cannot translate into an outer
					// `input_required` exchange. Enabling sync-MRTR here would emit an
					// outer prompt the inner caller can never satisfy. Inner approval
					// gaps therefore surface as an inline failure, not a sync round-trip.
					//
					// `autoConfirmAgent: true`: since sync-MRTR is unreachable here, a
					// tedi running its own scope-permitted destructive tool would
					// otherwise fail closed — breaking autonomous workflows. Governance
					// auto-approves it (audited) only when the caller is a genuine agent;
					// a human operator via Code Mode still confirms explicitly. Crown-jewel
					// gates are enforced separately and unaffected. See the autoConfirmAgent
					// doc on DestructiveApprovalOptions.
					{ allowSyncMrtr: false, autoConfirmAgent: true, args: toolArgs },
				);
				if (approvalFailure) {
					throw new Error(callToolResultText(approvalFailure));
				}
				const executionArgs = stripDestructiveApprovalArgs(tool, toolArgs);

				const payment = await checkToolPayment({
					agent: serverCtx,
					tool,
					args: executionArgs,
					extra: executionRefs.paymentExtra ?? inlineExtra,
				});
				if (!payment.paid) return payment.result;

				const adapterScope = parseAdapterScope(tool.adapterScope);
				const resultStrategy = (tool.resultStrategy ??
					"text") as ResultStrategy;

				const rpcStart = Date.now();
				const innerCallOrdinal = executionRefs.rpcCallCount++;
				let rpcSuccess = true;
				try {
					const result = await executeTool(serverCtx, tool, executionArgs, {
						adapterScope,
						resultStrategy,
						executionId: executionRefs.executionId,
					});
					if (result.isError) {
						rpcSuccess = false;
						throw new Error(callToolResultText(result));
					}
					collectCodeModeCollectionRead({
						meta: result._meta,
						executionId: executionRefs.executionId,
						innerCallOrdinal,
						into: executionRefs.collectionReads,
					});
					const settlement = await settleToolPayment(
						serverCtx,
						payment.settlement,
					);
					if (!settlement.settled) {
						rpcSuccess = false;
						throw new Error(callToolResultText(settlement.result));
					}
					const paymentResponse =
						settlement.paymentResponse ?? payment.paymentResponse;
					const paidResult = attachPaymentResponseMeta(result, paymentResponse);
					collectCodeModeReadObservation({
						meta: paidResult._meta,
						executionId: executionRefs.executionId,
						innerCallOrdinal,
						into: executionRefs.readObservations,
					});
					if (paymentResponse) {
						executionRefs.paymentResponses.push(paymentResponse);
					}
					if (paidResult.isError) {
						// An inner MCP failure must fail the Code Mode program. Merely
						// recording failed telemetry and then returning the text lets
						// `await namespace.tool()` resolve to an error-looking string;
						// the outer `code` tool and callers such as Home write settlement
						// then record a provider failure as successful execution.
						rpcSuccess = false;
						throw new Error(callToolResultText(paidResult));
					}

					const normalizedResult = unwrapCallToolResult(
						paidResult,
						tool.toolId,
					);
					const normalizedRecord = recordFrom(normalizedResult);
					if (normalizedRecord) {
						const {
							appCapabilities: _appCapabilities,
							layoutSpec,
							...data
						} = normalizedRecord;
						return attachCodeModeWidgetMetadata(
							Object.keys(data).length > 0 ? data : normalizedRecord,
							serverCtx,
							tool,
							recordFrom(layoutSpec) ?? undefined,
						);
					}
					return normalizedResult;
				} catch (err) {
					rpcSuccess = false;
					throw err;
				} finally {
					const durationMs = Date.now() - rpcStart;
					executionRefs.rpcNamespaces.add(ns);
					console.log(
						JSON.stringify({
							_cm: "rpc",
							...codeModeTailContext(serverCtx, executionRefs.executionId),
							ns,
							tool: safeName,
							durationMs,
							success: rpcSuccess,
						}),
					);
					writeCodeModeAnalytics(serverCtx, {
						eventType: "rpc",
						appId: serverCtx.appId,
						appSlug: serverCtx.appSlug,
						organizationId: serverCtx.app.organizationId,
						toolName: `${ns}.${safeName}`,
						userId: serverCtx.callerIdentity?.userId,
						tediId: serverCtx.callerIdentity?.tediId,
						authType: serverCtx.callerIdentity?.authType,
						executionId: executionRefs.executionId,
						traceId: serverCtx.traceId,
						durationMs,
						success: rpcSuccess,
					});
				}
			};
			const runWithEvidence = async () => {
				try {
					const result = await runTool();
					const evidence = buildCompletionEvidence({
						operation: safeName,
						result,
						retryKey,
						attempts: retryState.attempts,
						limit: retryState.limit,
					});
					const updatedRetryState =
						evidence.status === "failed" || evidence.status === "partial"
							? executionRefs.failureBudget.recordFailure(retryKey)
							: executionRefs.failureBudget.recordSuccess(retryKey);
					const resultRecord = recordFrom(result);
					if (
						safeName === "run_skill_workflow" &&
						evidence.status === "succeeded"
					) {
						const runId = skillWorkflowRunId(result);
						if (runId && executionRefs.skillWorkflowRunIds.size < 40)
							executionRefs.skillWorkflowRunIds.add(runId);
					}
					const resultError =
						evidence.status === "failed" || evidence.status === "partial"
							? typeof resultRecord?.error === "string"
								? resultRecord.error
								: typeof resultRecord?.message === "string"
									? resultRecord.message
									: undefined
							: undefined;
					executionRefs.toolReceipts.push({
						operation: `${ns}.${safeName}`,
						status: evidence.status,
						...(resultError ? { error: resultError.slice(0, 300) } : {}),
					});
					return withCompletionEvidence(safeName, result, {
						key: retryKey,
						attempts: updatedRetryState.attempts,
						limit: updatedRetryState.limit,
					});
				} catch (error) {
					const updatedRetryState =
						executionRefs.failureBudget.recordFailure(retryKey);
					executionRefs.toolReceipts.push({
						operation: `${ns}.${safeName}`,
						status: "failed",
						error: (error instanceof Error
							? error.message
							: String(error)
						).slice(0, 300),
					});
					return withCompletionEvidence(
						safeName,
						{
							ok: false,
							error: error instanceof Error ? error.message : String(error),
						},
						{
							key: retryKey,
							attempts: updatedRetryState.attempts,
							limit: updatedRetryState.limit,
						},
					);
				}
			};
			return isSideEffectfulTool(tool.annotations)
				? runSerializedSideEffect(executionRefs, runWithEvidence)
				: runWithEvidence();
		};

		// JSON Schema descriptor for type generation.
		group.schemas[safeName] = {
			description: tool.description ?? toolId,
			inputSchema: {
				type: "object",
				properties: (withDestructiveApprovalSchema(
					tool,
					resolveToolAnnotations({
						annotations: tool.annotations ?? null,
						writeCapability: tool.writeCapability ?? null,
						meta: tool.meta as Record<string, unknown> | null,
					}),
				).properties ??
					{}) as JsonSchemaToolDescriptors[string]["inputSchema"]["properties"],
			},
		};

		// SEAM A — dual-mount: register the same closure under the peer alias
		// namespace (e.g. "apps" ↔ "app", "tedis" ↔ "tedi") so a caller that
		// uses either form reaches the same handler. Auth checks inside the
		// closure log the primary namespace `ns`; the alias is transparent.
		const aliasNs = NAMESPACE_PEER_ALIASES.get(ns);
		if (aliasNs !== undefined) {
			const aliasOwnerKey = `${aliasNs}.${safeName}`;
			if (toolOwners.has(aliasOwnerKey)) {
				console.warn(
					`Code Mode alias slot ${aliasOwnerKey} already claimed by ${toolOwners.get(aliasOwnerKey)} — skipping alias for ${toolId}`,
				);
			} else {
				toolOwners.set(aliasOwnerKey, toolId);
				if (!groups.has(aliasNs)) {
					groups.set(aliasNs, { fns: {}, schemas: {} });
				}
				const aliasGroup = groups.get(aliasNs)!;
				// Shared closure — same function object, no copy.
				aliasGroup.fns[safeName] = group.fns[safeName]!;
				aliasGroup.schemas[safeName] = group.schemas[safeName]!;
			}
		}
	}

	return groups;
}

// Auto-generated D1 tools whose oRPC contract has no description/summary get a
// placeholder description (`Tedix oRPC endpoint <router>/<proc>`, or empty) from
// tool-schema-sync. That's useless for an agent deciding whether to call the
// tool. Replace it AT DISCOVERY SERVE TIME (not in D1 — avoids the schema-drift
// gate) with a readable sentence derived from the verb-first tool name, e.g.
// `list_adapter_bindings_by_app` → "List adapter bindings by app." Real authored
// descriptions are left untouched.
function humanizeWeakDescription(
	description: string | null | undefined,
	toolName: string,
): string {
	const desc = (description ?? "").trim();
	const isWeak =
		desc.length === 0 || /^Tedix oRPC endpoint \S+\/\S+$/.test(desc);
	if (!isWeak) return desc;
	const words = toolName.split(/[_\s]+/).filter(Boolean);
	if (words.length === 0) return desc;
	const sentence = words.join(" ");
	return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

function splitCallable(callable: string): { namespace: string; tool: string } {
	const dot = callable.indexOf(".");
	return { namespace: callable.slice(0, dot), tool: callable.slice(dot + 1) };
}

/**
 * Identify generated tedi mirrors only. A coincidental tool with the same name
 * in an app namespace remains independently discoverable.
 */
function mirroredSkillWorkflowSurface(
	namespace: string,
	toolName: string,
	meta: CatalogToolEntry,
): SkillWorkflowSurface | undefined {
	const surface = SKILL_WORKFLOW_SURFACE_BY_TEDI_TOOL.get(toolName);
	if (!surface || namespace === "skills" || namespace === FLOW_NAMESPACE) {
		return undefined;
	}
	return meta.schemaFreshness?.source === "mcp" &&
		meta.schemaFreshness.sourceRef === toolName
		? surface
		: undefined;
}

function workflowTediOwners(
	catalog: Record<string, Record<string, CatalogToolEntry>>,
): Map<string, Array<{ namespace: string; callable: string }>> {
	const owners = new Map<
		string,
		Array<{ namespace: string; callable: string }>
	>();
	for (const [namespace, tools] of Object.entries(catalog)) {
		for (const [toolName, meta] of Object.entries(tools)) {
			const surface = mirroredSkillWorkflowSurface(namespace, toolName, meta);
			if (!surface) continue;
			const list = owners.get(surface.canonicalCallable) ?? [];
			list.push({ namespace, callable: meta.callable });
			owners.set(surface.canonicalCallable, list);
		}
	}
	for (const list of owners.values()) {
		list.sort((a, b) => a.namespace.localeCompare(b.namespace));
	}
	return owners;
}

/**
 * A tedi-native tool (per-tedi worker interface synced from the tedi's own
 * MCP surface) is marked by `schemaFreshness.source === "mcp"` with a bare
 * `sourceRef === toolName` — external MCP apps carry an `<appId>:` prefix on
 * sourceRef, so they never group here.
 */
function isTediNativeInterfaceTool(meta: CatalogToolEntry): boolean {
	return (
		meta.schemaFreshness?.source === "mcp" &&
		meta.schemaFreshness.sourceRef === meta.tool
	);
}

/**
 * Role-verb collapse: the same worker interface repeats identically across
 * every role namespace (nine 152-tool namespaces ≈ 28% of the tedix-unified
 * catalog when this shipped). Group tedi-native tools by tool name; unfiltered
 * enumeration emits one representative row (alphabetically-first namespace)
 * with the other owners in `equivalentTediOwners`, exactly the shape the
 * skill-workflow mirror collapse already uses. Execution and namespace-filtered
 * search are untouched — every role callable still dispatches.
 */
function tediNativeInterfaceGroups(
	catalog: Record<string, Record<string, CatalogToolEntry>>,
	preferredNamespace?: string,
): Map<string, Array<{ namespace: string; callable: string }>> {
	const groups = new Map<
		string,
		Array<{ namespace: string; callable: string }>
	>();
	for (const [namespace, tools] of Object.entries(catalog)) {
		for (const [toolName, meta] of Object.entries(tools)) {
			if (meta.aliasOf) continue;
			if (!isTediNativeInterfaceTool(meta)) continue;
			// Skill-workflow mirrors already collapse onto their platform
			// canonical callable; leave them to that machinery.
			if (mirroredSkillWorkflowSurface(namespace, toolName, meta)) continue;
			const list = groups.get(toolName) ?? [];
			list.push({ namespace, callable: meta.callable });
			groups.set(toolName, list);
		}
	}
	for (const [toolName, list] of groups) {
		if (list.length < 2) {
			groups.delete(toolName);
			continue;
		}
		list.sort((a, b) => {
			if (a.namespace === preferredNamespace) return -1;
			if (b.namespace === preferredNamespace) return 1;
			return a.namespace.localeCompare(b.namespace);
		});
	}
	return groups;
}

function callerTediNamespace(
	serverCtx: ServerContext,
	namespaceOverrides: Record<string, string> | undefined,
): string | undefined {
	const callerTediId = serverCtx.callerIdentity?.tediId;
	if (!callerTediId) return undefined;
	for (const [toolId, tool] of serverCtx.loadedTools) {
		const config = recordFrom(tool.config);
		if (config?._aggregateTediId !== callerTediId) continue;
		return projectedToolIdentity(toolId, tool, namespaceOverrides).namespace;
	}
	return undefined;
}

/**
 * Compact skill rows for discovery: the org library joins the one discovery
 * surface so a task query ("run measurement loop") surfaces the recorded
 * procedure above raw verbs, instead of requiring agents to already know the
 * skills.* namespace exists. Rows are summary-projected (never full SKILL.md)
 * and fetched lazily on the first ranked search of a request, cached per
 * ServerContext. Fetch failure degrades to tools-only discovery.
 */
interface SkillDiscoveryRow {
	kind: "skill";
	uri: string;
	slug: string;
	name: string;
	displayName: string;
	description: string;
	lifecycleState?: string;
	successCount?: number;
	load: string;
}

const skillDiscoveryRowsCache = new WeakMap<
	ServerContext,
	Promise<SkillDiscoveryRow[]>
>();

const SKILL_DISCOVERY_HIDDEN_LIFECYCLES = new Set(["stale", "archived"]);

function getSkillDiscoveryRows(
	serverCtx: ServerContext,
): Promise<SkillDiscoveryRow[]> {
	const cached = skillDiscoveryRowsCache.get(serverCtx);
	if (cached) return cached;
	const loaded = (async (): Promise<SkillDiscoveryRow[]> => {
		if (!serverCtx.apiClient?.skills?.listByOrg) return [];
		try {
			const result = await serverCtx.apiClient.skills.listByOrg({
				visibility: "org",
				summary: true,
				limit: 200,
			});
			const rows: SkillDiscoveryRow[] = [];
			for (const entry of result.entries ?? []) {
				const lifecycle = (entry as { lifecycleState?: string | null })
					.lifecycleState;
				if (lifecycle && SKILL_DISCOVERY_HIDDEN_LIFECYCLES.has(lifecycle)) {
					continue;
				}
				const slug = entry.slug ?? entry.id;
				rows.push({
					kind: "skill",
					uri: `skill://${slug}/SKILL.md`,
					slug,
					name: slug,
					displayName: entry.title,
					description:
						entry.description ??
						entry.summary ??
						entry.title ??
						"Recorded org skill.",
					...(lifecycle ? { lifecycleState: lifecycle } : {}),
					...(typeof entry.successCount === "number"
						? { successCount: entry.successCount }
						: {}),
					load: `skills.get_skills_for_mcp({ slug: ${JSON.stringify(slug)} })`,
				});
			}
			return rows;
		} catch (error) {
			console.warn(
				"[MCP] Skill discovery rows unavailable:",
				error instanceof Error ? error.message : error,
			);
			return [];
		}
	})();
	skillDiscoveryRowsCache.set(serverCtx, loaded);
	return loaded;
}

/**
 * Recorded procedures with a track record rank above unproven ones for the
 * same term match: proven/crystallized skills earned their place through the
 * promotion gate; active skills have shipped at least once.
 */
function skillLifecycleBoost(lifecycleState: string | undefined): number {
	if (lifecycleState === "proven" || lifecycleState === "crystallized")
		return 4;
	if (lifecycleState === "active") return 2;
	return 0;
}

/**
 * Top-level keys of a tool's result envelope, derived from its declared
 * outputSchema. A cold agent otherwise burns a call guessing the wrapper (e.g.
 * trying `items`/`rows` against a `{ data, pagination }` envelope). Names
 * only: the shapes stay behind includeOutputSchema, so this costs a few
 * tokens on the one entry a caller already asked to describe.
 */
function resultEnvelopeKeys(meta: CatalogToolEntry): string[] | undefined {
	const outputSchema = meta.outputSchema;
	if (!isRecord(outputSchema)) return undefined;
	const properties = outputSchema.properties;
	if (!isRecord(properties)) return undefined;
	const keys = Object.keys(properties);
	return keys.length > 0 ? keys.slice(0, 24) : undefined;
}

/**
 * Build a catalog provider — gives the LLM a searchable index of all tools
 * organized by namespace.
 */
export function buildCatalogProvider(
	serverCtx: ServerContext,
	namespaceOverrides: Record<string, string> | undefined,
	executionRefs?: CodeModeExecutionRefs,
	collisionKeys: ReadonlySet<string> = new Set(
		codeModeCollisionOwners(serverCtx, namespaceOverrides).keys(),
	),
): ToolProvider {
	const catalog: Record<string, Record<string, CatalogToolEntry>> = {};
	const catalogBuiltAt = new Date().toISOString();
	const preferredTediNamespace = callerTediNamespace(
		serverCtx,
		namespaceOverrides,
	);

	for (const [toolId, tool] of serverCtx.loadedTools) {
		const {
			namespace: ns,
			safeName,
			ownerKey,
		} = projectedToolIdentity(toolId, tool, namespaceOverrides);
		if (collisionKeys.has(ownerKey)) continue;
		if (!catalog[ns]) catalog[ns] = {};
		const paymentPolicy = getToolPaymentPolicy(tool);
		// Declared write capability folded onto the catalog's annotations, so
		// discover.search results classify the same way a raw tools/list entry
		// does (the Kernel write planner consumes both shapes).
		const wireAnnotations = resolveToolAnnotations({
			annotations: tool.annotations ?? null,
			writeCapability: tool.writeCapability ?? null,
			meta: tool.meta as Record<string, unknown> | null,
		});
		const paymentDescription = paymentPolicy
			? `\n\nPaid tool: ${paymentPolicy.amount} ${paymentPolicy.currency ?? "USDC"} on ${paymentPolicy.network}. If this call returns payment requirements, return that object directly from code; retry the outer code tool with _meta["x402/payment"] or the code tool's top-level payment argument.`
			: "";
		// Caller-relative authorization on every row through the same seam the
		// dispatch gates use — agents learn "discoverable but not executable"
		// from discovery instead of from a failed call.
		let authz:
			| { authorized: true }
			| {
					authorized: false;
					requiredScopes: string[];
					missingScopes: string[];
					scopeMappingMissing?: true;
			  };
		try {
			const authzDecision = evaluateMcpToolScopeAuthorization(
				serverCtx,
				tool,
				ns,
			);
			authz = authzDecision.authorized
				? { authorized: true }
				: {
						authorized: false,
						requiredScopes: authzDecision.requiredScopes,
						missingScopes: authzDecision.missingScopes,
					};
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!error.message.startsWith("Missing MCP capability mapping for tool:")
			) {
				throw error;
			}
			// A single unclassified tool is a configuration defect, not a reason to
			// take down discovery and every unrelated Code Mode call. Keep it visible
			// but fail closed until its capability policy is declared.
			authz = {
				authorized: false,
				requiredScopes: [],
				missingScopes: [],
				scopeMappingMissing: true,
			};
		}
		const primaryEntry = {
			...createCatalogToolEntry(ns, safeName, {
				name: tool.title ?? toolId,
				description: `${humanizeWeakDescription(tool.description, safeName)}${paymentDescription}`,
				parameters: withDestructiveApprovalSchema(tool, wireAnnotations),
				annotations: wireAnnotations,
				outputSchema: tool.outputSchema as
					| Record<string, unknown>
					| null
					| undefined,
				schemaFreshness: schemaFreshnessFromTool(tool),
			}),
			...authz,
		};
		catalog[ns][safeName] = primaryEntry;

		// SEAM B — dual-mount catalog entry under the peer alias namespace so
		// discover.search and discover.list_namespaces surface both forms.
		// The alias entry's `callable` field uses the alias namespace (e.g.
		// "app.list_apps") so the LLM can invoke it directly from the catalog.
		const catalogAliasNs = NAMESPACE_PEER_ALIASES.get(ns);
		if (catalogAliasNs !== undefined) {
			if (!catalog[catalogAliasNs]) catalog[catalogAliasNs] = {};
			if (!catalog[catalogAliasNs]![safeName]) {
				catalog[catalogAliasNs]![safeName] = {
					...createCatalogToolEntry(catalogAliasNs, safeName, {
						name: tool.title ?? toolId,
						description: `${humanizeWeakDescription(tool.description, safeName)}${paymentDescription}`,
						parameters: withDestructiveApprovalSchema(tool, wireAnnotations),
						annotations: wireAnnotations,
						outputSchema: tool.outputSchema as
							| Record<string, unknown>
							| null
							| undefined,
						schemaFreshness: schemaFreshnessFromTool(tool),
					}),
					...authz,
					aliasOf: ns,
				};
			}
		}
	}

	catalog[UI_NAMESPACE] = Object.fromEntries(
		Object.entries(UI_CATALOG_TOOLS).map(([toolName, meta]) => [
			toolName,
			createCatalogToolEntry(UI_NAMESPACE, toolName, meta),
		]),
	);
	catalog[CODEMODE_NAMESPACE] = Object.fromEntries(
		Object.entries(CODEMODE_CATALOG_TOOLS).map(([toolName, meta]) => [
			toolName,
			createCatalogToolEntry(CODEMODE_NAMESPACE, toolName, meta),
		]),
	);
	catalog[FLOW_NAMESPACE] = Object.fromEntries(
		Object.entries(FLOW_CATALOG_TOOLS).map(([toolName, meta]) => [
			toolName,
			createCatalogToolEntry(FLOW_NAMESPACE, toolName, meta),
		]),
	);

	const runners = Object.keys(catalog).filter(
		(namespace) =>
			catalog[namespace]?.run_skill_workflow &&
			catalog[namespace]?.run_skill_workflow.authorized !== false,
	);
	const dependencies = {
		record: Boolean(
			catalog.skills?.record_skills &&
			catalog.skills.record_skills.authorized !== false,
		),
		runners,
	};
	for (const [toolName, meta] of Object.entries(
		catalog[FLOW_NAMESPACE] ?? {},
	)) {
		meta.description +=
			toolName === "run"
				? ` Current dependencies: recorder ${dependencies.record ? "available" : "missing"}; runners ${runners.join(", ") || "none"}. A source draft requires the recorder and a runner; rerunning skillId requires only a runner.`
				: ` Current workflow runners: ${runners.join(", ") || "none"}.`;
	}

	const namespaces = Object.keys(catalog).sort();
	// Aliases resolve, never enumerate: pure-alias namespaces (every entry is a
	// SEAM B mirror) stay callable and namespace-filterable but are excluded
	// from enumeration surfaces — the summary, list_namespaces, and unfiltered
	// search/browse pages.
	const canonicalNamespaces = namespaces.filter((ns) => {
		const entries = Object.values(catalog[ns] ?? {});
		return entries.length === 0 || entries.some((entry) => !entry.aliasOf);
	});
	const namespaceSummary = canonicalNamespaces
		.map((ns) => `${ns} (${Object.keys(catalog[ns] ?? {}).length} tools)`)
		.join(", ");

	return {
		name: "discover",
		tools: {
			search: {
				description: `Search tool catalog across ${canonicalNamespaces.length} namespaces: ${namespaceSummary}. Returns { results, namespaces, meta }: ranked rows with callable, namespace, tool, display name, description, schemaFreshness, and _match evidence; meta carries pagination, freshness, and discovery hints. Rows carry caller-relative authorization: authorized: false with requiredScopes/missingScopes means discoverable but not executable for THIS caller — do not call it, and do not treat its absence from your grants as a platform outage. Results are compact by default: long descriptions are truncated (descriptionTruncated: true) and schemas are omitted. Pass { namespace } to restrict results to one namespace (an unknown namespace throws an error naming the nearest namespaces, never a silent no-op). Ranked results include RECORDED ORG SKILLS (kind: "skill") alongside tools — a skill row carries a skill:// uri and a load expression (e.g. skills.get_skills_for_mcp({ slug })) that fetches the full procedure; prefer a matching skill over reconstructing the procedure from raw tools. The cheap flow is: search with a small limit, then discover.describe(callable) for the ONE exact schema and full description you need, then call it — prefer that over includeParameters on a broad search (schema-bearing searches default to a page of ${SCHEMA_DISCOVERY_DEFAULT_LIMIT}). Execute the callable value exactly, for example namespace.tool(args).`,
				execute: async (query: unknown) => {
					const {
						includeParameters,
						includeOutputSchema,
						limit,
						offset,
						query: q,
						namespace: namespaceFilter,
					} = normalizeDiscoverySearchInput(query);
					if (executionRefs) {
						executionRefs.discoverCalls += 1;
						if (includeParameters || includeOutputSchema) {
							executionRefs.discoverParameterRequests += 1;
						}
					}
					const freshnessMeta = catalogFreshnessMeta(catalog, catalogBuiltAt);
					// A namespace filter is either honored or explicitly rejected —
					// never silently ignored (agents cannot distinguish a dropped
					// argument from an empty catalog). This throws rather than
					// returning an annotated empty page because expando props on the
					// result array (_meta and friends) are stripped at the sandbox
					// RPC boundary — an error is the only rejection the caller sees.
					if (namespaceFilter && !catalog[namespaceFilter]) {
						const nearest = nearestCatalogNamespaces(namespaceFilter, catalog)
							.slice(0, 3)
							.map((entry) => entry.namespace)
							.join(", ");
						throw new Error(
							`Unknown namespace "${namespaceFilter}" for discover.search.${nearest ? ` Nearest namespaces: ${nearest}.` : ""} Use discover.list_namespaces() to enumerate valid namespaces.`,
						);
					}
					const searchCatalog = namespaceFilter
						? { [namespaceFilter]: catalog[namespaceFilter] ?? {} }
						: catalog;
					if (!q)
						return paginateCatalog(
							searchCatalog,
							limit,
							offset,
							includeParameters,
							includeOutputSchema,
							{
								freshness: freshnessMeta,
								...(namespaceFilter
									? {
											discovery: { namespace: namespaceFilter, mode: "browse" },
										}
									: {}),
							},
							Boolean(namespaceFilter),
							preferredTediNamespace,
						);

					const rankedByCallable = new Map<string, CatalogPageEntry>();
					const tediOwners = workflowTediOwners(searchCatalog);
					// Role-verb collapse applies only to unfiltered ranking; an
					// explicit { namespace } filter shows that worker's own rows.
					const roleGroups = namespaceFilter
						? null
						: tediNativeInterfaceGroups(searchCatalog, preferredTediNamespace);
					const terms = normalizeSearchTerms(q);
					for (const [ns, tools] of Object.entries(searchCatalog)) {
						for (const [name, meta] of Object.entries(tools)) {
							// Alias mirrors enumerate only under an explicit filter on
							// their own namespace; unfiltered ranking shows the canonical
							// entry once.
							if (meta.aliasOf && ns !== namespaceFilter) continue;
							const roleGroup = roleGroups?.get(name);
							const isGroupedRoleVerb =
								roleGroup !== undefined && isTediNativeInterfaceTool(meta);
							if (isGroupedRoleVerb && ns !== roleGroup[0]!.namespace) {
								continue;
							}
							const match = scoreCatalogSearch(terms, ns, name, meta);
							if (!match) continue;
							const mirror = mirroredSkillWorkflowSurface(ns, name, meta);
							const canonical = mirror
								? splitCallable(mirror.canonicalCallable)
								: { namespace: ns, tool: name };
							const canonicalMeta =
								catalog[canonical.namespace]?.[canonical.tool];
							// A mirror is collapsed only when its canonical callable is mounted.
							// Otherwise keep the directly executable owner result.
							const targetMeta = canonicalMeta ?? meta;
							const targetNamespace = canonicalMeta ? canonical.namespace : ns;
							const targetTool = canonicalMeta ? canonical.tool : name;
							const callable = targetMeta.callable;
							const prior = rankedByCallable.get(callable);
							const priorMatch = recordFrom(prior?.meta)?._match as
								| CatalogSearchMatch
								| undefined;
							if (priorMatch && priorMatch.score >= match.score) continue;
							const groupOwners = isGroupedRoleVerb
								? roleGroup!.filter((owner) => owner.namespace !== ns)
								: undefined;
							rankedByCallable.set(callable, {
								namespace: targetNamespace,
								tool: targetTool,
								meta: {
									...targetMeta,
									...(tediOwners.get(callable)
										? { equivalentTediOwners: tediOwners.get(callable) }
										: groupOwners && groupOwners.length > 0
											? { equivalentTediOwners: groupOwners }
											: {}),
									_match: match,
								},
							});
						}
					}
					const rankedEntries = [...rankedByCallable.values()];
					// Recorded org skills rank alongside tools in unfiltered search:
					// a task query surfaces the procedure, not just the verbs.
					if (!namespaceFilter) {
						const skillRows = await getSkillDiscoveryRows(serverCtx);
						for (const row of skillRows) {
							const match = scoreCatalogSearch(terms, "skills", row.slug, {
								callable: "skills.get_skills_for_mcp",
								namespace: "skills",
								tool: row.slug,
								name: row.displayName,
								displayName: row.displayName,
								description: row.description,
								parameters: {},
							} as CatalogToolEntry);
							if (!match) continue;
							rankedEntries.push({
								namespace: "skills",
								tool: row.slug,
								meta: {
									...row,
									_match: {
										...match,
										score:
											match.score + skillLifecycleBoost(row.lifecycleState),
									},
								},
							});
						}
					}
					// Lexical relevance forms the compact authorized shortlist before
					// the paid semantic judgment. Explicit namespace filters obey the
					// same ranking rule as unfiltered discovery.
					rankedEntries.sort((a, b) => {
						const aMatch = recordFrom(a.meta)?._match as
							| CatalogSearchMatch
							| undefined;
						const bMatch = recordFrom(b.meta)?._match as
							| CatalogSearchMatch
							| undefined;
						const delta = (bMatch?.score ?? 0) - (aMatch?.score ?? 0);
						if (delta !== 0) return delta;
						return a.namespace === b.namespace
							? a.tool.localeCompare(b.tool)
							: a.namespace.localeCompare(b.namespace);
					});
					const rankDiscovery: DiscoveryRanker | undefined =
						serverCtx.apiClient?.cognitiveRuntime?.rankDiscovery;
					const reranked = await rerankDiscoveryShortlist(
						rankedEntries,
						q,
						serverCtx.app?.organizationId ||
							serverCtx.callerIdentity?.organizationId
							? rankDiscovery
							: undefined,
					);
					return paginateCatalogEntries(
						reranked.entries,
						limit,
						offset,
						includeParameters,
						includeOutputSchema,
						{
							freshness: freshnessMeta,
							discovery: {
								query: q,
								terms,
								mode: rankedEntries.length > 0 ? "ranked" : "empty",
								order: reranked.usedJev ? "jev" : "lexical",
								...(namespaceFilter ? { namespace: namespaceFilter } : {}),
								nearestNamespaces: nearestCatalogNamespaces(q, catalog),
								suggestedQueries: suggestedCatalogQueries(terms, catalog),
							},
						},
					);
				},
			},
			describe: {
				description:
					'Fetch ONE tool\'s full definition — exact JSON Schema parameters, outputSchema, annotations, schemaFreshness — by its exact callable (e.g. { callable: "work.list_work_items" }). This is the cheap second step after a compact search: one small result instead of schema-bearing search pages. `resultEnvelopeKeys` names the top-level keys the result is wrapped in (e.g. ["data","pagination"]) so you do not have to guess the envelope. Throws a current-catalog diagnostic when the callable is not exposed; re-run discover.search to correct the name.',
				execute: async (input: unknown) => {
					if (executionRefs) {
						executionRefs.discoverCalls += 1;
						executionRefs.discoverParameterRequests += 1;
					}
					const record = recordFrom(input);
					const callable =
						typeof input === "string"
							? input
							: typeof record?.callable === "string"
								? record.callable
								: "";
					const dot = callable.indexOf(".");
					if (dot <= 0)
						throw new Error(
							`discover.describe requires an exact namespace.tool callable, received ${JSON.stringify(callable)}`,
						);
					const ns = callable.slice(0, dot);
					const tool = callable.slice(dot + 1);
					const meta = catalog[ns]?.[tool];
					if (!meta)
						throw new Error(
							`Callable ${JSON.stringify(callable)} is not exposed in the current gateway catalog. This does not establish missing organization membership or upstream authentication. Nearest namespaces: ${
								nearestCatalogNamespaces(ns, catalog)
									.map((entry) => entry.namespace)
									.join(", ") || "none"
							}. Use discover.search({ query: ${JSON.stringify(tool)}, limit: 3 }) on this gateway.`,
						);
					// Full projection on purpose: this is the one entry the caller
					// asked for, so the heavy schema blobs and the untruncated
					// description are the payload, not waste.
					const described = projectCatalogMeta(meta, true, true, true);
					const envelopeKeys = resultEnvelopeKeys(meta);
					return envelopeKeys && isRecord(described)
						? { ...described, resultEnvelopeKeys: envelopeKeys }
						: described;
				},
			},
			list_namespaces: {
				description:
					"List available namespaces as an object keyed by namespace, with tool counts as values. Canonical namespaces only: peer aliases (see governance.aliases) still resolve for calls and namespace-filtered search but are not enumerated as separate entries. Use Object.keys/Object.entries to filter it. Pass { includeTools: true } only for debugging; use discover.search() to find tools.",
				execute: async (input: unknown) => {
					const includeTools =
						recordFrom(input)?.includeTools === true ||
						recordFrom(input)?.includeToolNames === true;
					return Object.fromEntries(
						canonicalNamespaces.map((ns) => [
							ns,
							{
								tools: Object.keys(catalog[ns] ?? {}).length,
								governance: namespaceGovernanceFor(ns),
								...(includeTools
									? { toolNames: Object.keys(catalog[ns] ?? {}) }
									: {}),
							},
						]),
					);
				},
			},
		},
		types: [
			"declare namespace discover {",
			"  /** Search tools by keyword. Returns a plain object { results, namespaces, meta }: results is the ranked row array, namespaces groups the same rows by namespace, meta carries pagination/freshness/discovery. (A plain object on purpose — expando props on arrays are stripped at the sandbox boundary.) Compact by default: parameters and outputSchema are omitted unless you pass includeParameters/includeOutputSchema, and long descriptions are truncated (descriptionTruncated: true — discover.describe returns the full text). Pass namespace to restrict results to one namespace; an unknown namespace throws an error naming the nearest namespaces. Ranked results also include recorded org skills (kind: 'skill', skill:// uri, load expression) — prefer a matching skill over reconstructing the procedure from raw tools. Execute the returned callable value exactly; name/displayName are labels only. Use schemaFreshness/meta.freshness to diagnose stale schemas, and use _match/meta.discovery before declaring a capability unavailable. */",
			"  function search(query: string | { query?: string; namespace?: string; limit?: number; offset?: number; includeParameters?: boolean; includeOutputSchema?: boolean }): Promise<{ results: Array<{ callable: string; namespace: string; tool: string; name: string; displayName: string; description: string; descriptionTruncated?: boolean; parameters?: Record<string, unknown>; annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }; outputSchema?: Record<string, unknown>; schemaFreshness?: { dialect?: string; source?: string; sourceRef?: string; sourceHash?: string; syncedAt?: string; toolUpdatedAt?: string }; equivalentTediOwners?: Array<{ namespace: string; callable: string }>; aliasOf?: string; authorized?: boolean; requiredScopes?: string[]; missingScopes?: string[]; kind?: 'skill'; uri?: string; load?: string; lifecycleState?: string; successCount?: number; _match?: { score: number; matchedTerms: string[]; unmatchedTerms: string[] } }>; namespaces: Record<string, Record<string, { callable: string; namespace: string; tool: string; name: string; displayName: string; description: string; descriptionTruncated?: boolean; parameters?: Record<string, unknown>; annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }; outputSchema?: Record<string, unknown>; schemaFreshness?: { dialect?: string; source?: string; sourceRef?: string; sourceHash?: string; syncedAt?: string; toolUpdatedAt?: string }; equivalentTediOwners?: Array<{ namespace: string; callable: string }>; aliasOf?: string; authorized?: boolean; requiredScopes?: string[]; missingScopes?: string[]; kind?: 'skill'; uri?: string; load?: string; lifecycleState?: string; successCount?: number; _match?: { score: number; matchedTerms: string[]; unmatchedTerms: string[] } }>>; meta: { pagination: { limit: number; offset: number; total: number }; freshness?: { catalogBuiltAt: string; toolCount: number; namespaceCount: number; schemaSyncedTools: number; unsyncedTools: number; newestSchemaSyncedAt?: string; oldestSchemaSyncedAt?: string }; discovery?: { query: string; terms: string[]; mode: string; order?: 'jev' | 'lexical'; namespace?: string; nearestNamespaces: Array<{ namespace: string; score: number; tools: number; sampleTools: string[] }>; suggestedQueries: string[] } } }>;",
			"  /** List all namespaces as an object keyed by namespace, with counts as values. Use Object.keys/Object.entries to filter it. Tool names are omitted unless includeTools is true; prefer search for normal discovery. */",
			"  /** Fetch ONE tool's full definition (parameters, outputSchema, annotations, schemaFreshness) by exact callable. The cheap second step after a compact search — prefer this over includeParameters on a broad search. Throws a current-catalog recovery diagnostic for an unknown callable. */",
			"  function describe(input: string | { callable: string }): Promise<{ callable: string; namespace: string; tool: string; name: string; displayName: string; description: string; resultEnvelopeKeys?: string[]; parameters?: Record<string, unknown>; outputSchema?: Record<string, unknown>; annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }; schemaFreshness?: { dialect?: string; source?: string; sourceRef?: string; sourceHash?: string; syncedAt?: string; toolUpdatedAt?: string } }>;",
			'  function list_namespaces(input?: { includeTools?: boolean }): Promise<Record<string, { tools: number; toolNames?: string[]; governance: { owner: string; class: "discovery" | "host" | "platform" | "tenant_app" | "virtual_tedi"; aliases: readonly string[]; requiredScopes: readonly string[]; visibility: "internal" | "tenant"; freshness: "build" | "request" | "d1_config"; collisionPolicy: "reserved_wins" | "reject_duplicate" } }>>;',
			"}",
		].join("\n"),
	};
}

function pickCatalogAnnotations(
	annotations: unknown,
): CatalogToolAnnotations | undefined {
	if (
		!annotations ||
		typeof annotations !== "object" ||
		Array.isArray(annotations)
	) {
		return undefined;
	}
	const a = annotations as Record<string, unknown>;
	const picked: CatalogToolAnnotations = {};
	if (typeof a.destructiveHint === "boolean")
		picked.destructiveHint = a.destructiveHint;
	if (typeof a.readOnlyHint === "boolean") picked.readOnlyHint = a.readOnlyHint;
	if (typeof a.idempotentHint === "boolean")
		picked.idempotentHint = a.idempotentHint;
	if (typeof a.openWorldHint === "boolean")
		picked.openWorldHint = a.openWorldHint;
	return Object.keys(picked).length > 0 ? picked : undefined;
}

function createCatalogToolEntry(
	namespace: string,
	tool: string,
	meta: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
		annotations?: unknown;
		outputSchema?: Record<string, unknown> | null;
		schemaFreshness?: CatalogSchemaFreshness;
	},
): CatalogToolEntry {
	const callable = `${namespace}.${tool}`;
	const annotations = pickCatalogAnnotations(meta.annotations);
	const outputSchema =
		meta.outputSchema && typeof meta.outputSchema === "object"
			? meta.outputSchema
			: undefined;
	const schemaFreshness =
		meta.schemaFreshness && Object.keys(meta.schemaFreshness).length > 0
			? meta.schemaFreshness
			: undefined;
	return {
		callable,
		namespace,
		tool,
		name: meta.name,
		displayName: meta.name,
		description: meta.description,
		parameters: meta.parameters,
		...(annotations && { annotations }),
		...(outputSchema && { outputSchema }),
		...(schemaFreshness && { schemaFreshness }),
	};
}

function schemaFreshnessFromTool(tool: AppTool): CatalogSchemaFreshness {
	return {
		...(tool.schemaDialect ? { dialect: tool.schemaDialect } : {}),
		...(tool.schemaSource ? { source: tool.schemaSource } : {}),
		...(tool.schemaSourceRef ? { sourceRef: tool.schemaSourceRef } : {}),
		...(tool.schemaSourceHash ? { sourceHash: tool.schemaSourceHash } : {}),
		...(tool.schemaSyncedAt ? { syncedAt: tool.schemaSyncedAt } : {}),
		...(tool.updatedAt ? { toolUpdatedAt: tool.updatedAt } : {}),
	};
}

function catalogFreshnessMeta(
	catalog: Record<string, Record<string, CatalogToolEntry>>,
	catalogBuiltAt: string,
) {
	const tools = Object.values(catalog).flatMap((namespaceTools) =>
		Object.values(namespaceTools),
	);
	const syncedAtValues = tools
		.map((tool) => tool.schemaFreshness?.syncedAt)
		.filter((value): value is string => typeof value === "string" && !!value)
		.sort();
	return {
		catalogBuiltAt,
		toolCount: tools.length,
		namespaceCount: Object.keys(catalog).length,
		schemaSyncedTools: syncedAtValues.length,
		unsyncedTools: tools.length - syncedAtValues.length,
		...(syncedAtValues[0] ? { oldestSchemaSyncedAt: syncedAtValues[0] } : {}),
		...(syncedAtValues.at(-1)
			? { newestSchemaSyncedAt: syncedAtValues.at(-1) }
			: {}),
	};
}

function normalizeDiscoverySearchInput(input: unknown): {
	includeParameters: boolean;
	includeOutputSchema: boolean;
	limit: number;
	offset: number;
	query: string;
	namespace: string;
} {
	const record = recordFrom(input);
	const rawLimit = record?.limit;
	const rawOffset = record?.offset;
	const includeParameters = record?.includeParameters === true;
	// outputSchema blobs dominate discovery payload size (full JSON Schema per
	// tool); keep them out of the default response so casual discovery stays
	// lean and survives client-side truncation. Opt in with
	// { includeOutputSchema: true } when planning downstream composition.
	const includeOutputSchema = record?.includeOutputSchema === true;
	return {
		query: (typeof input === "string"
			? input
			: typeof record?.query === "string"
				? record.query
				: ""
		).trim(),
		includeParameters,
		includeOutputSchema,
		namespace:
			typeof record?.namespace === "string" ? record.namespace.trim() : "",
		limit: clampCatalogNumber(
			typeof rawLimit === "number"
				? rawLimit
				: includeParameters || includeOutputSchema
					? SCHEMA_DISCOVERY_DEFAULT_LIMIT
					: DEFAULT_DISCOVERY_LIMIT,
			1,
			MAX_DISCOVERY_LIMIT,
		),
		offset: clampCatalogNumber(
			typeof rawOffset === "number" ? rawOffset : 0,
			0,
		),
	};
}

function clampCatalogNumber(
	value: number,
	min: number,
	max = Number.MAX_SAFE_INTEGER,
) {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

function paginateCatalog(
	catalog: Record<string, Record<string, CatalogToolEntry>>,
	limit: number,
	offset: number,
	includeParameters: boolean,
	includeOutputSchema: boolean,
	extraMeta?: Record<string, unknown>,
	keepAliasEntries = false,
	preferredTediNamespace?: string,
): CatalogDiscoveryResult {
	const tediOwners = workflowTediOwners(catalog);
	// keepAliasEntries doubles as the "explicitly namespace-filtered" signal:
	// filtered browsing shows a worker's own rows; unfiltered browsing
	// collapses repeated role verbs onto one representative row.
	const roleGroups = keepAliasEntries
		? null
		: tediNativeInterfaceGroups(catalog, preferredTediNamespace);
	const entries = Object.entries(catalog)
		.flatMap(([namespace, tools]) =>
			Object.entries(tools).flatMap(([tool, meta]) => {
				if (meta.aliasOf && !keepAliasEntries) return [];
				const roleGroup = roleGroups?.get(tool);
				const isGroupedRoleVerb =
					roleGroup !== undefined && isTediNativeInterfaceTool(meta);
				if (isGroupedRoleVerb && namespace !== roleGroup[0]!.namespace) {
					return [];
				}
				const mirror = mirroredSkillWorkflowSurface(namespace, tool, meta);
				if (mirror) {
					const canonical = splitCallable(mirror.canonicalCallable);
					if (catalog[canonical.namespace]?.[canonical.tool]) return [];
				}
				const groupOwners = isGroupedRoleVerb
					? roleGroup!.filter((owner) => owner.namespace !== namespace)
					: undefined;
				return [
					{
						namespace,
						tool,
						meta: {
							...meta,
							...(tediOwners.get(meta.callable)
								? {
										equivalentTediOwners: tediOwners.get(meta.callable),
									}
								: groupOwners && groupOwners.length > 0
									? { equivalentTediOwners: groupOwners }
									: {}),
						},
					},
				];
			}),
		)
		.sort((a, b) =>
			a.namespace === b.namespace
				? a.tool.localeCompare(b.tool)
				: a.namespace.localeCompare(b.namespace),
		);
	return paginateCatalogEntries(
		entries,
		limit,
		offset,
		includeParameters,
		includeOutputSchema,
		extraMeta,
	);
}

function paginateCatalogEntries(
	entries: CatalogPageEntry[],
	limit: number,
	offset: number,
	includeParameters: boolean,
	includeOutputSchema: boolean,
	extraMeta?: Record<string, unknown>,
): CatalogDiscoveryResult {
	const page = entries.slice(offset, offset + limit);
	const resultsArray: unknown[] = [];
	const namespaceMaps: Record<string, unknown> = {};
	for (const entry of page) {
		const projected = projectCatalogMeta(
			entry.meta,
			includeParameters,
			includeOutputSchema,
		);
		const namespaceTools = recordFrom(namespaceMaps[entry.namespace]) ?? {};
		namespaceTools[entry.tool] = projected;
		namespaceMaps[entry.namespace] = namespaceTools;
		// Flat ranked array for model-natural iteration and slicing.
		resultsArray.push(projected);
	}
	return createCatalogDiscoveryResult(resultsArray, namespaceMaps, {
		pagination: {
			limit,
			offset,
			total: entries.length,
		},
		...extraMeta,
	});
}

interface CatalogDiscoveryResult {
	results: unknown[];
	namespaces: Record<string, unknown>;
	meta: Record<string, unknown>;
}

/**
 * Plain-object result on purpose. The previous shape was a decorated array
 * (expando `results`/`_meta`/per-namespace props on the ranked array), but
 * structured clone at the sandbox RPC boundary strips expando properties from
 * arrays — sandbox code received a bare array and every documented meta
 * property was silently undefined. A plain object survives the boundary
 * intact, so the declared types are finally honest.
 */
function createCatalogDiscoveryResult(
	resultsArray: unknown[],
	namespaceMaps: Record<string, unknown>,
	meta: Record<string, unknown>,
): CatalogDiscoveryResult {
	return { results: resultsArray, namespaces: namespaceMaps, meta };
}

/**
 * Project a catalog entry for the discovery wire: strip the heavy
 * `parameters` (full input JSON Schema) and `outputSchema` blobs unless the
 * caller explicitly opted into each. Both default off so casual discovery
 * stays compact and survives client-side truncation — callers add
 * { includeParameters: true } / { includeOutputSchema: true } when they need
 * exact schemas to plan a call or downstream composition.
 */
function projectCatalogMeta(
	meta: unknown,
	includeParameters: boolean,
	includeOutputSchema: boolean,
	fullDescription = false,
): unknown {
	if (!isRecord(meta)) return meta;
	const { parameters, outputSchema, ...rest } = meta;
	const compacted =
		!fullDescription && typeof rest.description === "string"
			? compactDiscoveryDescription(rest.description)
			: null;
	return {
		...rest,
		...(compacted ? compacted : {}),
		...(includeParameters ? { parameters } : {}),
		...(includeOutputSchema ? { outputSchema } : {}),
	};
}

/**
 * Search rows carry a bounded description: the full text (vendor tools ship
 * multi-KB REST doc dumps) is one discover.describe(callable) away, and
 * ranking already ran against the full text. The paid-tool notice appended by
 * buildCatalogProvider survives truncation verbatim — it changes how the call
 * must be made, so it must never be cut.
 */
function compactDiscoveryDescription(
	description: string,
): { description: string; descriptionTruncated: true } | null {
	if (description.length <= DISCOVERY_DESCRIPTION_BUDGET) return null;
	const paidIndex = description.indexOf("\n\nPaid tool: ");
	const head = paidIndex >= 0 ? description.slice(0, paidIndex) : description;
	const tail = paidIndex >= 0 ? description.slice(paidIndex) : "";
	if (head.length <= DISCOVERY_DESCRIPTION_BUDGET) return null;
	const cut = head.slice(0, DISCOVERY_DESCRIPTION_BUDGET);
	const lastSpace = cut.lastIndexOf(" ");
	const trimmed = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd();
	return {
		description: `${trimmed}…${tail}`,
		descriptionTruncated: true,
	};
}

function scoreCatalogSearch(
	terms: string[],
	namespace: string,
	toolName: string,
	meta: CatalogToolEntry,
): CatalogSearchMatch | null {
	if (terms.length === 0) {
		return { score: 1, matchedTerms: [], unmatchedTerms: [] };
	}
	const fields = [
		// Namespace is the highest-signal field, but a substring-only hit (e.g. the
		// query "tedi" inside the tenant suffix "tedix" across ~40 external app
		// namespaces) used to win at full weight and drown real results. So a
		// full-TOKEN namespace match keeps 14, while a substring-only match is
		// demoted below toolName (12) via `substringWeight`.
		{ text: namespace, weight: 14, substringWeight: 6 },
		{ text: toolName, weight: 12 },
		{ text: meta.callable, weight: 10 },
		{ text: meta.name, weight: 8 },
		{ text: meta.displayName, weight: 8 },
		{ text: meta.description, weight: 4 },
		{ text: JSON.stringify(meta.parameters), weight: 1 },
	].map((field) => ({ ...field, text: normalizeSearchText(field.text ?? "") }));
	let score = 0;
	const matchedTerms: string[] = [];
	const unmatchedTerms: string[] = [];
	for (const term of terms) {
		const variants = searchTermVariants(term);
		const best = fields.reduce((max, field) => {
			let fieldWeight = 0;
			for (const variant of variants) {
				if (!field.text.includes(variant)) continue;
				if (field.substringWeight !== undefined) {
					// Tokenized field: a full-token (whole word) match earns the full
					// weight; a mere substring earns the reduced substringWeight.
					const tokens = field.text.split(/[^a-z0-9]+/).filter(Boolean);
					const fullToken = tokens.includes(variant);
					fieldWeight = Math.max(
						fieldWeight,
						fullToken ? field.weight : field.substringWeight,
					);
				} else {
					fieldWeight = Math.max(fieldWeight, field.weight);
				}
			}
			return Math.max(max, fieldWeight);
		}, 0);
		if (best > 0) {
			score += best;
			matchedTerms.push(term);
		} else {
			unmatchedTerms.push(term);
		}
	}
	if (matchedTerms.length === 0) return null;
	score += Math.round((matchedTerms.length / terms.length) * 20);
	return { score, matchedTerms, unmatchedTerms };
}

function searchTermVariants(term: string): string[] {
	const variants = new Set([term]);
	if (term.length > 4 && term.endsWith("s")) variants.add(term.slice(0, -1));
	if (term.length > 4 && term.endsWith("ies")) {
		variants.add(`${term.slice(0, -3)}y`);
	}
	return [...variants];
}

function nearestCatalogNamespaces(
	query: string,
	catalog: Record<string, Record<string, CatalogToolEntry>>,
): Array<{
	namespace: string;
	score: number;
	tools: number;
	sampleTools: string[];
}> {
	const terms = normalizeSearchTerms(query);
	return Object.entries(catalog)
		.map(([namespace, tools]) => {
			let score = 0;
			for (const [toolName, meta] of Object.entries(tools)) {
				const match = scoreCatalogSearch(terms, namespace, toolName, meta);
				score = Math.max(score, match?.score ?? 0);
			}
			if (score === 0) {
				score = fuzzyNamespaceScore(terms, namespace, Object.keys(tools));
			}
			return {
				namespace,
				score,
				tools: Object.keys(tools).length,
				sampleTools: Object.keys(tools).slice(0, 5),
			};
		})
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.namespace.localeCompare(b.namespace))
		.slice(0, 8);
}

function fuzzyNamespaceScore(
	terms: string[],
	namespace: string,
	toolNames: string[],
): number {
	const candidates = normalizeSearchText([namespace, ...toolNames].join(" "))
		.split(" ")
		.filter(Boolean);
	let score = 0;
	for (const term of terms) {
		const best = candidates.reduce(
			(min, candidate) => Math.min(min, editDistance(term, candidate)),
			Number.POSITIVE_INFINITY,
		);
		if (best <= 2) score += 2 - best + 1;
	}
	return score;
}

function editDistance(left: string, right: string): number {
	const previous = Array.from({ length: right.length + 1 }, (_, i) => i);
	for (let i = 1; i <= left.length; i++) {
		const current = [i];
		for (let j = 1; j <= right.length; j++) {
			const cost = left[i - 1] === right[j - 1] ? 0 : 1;
			current[j] = Math.min(
				current[j - 1]! + 1,
				previous[j]! + 1,
				previous[j - 1]! + cost,
			);
		}
		for (let j = 0; j < current.length; j++) previous[j] = current[j]!;
	}
	return previous[right.length] ?? 0;
}

function suggestedCatalogQueries(
	terms: string[],
	catalog: Record<string, Record<string, CatalogToolEntry>>,
): string[] {
	const namespaceTerms = new Set<string>();
	for (const namespace of Object.keys(catalog)) {
		for (const term of normalizeSearchTerms(namespace))
			namespaceTerms.add(term);
	}
	const shared = terms.filter((term) => namespaceTerms.has(term)).slice(0, 3);
	return Array.from(
		new Set([
			...(shared.length > 0 ? [shared.join(" ")] : []),
			terms.slice(0, 3).join(" "),
			terms.slice(-3).join(" "),
		]),
	).filter(Boolean);
}

function normalizeSearchTerms(query: string): string[] {
	return Array.from(new Set(normalizeSearchText(query).split(" "))).filter(
		Boolean,
	);
}

function normalizeSearchText(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function buildUiProvider(serverCtx: ServerContext): ToolProvider {
	return {
		name: UI_NAMESPACE,
		tools: {
			get_catalog: {
				description: UI_CATALOG_TOOLS.get_catalog.description,
				execute: async (input: unknown) => codeModeUiCatalog(input),
			},
			create_view: {
				description: UI_CATALOG_TOOLS.create_view.description,
				execute: async (input: unknown) =>
					createCodeModeUiView(serverCtx, normalizeUiViewInput(input)),
			},
			create_mcp_app: {
				description: UI_CATALOG_TOOLS.create_mcp_app.description,
				execute: async (input: unknown) =>
					createCodeModeMcpApp(serverCtx, normalizeUiMcpAppInput(input)),
			},
			create_health_sweep: {
				description: UI_CATALOG_TOOLS.create_health_sweep.description,
				execute: async (input: unknown) =>
					createCodeModeHealthSweep(
						serverCtx,
						normalizeUiHealthSweepInput(input),
					),
			},
			validate_layout: {
				description: UI_CATALOG_TOOLS.validate_layout.description,
				execute: async (input: unknown) => {
					const args = recordFrom(input) ?? {};
					return normalizeJsonRenderLayoutSpec(args.layoutSpec);
				},
			},
		},
		types: UI_PROVIDER_TYPES,
	};
}

const DEFAULT_UI_CATALOG_COMPONENTS = [
	"Stack",
	"Grid",
	"SectionHeader",
	"Text",
	"Badge",
	"DataTable",
	"DataChart",
	"StatGrid",
	"KeyValuePanel",
	"BarList",
	"StatusTimeline",
	"AnswerBlock",
] as const;

function codeModeUiCatalog(input: unknown): Record<string, unknown> {
	const rawComponents = recordFrom(input)?.components;
	const requested = Array.isArray(rawComponents)
		? rawComponents.filter(
				(value): value is string => typeof value === "string",
			)
		: [];
	const selected = requested.length
		? requested
		: [...DEFAULT_UI_CATALOG_COMPONENTS];
	const allowed = new Set<string>(LAYOUT_CATALOG_COMPONENTS);
	const componentDefinitions = selected
		.filter(
			(name, index, names) =>
				allowed.has(name) && names.indexOf(name) === index,
		)
		.slice(0, 12)
		.map((name) =>
			LAYOUT_CATALOG_PROMPT.split("\n").find((line) =>
				line.startsWith(`- ${name}:`),
			),
		)
		.filter((line): line is string => Boolean(line));
	return {
		components: [...LAYOUT_CATALOG_COMPONENTS],
		componentDefinitions,
		actions: [...LAYOUT_CATALOG_ACTIONS],
		schema: LAYOUT_CATALOG_JSON_SCHEMA,
		rules: [
			"Every spec has root and elements; every element has type, props, and children.",
			"Use only the returned component and action names.",
			"Put runtime values in data and bind them with $state JSON pointers instead of duplicating them in props.",
			"Every child key and named-slot key must resolve to an element.",
			"Use repeat for state-backed arrays and keep on, visible, repeat, and slots beside props rather than inside it.",
			"Call ui.validate_layout({ layoutSpec }) before ui.create_view({ layoutSpec, data, ... }).",
		],
	};
}

function buildRuntimeProvider(
	serverCtx: ServerContext,
	executionRefs: CodeModeExecutionRefs,
	getCounts: () => {
		modules: string[];
		namespaceCount: number;
		toolCount: number;
	},
): ToolProvider {
	return {
		name: CODEMODE_NAMESPACE,
		tools: {
			__runtime: {
				description: CODEMODE_CATALOG_TOOLS.__runtime.description,
				execute: async () => {
					const executionId = executionRefs.executionId ?? null;
					const counts = getCounts();
					const userId = serverCtx.callerIdentity?.userId ?? null;
					const tediId = serverCtx.callerIdentity?.tediId ?? null;
					const externalAgentPrincipalId =
						serverCtx.callerIdentity?.externalAgentPrincipalId ?? null;
					const externalAgentSessionId =
						serverCtx.callerIdentity?.externalAgentSessionId ?? null;
					const participantIds = [
						tediId,
						externalAgentPrincipalId,
						userId,
					].filter(
						(value): value is string =>
							typeof value === "string" && value.length > 0,
					);
					return {
						mode: "stateless" as const,
						surface: "mcp-gateway" as const,
						executionId,
						appId: serverCtx.appId,
						appSlug: serverCtx.appSlug,
						organizationId: serverCtx.app.organizationId ?? null,
						traceId: serverCtx.traceId,
						actor: {
							authType: serverCtx.callerIdentity?.authType ?? "anonymous",
							userId,
							tediId,
							clientId: serverCtx.callerIdentity?.clientId ?? null,
							externalAgentPrincipalId,
							externalAgentSessionId,
							externalAgentHarness:
								serverCtx.callerIdentity?.externalAgentHarness ?? null,
							externalAgentModel:
								serverCtx.callerIdentity?.externalAgentModel ?? null,
						},
						toolCount: counts.toolCount,
						namespaceCount: counts.namespaceCount,
						modules: counts.modules,
						executionSurface: {
							kind: "mcp-gateway" as const,
							surfaceId: `mcp-gateway:${serverCtx.appId}`,
							sessionIds: [externalAgentSessionId, executionId].filter(
								(value): value is string => Boolean(value),
							),
							participantIds,
						},
					};
				},
			},
		},
		types: CODEMODE_PROVIDER_TYPES,
	};
}

function normalizeUiViewInput(input: unknown): UiViewInput {
	const record = recordFrom(input);
	if (!record) throw new Error("ui.create_view expects an object input.");
	return {
		appId: optionalString(record.appId),
		appName: optionalString(record.appName),
		appSlug: optionalString(record.appSlug),
		data: record.data,
		layoutId: optionalString(record.layoutId),
		layoutSpec: record.layoutSpec,
		logoUrl: optionalString(record.logoUrl),
		summary: optionalString(record.summary),
		title: optionalString(record.title),
		visualKind: normalizeUiVisualKind(record.visualKind),
	};
}

function normalizeUiMcpAppInput(input: unknown): UiMcpAppInput {
	const record = recordFrom(input);
	if (!record) throw new Error("ui.create_mcp_app expects an object input.");
	const title = optionalString(record.title);
	const summary = optionalString(record.summary);
	const html = typeof record.html === "string" ? record.html.trim() : "";
	if (!title) throw new Error("ui.create_mcp_app requires a title.");
	if (!summary) {
		throw new Error(
			"ui.create_mcp_app requires a meaningful plain-text summary fallback.",
		);
	}
	if (!html) throw new Error("ui.create_mcp_app requires HTML content.");
	if (html.length > GENERATED_MCP_APP_HTML_CHAR_CAP) {
		throw new Error(
			`ui.create_mcp_app HTML exceeds the ${GENERATED_MCP_APP_HTML_CHAR_CAP.toLocaleString()} character transient limit; use a generated widget artifact for larger UI.`,
		);
	}
	const data = record.data === undefined ? undefined : recordFrom(record.data);
	if (record.data !== undefined && !data) {
		throw new Error(
			"ui.create_mcp_app data must be a JSON object when provided.",
		);
	}
	return {
		appId: optionalString(record.appId),
		appName: optionalString(record.appName),
		appSlug: optionalString(record.appSlug),
		...(data ? { data } : {}),
		html,
		logoUrl: optionalString(record.logoUrl),
		summary,
		title,
	};
}

function normalizeUiHealthSweepInput(input: unknown): UiHealthSweepInput {
	const record = recordFrom(input);
	if (!record)
		throw new Error("ui.create_health_sweep expects an object input.");
	const checks = recordArrayFrom(record.checks);
	if (!checks || checks.length === 0) {
		throw new Error("ui.create_health_sweep requires at least one check row.");
	}
	return {
		appName: optionalString(record.appName),
		appSlug: optionalString(record.appSlug),
		checks,
		summary: optionalString(record.summary),
		title: optionalString(record.title),
	};
}

function createCodeModeHealthSweep(
	serverCtx: ServerContext,
	input: UiHealthSweepInput,
): Record<string, unknown> {
	const checks = input.checks.map(normalizeHealthSweepCheck);
	const counts = checks.reduce<Record<HealthSweepStatus, number>>(
		(acc, check) => {
			acc[check.status] = (acc[check.status] ?? 0) + 1;
			return acc;
		},
		{ blocked: 0, error: 0, missing: 0, ok: 0, unknown: 0, warning: 0 },
	);
	const attention = checks.length - counts.ok;
	const summary =
		input.summary ??
		`${checks.length} checks: ${counts.ok} OK, ${attention} need attention.`;
	const stats = [
		{ label: "Total", value: checks.length, format: "number" },
		{ label: "OK", value: counts.ok, format: "number", tone: "success" },
		{
			label: "Attention",
			value: attention,
			format: "number",
			tone: attention > 0 ? "warning" : "success",
		},
		{
			label: "Errors",
			value: counts.error + counts.blocked + counts.missing,
			format: "number",
			tone:
				counts.error + counts.blocked + counts.missing > 0
					? "danger"
					: "default",
		},
	];

	return createCodeModeUiView(serverCtx, {
		appName: input.appName ?? "Tedix Unified",
		appSlug: input.appSlug ?? "tedix-unified",
		data: {
			checks,
			stats,
			_view: { tableStats: stats },
		},
		layoutId: "mcp-health-sweep",
		layoutSpec: buildHealthSweepLayoutSpec(
			input.title ?? "MCP health sweep",
			summary,
			checks,
		),
		summary,
		title: input.title ?? "MCP health sweep",
	});
}

function createCodeModeMcpApp(
	serverCtx: ServerContext,
	input: UiMcpAppInput,
): Record<string, unknown> {
	const app = normalizeUiViewApp(serverCtx, input);
	const resourceUri = `ui://widgets/mcp-app/${app.slug}/r/generated-app.html`;
	return {
		...input.data,
		title: input.title,
		summary: input.summary,
		generatedMcpApp: {
			html: input.html,
			renderMode: "sandboxed-html-css",
		},
		app,
		_meta: {
			ui: {
				app,
				resourceUri,
			},
		},
	};
}

function normalizeHealthSweepCheck(
	check: Record<string, unknown>,
): NormalizedHealthSweepCheck {
	const namespace =
		optionalString(check.namespace) ??
		optionalString(check.provider) ??
		optionalString(check.app) ??
		"unknown";
	const tool = optionalString(check.tool) ?? optionalString(check.name);
	const status = normalizeHealthStatus(check.status);
	const latencyMs =
		typeof check.latencyMs === "number" && Number.isFinite(check.latencyMs)
			? Math.max(0, Math.trunc(check.latencyMs))
			: undefined;
	return {
		namespace,
		...(tool ? { tool } : {}),
		label:
			optionalString(check.label) ??
			(tool ? `${namespace}.${tool}` : namespace),
		status,
		...(optionalString(check.summary)
			? { summary: optionalString(check.summary) }
			: {}),
		...(optionalString(check.error)
			? { error: optionalString(check.error) }
			: {}),
		...(latencyMs !== undefined ? { latencyMs } : {}),
		tone: statusTone(status),
	};
}

function normalizeHealthStatus(value: unknown): HealthSweepStatus {
	const raw =
		typeof value === "string" && value.trim()
			? value.trim().toLowerCase()
			: "unknown";
	if (/^(ok|pass|passed|success|healthy|available|working)$/.test(raw))
		return "ok";
	if (/^(warn|warning|degraded|partial|slow|limited)$/.test(raw))
		return "warning";
	if (/^(blocked|auth|unauthenticated|unauthorized|forbidden)$/.test(raw))
		return "blocked";
	if (/^(missing|not_found|not-found|unavailable|absent)$/.test(raw))
		return "missing";
	if (/^(error|failed|failure|broken|invalid|timeout)$/.test(raw))
		return "error";
	return "unknown";
}

function buildHealthSweepLayoutSpec(
	title: string,
	summary: string,
	checks: Record<string, unknown>[],
): Record<string, unknown> {
	return {
		root: "shell",
		elements: {
			shell: {
				type: "Stack",
				props: { gap: 3 },
				children: ["title", "summary", "stats", "checks"],
			},
			title: {
				type: "Text",
				props: { text: title, variant: "default" },
				children: [],
			},
			summary: {
				type: "Text",
				props: { text: summary, variant: "muted" },
				children: [],
			},
			stats: {
				type: "StatGrid",
				props: {
					stats: { $state: "/stats" },
					columns: { mobile: 2, tablet: 4, desktop: 4 },
					variant: "minimal",
					density: "compact",
				},
				children: [],
			},
			checks: {
				type: "DataTable",
				props: {
					columns: selectTableColumns(checks),
					data: { $state: "/checks" },
					pageSize: 12,
					striped: true,
					compact: true,
				},
				children: [],
			},
		},
	};
}

function createCodeModeUiView(
	serverCtx: ServerContext,
	input: UiViewInput,
): Record<string, unknown> {
	// Bare record arrays are part of the public contract and normalize under
	// `rows`, one of the keys layout inference recognizes. Any other scalar or
	// non-object data still throws because it cannot provide stable bindings.
	const recordArray =
		Array.isArray(input.data) && input.data.every(isRecord) ? input.data : null;
	const data = recordArray ? { rows: recordArray } : recordFrom(input.data);
	if (!data) {
		throw new Error(
			"ui.create_view requires data to be a JSON object or an array of records",
		);
	}

	const inferFallback = () =>
		inferJsonRenderLayout(data, {
			summary: input.summary,
			title: input.title,
			visualKind: input.visualKind ?? "auto",
		});
	const explicitLayoutSpec =
		input.layoutSpec === undefined ? null : recordFrom(input.layoutSpec);
	const explicitValidation = explicitLayoutSpec
		? normalizeJsonRenderLayoutSpec(explicitLayoutSpec)
		: null;
	const inferred: InferredLayout =
		explicitValidation?.valid && explicitValidation.layoutSpec
			? { layoutSpec: explicitValidation.layoutSpec }
			: inferFallback();
	let validation = normalizeJsonRenderLayoutSpec(inferred.layoutSpec);
	let layoutSpec = validation.layoutSpec;
	if (!validation.valid || !layoutSpec) {
		const summaryValidation = normalizeJsonRenderLayoutSpec(
			buildSummaryLayoutSpec(
				input.title ?? "Generated view",
				input.summary,
				data,
			),
		);
		validation = summaryValidation;
		layoutSpec = summaryValidation.layoutSpec;
	}
	if (!validation.valid || !layoutSpec) {
		throw new Error(
			`Invalid json-render layoutSpec: ${validation.issues.join("; ")}`,
		);
	}

	const outputData: Record<string, unknown> = inferred.viewData
		? {
				...data,
				_view: {
					...recordFrom(data._view),
					...inferred.viewData,
				},
			}
		: data;
	const app = normalizeUiViewApp(serverCtx, input);
	const layoutId = normalizeUiLayoutId(
		input.layoutId ?? input.title ?? "generated view",
	);
	const resourceUri = `ui://widgets/mcp-app/${app.slug}/r/${layoutId}.html`;
	const title = input.title ?? input.summary ?? `${app.name} view`;
	const existingMeta = recordFrom(outputData._meta) ?? {};

	return {
		...outputData,
		title,
		...(input.summary ? { summary: input.summary } : {}),
		layoutSpec,
		app,
		_meta: {
			...existingMeta,
			ui: {
				...recordFrom(existingMeta.ui),
				app,
				resourceUri,
			},
		},
	};
}

function inferJsonRenderLayout(
	data: Record<string, unknown>,
	options: {
		summary?: string;
		title?: string;
		visualKind: UiVisualKind;
	},
): InferredLayout {
	const title = options.title ?? "Generated view";
	const table = findPrimaryTableCandidate(data);
	const timeline = findTimelineCandidate(data, table);
	const chart = findChartCandidate(table, options.visualKind);

	if (options.visualKind === "comparison") {
		return table
			? buildComparisonLayout(title, options.summary, table)
			: { layoutSpec: buildSummaryLayoutSpec(title, options.summary, data) };
	}
	if (options.visualKind === "timeline") {
		return timeline
			? buildTimelineLayout(title, options.summary, timeline)
			: { layoutSpec: buildSummaryLayoutSpec(title, options.summary, data) };
	}
	if (options.visualKind === "stats") {
		return buildStatsLayout(title, options.summary, data);
	}
	if (
		options.visualKind === "chart" ||
		options.visualKind === "timeSeries" ||
		options.visualKind === "categoricalCounts" ||
		options.visualKind === "rankedMetrics"
	) {
		return chart
			? buildChartLayout(title, options.summary, chart)
			: table
				? buildTableLayout(title, options.summary, table, data)
				: { layoutSpec: buildSummaryLayoutSpec(title, options.summary, data) };
	}
	if (options.visualKind === "details" || options.visualKind === "summary") {
		return { layoutSpec: buildSummaryLayoutSpec(title, options.summary, data) };
	}
	if (options.visualKind === "table") {
		return table
			? buildTableLayout(title, options.summary, table, data)
			: { layoutSpec: buildSummaryLayoutSpec(title, options.summary, data) };
	}

	if (table) {
		if (isComparisonCandidate(table.rows)) {
			return buildComparisonLayout(title, options.summary, table);
		}
		if (chart?.variant === "line" || chart?.variant === "area") {
			return buildChartLayout(title, options.summary, chart);
		}
		const stats = extractDashboardStats(data, table);
		if (shouldUseDashboardLayout(data, table, stats, timeline)) {
			return buildDashboardLayout(
				title,
				options.summary,
				table,
				stats,
				timeline,
			);
		}
		const bars = buildBarListItems(table.rows);
		if (bars.length >= 3) {
			return buildRankingLayout(title, options.summary, table, bars);
		}
		if (isTimelineCandidate(table.rows)) {
			return buildTimelineLayout(title, options.summary, table);
		}
		return buildTableLayout(title, options.summary, table, data);
	}

	const stats = extractStatItems(data);
	if (stats.length >= 2) {
		return buildStatsLayout(title, options.summary, data);
	}

	return { layoutSpec: buildSummaryLayoutSpec(title, options.summary, data) };
}

function findPrimaryTableCandidate(
	data: Record<string, unknown>,
): TableCandidate | null {
	const preferred = [
		"items",
		"results",
		"products",
		"listings",
		"deployments",
		"providers",
		"sources",
		"checks",
		"findings",
		"apps",
		"namespaces",
		"workflows",
		"tasks",
		"events",
		"tools",
		"rows",
		"records",
		"list",
		"data",
	];
	for (const key of preferred) {
		const direct = recordArrayFrom(data[key]);
		if (direct) return { path: `/${key}`, rows: direct };
	}
	return findRecordArray(data);
}

function findRecordArray(
	value: unknown,
	path: string[] = [],
	depth = 0,
): TableCandidate | null {
	if (depth > 3) return null;
	const rows = recordArrayFrom(value);
	if (rows) return { path: `/${path.join("/")}`, rows };
	const record = recordFrom(value);
	if (!record) return null;
	for (const [key, nested] of Object.entries(record)) {
		if (isNonTableArrayKey(key)) continue;
		const candidate = findRecordArray(nested, [...path, key], depth + 1);
		if (candidate) return candidate;
	}
	return null;
}

function findTimelineCandidate(
	data: Record<string, unknown>,
	primaryTable: TableCandidate | null,
): TableCandidate | null {
	const preferred = [
		"timeline",
		"events",
		"activity",
		"history",
		"steps",
		"logs",
		"evidence",
		"runs",
	];
	for (const key of preferred) {
		const rows = recordArrayFrom(data[key]);
		if (rows && isTimelineCandidate(rows)) {
			return { path: `/${key}`, rows };
		}
	}
	if (primaryTable && isTimelineCandidate(primaryTable.rows))
		return primaryTable;
	return null;
}

function isNonTableArrayKey(key: string): boolean {
	return /^(stats|metrics|kpis|summaryStats|tableStats|comparisonItems|timelineItems|barItems|chartData)$/i.test(
		key,
	);
}

function recordArrayFrom(value: unknown): Record<string, unknown>[] | null {
	if (!Array.isArray(value)) return null;
	const rows = value.filter(recordFrom);
	return rows.length > 0 ? rows : null;
}

function buildTableLayout(
	title: string,
	summary: string | undefined,
	table: TableCandidate,
	data: Record<string, unknown>,
): InferredLayout {
	const stats = extractDashboardStats(data, table).slice(0, 8);
	if (stats.length < 2) {
		return { layoutSpec: buildTableLayoutSpec(title, summary, table, false) };
	}
	return {
		viewData: { tableStats: stats },
		layoutSpec: buildTableLayoutSpec(title, summary, table, true),
	};
}

function buildDashboardLayout(
	title: string,
	summary: string | undefined,
	table: TableCandidate,
	stats: Array<Record<string, unknown>>,
	timeline: TableCandidate | null,
): InferredLayout {
	const viewData: Record<string, unknown> = {
		dashboardStats: stats.slice(0, 8),
	};
	const children = [
		"title",
		...(summary ? ["summary"] : []),
		...(stats.length >= 2 ? ["stats"] : []),
		"table",
		...(timeline ? ["timeline"] : []),
	];
	if (timeline) {
		viewData.timelineItems = timeline.rows
			.slice(0, 12)
			.map((row, index) => normalizeTimelineItem(row, index));
	}
	return {
		viewData,
		layoutSpec: {
			root: "shell",
			elements: {
				shell: {
					type: "Stack",
					props: { gap: 3 },
					children,
				},
				title: {
					type: "Text",
					props: { text: title, variant: "default" },
					children: [],
				},
				...(summary
					? {
							summary: {
								type: "Text",
								props: { text: summary, variant: "muted" },
								children: [],
							},
						}
					: {}),
				...(stats.length >= 2
					? {
							stats: {
								type: "StatGrid",
								props: {
									stats: { $state: "/_view/dashboardStats" },
									columns: { mobile: 2, tablet: 4, desktop: 4 },
									variant: "minimal",
									density: "compact",
								},
								children: [],
							},
						}
					: {}),
				table: {
					type: "DataTable",
					props: {
						columns: selectTableColumns(table.rows),
						data: { $state: table.path },
						pageSize: 10,
						striped: true,
						compact: true,
					},
					children: [],
				},
				...(timeline
					? {
							timeline: {
								type: "StatusTimeline",
								props: {
									items: { $state: "/_view/timelineItems" },
									title: "Activity",
									density: "compact",
									showConnectors: true,
									variant: "plain",
								},
								children: [],
							},
						}
					: {}),
			},
		},
	};
}

function buildRankingLayout(
	title: string,
	summary: string | undefined,
	table: TableCandidate,
	bars: Array<Record<string, unknown>>,
): InferredLayout {
	return {
		viewData: { barItems: bars.slice(0, 12) },
		layoutSpec: {
			root: "shell",
			elements: {
				shell: {
					type: "Stack",
					props: { gap: 3 },
					children: ["title", ...(summary ? ["summary"] : []), "bars", "table"],
				},
				title: {
					type: "Text",
					props: { text: title, variant: "default" },
					children: [],
				},
				...(summary
					? {
							summary: {
								type: "Text",
								props: { text: summary, variant: "muted" },
								children: [],
							},
						}
					: {}),
				bars: {
					type: "BarList",
					props: {
						items: { $state: "/_view/barItems" },
						showValues: true,
						sort: "desc",
						limit: 12,
						variant: "plain",
					},
					children: [],
				},
				table: {
					type: "DataTable",
					props: {
						columns: selectTableColumns(table.rows),
						data: { $state: table.path },
						pageSize: 10,
						striped: true,
						compact: true,
					},
					children: [],
				},
			},
		},
	};
}

function findChartCandidate(
	table: TableCandidate | null,
	visualKind: UiVisualKind,
): ChartCandidate | null {
	if (!table) return null;
	if (visualKind === "timeSeries") return findTimeSeriesChartCandidate(table);
	if (visualKind === "categoricalCounts") {
		return findCategoricalChartCandidate(table);
	}
	if (visualKind === "rankedMetrics")
		return findRankedMetricChartCandidate(table);
	return (
		findTimeSeriesChartCandidate(table) ??
		(visualKind === "chart"
			? (findCategoricalChartCandidate(table) ??
				findRankedMetricChartCandidate(table))
			: null)
	);
}

function findTimeSeriesChartCandidate(
	table: TableCandidate,
): ChartCandidate | null {
	const xKey = findTimeKey(table.rows);
	if (!xKey) return null;
	const yKeys = findNumericChartKeys(table.rows, xKey).slice(0, 4);
	if (yKeys.length === 0) return null;
	const data = table.rows
		.flatMap((row) => {
			const point: Record<string, unknown> = {
				[xKey]: stringifyChartLabel(row[xKey]),
			};
			for (const key of yKeys) {
				const numeric = numericChartValue(row[key]);
				if (numeric !== null) point[key] = numeric;
			}
			return Object.keys(point).length > 1 ? [point] : [];
		})
		.sort((left, right) => {
			const leftTime = Date.parse(String(left[xKey] ?? ""));
			const rightTime = Date.parse(String(right[xKey] ?? ""));
			if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return 0;
			return leftTime - rightTime;
		})
		.slice(0, 120);
	if (data.length < 2) return null;
	return {
		table,
		data,
		variant: yKeys.length > 2 ? "area" : "line",
		xKey,
		yKeys,
		series: yKeys.map((key, index) => ({
			key,
			label: humanizeSlug(key),
			color: chartColorToken(index),
		})),
	};
}

function findCategoricalChartCandidate(
	table: TableCandidate,
): ChartCandidate | null {
	const categoryKey = findStatusKey(table.rows) ?? findCategoryKey(table.rows);
	if (!categoryKey) return null;
	const countKey = findCountMetricKey(table.rows, categoryKey);
	const data = countKey
		? table.rows
				.flatMap((row) => {
					const label = stringifyChartLabel(row[categoryKey]);
					const value = numericChartValue(row[countKey]);
					return label && value !== null ? [{ label, value }] : [];
				})
				.sort((left, right) => Number(right.value) - Number(left.value))
		: deriveCategoryCounts(table.rows, categoryKey);
	if (data.length < 2) return null;
	return {
		table,
		data: data.slice(0, 20),
		variant: "bar",
		xKey: "label",
		yKeys: ["value"],
		nameKey: "label",
		valueKey: "value",
		series: [
			{
				key: "value",
				label: humanizeSlug(countKey ?? "count"),
				color: "chart-1",
			},
		],
	};
}

function findRankedMetricChartCandidate(
	table: TableCandidate,
): ChartCandidate | null {
	const labelKey = findLabelKey(table.rows);
	const metricKey = findRankingMetricKey(table.rows);
	if (!labelKey || !metricKey) return null;
	const data = table.rows
		.flatMap((row) => {
			const label = stringifyChartLabel(row[labelKey]);
			const value = numericChartValue(row[metricKey]);
			return label && value !== null ? [{ label, value }] : [];
		})
		.sort((left, right) => Number(right.value) - Number(left.value))
		.slice(0, 20);
	if (data.length < 2) return null;
	return {
		table,
		data,
		variant: "bar",
		xKey: "label",
		yKeys: ["value"],
		series: [
			{ key: "value", label: humanizeSlug(metricKey), color: "chart-1" },
		],
	};
}

function buildChartLayout(
	title: string,
	summary: string | undefined,
	chart: ChartCandidate,
): InferredLayout {
	return {
		viewData: { chartData: chart.data },
		layoutSpec: {
			root: "shell",
			elements: {
				shell: {
					type: "Stack",
					props: { gap: 3 },
					children: [
						"title",
						...(summary ? ["summary"] : []),
						"chart",
						"table",
					],
				},
				title: {
					type: "Text",
					props: { text: title, variant: "default" },
					children: [],
				},
				...(summary
					? {
							summary: {
								type: "Text",
								props: { text: summary, variant: "muted" },
								children: [],
							},
						}
					: {}),
				chart: {
					type: "DataChart",
					props: {
						data: { $state: "/_view/chartData" },
						variant: chart.variant,
						...(chart.xKey ? { xKey: chart.xKey } : {}),
						...(chart.yKeys ? { yKeys: chart.yKeys } : {}),
						...(chart.series ? { series: chart.series } : {}),
						...(chart.nameKey ? { nameKey: chart.nameKey } : {}),
						...(chart.valueKey ? { valueKey: chart.valueKey } : {}),
						height: 260,
						showLegend: (chart.series?.length ?? 0) > 1,
						showTooltip: true,
						stacked: false,
					},
					children: [],
				},
				table: {
					type: "DataTable",
					props: {
						columns: selectTableColumns(chart.table.rows),
						data: { $state: chart.table.path },
						pageSize: 10,
						striped: true,
						compact: true,
					},
					children: [],
				},
			},
		},
	};
}

function findTimeKey(rows: Record<string, unknown>[]): string | null {
	const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
	return (
		keys.find((key) =>
			/^(date|time|timestamp|day|week|month|period|createdAt|updatedAt|created|updated)$/i.test(
				key,
			),
		) ?? null
	);
}

function findNumericChartKeys(
	rows: Record<string, unknown>[],
	excludeKey: string,
): string[] {
	const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
	return keys.filter(
		(key) =>
			key !== excludeKey &&
			rows.some((row) => numericChartValue(row[key]) !== null),
	);
}

function findCategoryKey(rows: Record<string, unknown>[]): string | null {
	const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
	return (
		keys.find((key) =>
			/^(category|type|kind|provider|source|app|tool|namespace|label|name)$/i.test(
				key,
			),
		) ?? null
	);
}

function findCountMetricKey(
	rows: Record<string, unknown>[],
	excludeKey: string,
): string | null {
	return (
		findNumericChartKeys(rows, excludeKey).find((key) =>
			/(count|total|calls|usage|value|score|amount|tokens|cost|errors|failures|successes)$/i.test(
				key,
			),
		) ?? null
	);
}

function deriveCategoryCounts(
	rows: Record<string, unknown>[],
	categoryKey: string,
): Array<Record<string, unknown>> {
	const counts = new Map<string, number>();
	for (const row of rows) {
		const label = stringifyChartLabel(row[categoryKey]);
		if (!label) continue;
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	return Array.from(counts.entries())
		.map(([label, value]) => ({ label, value }))
		.sort((left, right) => Number(right.value) - Number(left.value));
}

function numericChartValue(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") return parseNumericString(value);
	return null;
}

function stringifyChartLabel(value: unknown): string {
	if (typeof value === "string" && value.trim()) return value.trim();
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return "";
}

function chartColorToken(
	index: number,
): "chart-1" | "chart-2" | "chart-3" | "chart-4" | "chart-5" | "chart-6" {
	return `chart-${(index % 6) + 1}` as
		| "chart-1"
		| "chart-2"
		| "chart-3"
		| "chart-4"
		| "chart-5"
		| "chart-6";
}

function buildTableLayoutSpec(
	title: string,
	summary: string | undefined,
	table: TableCandidate,
	includeStats = false,
): Record<string, unknown> {
	const columns = selectTableColumns(table.rows);
	const children = [
		"title",
		...(summary ? ["summary"] : []),
		...(includeStats ? ["stats"] : []),
		"table",
	];
	return {
		root: "shell",
		elements: {
			shell: {
				type: "Stack",
				props: { gap: 3 },
				children,
			},
			title: {
				type: "Text",
				props: { text: title, variant: "default" },
				children: [],
			},
			...(summary
				? {
						summary: {
							type: "Text",
							props: { text: summary, variant: "muted" },
							children: [],
						},
					}
				: {}),
			...(includeStats
				? {
						stats: {
							type: "StatGrid",
							props: {
								stats: { $state: "/_view/tableStats" },
								columns: { mobile: 2, tablet: 4, desktop: 4 },
								variant: "minimal",
								density: "compact",
							},
							children: [],
						},
					}
				: {}),
			table: {
				type: "DataTable",
				props: {
					columns,
					data: { $state: table.path },
					pageSize: 10,
					striped: true,
					compact: true,
				},
				children: [],
			},
		},
	};
}

function buildSummaryLayoutSpec(
	title: string,
	summary: string | undefined,
	data: Record<string, unknown>,
): Record<string, unknown> {
	const summaryItems = Object.entries(data)
		.filter((entry): entry is [string, string | number | boolean | null] =>
			isUiScalar(entry[1]),
		)
		.slice(0, 12)
		.map(([key, value]) => ({
			label: humanizeSlug(key),
			value: stringifyUiScalar(value),
		}));
	const description = summary ?? "Structured response summary";
	return {
		root: "shell",
		elements: {
			shell: {
				type: "Stack",
				props: { gap: 3 },
				children:
					summaryItems.length > 0
						? ["title", "summary", "facts"]
						: ["title", "summary"],
			},
			title: {
				type: "Text",
				props: { text: title, variant: "default" },
				children: [],
			},
			summary: {
				type: "Text",
				props: { text: description, variant: "muted" },
				children: [],
			},
			...(summaryItems.length > 0
				? {
						facts: {
							type: "KeyValuePanel",
							props: {
								items: summaryItems,
								columns: 2,
								density: "compact",
								variant: "plain",
							},
							children: [],
						},
					}
				: {}),
		},
	};
}

function buildComparisonLayout(
	title: string,
	summary: string | undefined,
	table: TableCandidate,
): InferredLayout {
	const items = table.rows
		.slice(0, 24)
		.map((row, index) => normalizeComparisonItem(row, index));
	return {
		viewData: { comparisonItems: items },
		layoutSpec: {
			root: "shell",
			elements: {
				shell: {
					type: "Stack",
					props: { gap: 3 },
					children: summary
						? ["title", "summary", "comparison"]
						: ["title", "comparison"],
				},
				title: {
					type: "Text",
					props: { text: title, variant: "default" },
					children: [],
				},
				...(summary
					? {
							summary: {
								type: "Text",
								props: { text: summary, variant: "muted" },
								children: [],
							},
						}
					: {}),
				comparison: {
					type: "ComparisonLayout",
					props: {
						results: { $state: "/_view/comparisonItems" },
						query: title,
						currency: inferCurrency(table.rows) ?? "USD",
						vertical: "ecommerce",
						sortBy: "price",
						hideFilters: false,
						allowFullscreen: true,
					},
					children: [],
				},
			},
		},
	};
}

function buildTimelineLayout(
	title: string,
	summary: string | undefined,
	table: TableCandidate,
): InferredLayout {
	const items = table.rows
		.slice(0, 24)
		.map((row, index) => normalizeTimelineItem(row, index));
	return {
		viewData: { timelineItems: items },
		layoutSpec: {
			root: "shell",
			elements: {
				shell: {
					type: "Stack",
					props: { gap: 3 },
					children: ["timeline"],
				},
				timeline: {
					type: "StatusTimeline",
					props: {
						items: { $state: "/_view/timelineItems" },
						title,
						...(summary ? { description: summary } : {}),
						density: "compact",
						showConnectors: true,
						variant: "plain",
					},
					children: [],
				},
			},
		},
	};
}

function buildStatsLayout(
	title: string,
	summary: string | undefined,
	data: Record<string, unknown>,
): InferredLayout {
	const stats = extractStatItems(data).slice(0, 8);
	if (stats.length === 0) {
		return { layoutSpec: buildSummaryLayoutSpec(title, summary, data) };
	}
	return {
		viewData: { stats },
		layoutSpec: {
			root: "shell",
			elements: {
				shell: {
					type: "Stack",
					props: { gap: 3 },
					children: ["stats"],
				},
				stats: {
					type: "StatGrid",
					props: {
						stats: { $state: "/_view/stats" },
						title,
						...(summary ? { description: summary } : {}),
						columns: { mobile: 2, tablet: 4, desktop: 4 },
						variant: "minimal",
						density: "compact",
					},
					children: [],
				},
			},
		},
	};
}

function isComparisonCandidate(rows: Record<string, unknown>[]): boolean {
	return rows.some((row) => {
		const keys = Object.keys(row).map((key) => key.toLowerCase());
		const hasName =
			keys.some((key) =>
				/^(title|name|product|productname|model|label)$/.test(key),
			) || typeof row.id === "string";
		const hasCommerceSignal = keys.some((key) =>
			/(price|offer|merchant|seller|rating|image|thumbnail|url|link|shop|store)/.test(
				key,
			),
		);
		return hasName && hasCommerceSignal;
	});
}

function isTimelineCandidate(rows: Record<string, unknown>[]): boolean {
	return rows.some((row) => {
		const keys = Object.keys(row).map((key) => key.toLowerCase());
		const hasState = keys.some((key) =>
			/(status|state|stage|phase|step|result|outcome)/.test(key),
		);
		const hasTime = keys.some((key) =>
			/(date|time|timestamp|created|updated|started|finished|completed|scheduled)/.test(
				key,
			),
		);
		const hasEventSignal = keys.some((key) =>
			/(event|message|description|reason|step|tool|operation)/.test(key),
		);
		return hasTime || (hasState && hasEventSignal);
	});
}

function normalizeComparisonItem(
	row: Record<string, unknown>,
	index: number,
): Record<string, unknown> {
	const title =
		firstString(row, [
			"title",
			"name",
			"productName",
			"product",
			"model",
			"label",
			"id",
		]) ?? `Result ${index + 1}`;
	const subtitle =
		firstString(row, [
			"subtitle",
			"merchant",
			"merchantName",
			"seller",
			"sellerName",
			"brand",
			"source",
		]) ?? comparisonSubtitleFromRow(row);
	const image = firstString(row, [
		"image",
		"imageUrl",
		"image_url",
		"thumbnail",
		"thumbnailUrl",
		"thumbnail_url",
	]);
	const url = firstString(row, [
		"url",
		"link",
		"href",
		"productUrl",
		"product_url",
	]);
	const price = normalizePrice(row);
	const rating = normalizeRating(row);
	const offers = normalizeOffers(row);
	const seller = normalizeSeller(row);
	return {
		id: firstString(row, ["id", "sku", "asin", "slug"]) ?? `item-${index + 1}`,
		title,
		...(subtitle ? { subtitle } : {}),
		...(firstString(row, ["description", "summary"])
			? {
					description: firstString(row, ["description", "summary"]),
				}
			: {}),
		...(image ? { image } : {}),
		...(url ? { url } : {}),
		...(price ? { price } : {}),
		...(rating ? { rating } : {}),
		...(offers.length > 0 ? { offers, offerCount: offers.length } : {}),
		...(seller ? { seller } : {}),
		metadata: row,
	};
}

function comparisonSubtitleFromRow(
	row: Record<string, unknown>,
): string | undefined {
	const parts = [
		firstString(row, ["chip", "cpu", "processor"]),
		firstString(row, ["memory", "ram"]),
		firstString(row, ["storage", "ssd", "disk"]),
		firstString(row, ["color", "colour"]),
		firstString(row, ["keyboard", "layout"]),
	].filter((part): part is string => Boolean(part));
	if (parts.length === 0) return undefined;
	return parts.slice(0, 4).join(" · ");
}

function normalizeTimelineItem(
	row: Record<string, unknown>,
	index: number,
): Record<string, unknown> {
	const rawStatus = firstString(row, [
		"status",
		"state",
		"stage",
		"phase",
		"result",
		"outcome",
	]);
	const status = normalizeTimelineStatus(rawStatus);
	const title =
		firstString(row, ["title", "name", "label", "id", "tool", "step"]) ??
		`Event ${index + 1}`;
	const description = firstString(row, [
		"description",
		"message",
		"summary",
		"error",
		"reason",
	]);
	const timestamp = firstString(row, [
		"timestamp",
		"createdAt",
		"updatedAt",
		"startedAt",
		"finishedAt",
		"completedAt",
		"date",
		"time",
	]);
	return {
		title,
		...(description ? { description } : {}),
		...(timestamp ? { timestamp } : {}),
		status,
		...(rawStatus ? { statusLabel: humanizeSlug(rawStatus) } : {}),
		metadata: row,
	};
}

function extractStatItems(
	data: Record<string, unknown>,
): Array<Record<string, unknown>> {
	const direct = recordArrayFrom(data.stats);
	if (direct) {
		return direct
			.map((stat) => normalizeStatItem(stat))
			.filter((stat): stat is Record<string, unknown> => Boolean(stat));
	}
	return Object.entries(data)
		.filter(([, value]) => typeof value === "number" || isNumericString(value))
		.map(([key, value]) => ({
			label: humanizeSlug(key),
			value: typeof value === "number" ? value : String(value),
			format: inferStatFormat(key, value),
			tone: inferStatTone(key),
		}));
}

function extractDashboardStats(
	data: Record<string, unknown>,
	table: TableCandidate | null,
): Array<Record<string, unknown>> {
	const explicit = extractStatItems(data);
	if (explicit.length >= 2) return explicit;
	if (!table) return explicit;
	const derived = deriveTableStats(table.rows);
	return derived.length >= 2 ? derived : explicit;
}

function shouldUseDashboardLayout(
	data: Record<string, unknown>,
	table: TableCandidate,
	stats: Array<Record<string, unknown>>,
	timeline: TableCandidate | null,
): boolean {
	if (timeline && timeline.path !== table.path) return true;
	if (recordArrayFrom(data.stats) && stats.length >= 2) return true;
	if (stats.length >= 2 && findStatusKey(table.rows)) return true;
	return false;
}

function deriveTableStats(
	rows: Record<string, unknown>[],
): Array<Record<string, unknown>> {
	const statusKey = findStatusKey(rows);
	if (!statusKey)
		return rows.length > 1 ? [{ label: "Total", value: rows.length }] : [];
	const counts = new Map<string, number>();
	for (const row of rows) {
		const value = row[statusKey];
		const label =
			typeof value === "string" && value.trim()
				? value.trim()
				: typeof value === "boolean"
					? String(value)
					: value === null || value === undefined
						? "Unknown"
						: String(value);
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	return [
		{ label: "Total", value: rows.length, tone: "default", format: "number" },
		...Array.from(counts.entries())
			.sort(([, a], [, b]) => b - a)
			.slice(0, 7)
			.map(([label, value]) => ({
				label: humanizeSlug(label),
				value,
				format: "number",
				tone: statusTone(label),
				badge: label,
				badgeVariant: statusBadgeVariant(label),
			})),
	];
}

function findStatusKey(rows: Record<string, unknown>[]): string | null {
	const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
	return (
		keys.find((key) =>
			/^(status|state|stage|phase|result|outcome|health|severity)$/i.test(key),
		) ?? null
	);
}

function buildBarListItems(
	rows: Record<string, unknown>[],
): Array<Record<string, unknown>> {
	const labelKey = findLabelKey(rows);
	const metricKey = findRankingMetricKey(rows);
	if (!labelKey || !metricKey) return [];
	return rows
		.flatMap((row) => {
			const label = row[labelKey];
			const value = row[metricKey];
			const numeric =
				typeof value === "number"
					? value
					: typeof value === "string"
						? parseNumericString(value)
						: null;
			if (typeof label !== "string" || !label.trim() || numeric === null) {
				return [];
			}
			return [
				{
					label: label.trim(),
					value: numeric,
					valueLabel: stringifyUiScalar(value as string | number),
					description: firstString(row, [
						"description",
						"summary",
						"subtitle",
						"provider",
						"source",
					]),
					tone: inferStatTone(label),
				},
			];
		})
		.sort((a, b) => Number(b.value) - Number(a.value));
}

function findLabelKey(rows: Record<string, unknown>[]): string | null {
	const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
	return (
		keys.find((key) =>
			/^(name|title|label|provider|source|app|tool|namespace)$/i.test(key),
		) ??
		keys.find((key) => rows.some((row) => typeof row[key] === "string")) ??
		null
	);
}

function findRankingMetricKey(rows: Record<string, unknown>[]): string | null {
	const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
	const numericKeys = keys.filter((key) =>
		rows.some(
			(row) => typeof row[key] === "number" || isNumericString(row[key]),
		),
	);
	return (
		numericKeys.find((key) =>
			/(score|rank|count|total|value|amount|usage|calls|tokens|cost|errors|failures|successes|latency|duration|progress|percent|rate)$/i.test(
				key,
			),
		) ?? null
	);
}

function normalizeStatItem(
	stat: Record<string, unknown>,
): Record<string, unknown> | null {
	const label = firstString(stat, ["label", "name", "title", "key"]);
	const value = stat.value ?? stat.count ?? stat.total ?? stat.amount;
	if (!label || !isUiScalar(value)) return null;
	return {
		label,
		value: typeof value === "boolean" ? String(value) : value,
		...(firstString(stat, ["unit"])
			? { unit: firstString(stat, ["unit"]) }
			: {}),
		...(firstString(stat, ["description", "summary"])
			? { description: firstString(stat, ["description", "summary"]) }
			: {}),
		format: inferStatFormat(label, value),
		tone: inferStatTone(label),
	};
}

function normalizePrice(
	row: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const value =
		row.price ??
		row.priceEUR ??
		row.priceUsd ??
		row.priceUSD ??
		row.priceText ??
		row.priceDisplay ??
		row.amount ??
		row.cost ??
		row.total ??
		row.lowestPrice;
	const explicitCurrency = firstString(row, ["currency", "priceCurrency"]);
	const currency =
		explicitCurrency ??
		(row.priceEUR !== undefined
			? "EUR"
			: row.priceUsd !== undefined || row.priceUSD !== undefined
				? "USD"
				: undefined) ??
		(typeof value === "string" ? inferCurrencyFromText(value) : undefined) ??
		"USD";
	if (isRecord(value) && typeof value.amount === "number") {
		return {
			amount: value.amount,
			currency: firstString(value, ["currency"]) ?? currency,
			...(typeof value.original === "number"
				? { original: value.original }
				: {}),
			...(firstString(value, ["formatted"])
				? {
						formatted: firstString(value, ["formatted"]),
					}
				: {}),
		};
	}
	if (typeof value === "number") {
		return {
			amount: value,
			currency,
			...(firstString(row, ["priceDisplay", "priceText", "formattedPrice"])
				? {
						formatted: firstString(row, [
							"priceDisplay",
							"priceText",
							"formattedPrice",
						]),
					}
				: {}),
		};
	}
	if (typeof value === "string") {
		const amount = parseNumericString(value);
		if (typeof amount === "number") {
			return {
				amount,
				currency: inferCurrencyFromText(value) ?? currency,
				formatted: value,
			};
		}
	}
	return undefined;
}

function normalizeRating(
	row: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const value = row.rating ?? row.score;
	if (isRecord(value) && typeof value.value === "number") {
		return {
			value: value.value,
			...(typeof value.count === "number" ? { count: value.count } : {}),
			...(typeof value.max === "number" ? { max: value.max } : {}),
		};
	}
	if (typeof value === "number") return { value, max: value > 5 ? 100 : 5 };
	return undefined;
}

function normalizeOffers(
	row: Record<string, unknown>,
): Record<string, unknown>[] {
	const offers = Array.isArray(row.offers) ? row.offers.filter(recordFrom) : [];
	return offers.flatMap((offer, index) => {
		const price = offer.price;
		const amount =
			typeof price === "number"
				? price
				: typeof price === "string"
					? parseNumericString(price)
					: null;
		if (typeof amount !== "number") return [];
		const merchantName =
			firstString(offer, ["merchantName", "merchant", "seller", "store"]) ??
			`Offer ${index + 1}`;
		return {
			merchantName,
			price: amount,
			currency:
				firstString(offer, ["currency"]) ??
				inferCurrencyFromText(typeof price === "string" ? price : "") ??
				firstString(row, ["currency"]) ??
				"USD",
			...(firstString(offer, ["merchantId"])
				? {
						merchantId: firstString(offer, ["merchantId"]),
					}
				: {}),
			...(firstString(offer, ["url", "link", "href"])
				? {
						url: firstString(offer, ["url", "link", "href"]),
					}
				: {}),
		};
	});
}

function normalizeSeller(
	row: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const name = firstString(row, [
		"sellerName",
		"seller",
		"merchant",
		"merchantName",
	]);
	if (!name) return undefined;
	return {
		name,
		...(firstString(row, ["sellerId", "merchantId"])
			? {
					id: firstString(row, ["sellerId", "merchantId"]),
				}
			: {}),
	};
}

function selectTableColumns(
	rows: Record<string, unknown>[],
): Array<{ field: string; header: string; format: string; sortable: boolean }> {
	const keys = Array.from(
		new Set(
			rows
				.flatMap((row) => Object.keys(row))
				.filter((key) => rows.some((row) => isUiScalar(row[key]))),
		),
	);
	return keys.slice(0, 6).map((key) => ({
		field: key,
		header: humanizeSlug(key),
		format: inferColumnFormat(key, rows),
		sortable: true,
	}));
}

function inferColumnFormat(
	key: string,
	rows: Record<string, unknown>[],
): "badge" | "date" | "number" | "text" {
	const lowerKey = key.toLowerCase();
	if (/(status|state|stage|type|priority|severity|enabled)/.test(lowerKey)) {
		return "badge";
	}
	if (/(date|time|created|updated|timestamp)/.test(lowerKey)) return "date";
	if (rows.some((row) => typeof row[key] === "number")) return "number";
	return "text";
}

function isUiScalar(value: unknown): value is string | number | boolean | null {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	);
}

function stringifyUiScalar(value: string | number | boolean | null): string {
	if (value === null) return "—";
	return String(value);
}

function firstString(
	record: Record<string, unknown>,
	keys: string[],
): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function isNumericString(value: unknown): value is string {
	return typeof value === "string" && parseNumericString(value) !== null;
}

function parseNumericString(value: string): number | null {
	const normalized = value
		.trim()
		.replace(/[^\d,.-]/g, "")
		.replace(/,(?=\d{3}\b)/g, "")
		.replace(",", ".");
	if (!normalized) return null;
	const parsed = Number(normalized);
	return Number.isFinite(parsed) ? parsed : null;
}

function inferCurrency(rows: Record<string, unknown>[]): string | undefined {
	for (const row of rows) {
		const explicit = firstString(row, ["currency", "priceCurrency"]);
		if (explicit) return explicit;
		if (row.priceEUR !== undefined) return "EUR";
		if (row.priceUsd !== undefined || row.priceUSD !== undefined) return "USD";
		const price = row.price;
		if (isRecord(price)) {
			const currency = firstString(price, ["currency"]);
			if (currency) return currency;
		}
		if (typeof price === "string") {
			const currency = inferCurrencyFromText(price);
			if (currency) return currency;
		}
		for (const key of ["priceText", "priceDisplay", "formattedPrice"]) {
			const currency = inferCurrencyFromText(firstString(row, [key]) ?? "");
			if (currency) return currency;
		}
	}
	return undefined;
}

function inferCurrencyFromText(value: string): string | undefined {
	if (value.includes("€")) return "EUR";
	if (value.includes("£")) return "GBP";
	if (value.includes("$")) return "USD";
	return undefined;
}

function normalizeTimelineStatus(value: string | undefined): string {
	const normalized = value?.toLowerCase().replace(/[\s_-]+/g, "") ?? "";
	if (
		/^(ok|done|success|succeeded|complete|completed|passed|healthy|published)$/.test(
			normalized,
		)
	) {
		return "completed";
	}
	if (
		/^(active|current|running|processing|inprogress|live)$/.test(normalized)
	) {
		return "current";
	}
	if (/^(pending|queued|waiting|scheduled|todo|draft)$/.test(normalized)) {
		return "pending";
	}
	if (/^(warn|warning|degraded|partial)$/.test(normalized)) {
		return "warning";
	}
	if (
		/^(error|failed|failure|blocked|unhealthy|rejected)$/.test(normalized) ||
		normalized.includes("blocked")
	) {
		return "error";
	}
	return "info";
}

function inferStatFormat(key: string, value: unknown): string {
	const lower = key.toLowerCase();
	if (/(rate|ratio|percent|percentage)/.test(lower)) return "percent";
	if (
		/(price|amount|revenue|cost|spend)/.test(lower) &&
		typeof value === "number"
	) {
		return "currency";
	}
	return typeof value === "number" || isNumericString(value)
		? "number"
		: "text";
}

function inferStatTone(key: string): string {
	const lower = key.toLowerCase();
	if (
		/(success|passed|healthy|complete|completed|active|published)/.test(lower)
	) {
		return "success";
	}
	if (/(warn|warning|pending|queued|waiting)/.test(lower)) return "warning";
	if (/(error|failed|failure|blocked|unhealthy|rejected)/.test(lower)) {
		return "danger";
	}
	return "default";
}

function statusBadgeVariant(value: string): string {
	const normalized = normalizeTimelineStatus(value);
	if (normalized === "completed") return "success";
	if (normalized === "warning" || normalized === "pending") return "warning";
	if (normalized === "error") return "destructive";
	return "secondary";
}

function statusTone(value: string): string {
	const normalized = normalizeTimelineStatus(value);
	if (normalized === "completed") return "success";
	if (normalized === "warning" || normalized === "pending") return "warning";
	if (normalized === "error") return "danger";
	if (normalized === "info" || normalized === "current") return "info";
	return "default";
}

function normalizeJsonRenderLayoutSpec(input: unknown): {
	valid: boolean;
	issues: string[];
	layoutSpec?: Record<string, unknown>;
} {
	const spec = recordFrom(input);
	if (!spec || !isNonEmptySpec(spec as never)) {
		return {
			valid: false,
			issues: ["layoutSpec must be a non-empty json-render object."],
		};
	}

	const initial = validateSpec(spec as never);
	if (initial.valid) {
		return { valid: true, issues: [], layoutSpec: spec };
	}

	const { spec: fixed } = autoFixSpec(spec as never);
	const fixedRecord = recordFrom(fixed);
	const recheck = validateSpec(fixed as never);
	if (fixedRecord && recheck.valid) {
		return { valid: true, issues: [], layoutSpec: fixedRecord };
	}

	return {
		valid: false,
		issues: readJsonRenderIssues(initial.issues ?? recheck.issues),
	};
}

function readJsonRenderIssues(issues: unknown): string[] {
	if (!Array.isArray(issues)) return ["Unknown json-render validation error."];
	const messages = issues
		.map((issue) => {
			const record = recordFrom(issue);
			return typeof record?.message === "string" ? record.message : null;
		})
		.filter((message): message is string => Boolean(message));
	return messages.length > 0
		? messages.slice(0, 8)
		: ["Unknown json-render validation error."];
}

function normalizeUiViewApp(
	serverCtx: ServerContext,
	input: UiViewInput,
): { id: string; slug: string; name: string; logoUrl?: string } {
	const slug = isWidgetAppSlug(input.appSlug)
		? input.appSlug
		: serverCtx.appSlug;
	const name =
		input.appName ??
		(slug === serverCtx.appSlug
			? (serverCtx.app?.name ?? humanizeSlug(slug))
			: humanizeSlug(slug));
	const logoUrl =
		input.logoUrl ??
		(slug === serverCtx.appSlug ? serverCtx.app?.logoUrl : undefined);
	return {
		id: input.appId ?? (slug === serverCtx.appSlug ? serverCtx.appId : slug),
		slug,
		name,
		...(logoUrl ? { logoUrl } : {}),
	};
}

function normalizeUiLayoutId(value: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/^\/?r\//, "")
		.replace(/\.html$/, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 72);
	return normalized || "generated-view";
}

function optionalString(value: unknown): string | undefined {
	const trimmed = typeof value === "string" ? value.trim() : "";
	return trimmed ? trimmed : undefined;
}

function normalizeUiVisualKind(value: unknown): UiVisualKind | undefined {
	return value === "auto" ||
		value === "categoricalCounts" ||
		value === "chart" ||
		value === "comparison" ||
		value === "details" ||
		value === "rankedMetrics" ||
		value === "stats" ||
		value === "summary" ||
		value === "table" ||
		value === "timeSeries" ||
		value === "timeline"
		? value
		: undefined;
}

// =============================================================================
// TOOL-NOT-FOUND SUGGESTIONS
// =============================================================================

/**
 * Token-overlap score between a missed tool name and an existing callable.
 * "list_skills" vs "skills.list_by_app_skills" → tokens {list, skills} vs
 * {skills, list, by, app} → overlap 2 / max 4 = 0.5.
 */
function scoreCallableMatch(missed: string, candidate: string): number {
	const missedTokens = new Set(
		missed.toLowerCase().split(/[._]+/).filter(Boolean),
	);
	const candidateTokens = new Set(
		candidate.toLowerCase().split(/[._]+/).filter(Boolean),
	);
	if (missedTokens.size === 0 || candidateTokens.size === 0) return 0;
	let overlap = 0;
	for (const token of missedTokens) {
		if (candidateTokens.has(token)) overlap += 1;
	}
	return overlap / Math.max(missedTokens.size, candidateTokens.size);
}

/** Top callables most similar to a missed tool name (token overlap ≥ ~1/3). */
function findClosestCallables(
	missed: string,
	callables: readonly string[],
	limit = 5,
): string[] {
	return callables
		.map((callable) => ({
			callable,
			score: scoreCallableMatch(missed, callable),
		}))
		.filter((entry) => entry.score >= 0.34)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((entry) => entry.callable);
}

const TOOL_NOT_FOUND_PATTERN = /Tool "([^"]+)" not found/;

/**
 * Enrich upstream's bare `Tool "X" not found` execution error with the
 * closest existing callables so the model self-corrects in one round trip
 * instead of retrying guessed name variants. Zero static context cost —
 * suggestions only ship when a guess misses.
 */
export function enrichToolNotFoundError(
	error: string,
	callables: readonly string[],
): string {
	const match = error.match(TOOL_NOT_FOUND_PATTERN);
	if (!match?.[1]) return error;
	const missed = match[1];
	const closest = findClosestCallables(missed, callables);
	const suggestions =
		closest.length > 0 ? ` Closest callables: ${closest.join(", ")}.` : "";
	return `${error}.${suggestions} Run discover.search({ query: "${missed.replace(/_/g, " ")}" }) and call the returned callable exactly.`;
}

const NOT_DEFINED_PATTERN = /\b([A-Za-z_$][\w$]*) is not defined\b/;

/**
 * Explain a missing binding that matches the gateway's potential namespaces.
 * That inventory does not prove exposure: explicit tool filters can exclude
 * every tool in a namespace, and upstream resolution can also fail. These
 * inputs identify neither cause, so report only the observed missing binding
 * and direct the caller to discovery on the current organization target.
 */
export function enrichUnmountedNamespaceError(
	error: string,
	knownNamespaces: ReadonlySet<string>,
	mountedNamespaces: ReadonlySet<string>,
	requestedNamespaces: ReadonlySet<string> | null,
): string {
	const missing = error.match(NOT_DEFINED_PATTERN)?.[1];
	if (!missing) return error;
	if (mountedNamespaces.has(missing)) return error;
	if (!knownNamespaces.has(missing)) return error;
	// Extraction is a regex over `ns.tool(` call sites: it sees `ns.tool(...)`
	// and `ns["tool"](...)`, but not `ns[variable](...)`. A snippet that reaches
	// a namespace dynamically therefore never asks for it, so no hydration is
	// even attempted and retrying is futile — a deterministic miss, not a flake.
	if (requestedNamespaces && !requestedNamespaces.has(missing)) {
		return `${error}. Namespace "${missing}" is unavailable in this request, and your snippet never requested it: namespace hydration uses literal \`ns.tool(args)\` call sites, and computed access like \`ns[variable](args)\` is invisible to that scan. Use discover.search on the current organization target to confirm exposure, then call the returned callable literally.`;
	}
	return `${error}. Namespace "${missing}" is unavailable in this request. The potential namespace inventory does not establish tool exposure or the cause of the missing binding. Use discover.search on the current organization target to find an exposed callable. This result does not establish an upstream failure or missing organization membership.`;
}

// =============================================================================
// PROVIDER RESOLUTION
// =============================================================================

/**
 * Convert namespace groups into resolved providers for the executor.
 */
function buildProviders(
	namespaceGroups: Map<string, NamespaceGroup>,
): ResolvedProvider[] {
	const providers: ResolvedProvider[] = [];

	for (const [ns, group] of namespaceGroups) {
		providers.push({
			name: ns,
			fns: group.fns as Record<
				string,
				(...args: unknown[]) => Promise<unknown>
			>,
		});
	}

	return providers;
}

// =============================================================================
// REGISTRATION
// =============================================================================

/**
 * Register the unified Code Mode `code` tool on an McpServer.
 *
 * All app tools are grouped by namespace and exposed as typed
 * methods in a single sandbox execution. A `catalog.*` namespace
 * provides tool discovery.
 *
 * Namespaces are auto-derived from endpoint prefixes. Per-app
 * overrides via mcpConfig.codeModeNamespaces in D1.
 *
 * Returns false if LOADER binding is not available (fallback to standard tools).
 */
export async function registerCodeModeTools(
	server: McpServer,
	serverCtx: ServerContext,
): Promise<boolean> {
	const env = serverCtx.env;

	if (!isCodeModeAvailable(env as unknown as Record<string, unknown>)) {
		console.warn(
			"[MCP] Code Mode requested but LOADER binding not available. Falling back to standard tools.",
		);
		return false;
	}

	const loader = env.LOADER as WorkerLoader;
	const mcpConfig = serverCtx.appMetadata?.mcpConfig as
		| Record<string, unknown>
		| undefined;
	const timeout =
		(mcpConfig?.codeModeTimeout as number | undefined) ??
		TEDI_DURABLE_CODE_GATEWAY_TIMEOUT_MS;
	// Per-app override for the model-facing result token budget (D1
	// mcpConfig.codeModeResultMaxTokens). Defaults to the @cloudflare/codemode
	// 6,000-token cap; oversized results always come back as a detectable
	// `__tedix_truncated` envelope, never a bare clipped string.
	const configuredResultMaxTokens = mcpConfig?.codeModeResultMaxTokens;
	const resultTruncationOptions: CodeModeTruncationOptions | undefined =
		typeof configuredResultMaxTokens === "number" &&
		Number.isFinite(configuredResultMaxTokens) &&
		configuredResultMaxTokens > 0
			? { maxTokens: configuredResultMaxTokens }
			: undefined;
	const namespaceOverrides = mcpConfig?.codeModeNamespaces as
		| Record<string, string>
		| undefined;
	const modules = mcpConfig?.codeModeModules as
		| Record<string, string>
		| undefined;

	const executor = new DynamicWorkerExecutor({
		loader: withModelAuthoredCodeIsolation(loader),
		timeout,
		globalOutbound: null,
		modules,
	});

	// Mutable refs for correlating code_exec → inner tool_calls and forwarding
	// outer MCP payment proofs into inner Code Mode tool calls.
	const executionRefs: CodeModeExecutionRefs = {
		authorizationDenial: undefined,
		replayUnsafeBuiltinCalls: 0,
		executionId: undefined,
		paymentExtra: undefined,
		paymentResponses: [],
		rpcCallCount: 0,
		rpcNamespaces: new Set(),
		sideEffectQueue: Promise.resolve(),
		failureBudget: new IdenticalFailureBudget(),
		discoverCalls: 0,
		discoverParameterRequests: 0,
		toolReceipts: [],
		skillWorkflowRunIds: new Set(),
		readObservations: [],
		collectionReads: [],
	};

	const collisionOwners = codeModeCollisionOwners(
		serverCtx,
		namespaceOverrides,
	);
	for (const [ownerKey, owners] of collisionOwners) {
		console.warn(
			JSON.stringify({
				component: "mcp.codemode",
				event: "tool_collision_quarantined",
				ownerKey,
				owners,
			}),
		);
	}
	const collisionKeys = new Set(collisionOwners.keys());

	// Build namespace groups from D1 tools. Every owner of an ambiguous
	// projected key is quarantined; choosing one by insertion order would route
	// a model call to the wrong installed app.
	const namespaceGroups = buildNamespaceGroups(
		serverCtx,
		namespaceOverrides,
		executionRefs,
		collisionKeys,
	);
	const appToolCount = serverCtx.loadedTools.size;
	const quarantinedToolCount = [...collisionOwners.values()].reduce(
		(sum, owners) => sum + owners.length,
		0,
	);
	const exposedToolCount =
		appToolCount -
		quarantinedToolCount +
		UI_TOOL_COUNT +
		CODEMODE_TOOL_COUNT +
		FLOW_TOOL_COUNT;
	const namespaceCount = new Set([
		...namespaceGroups.keys(),
		UI_NAMESPACE,
		CODEMODE_NAMESPACE,
		FLOW_NAMESPACE,
	]).size;
	const moduleNames = modules ? Object.keys(modules) : [];

	// Build catalog provider (search + describe + list_namespaces)
	const catalogProvider = buildCatalogProvider(
		serverCtx,
		namespaceOverrides,
		executionRefs,
		collisionKeys,
	);
	const resolvedCatalog = resolveProvider(catalogProvider);
	const resolvedUiProvider = resolveProvider(buildUiProvider(serverCtx));
	for (const name of ["create_view", "create_mcp_app", "create_health_sweep"]) {
		const execute = resolvedUiProvider.fns[name];
		if (!execute) continue;
		resolvedUiProvider.fns[name] = async (...args: unknown[]) => {
			executionRefs.replayUnsafeBuiltinCalls++;
			return execute(...args);
		};
	}
	const resolvedRuntimeProvider = resolveProvider(
		buildRuntimeProvider(serverCtx, executionRefs, () => ({
			modules: moduleNames,
			namespaceCount,
			toolCount: exposedToolCount,
		})),
	);

	// Build tool providers per namespace
	const toolProviders = buildProviders(namespaceGroups);

	// Potential namespaces from aggregate config vs bindings actually mounted.
	// The difference supports discovery guidance, but does not identify why a
	// namespace is absent (for example, explicit filters or resolution failure).
	const knownAggregateNamespaces = configuredAggregateNamespaces(
		mcpConfig ?? null,
	);
	const mountedNamespaces = new Set<string>([
		...namespaceGroups.keys(),
		resolvedCatalog.name,
		CODEMODE_NAMESPACE,
		UI_NAMESPACE,
		FLOW_NAMESPACE,
	]);

	const resolvedFlowProvider = resolveProvider(
		buildFlowProvider(namespaceGroups, (namespace, toolName) => {
			const owner = [...serverCtx.loadedTools].find(([toolId, tool]) => {
				const identity = projectedToolIdentity(
					toolId,
					tool,
					namespaceOverrides,
				);
				return (
					identity.safeName === toolName &&
					(identity.namespace === namespace ||
						NAMESPACE_PEER_ALIASES.get(identity.namespace) === namespace)
				);
			});
			if (!owner)
				throw new Error(`flow: ${namespace}.${toolName} has no mounted owner`);
			const decision = evaluateMcpToolScopeAuthorization(
				serverCtx,
				owner[1],
				namespace,
			);
			if (!decision.authorized)
				throw new Error(
					`flow: ${namespace}.${toolName} is not authorized; missing scopes: ${decision.missingScopes.join(", ")}`,
				);
		}),
	);

	// All providers: catalog + built-ins + per-namespace tool providers
	const allProviders: ResolvedProvider[] = [
		resolvedCatalog,
		resolvedRuntimeProvider,
		resolvedUiProvider,
		resolvedFlowProvider,
		...toolProviders,
	];

	// Full callable inventory ("ns.tool_name") — fuels tool-not-found
	// suggestions on execution errors. Never shipped in the description.
	const allCallables: string[] = allProviders.flatMap((provider) =>
		Object.keys(provider.fns).map((toolName) => `${provider.name}.${toolName}`),
	);

	// Build namespace summary for tool description
	const nsSummary = Array.from(namespaceGroups.entries())
		.sort(
			([, a], [, b]) => Object.keys(b.fns).length - Object.keys(a.fns).length,
		)
		.map(([ns, g]) => `${ns} (${Object.keys(g.fns).length})`)
		.concat(`${CODEMODE_NAMESPACE} (${CODEMODE_TOOL_COUNT})`)
		.concat(`${UI_NAMESPACE} (${UI_TOOL_COUNT})`)
		.concat(`${FLOW_NAMESPACE} (${FLOW_TOOL_COUNT})`)
		.join(", ");

	// Build module availability hint for tool description
	const moduleHint =
		moduleNames.length > 0
			? `\nAvailable modules (use import): ${moduleNames.join(", ")}\n`
			: "";

	// Build compact type declarations only while they can realistically fit in the
	// MCP tool description. Large aggregate servers already fall back to discovery,
	// so generating hundreds of KB of types only to discard them is wasted CPU.
	const shouldInlineCompactTypes =
		exposedToolCount <= MAX_INLINE_COMPACT_TYPE_TOOLS;
	const compactTypes = shouldInlineCompactTypes
		? buildCompactTypes(namespaceGroups)
		: "";

	// Assemble code tool description with hard budget
	const preamble =
		`Execute JavaScript to call this app's ${exposedToolCount} tools across ${namespaceCount} namespaces.\n` +
		`Namespaces: ${nsSummary}\n` +
		`Discovery: use discover.search("keyword") first. Search results are ranked and include callable plus _match.matchedTerms/unmatchedTerms; execute the callable value exactly. name/displayName are labels only. Inspect annotations.destructiveHint / readOnlyHint before calling — destructive tools may prompt the user; read-only tools are safe to call freely. Rows also carry caller-relative authorization: authorized: false with requiredScopes/missingScopes means discoverable but not executable for this caller — skip it instead of burning a failed call. Discovery is compact by default — outputSchema and parameters are omitted; pass { includeOutputSchema: true } to get return shapes for planning downstream composition, and { includeParameters: true } for exact input schemas. schemaFreshness and meta.freshness show D1 schema sync timestamps and the catalog build time when you need to diagnose stale discovery. Search returns { results, namespaces, meta } (a plain object; iterate results). If search returns no rows, inspect meta.discovery.nearestNamespaces/suggestedQueries before declaring a capability unavailable. list_namespaces() returns an object keyed by namespace (use Object.keys/Object.entries, not .filter/.map directly); pass { includeTools: true } only for inventory.\n` +
		`Execution: namespace.tool_name({ param: value }) using the discover.search(...).*.callable field or the compact type signatures below.\n` +
		`discover.search returns a real Array of ranked tools with { results: [...], _meta, ...namespace keys } attached; \`const tools = await discover.search("skills"); tools.slice(0, 5)\` and \`const { results } = await discover.search(...)\` are both valid.\n` +
		`Example: const tools = await discover.search({ query: "skills" }); const callable = tools.slice(0, 1)[0]?.callable; // e.g. "skills.find_skills" — call await skills.find_skills({ ... }). Never guess tool names: a namespace existing does NOT mean a guessed name inside it exists; on "not found" errors, search again and use the returned callable verbatim.\n` +
		`Sandbox globals are only the listed provider namespaces plus standard JavaScript built-ins; there is no host, fs, require, process, or external fetch. Use provider tools for all side effects.\n` +
		`Evidence: every operational result includes completionEvidence. Claim only supportedClaims, cite evidenceRefs, and never infer job completion from exec acceptance; poll read_execution to terminal evidence. When retry.blocked is true, change the arguments or execution plan.\n` +
		`Runtime proof: call codemode.__runtime() when you need the current executionId, app/org, actor, traceId, module names, tool counts, or direct-gateway execution-surface evidence.\n` +
		`Long multi-step work: your cost is turns x context window, so do NOT run a long tool-call loop through your own context. For ~10+ platform/tool steps (sweeps, watches, migrations, fan-out judging), use flow.run({ source, capabilities }) — it records an EPHEMERAL skill workflow and starts it in one call; the steps run in a durable Cloudflare Workflow off your context and only the bounded return value comes back (put bulk output in an artifact and return the reference; poll flow.status later, never busy-wait). Tedix CLI users: \`tedix flow run --file plan.ts --watch\`. Decision rules: read the org skill "agent-context-efficiency" via skills.find_skills.\n` +
		`Visuals: when a visual answer is clearer, fetch and shape the data in the same run and return an MCP UI result directly. For a bespoke but catalog-constrained interface, inspect ui.get_catalog(), author layoutSpec, validate with ui.validate_layout(), then return ui.create_view({ data, title, appSlug, layoutSpec }); this is true generative UI, not a preset selector. Omit layoutSpec only when an inferred native comparison, chart/time-series, dashboard, ranking, timeline, stats, table, or summary is sufficient. If the catalog cannot express the requested presentation, return ui.create_mcp_app({ title, summary, data, html }) for a transient free-form HTML/CSS MCP App; its nested sandbox disables scripts and external capabilities, and larger or reusable apps must use the generated-widget artifact QA/publish lane. For reliable inferred record tables prefer data: { items: [{ ... }] }; a bare record array is also accepted and normalized under rows. When a tool/workflow result references a generated media artifact (e.g. artifactPath "outputs/generate-image.json" with a runId), embed it in your chat answer as markdown on its own line using the relative session-authed path ![desc](/skill-runs/{runId}/media/{artifactPath}) (append ?kind=video for video) — never signed /skill-media/...?exp&sig or absolute https://api.* URLs. For multi-provider/tool health checks, return ui.create_health_sweep({ checks, title }) after probing the requested namespaces. Do not stop at discovery or raw tool data first unless explicitly asked.\n\n` +
		`Paid inner tools may return payment requirements. Return that object directly; an x402 v2 challenge is an error CallToolResult with _meta["x402/error"] and _meta["x-tedix/payment-required"]. Retry with _meta["x402/payment"] or this code tool's top-level payment argument. Legacy v1 challenges may still use JSON-RPC 402.\n` +
		"Write an async arrow function. Chain multiple calls, add conditionals, loops, and error handling.\n" +
		"Do NOT use TypeScript syntax. Do NOT define named functions then call them.\n" +
		moduleHint;

	const compactTypesBlock = compactTypes
		? `\n\n${compactTypes}`
		: `\n\n(${exposedToolCount} tools across ${namespaceCount} namespaces — use discover.search() first; list_namespaces() is count-only unless includeTools is true)`;
	const typesBlock = `\n${catalogProvider.types}\n\n${CODEMODE_PROVIDER_TYPES}\n\n${UI_PROVIDER_TYPES}\n\n${FLOW_PROVIDER_TYPES}${compactTypesBlock}`;
	let description = preamble + typesBlock;
	let descriptionTruncated = false;

	if (description.length > MAX_CODEMODE_DESCRIPTION_CHARS) {
		// Truncation fallback: keep preamble + discovery types, drop per-tool types
		description = `${preamble}\n${catalogProvider.types}\n\n${CODEMODE_PROVIDER_TYPES}\n\n${UI_PROVIDER_TYPES}\n\n${FLOW_PROVIDER_TYPES}\n\n(${exposedToolCount} tools across ${namespaceCount} namespaces — use discover.search() first; list_namespaces() is count-only unless includeTools is true)`;
		descriptionTruncated = true;
	}

	console.log(
		`[MCP] Code Mode description: preamble=${preamble.length} compactTypes=${compactTypes.length} compactTypesInlined=${shouldInlineCompactTypes} total=${description.length} budget=${MAX_CODEMODE_DESCRIPTION_CHARS} descriptionTruncated=${descriptionTruncated}`,
	);

	// Register single unified code tool
	server.registerTool(
		"code",
		{
			description,
			annotations: CODE_MODE_TOOL_ANNOTATIONS,
			_meta: codeModeSecurityMeta(mcpConfig),
			inputSchema: z.object({
				code: z
					.string()
					.describe(
						"JavaScript async arrow function. Example: async () => { const posts = await blog.list_blog_posts({}); return posts; }",
					),
				payment: z
					.union([z.string().min(1), z.record(z.string(), z.unknown())])
					.optional()
					.describe(
						'Optional x402 payment proof for paid inner tools. Accepts an encoded facilitator payment string or an object proof and forwards it as _meta["x402/payment"] for clients that cannot set MCP request _meta directly.',
					),
			}),
		},
		async ({ code, payment }, ctx?: McpCtx) => {
			const extra = {
				_meta: resolveToolRequestMeta(
					ctx?.mcpReq?._meta,
					serverCtx.requestMeta,
				),
			};
			const execStart = Date.now();
			const executionId = crypto.randomUUID();
			const waitUntil = serverCtx.ctx.waitUntil.bind(serverCtx.ctx);
			const organizationId = serverCtx.app.organizationId;

			const emitExecTelemetry = (
				success: boolean,
				errorMsg?: string,
				resultMetrics?: {
					resultChars: number;
					resultTokensApprox: number;
					resultTruncated: boolean;
				},
			) => {
				const durationMs = Date.now() - execStart;
				const toolCount = executionRefs.rpcCallCount;
				const accessedNamespaceCount = executionRefs.rpcNamespaces.size;
				const discoverCalls = executionRefs.discoverCalls;
				const discoverParameterRequests =
					executionRefs.discoverParameterRequests;
				console.log(
					JSON.stringify({
						_cm: "exec",
						...codeModeTailContext(serverCtx, executionId),
						toolCount,
						namespaceCount: accessedNamespaceCount,
						totalDurationMs: durationMs,
						codeLength: code.length,
						// Cost-shape telemetry: what the model
						// actually re-reads, and how it discovered. Without these payload
						// amplification is invisible server-side.
						discoverCalls,
						discoverParameterRequests,
						// Spreading undefined is a no-op, so no fallback object needed.
						...resultMetrics,
						success,
						...(errorMsg && { error: errorMsg.slice(0, 200) }),
					}),
				);
				writeCodeModeAnalytics(serverCtx, {
					eventType: "exec",
					appId: serverCtx.appId,
					appSlug: serverCtx.appSlug,
					organizationId,
					toolName: "code",
					errorCode: errorMsg?.slice(0, 200),
					userId: serverCtx.callerIdentity?.userId,
					tediId: serverCtx.callerIdentity?.tediId,
					authType: serverCtx.callerIdentity?.authType,
					executionId,
					traceId: serverCtx.traceId,
					durationMs,
					codeLength: code.length,
					toolCount,
					namespaceCount: accessedNamespaceCount,
					discoverCalls,
					discoverParameterRequests,
					resultChars: resultMetrics?.resultChars,
					resultTokensApprox: resultMetrics?.resultTokensApprox,
					resultTruncated: resultMetrics?.resultTruncated,
					success,
				});

				const event: McpEvent = {
					timestamp: new Date().toISOString(),
					eventType: "code_exec",
					appId: serverCtx.appId,
					appSlug: serverCtx.appSlug,
					organizationId,
					toolName: "code",
					traceId: serverCtx.traceId,
					executionId,
					userId: serverCtx.callerIdentity?.userId,
					tediId: serverCtx.callerIdentity?.tediId,
					clientId: serverCtx.callerIdentity?.clientId,
					authType: serverCtx.callerIdentity?.authType,
					durationMs,
					success,
					toolInputSize: code.length,
					...(errorMsg && { errorMessage: errorMsg.slice(0, 500) }),
					metadata: {
						...buildCallerAuditMetadata(serverCtx.callerIdentity),
						...callerOrganizationMetadata(serverCtx),
						toolCount: exposedToolCount,
						namespaceCount,
					},
				};
				trackMcpEvent(serverCtx.env, event);
				emitMcpAuditEvent(serverCtx.env, event, waitUntil);
			};

			// This receipt comes from the trusted dispatch gate, never sandbox text.
			// Only an untouched program may be replayed by the host after OAuth.
			const authorizationFailure = () => {
				const denial = executionRefs.authorizationDenial;
				if (!denial) return undefined;
				const canChallenge =
					executionRefs.rpcCallCount === 0 &&
					executionRefs.replayUnsafeBuiltinCalls === 0 &&
					denial.missingScopes.length > 0 &&
					denial.requiredScopes.every((scope) =>
						/^mcp:[a-z][a-z0-9_.:-]*$/.test(scope),
					);
				return attachCodeModeReadObservations(
					{
						isError: true,
						content: [
							{
								type: "text" as const,
								text:
									denial.message +
									(canChallenge
										? " Authorize the required access before retrying."
										: " Review the execution receipts before retrying; this program may have dispatched earlier calls."),
							},
						],
						structuredContent: {
							executionId,
							error: denial.message,
							requiredScopes: denial.requiredScopes,
							missingScopes: denial.missingScopes,
							toolReceipts: executionRefs.toolReceipts,
							dispatchedCalls: executionRefs.rpcCallCount,
							replayUnsafeBuiltinCalls: executionRefs.replayUnsafeBuiltinCalls,
						},
						...(canChallenge
							? {
									_meta: {
										"mcp/www_authenticate": [
											`Bearer error="insufficient_scope", error_description="Additional Tedix access is required.", scope="${denial.requiredScopes.join(" ")}"`,
										],
									},
								}
							: {}),
					},
					executionRefs.readObservations,
					executionRefs.collectionReads,
				);
			};

			try {
				executionRefs.authorizationDenial = undefined;
				executionRefs.replayUnsafeBuiltinCalls = 0;
				executionRefs.executionId = executionId;
				executionRefs.paymentExtra = buildPaymentExtra(extra, payment);
				executionRefs.paymentResponses = [];
				executionRefs.rpcCallCount = 0;
				executionRefs.rpcNamespaces.clear();
				executionRefs.discoverCalls = 0;
				executionRefs.discoverParameterRequests = 0;
				executionRefs.failureBudget = new IdenticalFailureBudget();
				executionRefs.toolReceipts = [];
				executionRefs.skillWorkflowRunIds.clear();
				executionRefs.readObservations = [];
				executionRefs.collectionReads = [];
				// Workers custom spans are beta: diagnostic timing only, never an
				// SLO gate or proof artifact. IDs identify the execution; code and
				// returned values stay out of span attributes.
				const result = await tracing.enterSpan(
					"tedix.mcp.code_exec",
					async (span) => {
						span.setAttribute("tedix.trace_id", serverCtx.traceId);
						span.setAttribute("tedix.app_id", serverCtx.appId);
						span.setAttribute("tedix.execution_id", executionId);
						return runStatelessCodeMode({
							code,
							executor,
							providers: allProviders,
						});
					},
				);
				const scopeFailure = authorizationFailure();
				if (scopeFailure) {
					emitExecTelemetry(false, executionRefs.authorizationDenial!.message);
					return scopeFailure;
				}
				const paymentResponses = executionRefs.paymentResponses;

				const paymentRequired = findPaymentRequiredMeta(result.result);
				if (paymentRequired) {
					emitExecTelemetry(
						false,
						`Payment required for inner tool "${paymentRequired.toolId}"`,
					);
					return attachCodeModeReadObservations(
						buildPaymentRequiredResult(paymentRequired),
						executionRefs.readObservations,
						executionRefs.collectionReads,
					);
				}

				// The Cloudflare codemode SDK never throws on a thrown
				// JS/ReferenceError inside executed code — it returns
				// `{ result: undefined, error: <msg> }`. Without this guard the
				// success path below shapes `undefined` into a silent
				// `result: null` and reports the run as succeeded.
				if (result.error) {
					const enrichedError = enrichUnmountedNamespaceError(
						enrichToolNotFoundError(
							stripUpstreamCodeFailurePrefix(result.error),
							allCallables,
						),
						knownAggregateNamespaces,
						mountedNamespaces,
						serverCtx.requestedCodeModeNamespaces,
					);
					emitExecTelemetry(false, enrichedError);
					return attachCodeModeReadObservations(
						{
							content: [
								{
									type: "text" as const,
									text: `Execution error: ${enrichedError}`,
								},
							],
							isError: true,
							structuredContent: {
								executionId,
								error: enrichedError,
							},
						},
						executionRefs.readObservations,
						executionRefs.collectionReads,
					);
				}

				// The result token budget (default 6k tokens ≈ 24k indented chars) is
				// a MODEL prompt bound. A skill-runtime service-binding caller
				// (skillRunId identity) is a machine consumer whose transport already
				// enforces its own byte cap — clipping here would bound a bound.
				// Model-facing callers get the detectable `__tedix_truncated`
				// envelope on overflow instead of a silent clipped string.
				const modelResult = serverCtx.callerIdentity?.skillRunId
					? serializeCodeModeResult(result.result)
					: shapeCodeModeResultForModel(result.result, resultTruncationOptions);
				const baseIdentity = structuredResultIdentity(result.result);
				const resultIdentity =
					executionRefs.skillWorkflowRunIds.size > 0
						? {
								...(baseIdentity ?? {}),
								skillWorkflowRuns: [...executionRefs.skillWorkflowRunIds],
							}
						: baseIdentity;
				const resultProjection = structuredUiResultProjection(result.result);
				const executionReceipt = buildCodeModeExecutionReceipt(
					executionRefs.toolReceipts,
				);
				// Failed inner calls surface by name and cause on the outer result:
				// programs return hand-built projections that swallow ok:false inner
				// envelopes, so without this an audit has to stringify every inner
				// result to find (e.g.) a scope denial.
				const innerFailures = executionRefs.toolReceipts
					.filter(
						(receipt) =>
							receipt.status === "failed" || receipt.status === "canceled",
					)
					.slice(0, 10)
					.map((receipt) => ({
						tool: receipt.operation,
						...(receipt.error ? { error: receipt.error } : {}),
					}));
				const output: Record<string, unknown> = {
					executionId,
					result: modelResult ?? null,
					...(innerFailures.length > 0 ? { failures: innerFailures } : {}),
					...(resultIdentity ? { resultIdentity } : {}),
					...(resultProjection ? { resultProjection } : {}),
					...(executionReceipt ? { completionEvidence: executionReceipt } : {}),
				};
				if (result.logs?.length) {
					output.logs = boundCodeModeLogs(result.logs, resultTruncationOptions);
				}
				// Serialized ONCE: this exact text is both the returned content and
				// the measured response size, so telemetry can never drift from what
				// the model was actually sent.
				const outputText = JSON.stringify(output, null, 2);
				emitExecTelemetry(true, undefined, {
					resultChars: outputText.length,
					// Same chars-per-token heuristic as the truncation budget.
					resultTokensApprox: Math.ceil(outputText.length / 4),
					resultTruncated:
						isRecord(modelResult) && modelResult.__tedix_truncated === true,
				});
				const paymentResponseMeta =
					paymentResponses.length === 0
						? undefined
						: paymentResponses.length === 1
							? paymentResponses[0]
							: { settled: true, payments: paymentResponses };
				const projectedMeta = codeModeResultMeta(result.result) ?? {};
				delete projectedMeta[READ_OBSERVATION_META_KEY];
				delete projectedMeta[READ_OBSERVATIONS_META_KEY];
				delete projectedMeta[READ_COLLECTION_META_KEY];
				delete projectedMeta[READ_COLLECTIONS_META_KEY];
				const resultMeta = {
					...projectedMeta,
					...codeModeReadObservationMeta(executionRefs.readObservations),
					...codeModeCollectionReadMeta(executionRefs.collectionReads),
					...(paymentResponseMeta
						? { [X402_PAYMENT_RESPONSE_META_KEY]: paymentResponseMeta }
						: {}),
				};

				return {
					content: [
						{
							type: "text" as const,
							text: outputText,
						},
					],
					structuredContent: output,
					...(Object.keys(resultMeta).length > 0 ? { _meta: resultMeta } : {}),
				};
			} catch (error) {
				const scopeFailure = authorizationFailure();
				if (scopeFailure) {
					emitExecTelemetry(false, executionRefs.authorizationDenial!.message);
					return scopeFailure;
				}
				const rawError = error instanceof Error ? error.message : String(error);
				// "Tool not found" guesses get nearest-callable suggestions so the
				// model self-corrects instead of retrying name variants.
				const enrichedError = enrichUnmountedNamespaceError(
					enrichToolNotFoundError(
						stripUpstreamCodeFailurePrefix(rawError),
						allCallables,
					),
					knownAggregateNamespaces,
					mountedNamespaces,
					serverCtx.requestedCodeModeNamespaces,
				);
				emitExecTelemetry(false, enrichedError);
				return attachCodeModeReadObservations(
					{
						content: [
							{
								type: "text" as const,
								text: `Execution error: ${enrichedError}`,
							},
						],
						isError: true,
						structuredContent: {
							executionId,
							error: enrichedError,
						},
					},
					executionRefs.readObservations,
					executionRefs.collectionReads,
				);
			} finally {
				executionRefs.authorizationDenial = undefined;
				executionRefs.replayUnsafeBuiltinCalls = 0;
				executionRefs.executionId = undefined;
				executionRefs.paymentExtra = undefined;
				executionRefs.paymentResponses = [];
				executionRefs.rpcCallCount = 0;
				executionRefs.rpcNamespaces.clear();
				executionRefs.discoverCalls = 0;
				executionRefs.discoverParameterRequests = 0;
				executionRefs.toolReceipts = [];
				executionRefs.readObservations = [];
				executionRefs.collectionReads = [];
				executionRefs.skillWorkflowRunIds.clear();
				executionRefs.sideEffectQueue = Promise.resolve();
			}
		},
	);

	console.log(
		`[MCP] Code Mode enabled: 1 code tool wrapping ${appToolCount} app tools plus ${UI_TOOL_COUNT} ui tools across ${namespaceCount} namespaces`,
	);

	return true;
}
