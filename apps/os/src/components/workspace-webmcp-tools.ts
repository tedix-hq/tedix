import { useRef } from "react";
import type {
	WebMcpToolDef,
	WebMcpToolExecuteOptions,
	WebMcpToolResult,
} from "@tedix/webmcp-core/model-context";
import { webMcpError, webMcpResult } from "@tedix/webmcp-core/model-context";
// Type-only: erased at runtime, so the module stays import-inert.
import type { CanvasDocSelection } from "@/lib/canvas-search";
import { toWebMcpFailure } from "@/components/webmcp-execute";
import { useWebMcpTools } from "@/lib/webmcp/use-webmcp-tools";

/**
 * Context-bound, read-only WebMCP tools for the Workspace workbench
 * (`/workspace/{workspaceId}`, CanvasPage): "explain what this workspace is".
 * The tools close over the workspace the human has open — the scope key
 * includes the id, so navigating between workspaces replaces the scope — and
 * the selected workpiece is read live through a getter, so tab clicks never
 * re-register the scope.
 *
 * Strictly read-only: the workbench's mutating verbs (gadget revise/run,
 * collaboration commits, resource edits) are deliberately NOT exposed, this
 * scope performs zero cache writes and zero invalidations, and nothing here
 * touches `src/collab/` or the OT stream. Output reads stay compact rows on
 * purpose — the full read/write surface (`read_output`, the CAS patch verbs)
 * is owned by the Outputs scope and is not duplicated here.
 *
 * Every projection is drawn from the page's own canonical reads:
 * `workspaces.get`, `gadgets.list`/`gadgets.get`, `outputs.list`,
 * `resources.list`, and `executions.list` — the same contract calls behind
 * `canvasGadgetsQueryOptions`, `canvasOutputsQueryOptions`,
 * `workspaceResourcesQueryOptions`, and `gadgetExecutionsQueryOptions`, with
 * the page's own bounds.
 *
 * `@/lib/api` reads `window.location` at module scope, so it (and
 * `@/lib/os-query-options`, which imports it) is loaded lazily at execute
 * time. This keeps the component tree importable in a node test environment.
 */

type ApiModule = typeof import("@/lib/api");
type OptionsModule = typeof import("@/lib/os-query-options");

interface WorkspaceWebMcpRuntime {
	api: ApiModule;
	options: OptionsModule;
}

let runtime: Promise<WorkspaceWebMcpRuntime> | null = null;

const clientOptions = (options?: WebMcpToolExecuteOptions) =>
	options?.signal ? ([{ signal: options.signal }] as const) : ([] as const);
const loadRuntime = (): Promise<WorkspaceWebMcpRuntime> =>
	(runtime ??= Promise.all([
		import("@/lib/api"),
		import("@/lib/os-query-options"),
	]).then(([api, options]) => ({ api, options })));

/** The page's own executions bound (GADGET_EXECUTION_LIMIT in canvas-gadget-executions). */
const DEFAULT_EXECUTIONS_LIMIT = 20;
const MAX_EXECUTIONS_LIMIT = 50;
const DEFAULT_OUTPUTS_LIMIT = 25;
const MAX_OUTPUTS_LIMIT = 50;

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boundedLimit(value: unknown, fallback: number, max: number): number {
	const raw = typeof value === "number" ? value : fallback;
	return Math.min(Math.max(Math.trunc(raw), 1), max);
}

/** The workbench deep link for one workpiece: the URL selection contract. */
function workpieceDeepLink(workspaceId: string, doc: CanvasDocSelection) {
	return `/workspace/${workspaceId}?workpiece=${doc.type}:${doc.id}`;
}

type GadgetRevision = Awaited<
	ReturnType<ApiModule["osApi"]["osWorkspaces"]["gadgets"]["get"]>
>["currentRevision"];

/** Compact revision summary: identity plus the manifest facts agents act on. */
function projectGadgetRevision(
	revision: GadgetRevision,
): Record<string, unknown> | null {
	if (!revision) return null;
	return {
		revision: revision.revision,
		createdAt: revision.createdAt,
		capabilities: revision.manifest.capabilities,
		entry: revision.manifest.entry,
		skillSlug: revision.manifest.skillSlug ?? null,
	};
}

/** Build the workspace-scope WebMCP tool set. Pure so tests can drive execute(). */
export function buildWorkspaceWebMcpTools(
	workspaceId: string,
	getSelection: () => CanvasDocSelection | null,
): WebMcpToolDef[] {
	const deepLink = `/workspace/${workspaceId}`;

	const getWorkspaceOverview: WebMcpToolDef = {
		name: "get_workspace_overview",
		annotations: { readOnlyHint: true, untrustedContentHint: true },
		description:
			"Read the Tedix OS workspace currently open on this workbench: its identity and status plus counts of the gadgets, outputs, and external resources the page shows, and which workpiece the human has selected.",
		inputSchema: { type: "object", properties: {} },
		execute: async (_args, executeOptions): Promise<WebMcpToolResult> => {
			try {
				const { api, options } = await loadRuntime();
				const listBound = options.CANVAS_RESOURCE_LIST_LIMIT;
				const [detail, gadgets, outputs, resources] = await Promise.all([
					api.osApi.osWorkspaces.workspaces.get(
						{ workspaceId },
						...clientOptions(executeOptions),
					),
					api.osApi.osWorkspaces.gadgets.list(
						{ workspaceId, status: "active", limit: listBound },
						...clientOptions(executeOptions),
					),
					api.osApi.osWorkspaces.outputs.list(
						{ workspaceId, limit: listBound },
						...clientOptions(executeOptions),
					),
					api.osApi.osWorkspaces.resources.list(
						{ workspaceId, status: "active", limit: listBound },
						...clientOptions(executeOptions),
					),
				]);
				const selection = getSelection();
				const { workspace } = detail;
				return webMcpResult(
					{
						workspace: {
							id: workspace.id,
							name: workspace.name,
							description: workspace.description,
							status: workspace.status,
							sourceBlueprintId: workspace.sourceBlueprintId,
							createdAt: workspace.createdAt,
							updatedAt: workspace.updatedAt,
						},
						counts: {
							gadgets: gadgets.items.length,
							outputs: outputs.items.length,
							resources: resources.items.length,
						},
						truncated:
							gadgets.truncated || outputs.truncated || resources.truncated,
						selectedWorkpiece: selection
							? { type: selection.type, id: selection.id }
							: null,
					},
					deepLink,
				);
			} catch (error) {
				return toWebMcpFailure(error);
			}
		},
	};

	const getSelectedGadget: WebMcpToolDef = {
		name: "get_selected_gadget",
		annotations: { readOnlyHint: true, untrustedContentHint: true },
		description:
			"Read the gadget workpiece the human currently has selected on this workbench, with its current revision's declared capabilities and governed skill. Returns the selection kind instead when an output or nothing is selected.",
		inputSchema: { type: "object", properties: {} },
		execute: async (_args, executeOptions): Promise<WebMcpToolResult> => {
			try {
				const selection = getSelection();
				if (!selection) {
					return webMcpResult(
						{
							selectedWorkpiece: null,
							gadget: null,
							note: "No workpiece is selected. Use get_workspace_overview for counts or list_workspace_outputs for the outputs in this workspace.",
						},
						deepLink,
					);
				}
				if (selection.type !== "gadget") {
					return webMcpResult(
						{
							selectedWorkpiece: { type: selection.type, id: selection.id },
							gadget: null,
							note: "The selected workpiece is an output, not a gadget. list_workspace_outputs shows its compact row; the Outputs surface owns full output reads.",
						},
						workpieceDeepLink(workspaceId, selection),
					);
				}
				const { api } = await loadRuntime();
				const { gadget, currentRevision } =
					await api.osApi.osWorkspaces.gadgets.get(
						{ workspaceId, gadgetId: selection.id },
						...clientOptions(executeOptions),
					);
				return webMcpResult(
					{
						selectedWorkpiece: { type: "gadget", id: gadget.id },
						gadget: {
							id: gadget.id,
							name: gadget.name,
							description: gadget.description,
							status: gadget.status,
							createdAt: gadget.createdAt,
							updatedAt: gadget.updatedAt,
						},
						currentRevision: projectGadgetRevision(currentRevision),
					},
					workpieceDeepLink(workspaceId, selection),
				);
			} catch (error) {
				return toWebMcpFailure(error);
			}
		},
	};

	const listGadgetExecutions: WebMcpToolDef = {
		name: "list_gadget_executions",
		annotations: { readOnlyHint: true, untrustedContentHint: true },
		description:
			"List a gadget's governed execution receipts in this workspace, newest first — the same activity rows the workbench shows. Defaults to the selected gadget workpiece. Status: denied, queued, awaiting_approval, running, paused, completed, failed, or canceled.",
		inputSchema: {
			type: "object",
			properties: {
				gadgetId: {
					type: "string",
					format: "uuid",
					description:
						"Gadget to list receipts for; defaults to the selected gadget workpiece.",
				},
				limit: {
					type: "integer",
					minimum: 1,
					maximum: MAX_EXECUTIONS_LIMIT,
					description: `Rows to return (default ${DEFAULT_EXECUTIONS_LIMIT}, max ${MAX_EXECUTIONS_LIMIT}).`,
				},
			},
		},
		execute: async (args, executeOptions): Promise<WebMcpToolResult> => {
			try {
				const selection = getSelection();
				const gadgetId =
					optionalString(args["gadgetId"]) ??
					(selection?.type === "gadget" ? selection.id : undefined);
				if (!gadgetId) {
					return webMcpError(
						"gadgetId is required when no gadget workpiece is selected — get_workspace_overview shows the selection and get_selected_gadget reads it",
					);
				}
				const limit = boundedLimit(
					args["limit"],
					DEFAULT_EXECUTIONS_LIMIT,
					MAX_EXECUTIONS_LIMIT,
				);
				const { api } = await loadRuntime();
				const result = await api.osApi.osWorkspaces.executions.list(
					{ workspaceId, gadgetId, limit },
					...clientOptions(executeOptions),
				);
				return webMcpResult(
					{
						gadgetId,
						executions: result.items.map((execution) => ({
							id: execution.id,
							status: execution.status,
							revision: execution.revision,
							createdByKind: execution.createdByKind,
							createdAt: execution.createdAt,
							completedAt: execution.completedAt,
							error: execution.error,
						})),
						truncated: result.truncated,
					},
					`${workpieceDeepLink(workspaceId, { type: "gadget", id: gadgetId })}&view=activity`,
				);
			} catch (error) {
				return toWebMcpFailure(error);
			}
		},
	};

	const listWorkspaceOutputs: WebMcpToolDef = {
		name: "list_workspace_outputs",
		annotations: { readOnlyHint: true, untrustedContentHint: true },
		description:
			"List the durable outputs grouped under this workspace — documents, sheets, presentations, and videos — as the compact rows the workbench's resource rail shows, each with a workbench deep link. Full output reads and edits belong to the Outputs surface.",
		inputSchema: {
			type: "object",
			properties: {
				limit: {
					type: "integer",
					minimum: 1,
					maximum: MAX_OUTPUTS_LIMIT,
					description: `Rows to return (default ${DEFAULT_OUTPUTS_LIMIT}, max ${MAX_OUTPUTS_LIMIT}).`,
				},
			},
		},
		execute: async (args, executeOptions): Promise<WebMcpToolResult> => {
			try {
				const limit = boundedLimit(
					args["limit"],
					DEFAULT_OUTPUTS_LIMIT,
					MAX_OUTPUTS_LIMIT,
				);
				const { api } = await loadRuntime();
				const result = await api.osApi.osWorkspaces.outputs.list(
					{ workspaceId, limit },
					...clientOptions(executeOptions),
				);
				return webMcpResult(
					{
						items: result.items.map((output) => ({
							id: output.id,
							title: output.title,
							kind: output.kind,
							status: output.status,
							updatedAt: output.updatedAt,
							deepLink: workpieceDeepLink(workspaceId, {
								type: "output",
								id: output.id,
							}),
						})),
						truncated: result.truncated,
					},
					deepLink,
				);
			} catch (error) {
				return toWebMcpFailure(error);
			}
		},
	};

	return [
		getWorkspaceOverview,
		getSelectedGadget,
		listGadgetExecutions,
		listWorkspaceOutputs,
	];
}

/**
 * Register the workspace-bound tools for as long as this workbench is open.
 * The selection rides a ref read at execute time, so switching workpiece tabs
 * never re-registers the scope; switching workspaces replaces it.
 */
export function useWorkspaceWebMcpTools(
	workspaceId: string | null,
	selectedDoc: CanvasDocSelection | null,
): void {
	const selectionRef = useRef(selectedDoc);
	selectionRef.current = selectedDoc;
	useWebMcpTools(
		workspaceId ? `workspace:${workspaceId}` : "workspace:pending",
		() =>
			workspaceId
				? buildWorkspaceWebMcpTools(workspaceId, () => selectionRef.current)
				: [],
		[workspaceId],
	);
}
