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
		listResources: async () => [],
		listWork: async () => work,
	};
}

describe("workspace bindings", () => {
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
