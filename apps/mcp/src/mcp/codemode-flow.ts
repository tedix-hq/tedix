import { type NamespaceGroup } from "@tedix/mcp-shared/compact-types";
import { type ToolProvider, sanitizeToolName } from "@cloudflare/codemode";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { recordFrom } from "./codemode-ui";
import { jsonSchemaToInputSchema } from "./utils/schema";
import { type ToolJsonSchema } from "@tedix/api-contract/schemas/tools";

export const FLOW_NAMESPACE = "flow";

export const FLOW_TOOL_COUNT = 5;

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

export type SkillWorkflowSurface =
	(typeof SKILL_WORKFLOW_SURFACES)[keyof typeof SKILL_WORKFLOW_SURFACES];

export const SKILL_WORKFLOW_SURFACE_BY_TEDI_TOOL = new Map<
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
							// JSON strings are valid YAML double-quoted scalars, so a ": ",
							// quote, or newline in the value cannot break the frontmatter.
							`name: ${JSON.stringify(name)}`,
							`description: ${JSON.stringify(description)}`,
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

export const FLOW_CATALOG_TOOLS = {
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
