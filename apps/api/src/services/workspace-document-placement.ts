import { sha256Hex } from "@tedix/worker-kit/crypto";
import type { DbQueryClient } from "@tedix/db/query-client";
import {
	getOsWorkspace,
	listConversationWorkspaceDocuments,
	saveConversationAsOsWorkspace,
	type SaveConversationAsOsWorkspaceParams,
} from "@tedix/db/queries/os-workspaces/workspaces";
import {
	createInitializedWorkspace,
	workspaceDocumentRuntime,
} from "./workspace-document-owner";
import { transferWorkspaceDocument } from "./workspace-document-transfer";

export async function workspacePlacementId(
	organizationId: string,
	operation: string,
) {
	const hash = await sha256Hex(JSON.stringify([organizationId, operation]));
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export class WorkspacePlacementError extends Error {
	readonly retryable = true;
	constructor(
		readonly workspaceId: string,
		readonly movedOutputIds: string[],
		readonly pendingOutputIds: string[],
		cause: unknown,
	) {
		super(
			`Document placement in ${workspaceId} is incomplete; moved: ${movedOutputIds.join(", ") || "none"}; pending: ${pendingOutputIds.join(", ")}`,
			{ cause },
		);
	}
}

/** A durable plan retains the original source after the index has moved. */
export async function placeWorkspaceDocuments(
	db: DbQueryClient,
	organizationId: string,
	workspaceId: string,
	planId: string,
	documents: { outputId: string; workspaceId: string }[],
	authorizeSource: (workspaceId: string) => Promise<void>,
) {
	const plan = await workspaceDocumentRuntime().outputQuery(
		{ organizationId, workspaceId },
		{
			op: "placementPlan",
			planId,
			documents: documents
				.filter((document) => document.workspaceId !== workspaceId)
				.map((document) => ({
					transferId: `${planId}:${document.outputId}`,
					outputId: document.outputId,
					sourceWorkspaceId: document.workspaceId,
					targetWorkspaceId: workspaceId,
				})),
		},
	);
	const moved: string[] = [];
	for (const document of plan) {
		try {
			await authorizeSource(document.sourceWorkspaceId);
			await transferWorkspaceDocument(db, organizationId, document);
			moved.push(document.outputId);
		} catch (cause) {
			throw new WorkspacePlacementError(
				workspaceId,
				moved,
				plan.slice(moved.length).map((document) => document.outputId),
				cause,
			);
		}
	}
	return moved;
}

export async function saveConversationWorkspace(
	db: DbQueryClient,
	params: SaveConversationAsOsWorkspaceParams,
) {
	const workspace = await createInitializedWorkspace(
		async () => (await saveConversationAsOsWorkspace(db, params)).workspace,
	);
	const documents = await listConversationWorkspaceDocuments(db, {
		organizationId: workspace.organizationId,
		conversationId: params.conversationId,
		fromWorkspaceIds: params.fromWorkspaceIds,
	});
	const movedOutputIds = await placeWorkspaceDocuments(
		db,
		workspace.organizationId,
		workspace.id,
		`save:${params.conversationId}`,
		documents,
		async (sourceId) => {
			const source = await getOsWorkspace(db, {
				organizationId: workspace.organizationId,
				workspaceId: sourceId,
			});
			if (
				!source ||
				(source.visibility === "private" &&
					source.ownerUserId !== workspace.ownerUserId)
			)
				throw new Error("Document source is outside the owner boundary");
		},
	);
	return { workspace, movedOutputIds };
}
