import type { RevisionRef, UndoPlan } from "@tedix/agent-governance/types";
import { wrapBinding } from "@tedix/agent-governance/wrap-binding";
import {
	OsOutputContentSchema,
	OsOutputPatchSchema,
	type OsOutputContent,
} from "@tedix/api-contract/schemas/os-workspaces";
import { applySheetRange } from "@tedix/api-contract/utils/sheet-range";
import type { BindingDeps } from "./bindings";
import type { OutputDetail } from "./data-port";

export function buildSheetBinding(deps: BindingDeps) {
	const read = async (input: { outputId: string }) => {
		const output = await deps.data.getOutput(input.outputId);
		if (!output || output.content?.kind !== "sheet")
			throw new Error("Sheet not found or unavailable");
		return { ...output, content: output.content };
	};
	const sheetWrite = {
		riskTier: "bounded_write" as const,
		blastRadius: "single_resource" as const,
		before: async (args: unknown[]): Promise<RevisionRef | undefined> => {
			const output = await deps.data.getOutput(
				(args[0] as { outputId: string }).outputId,
			);
			return output?.revisionId ? { revisionId: output.revisionId } : undefined;
		},
		after: async (
			_args: unknown[],
			result: unknown,
		): Promise<RevisionRef | undefined> => {
			const output = result as OutputDetail;
			return output.revisionId ? { revisionId: output.revisionId } : undefined;
		},
		undo: (
			_args: unknown[],
			_result: unknown,
			before?: RevisionRef,
		): UndoPlan | undefined =>
			before ? { kind: "rollback_revision", toRevision: before } : undefined,
	};
	return wrapBinding(
		{
			read,
			replace: async (input: {
				outputId: string;
				expectedRevision: number;
				content: unknown;
			}) => {
				await read(input);
				const content = OsOutputContentSchema.parse(input.content);
				if (content.kind !== "sheet") throw new Error("Expected sheet content");
				return deps.data.reviseOutput({
					outputId: input.outputId,
					expectedRevision: input.expectedRevision,
					content,
					actorId: deps.actor.id,
				});
			},
			edit: async (input: {
				outputId: string;
				expectedRevision: number;
				startRow: number;
				startColumn: number;
				cells: Extract<OsOutputContent, { kind: "sheet" }>["rows"];
			}) => {
				const output = await read(input);
				const patch = OsOutputPatchSchema.parse({
					kind: "sheet",
					expectedRevision: input.expectedRevision,
					startRow: input.startRow,
					startColumn: input.startColumn,
					cells: input.cells,
				});
				if (patch.kind !== "sheet") throw new Error("Expected sheet edits");
				const width = Math.max(...patch.cells.map((row) => row.length));
				if (patch.startColumn + width > output.content.columns.length)
					throw new Error(
						"The edited range exceeds the sheet columns; replace content to add columns first",
					);
				if (patch.startRow + patch.cells.length > 1000)
					throw new Error("The edited range exceeds the 1000-row sheet limit");
				const content = OsOutputContentSchema.parse(
					applySheetRange(
						output.content,
						patch.startRow,
						patch.startColumn,
						patch.cells,
					),
				);
				return deps.data.reviseOutput({
					outputId: input.outputId,
					expectedRevision: patch.expectedRevision,
					content,
					actorId: deps.actor.id,
				});
			},
		},
		{
			compliance: deps.compliance,
			accountability: deps.accountability,
			actor: deps.actor,
			source: deps.source,
			onRecorded: deps.onRecorded,
			resource: "output",
			methods: {
				read: { riskTier: "read", blastRadius: "none" },
				replace: sheetWrite,
				edit: sheetWrite,
			},
		},
	);
}
