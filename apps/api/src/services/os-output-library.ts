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
import { listOsOutputLibraryRows } from "@tedix/db/queries/os-workspaces/outputs";
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
	const { skillRunId, skillId, accessEnvelope, ...rest } = row;
	return {
		...rest,
		content: OsOutputContentSchema.parse(JSON.parse(row.content)),
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
			const values = block.type === "list" ? block.items : [block.text];
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

export async function buildOsOutputLibrary(
	db: DbQueryClient,
	params: {
		organizationId: string;
		creator: { kind: OsCreatedByKind; id: string };
		workspaceId?: string;
		kind?: OsOutputKind;
		status?: OsOutputStatus;
		limit: number;
		canReadRevision: (revision: OsOutputRevisionRow) => Promise<boolean>;
	},
): Promise<{ items: OsOutputLibraryItem[]; truncated: boolean }> {
	const rows = await listOsOutputLibraryRows(db, params.organizationId, {
		workspaceId: params.workspaceId,
		kind: params.kind,
		status: params.status,
		limit: params.limit + 1,
	});
	return {
		items: await Promise.all(
			rows
				.slice(0, params.limit)
				.map(async ({ output, revision, workspace }) => ({
					output: { ...output, currentRevisionId: revision.id },
					workspace: workspace
						? {
								id: workspace.id,
								name: workspace.name,
								status: workspace.status,
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
							? "mine"
							: "organization",
					preview: !(await params.canReadRevision(revision))
						? ({
								kind: "unavailable",
								reason: "source_access_unavailable",
							} as const)
						: outputLibraryPreview(
								OsOutputContentSchema.parse(JSON.parse(revision.content)),
							),
				})),
		),
		truncated: rows.length > params.limit,
	};
}
