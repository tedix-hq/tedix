import { describe, expect, test } from "bun:test";
import { createInMemoryAdapters } from "@tedix/agent-governance/in-memory";
import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import type { OutputDetail, WorkspaceDataPort } from "./data-port";
import { buildSheetBinding } from "./sheet-binding";

function fixture(ask = false) {
	const content: Extract<OsOutputContent, { kind: "sheet" }> = {
		kind: "sheet",
		columns: ["A", "B"],
		rows: [[2, 4]],
		workbook: {
			activeSheetId: "main",
			sheets: [
				{
					id: "main",
					name: "Main",
					columns: [
						{ id: "a", label: "A", width: 120 },
						{ id: "b", label: "B", width: 120 },
					],
					rows: [
						[
							{ input: "2", value: 2, format: { bold: true } },
							{ input: "=A1*2", value: 4 },
						],
					],
					frozenRows: 0,
					frozenColumns: 0,
				},
			],
		},
	};
	let output: OutputDetail = {
		id: "sheet",
		kind: "sheet",
		title: "Budget",
		status: "active",
		revision: 1,
		revisionId: "r1",
		updatedAt: "t",
		content,
	};
	let writes = 0;
	const data: WorkspaceDataPort = {
		workspace: async () => ({
			id: "workspace",
			name: "Workspace",
			description: null,
			organizationId: "org",
			projectIds: [],
		}),
		listOutputs: async () => [],
		getOutput: async (id) => (id === output.id ? output : null),
		createOutput: async () => {
			throw new Error("Unused");
		},
		reviseOutput: async (input) => {
			if (input.expectedRevision !== output.revision)
				throw new Error("Revision conflict");
			writes++;
			output = {
				...output,
				revision: output.revision + 1,
				revisionId: `r${output.revision + 1}`,
				content: input.content,
			};
			return output;
		},
		listApps: async () => [],
		listResources: async () => [],
		listWork: async () => [],
		createWork: async () => {
			throw new Error("unused");
		},
	};
	const adapters = createInMemoryAdapters(
		ask ? { policies: { output: { disposition: "ask" } } } : {},
	);
	const binding = buildSheetBinding({
		data,
		...adapters,
		actor: { id: "agent", kind: "tedi", organizationId: "org" },
		source: { surface: "workspace_object", traceId: "test" },
	});
	return { binding, adapters, writes: () => writes, current: () => output };
}
describe("Sheet binding", () => {
	test("holds a range write for approval without mutating the output", async () => {
		const { binding, adapters, writes } = fixture(true);
		await expect(
			binding.edit({
				outputId: "sheet",
				expectedRevision: 1,
				startRow: 0,
				startColumn: 0,
				cells: [[3]],
			}),
		).rejects.toThrow("Approval required");
		expect(writes()).toBe(0);
		const [record] = await adapters.accountability.list();
		expect(record?.outcome).toBe("needs_approval");
	});
	test("records canonical CAS edits while preserving formula inputs, cached values and formats", async () => {
		const { binding, adapters, current, writes } = fixture();
		const edited = await binding.edit({
			outputId: "sheet",
			expectedRevision: 1,
			startRow: 0,
			startColumn: 0,
			cells: [[3]],
		});
		if (edited.content?.kind !== "sheet") throw new Error("Expected sheet");
		expect(edited.content.workbook!.sheets[0]!.rows[0]![0]).toEqual({
			input: "3",
			value: 3,
			format: { bold: true },
		});
		expect(edited.content.workbook!.sheets[0]!.rows[0]![1]).toEqual({
			input: "=A1*2",
			value: 4,
		});
		const [record] = await adapters.accountability.list();
		expect(record?.before?.revisionId).toBe("r1");
		expect(record?.after?.revisionId).toBe("r2");
		expect(record?.undo?.kind).toBe("rollback_revision");
		await expect(
			binding.replace({
				outputId: "sheet",
				expectedRevision: 1,
				content: current().content,
			}),
		).rejects.toThrow("Revision conflict");
		expect(writes()).toBe(1);
	});
	test("rejects unavailable documents, malformed ranges and writes outside sheet bounds", async () => {
		const { binding, writes } = fixture();
		await expect(
			binding.read({ outputId: "another-workspace" }),
		).rejects.toThrow("Sheet not found");
		await expect(
			binding.edit({
				outputId: "sheet",
				expectedRevision: 1,
				startRow: 0,
				startColumn: 2,
				cells: [[1]],
			}),
		).rejects.toThrow("exceeds the sheet columns");
		await expect(
			binding.edit({
				outputId: "sheet",
				expectedRevision: 1,
				startRow: 50_000,
				startColumn: 0,
				cells: [[1]],
			}),
		).rejects.toThrow("50000-row");
		await expect(
			binding.edit({
				outputId: "sheet",
				expectedRevision: 1,
				startRow: -1,
				startColumn: 0,
				cells: [[1]],
			}),
		).rejects.toThrow();
		expect(writes()).toBe(0);
	});
});
