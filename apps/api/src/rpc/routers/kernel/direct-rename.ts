/**
 * Direct renames of a Workspace app or output, resolved without a model.
 *
 * "Rename the app to X" names its target by kind; the chat's attached
 * workpiece is context, not necessarily the target, so a request naming an
 * app while a sheet is attached resolves to the Workspace's app. "Reverse
 * that change" after a rename restores the name the item had before it.
 * Every resolved rename still goes through the normal write approval.
 */
import type { DbClient } from "@tedix/db/client";
import { getAppBySlugForOrg } from "@tedix/db/queries/apps";
import { getAuditEventsByResource } from "@tedix/db/queries/audit";
import { listKernelRuntimeRuns } from "@tedix/db/queries/kernel-runtime-runs";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { listOsGadgets } from "@tedix/db/queries/os-workspaces/gadgets";
import { organizationGatewaySlug } from "../../../lib/organization-mcp-gateway";
import type { KernelResult } from "./index";
import {
	parseRenameRequest,
	renameIntentFor,
	stripContextMarkers,
	type SelectedWorkpieceContext,
	type WorkpieceRenameIntent,
	workpieceRenameIntent,
} from "./write-tool-intent";

/** "Undo that", "reverse that change", "revert the rename". */
const UNDO_RENAME_RE =
	/\b(?:undo|revert|reverse|roll ?back)\s+(?:(?:that|the|this|your|my|last|previous)\s+)*(?:change|rename|renaming|edit)\b|\b(?:undo|revert|reverse)\s+(?:it|that|this)\b|^undo\b/i;

export interface DirectRename {
	intent: WorkpieceRenameIntent;
	/** Provider app the rename runs on, when known from an earlier rename. */
	appSlug?: string;
	reason: "rename" | "undo";
}

interface RunRenameProposal {
	appSlug: string;
	intent: WorkpieceRenameIntent;
}

function executedRenameProposal(metadata: unknown): RunRenameProposal | null {
	if (!metadata || typeof metadata !== "object") return null;
	const record = metadata as Record<string, unknown>;
	if (!record.kernelWriteExecutedAt) return null;
	const proposal = record.kernelWriteProposal as
		| { appSlug?: unknown; toolName?: unknown; args?: unknown }
		| undefined;
	const args = (proposal?.args ?? {}) as Record<string, unknown>;
	if (typeof proposal?.appSlug !== "string") return null;
	if (
		proposal.toolName === "os.rename_os_gadget" &&
		typeof args.workspaceId === "string" &&
		typeof args.gadgetId === "string" &&
		typeof args.name === "string"
	)
		return {
			appSlug: proposal.appSlug,
			intent: renameIntentFor(
				{ kind: "gadget", workspaceId: args.workspaceId, id: args.gadgetId },
				args.name,
			),
		};
	if (
		proposal.toolName === "os.rename_os_output" &&
		typeof args.outputId === "string" &&
		typeof args.title === "string"
	)
		return {
			appSlug: proposal.appSlug,
			intent: renameIntentFor(
				{ kind: "output", id: args.outputId },
				args.title,
			),
		};
	return null;
}

/**
 * The name an item carried before a rename to `renamedTo`, from its audit
 * trail (newest first): the next older rename or its creation.
 */
export async function nameBeforeRename(
	db: DbClient,
	input: {
		organizationId: string;
		kind: "gadget" | "output";
		id: string;
		renamedTo: string;
	},
): Promise<string | null> {
	const field = input.kind === "gadget" ? "name" : "title";
	const events = await getAuditEventsByResource(
		db,
		input.organizationId,
		input.kind === "gadget" ? "os_gadget" : "os_output",
		input.id,
		50,
	);
	const named = events.flatMap((event) => {
		const value = (event.metadata as Record<string, unknown> | null)?.[field];
		return /\.(?:renamed|created)$/.test(event.action) &&
			typeof value === "string"
			? [value]
			: [];
	});
	const renamedAt = named.indexOf(input.renamedTo);
	const before = renamedAt >= 0 ? named[renamedAt + 1] : undefined;
	return before && before !== input.renamedTo ? before : null;
}

async function undoLastRename(
	db: DbClient,
	input: { organizationId: string; conversationId: string; runId: string },
): Promise<DirectRename | null> {
	const runs = await listKernelRuntimeRuns(db, {
		organizationId: input.organizationId,
		conversationId: input.conversationId,
		orderBy: "created",
		limit: 10,
	});
	for (const run of runs) {
		if (run.id === input.runId) continue;
		if (
			!(run.metadata as Record<string, unknown> | null)?.kernelWriteExecutedAt
		)
			continue;
		// Only the conversation's latest executed write can be "that change".
		const last = executedRenameProposal(run.metadata);
		if (!last) return null;
		const target =
			last.intent.capability === "gadgets.rename"
				? {
						kind: "gadget" as const,
						workspaceId: last.intent.args.workspaceId,
						id: last.intent.args.gadgetId,
						renamedTo: last.intent.args.name,
					}
				: {
						kind: "output" as const,
						id: last.intent.args.outputId,
						renamedTo: last.intent.args.title,
					};
		const previous = await nameBeforeRename(db, {
			organizationId: input.organizationId,
			kind: target.kind,
			id: target.id,
			renamedTo: target.renamedTo,
		});
		return previous
			? {
					intent: renameIntentFor(target, previous),
					appSlug: last.appSlug,
					reason: "undo",
				}
			: null;
	}
	return null;
}

/** The Workspace app a request names when the selection is not that app. */
async function namedWorkspaceApp(
	db: DbClient,
	input: { organizationId: string; workspaceId: string; target: string },
): Promise<{ id: string } | null> {
	const gadgets = await listOsGadgets(db, input.organizationId, {
		workspaceId: input.workspaceId,
		status: "active",
		limit: 50,
	});
	const target = input.target.toLowerCase();
	const named = gadgets.filter((gadget) =>
		target.includes(gadget.name.toLowerCase()),
	);
	if (named.length === 1) return named[0]!;
	return gadgets.length === 1 ? gadgets[0]! : null;
}

/**
 * Resolve a rename (or the undo of the conversation's last rename) to one
 * exact call. Null when the request is neither, or its target is ambiguous.
 */
export async function resolveDirectRename(
	db: DbClient,
	input: {
		organizationId: string;
		conversationId: string;
		runId: string;
		content: string;
		workspaceContext?: SelectedWorkpieceContext | null;
	},
): Promise<DirectRename | null> {
	const request = parseRenameRequest(input.content);
	if (!request) {
		const text = stripContextMarkers(input.content);
		return text.length <= 300 && UNDO_RENAME_RE.test(text)
			? undoLastRename(db, input)
			: null;
	}
	const selected = workpieceRenameIntent(input.content, input.workspaceContext);
	if (selected) return { intent: selected, reason: "rename" };
	const workspaceId = input.workspaceContext?.workspaceId;
	if (request.kind !== "gadget" || !workspaceId) return null;
	const app = await namedWorkspaceApp(db, {
		organizationId: input.organizationId,
		workspaceId,
		target: request.target,
	});
	return app
		? {
				intent: renameIntentFor(
					{ kind: "gadget", workspaceId, id: app.id },
					request.name,
				),
				reason: "rename",
			}
		: null;
}

/**
 * A write route for a resolved rename, used when the router produced no
 * decision (or only an answer for an undo). It plans and parks the same
 * approval as a routed rename; nothing executes here.
 */
export function directRenameKernelResult(
	rename: DirectRename,
	appSlug: string,
): KernelResult {
	const what =
		rename.intent.capability === "gadgets.rename"
			? `the app to “${rename.intent.args.name}”`
			: `the output to “${rename.intent.args.title}”`;
	return {
		assistantContent: `Rename ${what}.`,
		route: {
			routeKind: "propose_tool_write",
			answer: `Rename ${what}.`,
			rationale:
				rename.reason === "undo"
					? "Restore the name the item had before the last rename in this conversation."
					: "Rename the Workspace item the request names.",
			risk: "low",
			confidence: 1,
			effortClass: "single_read",
			targetTediId: null,
			targetTediLabel: null,
			targetActivityId: null,
			plannedToolIds: [],
			toolIntent: {
				appSlug,
				capability: rename.intent.capability,
				connectionStatus: "connected",
			},
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		},
		workWriteGateway: null,
		delegation: null,
		routeUsage: null,
		contextManifest: {
			version: 1,
			budgetTokens: 0,
			sources: [],
			historyCompaction: null,
			recall: "static",
			recallAgeMs: null,
			recallCandidates: 0,
			recallWaitedMs: 0,
		},
	};
}

/** The organization's Code Mode gateway, which carries the Workspace tools. */
export async function organizationGatewayApp(
	db: DbClient,
	organizationId: string,
): Promise<string | null> {
	const organization = await getOrganizationById(db, organizationId);
	if (!organization?.slug) return null;
	const slug = organizationGatewaySlug(
		organization.slug,
		organizationId,
	).toLowerCase();
	const app = await getAppBySlugForOrg(db, slug, organizationId);
	return app?.slug ?? null;
}
