import { describe, expect, test } from "bun:test";
import { createInMemoryAdapters } from "@tedix/agent-governance/in-memory";
import { buildWorkspaceBindings } from "./bindings";
import type { WorkspaceDataPort } from "./data-port";

function fakeData(): WorkspaceDataPort {
	const work = [
		{
			id: "1",
			title: "a",
			disposition: "accepted",
			workKind: "coding",
			priority: null,
			projectId: "p",
			updatedAt: "2",
		},
		{
			id: "2",
			title: "b",
			disposition: "completed",
			workKind: "coding",
			priority: null,
			projectId: "p",
			updatedAt: "1",
		},
	];
	return {
		workspace: async () => ({
			id: "w",
			name: "W",
			description: null,
			organizationId: "o",
			projectIds: ["p"],
		}),
		listOutputs: async () => [],
		getOutput: async (id) => ({
			id,
			kind: "sheet",
			title: "S",
			status: "active",
			revision: 3,
			revisionId: "r3",
			updatedAt: "t",
			content: null,
		}),
		createOutput: async () => {
			throw new Error("unused");
		},
		reviseOutput: async (input) => ({
			id: input.outputId,
			kind: "sheet",
			title: "S",
			status: "active",
			revision: 4,
			revisionId: "r4",
			updatedAt: "t",
			content: input.content,
		}),
		listApps: async () => [],
		getAppCode: async () => {
			throw new Error("unused");
		},
		reviseAppCode: async () => {
			throw new Error("unused");
		},
		listResources: async () => [],
		listWork: async () => work,
		createWork: async (input) => ({
			id: "new",
			title: input.title,
			disposition: "proposed",
			workKind: input.workKind ?? "other",
			priority: input.priority ?? "medium",
			projectId: input.projectId ?? "p",
			updatedAt: input.actorId,
		}),
	};
}

describe("workspace bindings", () => {
	test("document writes share canonical CAS, revisions and approval policy", async () => {
		const data = fakeData();
		let current = {
			id: "doc",
			kind: "document" as const,
			title: "Doc",
			status: "active" as const,
			revision: 3,
			revisionId: "r3",
			updatedAt: "t",
			content: {
				kind: "document" as const,
				blocks: [{ type: "paragraph" as const, text: "Before" }],
			},
		};
		let writes = 0;
		data.getOutput = async (id) => (id === current.id ? current : null);
		data.reviseOutput = async (input) => {
			if (input.expectedRevision !== current.revision)
				throw new Error("Revision conflict");
			if (input.content.kind !== "document")
				throw new Error("Expected document");
			writes++;
			current = {
				...current,
				revision: current.revision + 1,
				revisionId: `r${current.revision + 1}`,
				content: input.content,
			};
			return current;
		};
		const make = (ask = false) => {
			const adapters = createInMemoryAdapters(
				ask ? { policies: { output: { disposition: "ask" } } } : {},
			);
			const env = buildWorkspaceBindings({
				data,
				...adapters,
				actor: { id: "agent", kind: "tedi", organizationId: "o" },
				source: { surface: "workspace_object", traceId: "t" },
			});
			return {
				adapters,
				documents: env.documents as {
					read(input: unknown): Promise<unknown>;
					edit(input: unknown): Promise<unknown>;
					replace(input: unknown): Promise<unknown>;
				},
			};
		};
		const denied = make(true);
		await expect(
			denied.documents.edit({
				outputId: "doc",
				expectedRevision: 3,
				ops: [
					{
						op: "replace",
						index: 0,
						block: { type: "paragraph", text: "After" },
					},
				],
			}),
		).rejects.toThrow("Approval required");
		expect(writes).toBe(0);
		const allowed = make();
		await allowed.documents.edit({
			outputId: "doc",
			expectedRevision: 3,
			ops: [
				{
					op: "replace",
					index: 0,
					block: { type: "paragraph", text: "After" },
				},
			],
		});
		expect(current.content.blocks[0]).toEqual({
			type: "paragraph",
			text: "After",
		});
		const [record] = await allowed.adapters.accountability.list();
		expect(record?.before?.revisionId).toBe("r3");
		expect(record?.after?.revisionId).toBe("r4");
		expect(record?.undo?.kind).toBe("rollback_revision");
		await expect(
			allowed.documents.replace({
				outputId: "doc",
				expectedRevision: 3,
				content: { kind: "document", blocks: [] },
			}),
		).rejects.toThrow("Revision conflict");
		await expect(
			allowed.documents.read({ outputId: "another-workspace" }),
		).rejects.toThrow("Document not found");
		expect(writes).toBe(1);
	});

	test("reads pass and are recorded; listOpen filters closed items", async () => {
		const adapters = createInMemoryAdapters();
		const env = buildWorkspaceBindings({
			data: fakeData(),
			compliance: adapters.compliance,
			accountability: adapters.accountability,
			actor: { id: "u1", kind: "user", organizationId: "o" },
			source: { surface: "workspace_object", traceId: "t" },
		});
		const open = await (
			env.work as { listOpen(): Promise<unknown[]> }
		).listOpen();
		expect(open).toHaveLength(1);
		const records = await adapters.accountability.list();
		expect(records).toHaveLength(1);
		expect(records[0]?.operation).toBe("listOpen");
		expect(records[0]?.decision.riskTier).toBe("read");
		expect(records[0]?.outcome).toBe("applied");
	});

	test("filing a Work Item is a bounded write that holds for approval", async () => {
		const make = (ask: boolean) => {
			const adapters = createInMemoryAdapters(
				ask ? { policies: { work: { disposition: "ask" } } } : {},
			);
			const env = buildWorkspaceBindings({
				data: fakeData(),
				...adapters,
				actor: { id: "u1", kind: "user", organizationId: "o" },
				source: { surface: "workspace_object", traceId: "t" },
			});
			return {
				adapters,
				work: env.work as { create(input: unknown): Promise<unknown> },
			};
		};
		const held = make(true);
		await expect(
			held.work.create({ title: "Make the Work tab live" }),
		).rejects.toThrow("Approval required");
		const [hold] = await held.adapters.accountability.list({
			resource: "work",
		});
		expect(hold?.operation).toBe("create");
		expect(hold?.outcome).toBe("needs_approval");
		expect(hold?.decision.riskTier).toBe("bounded_write");

		const allowed = make(false);
		expect(
			await allowed.work.create({ title: "Make the Work tab live" }),
		).toMatchObject({ id: "new", disposition: "proposed", updatedAt: "u1" });
	});

	test("a write records before/after revisions and an undo plan", async () => {
		const adapters = createInMemoryAdapters();
		const env = buildWorkspaceBindings({
			data: fakeData(),
			compliance: adapters.compliance,
			accountability: adapters.accountability,
			actor: { id: "u1", kind: "user", organizationId: "o" },
			source: { surface: "workspace_object", traceId: "t" },
		});
		await (env.outputs as { revise(i: unknown): Promise<unknown> }).revise({
			outputId: "x",
			content: { kind: "sheet", columns: [], rows: [] },
			expectedRevision: 3,
		});
		const [record] = await adapters.accountability.list({ resource: "output" });
		expect(record?.before?.revisionId).toBe("r3");
		expect(record?.after?.revisionId).toBe("r4");
		expect(record?.undo?.kind).toBe("rollback_revision");
		expect(record?.decision.riskTier).toBe("bounded_write");
	});
});
