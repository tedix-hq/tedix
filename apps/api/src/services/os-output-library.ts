import {
	documentBlockText,
	withDerivedDocumentBlocks,
} from "@tedix/api-contract/utils/os-document";
import type {
	OsCreatedByKind,
	OsOutputContent,
	OsOutputKind,
	OsOutputLibraryItem,
	OsOutputLibraryPreview,
	OsOutput,
	OsOutputRevision,
	OsOutputStatus,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	OsDerivedAccessEnvelopeSchema,
	OsOutputContentSchema,
} from "@tedix/api-contract/schemas/os-workspaces";
import type { OsOutputRevisionMetadataRow } from "@tedix/db/queries/os-workspaces/outputs";
import {
	listWorkspaceOutputLibrary,
	type WorkspaceOutputLibraryRow,
} from "@tedix/db/queries/workspace-feed/read";
import { workspaceIdOfFeedScope } from "@tedix/api-contract/schemas/workspace-feed";
import type { OsWorkspaceViewer } from "@tedix/db/queries/os-workspaces/workspaces";
import type { DbQueryClient } from "@tedix/db/query-client";
import type {
	OsOutputRevisionRow,
	OsOutputRow,
} from "@tedix/db/schema/os-workspaces";

export function mapOsOutputRow(row: OsOutputRow): OsOutput {
	if (!row.currentRevisionId) {
		throw new Error("OS output row has no current revision pointer");
	}
	return { ...row, currentRevisionId: row.currentRevisionId };
}

export function mapOsOutputRevisionRow(
	row: OsOutputRevisionRow,
): OsOutputRevision {
	return {
		...mapOsOutputRevisionMetadata(row),
		content: withDerivedDocumentBlocks(
			OsOutputContentSchema.parse(JSON.parse(row.content)),
		),
	};
}

export function mapOsOutputRevisionMetadata(
	row: OsOutputRevisionMetadataRow,
): Omit<OsOutputRevision, "content"> {
	const { skillRunId, skillId, accessEnvelope } = row;
	// Explicitly omit bodies even when passed a fully hydrated row.
	return {
		id: row.id,
		organizationId: row.organizationId,
		outputId: row.outputId,
		revision: row.revision,
		note: row.note,
		createdByKind: row.createdByKind,
		createdById: row.createdById,
		createdAt: row.createdAt,
		// The run id is the receipt. A skill id without one identifies no
		// authoring event, so the envelope collapses to null rather than
		// reporting half of it.
		producedBy: skillRunId ? { skillRunId, skillId } : null,
		accessEnvelope:
			accessEnvelope == null
				? null
				: OsDerivedAccessEnvelopeSchema.parse(JSON.parse(accessEnvelope)),
	};
}

function compactPreviewText(value: string): string {
	return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

/** Project revision content into inert, bounded card data. */
export function outputLibraryPreview(
	content: OsOutputContent,
): OsOutputLibraryPreview {
	if (content.kind === "document") {
		const lines: string[] = [];
		for (const block of content.blocks) {
			const values = documentBlockText(block);
			for (const value of values) {
				const line = compactPreviewText(value);
				if (line) lines.push(line);
				if (lines.length === 6) break;
			}
			if (lines.length === 6) break;
		}
		return { kind: "document", lines, blockCount: content.blocks.length };
	}
	if (content.kind === "sheet") {
		return {
			kind: "sheet",
			columns: content.columns.slice(0, 6).map((value) => value.slice(0, 80)),
			rows: content.rows
				.slice(0, 5)
				.map((row) =>
					row
						.slice(0, 6)
						.map((cell) =>
							typeof cell === "string" ? compactPreviewText(cell) : cell,
						),
				),
			rowCount: content.rows.length,
			columnCount: content.columns.length,
			sheetCount: content.workbook?.sheets.length ?? 1,
		};
	}
	if (content.kind === "video") {
		return {
			kind: "video",
			mimeType: content.mimeType,
			caption: content.caption
				? compactPreviewText(content.caption)
				: undefined,
			delivery: content.delivery
				? {
						status: content.delivery.status,
						verdict: content.delivery.verdict,
						score: content.delivery.score,
					}
				: undefined,
		};
	}
	const first = content.slides[0];
	return {
		kind: "presentation",
		title: compactPreviewText(first?.title ?? ""),
		bullets: (first?.bullets ?? [])
			.slice(0, 4)
			.map((bullet) => compactPreviewText(bullet)),
		slideCount: content.slides.length,
	};
}

/**
 * An index row rendered as the output and revision rows the library card
 * and its access check expect. The projection carries every output-level
 * and revision-level column except the body.
 */
export function outputLibraryRowsFromIndex(row: WorkspaceOutputLibraryRow): {
	output: OsOutputRow;
	revision: OsOutputRevisionMetadataRow;
} {
	const index = row.index;
	return {
		output: {
			id: index.outputId,
			organizationId: index.organizationId,
			workspaceId: workspaceIdOfFeedScope(index.workspaceId),
			kind: index.outputKind,
			title: index.title,
			status: index.status,
			currentRevisionId: index.revisionId,
			createdByKind: index.outputCreatedByKind,
			createdById: index.outputCreatedById,
			createdAt: index.outputCreatedAt,
			updatedAt: index.updatedAt,
		},
		revision: {
			id: index.revisionId,
			organizationId: index.organizationId,
			outputId: index.outputId,
			revision: index.revision,
			note: index.note,
			createdByKind: index.revisionCreatedByKind,
			createdById: index.revisionCreatedById,
			createdAt: index.revisionCreatedAt,
			skillRunId: index.skillRunId,
			skillId: index.skillId,
			accessEnvelope: index.accessEnvelope,
			contentSha256: index.contentSha256,
			contentBytes: index.contentBytes,
			bodyR2Key: index.bodyR2Key,
		},
	};
}

/**
 * The Outputs library reads the workspace change projection: one indexed
 * row per current revision, written by the feed consumer. No workspace
 * object and no workspace-scoped table is read for the listing.
 */
export async function buildOsOutputLibrary(
	db: DbQueryClient,
	params: {
		organizationId: string;
		viewer: OsWorkspaceViewer;
		creator: { kind: OsCreatedByKind; id: string };
		workspaceId?: string;
		kind?: OsOutputKind;
		status?: OsOutputStatus;
		search?: string;
		limit: number;
		canReadRevision: (
			revision: OsOutputRevisionMetadataRow,
		) => Promise<boolean>;
	},
): Promise<{ items: OsOutputLibraryItem[]; truncated: boolean }> {
	const rows = await listWorkspaceOutputLibrary(
		db,
		{ organizationId: params.organizationId, viewer: params.viewer },
		{
			workspaceId: params.workspaceId,
			kind: params.kind,
			status: params.status,
			search: params.search,
			limit: params.limit + 1,
		},
	);
	return {
		items: await Promise.all(
			rows.slice(0, params.limit).map(async (row) => {
				const { output, revision } = outputLibraryRowsFromIndex(row);
				return {
					output: { ...output, currentRevisionId: revision.id },
					workspace: row.workspace
						? {
								id: row.workspace.id,
								name: row.workspace.name,
								status: row.workspace.status as "active" | "archived",
							}
						: null,
					currentRevision: {
						id: revision.id,
						revision: revision.revision,
						createdAt: revision.createdAt,
					},
					scope:
						output.createdByKind === params.creator.kind &&
						output.createdById === params.creator.id
							? ("mine" as const)
							: ("organization" as const),
					preview: !(await params.canReadRevision(revision))
						? ({
								kind: "unavailable",
								reason: "source_access_unavailable",
							} as const)
						: ({ kind: "metadata" } as const),
				};
			}),
		),
		truncated: rows.length > params.limit,
	};
}
