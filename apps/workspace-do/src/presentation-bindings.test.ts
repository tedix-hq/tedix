import { describe, expect, test } from "bun:test";
import { createInMemoryAdapters } from "@tedix/agent-governance/in-memory";
import { buildPresentationBinding } from "./presentation-bindings";
import type { OutputDetail, WorkspaceDataPort } from "./data-port";

function fixture(ask = false) {
	let current: OutputDetail = {
		id: "presentation",
		kind: "presentation",
		title: "Launch",
		status: "active",
		revision: 3,
		revisionId: "r3",
		updatedAt: "time",
		content: {
			kind: "presentation",
			slides: [{ title: "Before", bullets: ["Original"] }],
		},
	};
	let writes = 0;
	const data: WorkspaceDataPort = {
		workspace: async () => ({
			id: "workspace",
			name: "Example",
			description: null,
			organizationId: "org",
			projectIds: [],
		}),
		listOutputs: async () => [current],
		getOutput: async (id) =>
			id === current.id ? structuredClone(current) : null,
		createOutput: async () => {
			throw new Error("Unexpected create");
		},
		reviseOutput: async (input) => {
			if (input.expectedRevision !== current.revision)
				throw new Error("Revision conflict");
			writes++;
			current = {
				...current,
				revision: current.revision + 1,
				revisionId: `r${current.revision + 1}`,
				content: input.content,
			};
			return structuredClone(current);
		},
		listApps: async () => [],
		getAppCode: async () => {
			throw new Error("unused");
		},
		editAppFiles: async () => {
			throw new Error("unused");
		},
		listResources: async () => [],
		listWork: async () => [],
		createWork: async () => {
			throw new Error("unused");
		},
	};
	const adapters = createInMemoryAdapters(
		ask ? { policies: { output: { disposition: "ask" } } } : {},
	);
	return {
		...adapters,
		current: () => current,
		writes: () => writes,
		binding: buildPresentationBinding({
			data,
			...adapters,
			actor: { id: "agent", kind: "tedi", organizationId: "org" },
			source: { surface: "workspace_object", traceId: "trace" },
		}),
	};
}

describe("presentation binding", () => {
	test("holds writes for approval before touching canonical content", async () => {
		const app = fixture(true);
		await expect(
			app.binding.edit({
				outputId: "presentation",
				expectedRevision: 3,
				ops: [
					{ op: "replace", index: 0, slide: { title: "After", bullets: [] } },
				],
			}),
		).rejects.toThrow("Approval required");
		expect(app.writes()).toBe(0);
		expect(app.current().revision).toBe(3);
	});
	test("shares canonical revisions, records rollback and rejects stale or inaccessible writes", async () => {
		const app = fixture();
		await app.binding.edit({
			outputId: "presentation",
			expectedRevision: 3,
			ops: [
				{
					op: "replace",
					index: 0,
					slide: { title: "After", bullets: ["Updated"] },
				},
			],
		});
		expect(app.current()).toMatchObject({
			revision: 4,
			content: {
				kind: "presentation",
				slides: [{ title: "After", bullets: ["Updated"] }],
			},
		});
		const [record] = await app.accountability.list();
		expect(record).toMatchObject({
			before: { revisionId: "r3" },
			after: { revisionId: "r4" },
			undo: { kind: "rollback_revision" },
		});
		await expect(
			app.binding.replace({
				outputId: "presentation",
				expectedRevision: 3,
				content: { kind: "presentation", slides: [] },
			}),
		).rejects.toThrow("Revision conflict");
		await expect(
			app.binding.read({ outputId: "another-workspace" }),
		).rejects.toThrow("Presentation not found");
		expect(app.writes()).toBe(1);
	});
});
