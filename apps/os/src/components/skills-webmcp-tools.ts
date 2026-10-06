// The contract module is pure zod/oRPC metadata — safe at module scope (the
// import-inertness rule bans only the app-bootstrap modules).
import { skillsContract } from "@tedix/api-contract/contracts/cognitive";
import type {
	SkillEntry,
	SkillRun,
	SkillRunStatus,
} from "@tedix/api-contract/contracts/cognitive";
import type { TediType } from "@tedix/api-contract/schemas/tedi";
import type {
	WebMcpToolDef,
	WebMcpToolExecuteOptions,
} from "@tedix/webmcp-core/model-context";
import { webMcpError, webMcpResult } from "@tedix/webmcp-core/model-context";
import { toWebMcpFailure } from "@/components/webmcp-execute";
import {
	contractInputSchema,
	deriveToolSchema,
} from "@/lib/webmcp/derive-schema";
import { useWebMcpTools } from "@/lib/webmcp/use-webmcp-tools";

/**
 * WebMCP tools for the OS Skills surface: the org's saved automations
 * (governed skills) executed by a chosen tedi. A browser agent gets the same
 * verbs the visible UI has — browse the catalog, inspect one skill, dispatch
 * its workflow to a tedi, and poll the resulting run.
 *
 * Reads go through `osApi` directly (no cache writes); the one cache touch is
 * invalidating the skill-runs history key after a successful dispatch, so the
 * human watches the run appear live. Deep links land on `/skills/{id}` and
 * `/work/runs/{runId}`.
 */

function skillDeepLink(skillId: string): string {
	return `/skills/${skillId}`;
}

function runDeepLink(runId: string): string {
	return `/work/runs/${runId}`;
}

/** Injectable seams; production uses the app singletons via {@link useSkillsWebMcpTools}. */
export interface SkillsWebMcpDeps {
	listSkills: (
		input: {
			limit?: number;
			domain?: string;
			tediId?: string;
			summary?: boolean;
		},
		options?: WebMcpToolExecuteOptions,
	) => Promise<{ entries: SkillEntry[]; total: number }>;
	getSkill: (
		input: { id: string },
		options?: WebMcpToolExecuteOptions,
	) => Promise<{ entry: SkillEntry | null }>;
	runWorkflow: (
		input: {
			skillId: string;
			tediId: string;
			reason: string;
			idempotencyKey: string;
			params?: Record<string, unknown>;
			confirmDestructive?: boolean;
		},
		options?: WebMcpToolExecuteOptions,
	) => Promise<{
		runId: string;
		workflowInstanceId: string;
		status: SkillRunStatus;
		workItemId: string | null;
		deduplicated: boolean;
	}>;
	runWorkflowStatus: (
		input: { runId: string },
		options?: WebMcpToolExecuteOptions,
	) => Promise<SkillRun>;
	listTedis: (
		options?: WebMcpToolExecuteOptions,
	) => Promise<{ data: TediType[] }>;
	/** Called after a successful dispatch so the runs history refetches. */
	invalidateSkillRuns: () => void;
	randomUuid: () => string;
}

/**
 * Memoized loader for the production singletons. Deliberately dynamic:
 * `@/lib/api` reads `window.location` at module scope (breaks node-env tests
 * that reach this module through a host component), and `@/router` /
 * `@/lib/os-query-options` drag the route tree and query-options graph into
 * any narrowly-mocked suite. Loading them on first tool execution keeps this
 * module import-inert; `vi.mock` still intercepts the dynamic imports.
 */
let defaultDepsPromise: Promise<SkillsWebMcpDeps> | null = null;
function loadDefaultDeps(): Promise<SkillsWebMcpDeps> {
	defaultDepsPromise ??= Promise.all([
		import("@/lib/api"),
		import("@/router"),
		import("@/lib/os-query-options"),
	]).then(([api, router, queryOptions]) => ({
		listSkills: (input, options) =>
			api.osApi.skills.listByOrg(input, ...executeArgs(options)),
		getSkill: (input, options) =>
			api.osApi.skills.get(input, ...executeArgs(options)),
		runWorkflow: (input, options) =>
			api.osApi.skills.runWorkflow(input, ...executeArgs(options)),
		runWorkflowStatus: (input, options) =>
			api.osApi.skills.runWorkflowStatus(input, ...executeArgs(options)),
		listTedis: (options) => api.osApi.tedis.list({}, ...executeArgs(options)),
		invalidateSkillRuns: () => {
			void router.osQueryClient.invalidateQueries({
				queryKey: queryOptions.osQueryKeys.skillRuns(),
			});
		},
		randomUuid: () => crypto.randomUUID(),
	}));
	return defaultDepsPromise;
}

const WORKFLOW_FILE = "scripts/workflow.ts";

/** The contract input `run_skill_workflow` derives its schema from. */
const RUN_WORKFLOW_INPUT = contractInputSchema(skillsContract.runWorkflow);

/**
 * Derived from the runWorkflow contract input: `reason`'s bounds (1-4000) and
 * `skillId`/`params` shapes track the contract. Deliberate overlay: `reason`
 * and `tediSlug` are tool-required (the contract keeps reason optional and
 * takes `tediId`), `tediSlug` and `confirm` are tool-only remaps resolved in
 * execute (slug → tediId; confirm → confirmDestructive), and `skillId` is
 * only required when no skill is bound to the page.
 */
function runSkillWorkflowSchema(
	currentSkillId?: string,
): Record<string, unknown> {
	return deriveToolSchema(RUN_WORKFLOW_INPUT, {
		pick: ["skillId", "reason", "params"],
		require: currentSkillId
			? ["reason", "tediSlug"]
			: ["skillId", "reason", "tediSlug"],
		override: {
			skillId: {
				description: currentSkillId
					? `Skill id to run. Defaults to the currently open skill (${currentSkillId}).`
					: "Skill id to run (see list_skills).",
			},
			reason: { description: "Audit reason recorded with the dispatch." },
			params: { description: "Input params for the workflow." },
		},
		extra: {
			tediSlug: {
				type: "string",
				description:
					"Slug of the tedi (digital worker) that owns and executes this run.",
			},
			confirm: {
				type: "boolean",
				description:
					"Pass true to confirm running a destructive skill; omit otherwise.",
			},
		},
		additionalProperties: false,
	});
}

const executeArgs = (options?: WebMcpToolExecuteOptions) =>
	options?.signal ? ([options] as const) : ([] as const);

/**
 * Compact catalog row. `executable` is only reported when the row actually
 * carries `files` — summary projections null them out, and a false negative
 * would read as "cannot run".
 */
function skillListRow(entry: SkillEntry) {
	const row: Record<string, unknown> = {
		id: entry.id,
		slug: entry.slug ?? null,
		title: entry.title,
		description: entry.summary ?? entry.description ?? null,
		lifecycleState: entry.lifecycleState ?? null,
		deepLink: skillDeepLink(entry.id),
	};
	if (entry.files && typeof entry.files === "object") {
		row["executable"] = WORKFLOW_FILE in entry.files;
	}
	return row;
}

async function resolveTediBySlug(
	deps: SkillsWebMcpDeps,
	tediSlug: string,
	options?: WebMcpToolExecuteOptions,
): Promise<
	| { tedi: TediType }
	| { tedi?: undefined; error: ReturnType<typeof webMcpError> }
> {
	const { data } = await deps.listTedis(...executeArgs(options));
	const tedi = data.find((t) => t.slug === tediSlug);
	if (tedi) return { tedi };
	const slugs = data.map((t) => t.slug).join(", ");
	return {
		error: webMcpError(
			`Unknown tedi slug "${tediSlug}". Valid slugs: ${slugs || "(none — this organization has no live tedis)"}.`,
		),
	};
}

/**
 * Pure tool-set builder, exported for tests. Every `execute` resolves — API
 * failures come back as `webMcpError`, never as a thrown rejection. When
 * `currentSkillId` is bound (the skill detail page), `get_skill` and
 * `run_skill_workflow` default to that skill.
 */
export function buildSkillsWebMcpTools(
	currentSkillId?: string,
	explicitDeps?: SkillsWebMcpDeps,
): WebMcpToolDef[] {
	const resolveDeps = (): Promise<SkillsWebMcpDeps> =>
		explicitDeps ? Promise.resolve(explicitDeps) : loadDefaultDeps();
	return [
		{
			name: "list_skills",
			annotations: { readOnlyHint: true, untrustedContentHint: true },
			description:
				"List the organization's skills — its saved automations executed by a chosen tedi (digital worker) — with per-skill deep links the human can open in the Skills page.",
			inputSchema: {
				type: "object",
				properties: {
					limit: {
						type: "integer",
						minimum: 1,
						maximum: 50,
						description: "Maximum skills to return (default 25).",
					},
					domain: {
						type: "string",
						description: "Filter by domain name.",
					},
					tediId: {
						type: "string",
						description: "Filter to skills owned by this tedi id.",
					},
				},
				additionalProperties: false,
			},
			execute: async (args, executeOptions) => {
				try {
					const limit = typeof args["limit"] === "number" ? args["limit"] : 25;
					const deps = await resolveDeps();
					const { entries, total } = await deps.listSkills(
						{
							limit,
							domain:
								typeof args["domain"] === "string" ? args["domain"] : undefined,
							tediId:
								typeof args["tediId"] === "string" ? args["tediId"] : undefined,
							// Compact projection: truncated content, files nulled. The
							// executable flag comes from get_skill instead.
							summary: true,
						},
						...executeArgs(executeOptions),
					);
					return webMcpResult({
						skills: entries.map(skillListRow),
						total,
					});
				} catch (error) {
					return toWebMcpFailure(error);
				}
			},
		},
		{
			name: "get_skill",
			annotations: { readOnlyHint: true, untrustedContentHint: true },
			description:
				"Get one organization skill — a saved automation executed by a chosen tedi — including whether it is executable as a workflow; the human can open it at the deep link.",
			inputSchema: {
				type: "object",
				properties: {
					skillId: {
						type: "string",
						description: currentSkillId
							? `Skill id. Defaults to the currently open skill (${currentSkillId}).`
							: "Skill id (see list_skills).",
					},
				},
				...(currentSkillId ? {} : { required: ["skillId"] }),
				additionalProperties: false,
			},
			execute: async (args, executeOptions) => {
				try {
					const skillId =
						typeof args["skillId"] === "string" && args["skillId"] !== ""
							? args["skillId"]
							: currentSkillId;
					if (!skillId) {
						return webMcpError("skillId is required (see list_skills).");
					}
					const deps = await resolveDeps();
					const { entry } = await deps.getSkill(
						{ id: skillId },
						...executeArgs(executeOptions),
					);
					if (!entry) {
						return webMcpError(`No skill found with id "${skillId}".`);
					}
					return webMcpResult(
						{
							id: entry.id,
							slug: entry.slug ?? null,
							title: entry.title,
							description: entry.summary ?? entry.description ?? null,
							lifecycleState: entry.lifecycleState ?? null,
							executable: Boolean(entry.files?.[WORKFLOW_FILE]),
							revision: entry.revision,
							successCount: entry.successCount,
							failureCount: entry.failureCount,
							lastUsedAt: entry.lastUsedAt ?? null,
						},
						skillDeepLink(entry.id),
					);
				} catch (error) {
					return toWebMcpFailure(error);
				}
			},
		},
		{
			name: "run_skill_workflow",
			annotations: { readOnlyHint: false, untrustedContentHint: false },
			description:
				"Run a skill's workflow — one of the org's saved automations — executed by the tedi (digital worker) named by tediSlug; the human can watch the run live at the returned deep link. A destructive skill may require confirm: true.",
			inputSchema: runSkillWorkflowSchema(currentSkillId),
			execute: async (args, executeOptions) => {
				try {
					const skillId =
						typeof args["skillId"] === "string" && args["skillId"] !== ""
							? args["skillId"]
							: currentSkillId;
					if (!skillId) {
						return webMcpError("skillId is required (see list_skills).");
					}
					const tediSlug = args["tediSlug"];
					if (typeof tediSlug !== "string" || tediSlug.trim() === "") {
						return webMcpError("tediSlug is required.");
					}
					const reason = args["reason"];
					if (
						typeof reason !== "string" ||
						reason.trim() === "" ||
						reason.length > 4000
					) {
						return webMcpError(
							"reason is required and must be 1-4000 characters.",
						);
					}
					const deps = await resolveDeps();
					const resolved = await resolveTediBySlug(
						deps,
						tediSlug,
						...executeArgs(executeOptions),
					);
					if (!resolved.tedi) return resolved.error;
					const output = await deps.runWorkflow(
						{
							skillId,
							tediId: resolved.tedi.id,
							reason,
							idempotencyKey: deps.randomUuid(),
							params:
								args["params"] &&
								typeof args["params"] === "object" &&
								!Array.isArray(args["params"])
									? (args["params"] as Record<string, unknown>)
									: undefined,
							// Only an explicit caller confirm maps through — never
							// hardcoded, so the API's destructive gate stays real.
							confirmDestructive: args["confirm"] === true ? true : undefined,
						},
						...executeArgs(executeOptions),
					);
					deps.invalidateSkillRuns();
					return webMcpResult(
						{
							runId: output.runId,
							status: output.status,
							deduplicated: output.deduplicated,
						},
						runDeepLink(output.runId),
					);
				} catch (error) {
					return toWebMcpFailure(error);
				}
			},
		},
		{
			name: "get_skill_run_status",
			annotations: { readOnlyHint: true, untrustedContentHint: false },
			description:
				"Get the current status of a skill workflow run; the human can watch the run live at the deep link.",
			inputSchema: {
				type: "object",
				properties: {
					runId: {
						type: "string",
						description: "Run id returned by run_skill_workflow.",
					},
				},
				required: ["runId"],
				additionalProperties: false,
			},
			execute: async (args, executeOptions) => {
				try {
					const runId = args["runId"];
					if (typeof runId !== "string" || runId.trim() === "") {
						return webMcpError("runId is required.");
					}
					const deps = await resolveDeps();
					const run = await deps.runWorkflowStatus(
						{ runId },
						...executeArgs(executeOptions),
					);
					return webMcpResult(
						{
							runId: run.id,
							status: run.status,
							skillId: run.skillId,
							tediId: run.tediId,
							startedAt: run.startedAt ?? null,
							completedAt: run.completedAt ?? null,
							error: run.error ?? null,
						},
						runDeepLink(run.id),
					);
				} catch (error) {
					return toWebMcpFailure(error);
				}
			},
		},
	];
}

/**
 * Register the Skills scope's WebMCP tools for the lifetime of the calling
 * page. Pass the current skill id on the detail page so `get_skill` and
 * `run_skill_workflow` default to it.
 */
export function useSkillsWebMcpTools(currentSkillId?: string): void {
	useWebMcpTools(
		currentSkillId ? `skills:${currentSkillId}` : "skills",
		() => buildSkillsWebMcpTools(currentSkillId),
		[currentSkillId ?? null],
	);
}
