import { type NamespaceGroup } from "@tedix/mcp-shared/compact-types";
import { type ToolProvider, sanitizeToolName } from "@cloudflare/codemode";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { recordFrom } from "./codemode-ui";
import { jsonSchemaToInputSchema } from "./utils/schema";
import { type ToolJsonSchema } from "@tedix/api-contract/schemas/tools";
import {
	FlowWatchInputSchema,
	WATCH_CHECK_CALLABLES,
	normalizeFlowWatchInput,
} from "@tedix/api-contract/schemas/flow-watch";

export const FLOW_NAMESPACE = "flow";

export const FLOW_TOOL_COUNT = 8;

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

const WATCH_START_TOOL = "start_work_item_watch";
const WATCH_CANCEL_TOOL = "cancel_skill_workflow";
/** Contract-named run tools on an organization's admin surface. */
const ADMIN_SURFACE_RUN_TOOLS: Record<string, string> = {
	get_skill_workflow_status: "run_workflow_status",
	cancel_skill_workflow: "run_workflow_cancel",
};

const FLOW_PROVIDER_TYPES = [
	"declare namespace flow {",
	'  type WorkspaceContextRef = { kind: "file" | "resource" | "output" | "link" | "structured"; uri: string; revision?: string; label?: string };',
	"  /** Run a multi-step job OFF your context window: records `source` as an EPHEMERAL draft skill automation, a scripts/workflow.ts file (never scheduled, auto-archives unused), and starts it in one call. `source` is a Cloudflare Workflow module: export default { async run(event, step, env) { ... } } using step.do/sleep and env.MCP.<namespace>.<tool>(args) for every capability DECLARED in `capabilities.mcp`. The automation runs durably server-side; only its RETURN VALUE ever reaches your context, so return counts/ids/verdicts and put bulk output in an artifact. Returns { skillId, runId } — poll flow.status later (the run outlives this execution; do NOT busy-wait here). */",
	"  function run(input: { source?: string; skillId?: string; name?: string; description?: string; skillDoc?: string; capabilities?: { mcp?: Record<string, string[]>; network?: boolean; reason?: { maxCalls?: number } }; params?: Record<string, unknown>; workspaceContext?: WorkspaceContextRef[]; workItemId?: string; tediSlug?: string; reason?: string }): Promise<{ skillId: string; runId: string; status: string; tediSlug: string; workItemId: string | null; workspaceContext: WorkspaceContextRef[] }>;",
	"  /** Save a workflow module YOU wrote (same shape as flow.run source) as a draft skill tagged code-saved, WITHOUT running it. Returns { skillId, revision }; start it later with flow.run({ skillId }). */",
	"  function save(input: { source: string; name: string; description?: string; skillDoc?: string; capabilities?: { mcp?: Record<string, string[]>; network?: boolean; reason?: { maxCalls?: number } } }): Promise<{ skillId: string; revision: number | null }>;",
	"  /** Compact lifecycle poll for a flow run: { status, output, error, durationMs }. Terminal statuses: completed | failed | canceled. */",
	"  function status(input: { runId: string; tediSlug?: string }): Promise<{ status: string | null; output: unknown; error: unknown; durationMs: number | null }>;",
	"  /** Full evidence view (steps, tool-call receipts, artifacts, warnings) — reach for it when a run FAILED, not per poll. */",
	"  function inspect(input: { runId: string; tediSlug?: string }): Promise<unknown>;",
	"  /** Recent flow-authored automation runs for the selected tedi. Persistent and scheduled skill runs stay in list_skill_workflow_history. */",
	"  function list(input?: { limit?: number; tediSlug?: string }): Promise<unknown>;",
	"  /** List the exact env.MCP.tedi methods reachable by an automation on this gateway. Call this before authoring a manifest instead of guessing from the broader Code Mode catalog. */",
	"  function tools(input?: { tediSlug?: string }): Promise<{ tediSlug: string; namespace: string; methods: string[]; manifest: { mcp: { tedi: string[] } } }>;",
	'  /** Wait for a Work Item status OFF your context: a durable watch checks it every `every` (>= 15 s) until `until` matches, maxChecks (<= 100) is used or the deadline (<= 24 h) passes. Returns { runId } at once; end your turn and read the outcome later with flow.status (output.outcome: matched | max_checks | deadline | check_failed). At most 20 open watches per organization. On an organization admin surface pass tediSlug, e.g. "tedix_unified_tedix". until is a rule, not code: { path: "disposition", in: ["completed"] } | { path, eq } | { path, gte }. */',
	'  function watch(input: { check: { callable: "work.item_status"; args: { workItemId: string } }; until: { path: string; in?: Array<string | number | boolean>; eq?: string | number | boolean; gte?: number }; every: number | string; maxChecks?: number; deadline?: number | string; tediSlug?: string; reason?: string }): Promise<{ runId: string; status: string; tediSlug: string; workItemId: string; everySeconds: number; maxChecks: number; deadlineAt: string }>;',
	"  /** Stop a flow run (a watch or any flow.run job). */",
	"  function cancel(input: { runId: string; tediSlug?: string; reason?: string }): Promise<unknown>;",
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
		if (namespaceGroups.get("skills")?.fns[tool]) return "skills";
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

	// An organization's admin surface (e.g. tedix_unified_tedix) projects the
	// same run procedures under their contract names and has no tedi of its
	// own. With an explicit tediSlug naming such a surface, use those names.
	const resolveRunTool = (
		input: Record<string, unknown>,
		tool: string,
	): { namespace: string; tool: string } => {
		const alias = ADMIN_SURFACE_RUN_TOOLS[tool];
		const explicit =
			typeof input.tediSlug === "string" &&
			/^[a-z0-9_-]{1,64}$/i.test(input.tediSlug.trim())
				? sanitizeToolName(input.tediSlug.trim())
				: "";
		const group = explicit ? namespaceGroups.get(explicit) : undefined;
		if (alias && group && !group.fns[tool] && group.fns[alias])
			return { namespace: explicit, tool: alias };
		return { namespace: resolveTediNamespace(input, tool), tool };
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

	/**
	 * Record `source` as a draft skill through skills.record_skills — the one
	 * path flow.run and flow.save share, so the near-duplicate gate, slug rules
	 * and validation stay the library's.
	 */
	const recordDraft = async (
		verb: "flow.run" | "flow.save",
		input: Record<string, unknown>,
		draft: {
			name: string;
			description: string;
			source: string;
			tag: "flow-ephemeral" | "code-saved";
			note: string[];
		},
	): Promise<{ skillId: string; revision: number | null }> => {
		const { name, description } = draft;
		// The capability manifest rides SKILL.md frontmatter. JSON is valid
		// YAML, so the declared object embeds verbatim — the platform validator
		// stays the single authority on its shape.
		const capabilities = recordFrom(input.capabilities) ?? {};
		const content =
			typeof input.skillDoc === "string" && input.skillDoc.trim()
				? input.skillDoc
				: [
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
						...draft.note,
						"",
					].join("\n");
		let recorded: unknown;
		try {
			recorded = await call("skills", "record_skills", {
				title: name,
				description,
				content,
				files: { "scripts/workflow.ts": draft.source },
				tags: [draft.tag],
				lifecycleState: "draft",
				validate: "error",
			});
		} catch (error) {
			// The library's near-duplicate gate is the wrong shape for ephemeral
			// RERUNS (a retry is a near-dupe of itself by definition), but silently
			// mutating the 90%-similar skill it names would be worse — that could
			// be a real library asset. Turn the refusal into the rerun path instead.
			const message = error instanceof Error ? error.message : String(error);
			const suggested = message.match(
				/improve_skills\(\{ id: "([0-9a-f-]{36})"/,
			)?.[1];
			if (suggested) {
				throw new Error(
					`${verb}: an equivalent skill already exists (${suggested}). Rerun it as-is with flow.run({ skillId: "${suggested}", params }), or change the automation body if this is genuinely new. Original: ${message}`,
				);
			}
			throw error;
		}
		// Handlers nest the created row (live shape: { entry: {...} }); tolerate
		// top-level and the sibling wrappers too.
		const recordedRow = recordFrom(recorded) ?? {};
		const nested =
			recordFrom(recordedRow.entry) ??
			recordFrom(recordedRow.skill) ??
			recordFrom(recordedRow.data) ??
			recordedRow;
		const foundId = nested.id ?? nested.skillId ?? recordedRow.id;
		if (typeof foundId !== "string" || !foundId) {
			throw new Error(
				`${verb}: draft was recorded without an id — inspect skills.record_skills output directly`,
			);
		}
		return {
			skillId: foundId,
			revision: typeof nested.revision === "number" ? nested.revision : null,
		};
	};

	return {
		name: FLOW_NAMESPACE,
		tools: {
			tools: {
				description:
					"List the exact env.MCP.tedi methods reachable by a flow on this gateway. Use this before writing capabilities.mcp.tedi; the broader Code Mode catalog may contain tools that the automation bridge does not project.",
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
					"Record an ephemeral draft skill automation (a scripts/workflow.ts file) from source and start it in ONE call — or rerun an existing one by passing skillId instead of source. The steps run in a durable Cloudflare Workflow off your context; only the bounded return value comes back. Returns { skillId, runId } immediately — poll flow.status later instead of waiting.",
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
							"flow.run requires `source` (an automation module string — export default { async run(event, step, env) { ... } }) or `skillId` to rerun an existing automation",
						);
					}
					const name =
						typeof input.name === "string" && input.name.trim()
							? input.name.trim().slice(0, 80)
							: "flow-ephemeral";
					const description =
						typeof input.description === "string" && input.description.trim()
							? input.description.trim()
							: "Ephemeral automation authored via flow.run.";
					const tediNs = resolveTediNamespace(
						input,
						SKILL_WORKFLOW_SURFACES.run.tediTool,
					);
					if (input.params !== undefined && !isRecord(input.params))
						throw new Error("flow.run params must be an object");
					const params = recordFrom(input.params) ?? {};
					// The CLI's --params certification flag explicitly requests the owner-only API mode.
					const certification = input.certification ?? params.certification;
					if (certification !== undefined && typeof certification !== "boolean")
						throw new Error("flow.run certification must be a boolean");
					if (certification && !existingSkillId)
						throw new Error("Certification requires an existing skillId");
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
							...(certification === true ? { certification: true } : {}),
							confirmDestructive: true,
							reason:
								typeof input.reason === "string" && input.reason.trim()
									? input.reason.trim()
									: `flow.run: ephemeral automation "${name}"`,
						});
						if (checked.issues)
							throw new Error(
								`flow.run runner arguments invalid: ${checked.issues.map((issue) => issue.message).join("; ")}`,
							);
					}
					const skillId =
						existingSkillId ??
						(
							await recordDraft("flow.run", input, {
								name,
								description,
								source,
								// The adoption cohort — same tag the CLI stamps, so gateway
								// and CLI usage are one queryable population.
								tag: "flow-ephemeral",
								note: [
									"Ephemeral flow.run automation: runs only when started, never on",
									"a schedule, auto-archives after 14 days unused.",
								],
							})
						).skillId;

					const started = await call(
						tediNs,
						SKILL_WORKFLOW_SURFACES.run.tediTool,
						{
							skillId,
							...(certification === true ? { certification: true } : {}),
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
									: `flow.run: ephemeral automation "${name}"`,
						},
					);
					const runId = isRecord(started)
						? ((started.runId ?? started.id) as string | undefined)
						: undefined;
					if (!runId) {
						throw new Error(
							`flow.run: the automation did not return a runId (skillId ${skillId})`,
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
			save: {
				description:
					"Save a workflow module you wrote as a draft skill (tag code-saved) without running it. Returns { skillId, revision }; run it later with flow.run({ skillId }). Promotion stays an explicit request to org skill reviewers.",
				execute: async (rawInput: unknown) => {
					const input = recordFrom(rawInput) ?? {};
					const name = typeof input.name === "string" ? input.name.trim() : "";
					if (!name) throw new Error("flow.save requires `name`");
					const source = typeof input.source === "string" ? input.source : "";
					// Only an explicit module in the flow shape is saved; sandbox code is
					// never wrapped or translated, so it cannot move to the tedi's access.
					if (
						!/\bexport\s+default\b/.test(source) ||
						!/\brun\s*\(/.test(source)
					)
						throw new Error(
							"flow.save requires `source` as a workflow module: export default { async run(event, step, env) { ... } }",
						);
					if (!namespaceGroups.get("skills")?.fns.record_skills)
						throw new Error(
							"flow.save requires skills.record_skills on this gateway",
						);
					assertAuthorized("skills", "record_skills");
					return recordDraft("flow.save", input, {
						name: name.slice(0, 80),
						description:
							typeof input.description === "string" && input.description.trim()
								? input.description.trim()
								: "Workflow saved via flow.save.",
						source,
						tag: "code-saved",
						note: [
							"Saved with flow.save: a draft that runs only when started with",
							"flow.run({ skillId }), under the normal draft rules.",
						],
					});
				},
			},
			status: {
				description:
					"Compact lifecycle poll for a flow run: { status, output, error, durationMs, skillId, skillRevision, workItemId }. Terminal: completed | failed | canceled.",
				execute: async (rawInput: unknown) => {
					const input = recordFrom(rawInput) ?? {};
					const runId = typeof input.runId === "string" ? input.runId : "";
					if (!runId) throw new Error("flow.status requires `runId`");
					const target = resolveRunTool(
						input,
						SKILL_WORKFLOW_SURFACES.status.tediTool,
					);
					const row = recordFrom(
						await call(target.namespace, target.tool, { runId }),
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
						skillId: typeof row?.skillId === "string" ? row.skillId : null,
						skillRevision:
							typeof row?.skillRevision === "number" ? row.skillRevision : null,
						workItemId:
							typeof row?.workItemId === "string" ? row.workItemId : null,
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
			watch: {
				description:
					"Durable status watch: checks one Work Item's status every N seconds (>= 15 s) off your context until a JSON until rule matches, maxChecks (<= 100) is used or the deadline (<= 24 h) passes. Returns { runId } at once; read the outcome with flow.status.",
				execute: async (rawInput: unknown) => {
					const input = recordFrom(rawInput) ?? {};
					const { tediSlug: _tediSlug, reason, ...watchInput } = input;
					const callable = recordFrom(watchInput.check)?.callable;
					if (!(WATCH_CHECK_CALLABLES as readonly unknown[]).includes(callable))
						throw new Error(
							`flow.watch cannot run ${JSON.stringify(callable ?? null)}: the supported checks are ${WATCH_CHECK_CALLABLES.map((name) => `${name} (args { workItemId })`).join(", ")}`,
						);
					const parsed = FlowWatchInputSchema.safeParse(watchInput);
					if (!parsed.success)
						throw new Error(
							`flow.watch input invalid: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}`,
						);
					// Same caps the server enforces, reported before anything starts.
					normalizeFlowWatchInput(parsed.data, new Date());
					const tediNs = resolveTediNamespace(input, WATCH_START_TOOL);
					assertAuthorized(tediNs, WATCH_START_TOOL);
					const started = recordFrom(
						await call(tediNs, WATCH_START_TOOL, {
							watch: parsed.data,
							...(typeof reason === "string" && reason.trim()
								? { reason: reason.trim().slice(0, 500) }
								: {}),
						}),
					);
					if (typeof started?.runId !== "string")
						throw new Error("flow.watch: the watch did not return a runId");
					return { ...started, tediSlug: tediNs };
				},
			},
			cancel: {
				description:
					"Stop a flow run (a watch or a flow.run job) through cancel_skill_workflow.",
				execute: async (rawInput: unknown) => {
					const input = recordFrom(rawInput) ?? {};
					const runId = typeof input.runId === "string" ? input.runId : "";
					if (!runId) throw new Error("flow.cancel requires `runId`");
					const target = resolveRunTool(input, WATCH_CANCEL_TOOL);
					assertAuthorized(target.namespace, target.tool);
					return call(target.namespace, target.tool, {
						runId,
						// Destructive-governed: stateless callers authorize explicitly.
						confirmDestructive: true,
						reason:
							typeof input.reason === "string" && input.reason.trim()
								? input.reason.trim()
								: "flow.cancel: stop a flow run",
					});
				},
			},
			list: {
				description:
					"Recent flow-authored automation runs for the selected tedi. Persistent and scheduled skill runs are intentionally excluded.",
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
			"Record source as an EPHEMERAL draft skill automation (a scripts/workflow.ts file) and start it in one call. Use for ~10+ step jobs (sweeps, watches, migrations, fan-out judging): the steps run in a durable Cloudflare Workflow OFF your context window; only the bounded return value comes back. Returns { skillId, runId } immediately — poll flow.status later, never busy-wait in the same execution.",
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
	save: {
		name: "Save Flow Workflow As Draft Skill",
		description:
			"Save an explicit workflow module (export default { async run(event, step, env) { ... } }) as a draft skill tagged code-saved without running it. Returns { skillId, revision }; run it later with flow.run({ skillId }).",
		parameters: {
			type: "object",
			properties: {
				source: {
					type: "string",
					description:
						"Workflow module in the flow.run source shape. Sandbox code is not accepted or translated.",
				},
				name: { type: "string" },
				description: { type: "string" },
				skillDoc: { type: "string" },
				capabilities: { type: "object" },
			},
			required: ["source", "name"],
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
	watch: {
		name: "Watch Work Item Status",
		description:
			"Durable status watch off your context: checks one Work Item's status every N seconds (>= 15 s) until an until rule matches, maxChecks (<= 100) is used or the deadline (<= 24 h) passes. Returns { runId } at once; read the outcome with flow.status.",
		parameters: {
			type: "object",
			properties: {
				check: {
					type: "object",
					description:
						'{ callable: "work.item_status", args: { workItemId } }. No other checks are supported yet.',
				},
				until: {
					type: "object",
					description:
						"JSON rule on the status { workItemId, disposition, updatedAt }: { path, in } | { path, eq } | { path, gte }.",
				},
				every: {
					type: ["number", "string"],
					description: 'Seconds, or e.g. "30 s", "5 minutes". At least 15 s.',
				},
				maxChecks: { type: "number", description: "1 to 100 (default 100)." },
				deadline: {
					type: ["number", "string"],
					description: "Up to 24 hours (default every x maxChecks).",
				},
				tediSlug: { type: "string" },
				reason: { type: "string" },
			},
			required: ["check", "until", "every"],
		},
	},
	cancel: {
		name: "Cancel Flow Run",
		description: "Stop a flow run (a watch or a flow.run job).",
		parameters: {
			type: "object",
			properties: {
				runId: { type: "string" },
				tediSlug: { type: "string" },
				reason: { type: "string" },
			},
			required: ["runId"],
		},
	},
	list: {
		name: "List Flow Runs",
		description: "List recent automation runs for the selected tedi.",
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
