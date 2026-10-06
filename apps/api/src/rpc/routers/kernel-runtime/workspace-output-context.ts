/** A bounded, source-free document projection for an explicit Home selection. */
import { OsOutputContentSchema } from "@tedix/api-contract/schemas/os-workspaces";
import type { DbQueryClient } from "@tedix/db/query-client";
import {
	getOsOutput,
	getOsOutputRevision,
} from "@tedix/db/queries/os-workspaces/outputs";
import { parseDerivedAccessEnvelope } from "../../../services/os-derived-resource-access";
import { hasOsReadAuthorization, type BaseContext } from "../../orpc";

const MAX_DOCUMENT_CHARS = 12_000;

export async function authorizedWorkspaceDocumentContext(
	context: BaseContext,
	organizationId: string,
	workspaceContext: Record<string, unknown> | null,
): Promise<string | null> {
	if (
		context.organizationId !== organizationId ||
		!hasOsReadAuthorization(context)
	)
		return null;
	return selectedWorkspaceDocumentContext(
		context.db,
		organizationId,
		workspaceContext,
	);
}

export function projectWorkspaceDocument(input: {
	workspaceId: string;
	outputId: string;
	title: string;
	revisionId: string;
	revision: number;
	content: unknown;
}): string | null {
	const parsed = OsOutputContentSchema.safeParse(input.content);
	if (!parsed.success || parsed.data.kind !== "document") return null;
	let text = "";
	let truncated = false;
	for (const block of parsed.data.blocks) {
		const lines =
			block.type === "list"
				? block.items.map((item) => `${block.ordered ? "1." : "-"} ${item}`)
				: [
						block.type === "heading"
							? `${"#".repeat(block.level)} ${block.text}`
							: block.text,
					];
		for (const line of lines) {
			const next = `${text ? "\n\n" : ""}${line}`;
			const remaining = MAX_DOCUMENT_CHARS - text.length;
			if (next.length > remaining) {
				text += next.slice(0, remaining);
				truncated = true;
				break;
			}
			text += next;
		}
		if (truncated) break;
	}
	return JSON.stringify({
		source: "selected_workspace_document",
		untrusted: true,
		workspaceId: input.workspaceId,
		outputId: input.outputId,
		title: input.title,
		revisionId: input.revisionId,
		revision: input.revision,
		truncated,
		text,
	});
}

export async function selectedWorkspaceDocumentContext(
	db: DbQueryClient,
	organizationId: string,
	workspaceContext: Record<string, unknown> | null,
): Promise<string | null> {
	const workpiece = workspaceContext?.workpiece;
	if (
		!workspaceContext ||
		typeof workspaceContext.workspaceId !== "string" ||
		!workpiece ||
		typeof workpiece !== "object" ||
		!("kind" in workpiece) ||
		workpiece.kind !== "output" ||
		!("id" in workpiece) ||
		typeof workpiece.id !== "string"
	)
		return null;
	const output = await getOsOutput(db, {
		organizationId,
		outputId: workpiece.id,
	});
	if (
		!output ||
		output.workspaceId !== workspaceContext.workspaceId ||
		output.status !== "active"
	)
		return null;
	const revision = output.currentRevisionId
		? await getOsOutputRevision(db, {
				organizationId,
				revisionId: output.currentRevisionId,
			})
		: null;
	if (!revision || revision.outputId !== output.id) return null;
	// A protected revision needs a recipient-specific source-access check. Never
	// smuggle it through the operator's delegation message.
	const envelope = parseDerivedAccessEnvelope(revision.accessEnvelope);
	if (!envelope || envelope.sources.length > 0) return null;
	let content: unknown;
	try {
		content = JSON.parse(revision.content);
	} catch {
		return null;
	}
	return projectWorkspaceDocument({
		workspaceId: output.workspaceId,
		outputId: output.id,
		title: output.title,
		revisionId: revision.id,
		revision: revision.revision,
		content,
	});
}
