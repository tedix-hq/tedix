import { env, waitUntil } from "cloudflare:workers";
import { ORPCError } from "@orpc/server";
import {
	OsOutputContentSchema,
	type OsSheetCell,
} from "@tedix/api-contract/schemas/os-workspaces";
import { applySheetRange } from "@tedix/api-contract/utils/sheet-range";
import {
	applyOutputPatch,
	diffOutputContent,
	OutputPatchError,
} from "@tedix/api-contract/utils/output-patch";
import { mergeOutputContent } from "@tedix/api-contract/utils/output-merge";
import { continuesOutputAutosaveBurst } from "@tedix/api-contract/utils/os-output-autosave";
import {
	OS_OUTPUT_AUTOSAVE_NOTE,
	OS_OUTPUT_CONTENT_MAX_BYTES,
} from "@tedix/api-contract/utils/os-output-limits";
import type { DbQueryClient } from "@tedix/db/query-client";
import {
	changedSheetRows,
	sheetContentBytes,
	readSheetBlocks,
	sheetBlockManifest,
	updateSheetBlocks,
	type SheetBlockManifest,
} from "@tedix/workspace-feed/sheet-blocks";
import { notifyOutputRevision } from "@tedix/workspace-feed/output-revision-notice";
import type { OsOutputPatchSave } from "./os-output-patch";
import { mapOsOutputRow } from "./os-output-library";
import { readStoredOutputRevision } from "./os-workspace-outputs";
import { storeOutputRevisionBody } from "./os-output-revision-body-store";
import {
	createOsOutputRevision,
	getOsOutputRevisionByNumber,
} from "./workspace-output-storage";

/** Return null for structural edits, which assemble the sheet before changing its layout. */
function cellSelection(input: OsOutputPatchSave, manifest: SheetBlockManifest) {
	const selected = new Map<string, Set<number>>();
	for (const op of input.patch.ops) {
		const path = op.path;
		let tableId: string;
		let row: unknown;
		let column: unknown;
		if (!manifest.content.workbook && path[0] === "rows" && path.length === 3) {
			tableId = "flat";
			row = path[1];
			column = path[2];
		} else if (
			manifest.content.workbook &&
			path[0] === "workbook" &&
			path[1] === "sheets" &&
			typeof path[2] === "object" &&
			path[3] === "rows" &&
			path.length >= 6
		) {
			tableId = path[2].id;
			row = path[4];
			column = path[5];
		} else return null;
		const table = manifest.tables.find((value) => value.id === tableId);
		if (
			(op.op !== "set" && op.op !== "unset") ||
			!table ||
			typeof row !== "number" ||
			!Number.isInteger(row) ||
			row < 0 ||
			row >= table.rows.length ||
			typeof column !== "number" ||
			!Number.isInteger(column) ||
			column < 0 ||
			column >= table.columns.length
		)
			return null;
		const rows = selected.get(tableId) ?? new Set<number>();
		rows.add(row);
		selected.set(tableId, rows);
	}
	return selected;
}

export async function saveSheetCellPatch(
	db: DbQueryClient,
	input: OsOutputPatchSave,
	range?: {
		startRow: number;
		startColumn: number;
		cells: OsSheetCell[][];
		expectedRevision?: number;
	},
) {
	const start = performance.now();
	let output = input.output;
	const bucket = env.R2_BUCKET;
	for (let attempt = 0; attempt < 3; attempt++) {
		const current = await readStoredOutputRevision(db, {
			organizationId: output.organizationId,
			workspaceId: output.workspaceId ?? undefined,
			revisionId: output.currentRevisionId!,
		});
		if (!current || !(await input.canReadRevision(current)))
			throw new ORPCError("FORBIDDEN", {
				message: "Output source access unavailable",
			});
		const manifest = sheetBlockManifest(current.content);
		if (!manifest) throw new Error("Sheet revision was not migrated to chunks");
		let selection = cellSelection(input, manifest);
		if (range) {
			const table = manifest.tables.find(
				(table) =>
					table.id === (manifest.content.workbook?.activeSheetId ?? "flat"),
			);
			if (
				!table ||
				range.startRow + range.cells.length > table.rows.length ||
				range.startColumn + Math.max(...range.cells.map((row) => row.length)) >
					table.columns.length
			)
				return null;
			selection = new Map([
				[
					table.id,
					new Set(range.cells.map((_, index) => range.startRow + index)),
				],
			]);
		}
		if (!selection) return null;
		const conflict = (parts?: string[]) =>
			new ORPCError("CONFLICT", {
				message: "Someone else changed the same part of this sheet",
				data: {
					expectedRevision: input.baseRevision,
					currentRevision: current.revision,
					...(parts ? { parts } : {}),
				},
			});
		if (
			input.baseRevision > current.revision ||
			(range?.expectedRevision !== undefined &&
				range.expectedRevision !== current.revision)
		)
			throw conflict();
		let base = manifest;
		if (!range && input.baseRevision < current.revision) {
			if (current.accessEnvelope !== input.accessEnvelope) throw conflict();
			const started = await getOsOutputRevisionByNumber(db, {
				organizationId: output.organizationId,
				outputId: output.id,
				revision: input.baseRevision,
			});
			if (!started || !(await input.canReadRevision(started))) throw conflict();
			const stored = await readStoredOutputRevision(db, {
				organizationId: output.organizationId,
				workspaceId: output.workspaceId ?? undefined,
				revisionId: started.id,
			});
			const startedManifest = stored && sheetBlockManifest(stored.content);
			const changed =
				startedManifest && changedSheetRows(startedManifest, manifest);
			if (!startedManifest || !changed) return null;
			base = startedManifest;
			for (const [table, positions] of changed) {
				const rows = selection.get(table) ?? new Set<number>();
				for (const position of positions) rows.add(position);
				selection.set(table, rows);
			}
		}
		const theirs = await readSheetBlocks(
			bucket,
			output.organizationId,
			manifest,
			selection,
		);
		const before =
			base === manifest
				? theirs
				: await readSheetBlocks(bucket, output.organizationId, base, selection);
		let mine;
		try {
			mine = range
				? applySheetRange(
						before,
						range.startRow,
						range.startColumn,
						range.cells,
					)
				: applyOutputPatch(before, input.patch);
		} catch (error) {
			if (!(error instanceof OutputPatchError)) throw error;
			throw new ORPCError("BAD_REQUEST", { message: error.message });
		}
		const merged =
			base === manifest
				? { ok: true as const, content: mine }
				: mergeOutputContent(before, mine, theirs);
		if (!merged.ok) throw conflict(merged.conflicts);
		const checked = OsOutputContentSchema.safeParse(merged.content);
		if (!checked.success)
			throw new ORPCError("BAD_REQUEST", {
				message: `The change does not fit this sheet: ${checked.error.issues[0]?.message ?? "invalid"}`,
			});
		const content = checked.data;
		if (content.kind !== "sheet")
			throw new Error("Sheet patch changed its kind");
		const next = await updateSheetBlocks(
			bucket,
			output.organizationId,
			manifest,
			content,
			selection,
		);
		if (sheetContentBytes(next) > OS_OUTPUT_CONTENT_MAX_BYTES)
			throw new ORPCError("BAD_REQUEST", {
				message: "Sheet exceeds the output size limit",
			});
		const body = await storeOutputRevisionBody(
			bucket,
			output.organizationId,
			JSON.stringify(next),
		);
		const note = input.autosave
			? OS_OUTPUT_AUTOSAVE_NOTE
			: (input.note ?? null);
		const result = await createOsOutputRevision(db, {
			id: crypto.randomUUID(),
			organizationId: output.organizationId,
			outputId: output.id,
			expectedWorkspaceId: input.expectedWorkspaceId,
			...body,
			content: "",
			expectedRevision: current.revision,
			note,
			createdByKind: input.creator.kind,
			createdById: input.creator.id,
			...input.producer,
			accessEnvelope: input.accessEnvelope,
		});
		if (!result.ok) {
			output = await input.reloadOutput();
			continue;
		}
		if (result.revision.id !== current.id)
			waitUntil(
				notifyOutputRevision(
					{
						db,
						rooms: env.APP_DRAFT_ROOM,
						env,
						development: env.ENVIRONMENT === "development",
					},
					output,
					{
						outputId: output.id,
						revisionId: result.revision.id,
						revision: result.revision.revision,
					},
				),
			);
		console.info({
			event: "os_output_sheet_blocks_saved",
			outputId: output.id,
			saveMs: Math.round(performance.now() - start),
			rowsRead:
				[...selection.values()].reduce((sum, rows) => sum + rows.size, 0) *
				(base === manifest ? 1 : 2),
			rowsChanged: next.tables.reduce(
				(sum, table, index) =>
					sum +
					table.rows.filter(
						(row, position) =>
							row.digest !== manifest.tables[index]!.rows[position]!.digest,
					).length,
				0,
			),
			manifestBytes: body.contentBytes,
			sheetBytes: sheetContentBytes(next),
		});
		return {
			output: mapOsOutputRow(result.output ?? output),
			revision: {
				id: result.revision.id,
				revision: result.revision.revision,
				createdAt: result.revision.createdAt,
			},
			mergedWith: base === manifest ? null : current.revision,
			continuesBurst:
				input.autosave === true &&
				continuesOutputAutosaveBurst(current, {
					note,
					createdByKind: input.creator.kind,
					createdById: input.creator.id,
					skillRunId: input.producer.skillRunId,
					createdAt: result.revision.createdAt,
				}),
			catchUp: diffOutputContent(mine, content),
		};
	}
	throw new ORPCError("CONFLICT", { message: "Sheet changed while saving" });
}
