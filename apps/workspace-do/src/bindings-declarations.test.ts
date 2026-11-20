import { describe, expect, test } from "bun:test";
import { createInMemoryAdapters } from "@tedix/agent-governance/in-memory";
import {
	buildWorkspaceBindings,
	CONNECTION_REASON_MAX_CHARS,
	type ConnectionRequest,
} from "./bindings";
import type { ResourceSummary, WorkspaceDataPort } from "./data-port";

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
		listAppVersions: async () => [],
		getAppCode: async () => {
			throw new Error("unused");
		},
		editAppFiles: async () => {
			throw new Error("unused");
		},
		checkNewApp: async () => {
			throw new Error("unused");
		},
		readableFileTitles: async () => [],
		allowAppRead: async () => {
			throw new Error("unused");
		},
		createApp: async () => {
			throw new Error("unused");
		},
		registerAppSchedule: async () => {
			throw new Error("unused");
		},
		listResources: async () => [],
		listWork: async () => work,
		listOpenWork: async () => ({
			covers: "linked_projects",
			items: [],
			projects: [],
		}),
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
	test("asking for an account shows a card only for a source the person has not connected, and never waits for approval", async () => {
		const source = (
			id: string,
			connectedForYou: boolean | null,
			connectionScope: ResourceSummary["connectionScope"] = "personal",
		): ResourceSummary => ({
			id,
			name: `Source ${id}`,
			kind: "folder",
			status: "active",
			slot: null,
			providerId: "drive",
			service: "Example Drive",
			connectionScope,
			connectionInstanceId: connectedForYou === null ? null : `account-${id}`,
			providerAccess: null,
			connectedForYou,
		});
		const data = fakeData();
		data.listResources = async () => [
			source("missing", false),
			source("shared", false, "organization"),
			source("connected", true),
			source("file", null),
		];
		const adapters = createInMemoryAdapters();
		const asked: ConnectionRequest[] = [];
		const build = (inChat: boolean) =>
			buildWorkspaceBindings({
				data,
				...adapters,
				actor: { id: "person", kind: "user", organizationId: "o" },
				source: { surface: "workspace_object", traceId: "t" },
				...(inChat
					? { requestConnection: (request) => void asked.push(request) }
					: {}),
			}).resources as {
				requestConnection(input: {
					resourceId?: string;
					reason?: string;
				}): Promise<{ requested: boolean; message: string }>;
			};
		const resources = build(true);
		expect(
			await resources.requestConnection({
				resourceId: "missing",
				reason: ` ${"r".repeat(CONNECTION_REASON_MAX_CHARS + 20)} `,
			}),
		).toMatchObject({ requested: true });
		expect(
			await resources.requestConnection({ resourceId: "shared" }),
		).toMatchObject({
			requested: true,
			message: expect.stringContaining("organization admin"),
		});
		for (const resourceId of ["connected", "file"])
			expect(await resources.requestConnection({ resourceId })).toMatchObject({
				requested: false,
			});
		expect(asked).toEqual([
			{
				resourceId: "missing",
				resourceName: "Source missing",
				providerId: "drive",
				service: "Example Drive",
				connectionScope: "personal",
				reason: "r".repeat(CONNECTION_REASON_MAX_CHARS),
			},
			{
				resourceId: "shared",
				resourceName: "Source shared",
				providerId: "drive",
				service: "Example Drive",
				connectionScope: "organization",
			},
		]);
		await expect(
			resources.requestConnection({ resourceId: "unknown" }),
		).rejects.toThrow("No connected source has that id");
		await expect(resources.requestConnection({})).rejects.toThrow(
			"Name the source by its resourceId",
		);
		await expect(
			build(false).requestConnection({ resourceId: "missing" }),
		).rejects.toThrow("only in a chat turn");
		const records = await adapters.accountability.list({});
		// Recorded as reads that were allowed; none waited for a person.
		expect(records.length).toBeGreaterThan(0);
		expect(
			records.every(
				(record) =>
					record.operation === "requestConnection" &&
					record.decision.riskTier === "read" &&
					record.decision.verdict === "allow",
			),
		).toBe(true);
	});

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

	test("reads pass and are recorded", async () => {
		const adapters = createInMemoryAdapters();
		const env = buildWorkspaceBindings({
			data: fakeData(),
			compliance: adapters.compliance,
			accountability: adapters.accountability,
			actor: { id: "u1", kind: "user", organizationId: "o" },
			source: { surface: "workspace_object", traceId: "t" },
		});
		await (env.work as { listOpen(): Promise<unknown> }).listOpen();
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

	test("creating an app checks its files first, then always holds for approval", async () => {
		const files = { "server.js": "export class App {}", "client.js": "" };
		const make = (ask: boolean) => {
			const adapters = createInMemoryAdapters(
				ask ? { policies: { app: { disposition: "ask" } } } : {},
			);
			const data = fakeData();
			const calls: string[] = [];
			data.checkNewApp = async (input) => {
				calls.push("check");
				if (!("server.js" in input.files))
					throw new Error("server.js is required");
			};
			data.createApp = async (input) => {
				calls.push("create");
				return {
					id: "app-1",
					name: input.name,
					revision: 1,
					revisionId: input.actorId,
				};
			};
			const env = buildWorkspaceBindings({
				data,
				...adapters,
				actor: { id: "u1", kind: "user", organizationId: "o" },
				source: { surface: "workspace_object", traceId: "t" },
			});
			return {
				adapters,
				calls,
				apps: env.apps as { create(input: unknown): Promise<unknown> },
			};
		};
		const broken = make(true);
		await expect(
			broken.apps.create({ name: "Tally", files: { "client.js": "" } }),
		).rejects.toThrow("server.js is required");
		// A failed check asks nobody: no hold is recorded.
		expect(
			await broken.adapters.accountability.list({ resource: "app" }),
		).toEqual([]);

		const held = make(true);
		await expect(held.apps.create({ name: "Tally", files })).rejects.toThrow(
			"Approval required",
		);
		expect(held.calls).toEqual(["check"]);
		const [hold] = await held.adapters.accountability.list({ resource: "app" });
		expect(hold?.operation).toBe("create");
		expect(hold?.outcome).toBe("needs_approval");
		expect(hold?.decision.riskTier).toBe("bounded_write");

		const allowed = make(false);
		expect(await allowed.apps.create({ name: "Tally", files })).toEqual({
			id: "app-1",
			name: "Tally",
			revision: 1,
			revisionId: "u1",
		});
		expect(allowed.calls).toEqual(["check", "create"]);
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
