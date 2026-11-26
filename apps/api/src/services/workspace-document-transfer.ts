import { env } from "cloudflare:workers";
import type {
	DocumentTransfer,
	DocumentTransferRuntime,
} from "@tedix/db/queries/durable-sqlite/output-rpc";
import type { DbQueryClient } from "@tedix/db/query-client";
import { repointDocumentTransferIndex } from "@tedix/db/queries/workspace-feed/document-transfer";

/** Preparation primitive; callers authorize both workspaces before invoking it. */
export async function transferWorkspaceDocument(
	db: DbQueryClient,
	organizationId: string,
	transfer: DocumentTransfer,
) {
	const runtime = (
		env as unknown as { WORKSPACE_RUNTIME?: DocumentTransferRuntime }
	).WORKSPACE_RUNTIME;
	if (!runtime) throw new Error("Workspace output runtime is unavailable");
	const source = { organizationId, workspaceId: transfer.sourceWorkspaceId };
	const target = { organizationId, workspaceId: transfer.targetWorkspaceId };
	const payload = await runtime.prepareDocumentTransfer(source, transfer);
	if (!payload.completed) {
		await runtime.importDocumentTransfer(target, payload);
		const confirmed = await runtime.confirmDocumentTransfer(target, transfer);
		if (JSON.stringify(confirmed) !== JSON.stringify(payload.snapshot))
			throw new Error("Document transfer confirmation mismatch");
		await repointDocumentTransferIndex(db, organizationId, payload);
	}
	await runtime.removeDocumentTransfer(source, transfer);
	return payload.snapshot.output;
}
