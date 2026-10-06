import type {
	WebMcpToolDef,
	WebMcpToolExecuteOptions,
	WebMcpToolResult,
} from "@tedix/webmcp-core/model-context";
import { webMcpResult } from "@tedix/webmcp-core/model-context";
import { toWebMcpFailure } from "@/components/webmcp-execute";
import { useWebMcpTools } from "@/lib/webmcp/use-webmcp-tools";

/**
 * Context-bound, read-only WebMCP tools for the Activity run detail page:
 * "explain what this run did". The tools close over the run the human is
 * currently looking at, so an in-page agent inspects exactly that run without
 * ever taking an id argument. The scope key includes the id, so navigating
 * between runs replaces the scope.
 *
 * Strictly read-only: the operator verbs on this page (cancel, retry,
 * approve/reject, send event) are deliberately NOT exposed — deciding is
 * human-only, and this scope performs zero cache writes and zero
 * invalidations.
 *
 * Every projection is drawn from the page's own canonical reads:
 * `skills.inspectWorkflowRun` (run + revision + steps + tool calls +
 * warnings), `skills.listRunArtifacts`, and `rationaleRecords.list` filtered
 * client-side by runId exactly as the page does (the contract exposes no
 * runId filter on rationale reads). Per-run USD ledger attribution is NOT
 * projected: pricing those rows requires the quarantine classifier in
 * `@/lib/cost-reading`, so the tools surface the run's own durable
 * `costSummary` rollup instead and leave ledger USD to the visible page.
 *
 * `@/lib/api` reads `window.location` at module scope, so it (and
 * `@/lib/os-query-options`, which imports it) is loaded lazily at execute
 * time. This keeps the component tree importable in a node test environment.
 */

type ApiModule = typeof import("@/lib/api");
type OptionsModule = typeof import("@/lib/os-query-options");

interface RunWebMcpRuntime {
	api: ApiModule;
	options: OptionsModule;
}

let runtime: Promise<RunWebMcpRuntime> | null = null;

const clientOptions = (options?: WebMcpToolExecuteOptions) =>
	options?.signal ? ([{ signal: options.signal }] as const) : ([] as const);
const loadRuntime = (): Promise<RunWebMcpRuntime> =>
	(runtime ??= Promise.all([
		import("@/lib/api"),
		import("@/lib/os-query-options"),
	]).then(([api, options]) => ({ api, options })));

const RATIONALE_TEXT_LIMIT = 400;

function truncateText(text: string): string {
	return text.length > RATIONALE_TEXT_LIMIT
		? `${text.slice(0, RATIONALE_TEXT_LIMIT)}…`
		: text;
}

type RunInspection = Awaited<
	ReturnType<ApiModule["osApi"]["skills"]["inspectWorkflowRun"]>
>;

/** The compact run summary shared by get_current_run and explain_current_run. */
function projectRunSummary(inspection: RunInspection): Record<string, unknown> {
	const { run, revision } = inspection;
	return {
		runId: run.id,
		status: run.status,
		skillId: run.skillId,
		skillSlug: revision.skillSlug ?? null,
		skillRevision: revision.revision ?? null,
		tediId: run.tediId,
		createdBy: run.createdBy ?? null,
		workItemId: run.workItemId ?? null,
		executionEpoch: run.executionEpoch,
		startedAt: run.startedAt ?? null,
		completedAt: run.completedAt ?? null,
		pausedAt: run.pausedAt ?? null,
		error: run.error ?? null,
		costSummary: run.costSummary
			? {
					steps: run.costSummary.steps,
					toolCalls: run.costSummary.toolCalls,
					retries: run.costSummary.retries,
					wallMs: run.costSummary.wallMs,
				}
			: null,
		warnings: inspection.warnings,
	};
}

/** Build the run-scope WebMCP tool set. Pure so tests can drive execute(). */
export function buildRunWebMcpTools(runId: string): WebMcpToolDef[] {
	const deepLink = `/work/runs/${runId}`;

	const getCurrentRun: WebMcpToolDef = {
		name: "get_current_run",
		annotations: { readOnlyHint: true, untrustedContentHint: true },
		description:
			"Read the workflow run currently open on this page — which skill and tedi ran, timing, error, execution-cost rollup, and reconciliation warnings. Status: queued, running, paused, completed, failed, or canceled.",
		inputSchema: { type: "object", properties: {} },
		execute: async (_args, executeOptions): Promise<WebMcpToolResult> => {
			try {
				const { api } = await loadRuntime();
				const inspection = await api.osApi.skills.inspectWorkflowRun(
					{ runId },
					...clientOptions(executeOptions),
				);
				return webMcpResult(projectRunSummary(inspection), deepLink);
			} catch (error) {
				return toWebMcpFailure(error);
			}
		},
	};

	const listCurrentRunSteps: WebMcpToolDef = {
		name: "list_current_run_steps",
		annotations: { readOnlyHint: true, untrustedContentHint: true },
		description:
			"List the durable workflow step receipts of the run currently open on this page, in execution order — governed MCP tool calls included. Outcome: pending, success, or failure.",
		inputSchema: { type: "object", properties: {} },
		execute: async (_args, executeOptions): Promise<WebMcpToolResult> => {
			try {
				const { api } = await loadRuntime();
				const inspection = await api.osApi.skills.inspectWorkflowRun(
					{ runId },
					...clientOptions(executeOptions),
				);
				return webMcpResult(
					{
						steps: inspection.steps.map((step) => ({
							name: step.name,
							kind: step.kind,
							outcome: step.outcome,
							status: step.status ?? null,
							attempt: step.attempt ?? null,
							durationMs: step.durationMs ?? null,
							executionEpoch: step.executionEpoch,
							toolCall:
								step.kind === "tool_call" && step.namespace && step.method
									? `${step.namespace}.${step.method}`
									: null,
						})),
						toolCallsCount: inspection.toolCalls.length,
					},
					deepLink,
				);
			} catch (error) {
				return toWebMcpFailure(error);
			}
		},
	};

	const explainCurrentRun: WebMcpToolDef = {
		name: "explain_current_run",
		annotations: { readOnlyHint: true, untrustedContentHint: true },
		description:
			"Explain what the run currently open on this page did: its summary plus the tedi's rationale records explicitly linked to this run and the artifacts it produced. Rationale carries no run filter in the contract, so the tedi's recent records are matched to this run client-side, exactly as the page does; per-run USD ledger attribution is shown only on the page.",
		inputSchema: { type: "object", properties: {} },
		execute: async (_args, executeOptions): Promise<WebMcpToolResult> => {
			try {
				const { api, options } = await loadRuntime();
				const inspection = await api.osApi.skills.inspectWorkflowRun(
					{ runId },
					...clientOptions(executeOptions),
				);
				const [rationale, artifacts] = await Promise.all([
					api.osApi.rationaleRecords.list(
						{
							tediId: inspection.run.tediId,
							limit: options.RUN_RATIONALE_LIMIT,
						},
						...clientOptions(executeOptions),
					),
					api.osApi.skills.listRunArtifacts(
						{ runId },
						...clientOptions(executeOptions),
					),
				]);
				const runRationale = rationale.data.filter(
					(record) => record.runId === runId,
				);
				return webMcpResult(
					{
						run: projectRunSummary(inspection),
						rationale: runRationale.map((record) => ({
							action: record.action,
							rationale: truncateText(record.rationale),
							category: record.category,
							confidence: record.confidence,
							outcomeStatus: record.outcomeStatus,
							outcome: record.outcome,
							createdAt: record.createdAt,
						})),
						artifacts: artifacts.artifacts.map((artifact) => ({
							path: artifact.path,
							mimeType: artifact.mimeType,
							sizeBytes: artifact.sizeBytes,
							outcome: artifact.outcome,
							storage: artifact.storage,
						})),
					},
					deepLink,
				);
			} catch (error) {
				return toWebMcpFailure(error);
			}
		},
	};

	return [getCurrentRun, listCurrentRunSteps, explainCurrentRun];
}

/** Register the context-bound tools for as long as this run's page is open. */
export function useRunWebMcpTools(runId: string): void {
	useWebMcpTools(`run:${runId}`, () => buildRunWebMcpTools(runId), [runId]);
}
