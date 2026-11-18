/**
 * The file tools agents call (`create_os_output`, `revise_os_output`,
 * `move_os_output`), through the router and the workspace-store fixture. Each
 * answer must be true: a save that reports success has saved, a no-op says it
 * changed nothing, and a refusal names its real cause.
 */
import type { WorkspaceOutputRuntime } from "@tedix/db/queries/durable-sqlite/output-rpc";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { enrichInputValidationError } from "../input-validation-error";
import { clients, homeWorkspaceId } from "./__tests__/os-workspaces-env";

let c: ReturnType<typeof clients>;
beforeEach(() => {
	c = clients();
});
afterEach(() => {
	vi.restoreAllMocks();
});

const paragraph = (text: string) => ({
	type: "paragraph",
	content: [{ type: "text", text }],
});

async function currentBody(outputId: string) {
	const read = await c.org1.outputs.get({ outputId });
	return {
		revision: read.currentRevision.revision,
		content: read.currentRevision.content,
	};
}

describe("revise_os_output", () => {
	async function document() {
		return c.org1.outputs.create({
			workspaceId: await homeWorkspaceId(c.env),
			kind: "document",
			title: "Letter",
			content: {
				kind: "document",
				blocks: [{ type: "paragraph", text: "First draft" }],
			},
		});
	}

	it("saves a new revision without expectedRevision and returns it", async () => {
		const created = await document();
		const revised = await c.machine.outputs.revise({
			outputId: created.output.id,
			content: {
				kind: "document",
				blocks: [{ type: "paragraph", text: "Second draft" }],
			},
		});
		expect(revised.status).toBe("saved");
		expect(revised.revision.revision).toBe(2);
		expect(revised.output.currentRevisionId).toBe(revised.revision.id);
		const stored = await currentBody(created.output.id);
		expect(stored.revision).toBe(2);
		expect(stored.content).toMatchObject({
			blocks: [{ type: "paragraph", text: "Second draft" }],
		});
		expect(stored.content).toEqual(revised.revision.content);
	});

	it("saves a new revision with expectedRevision and refuses a stale one that overlaps", async () => {
		const created = await document();
		const revised = await c.machine.outputs.revise({
			outputId: created.output.id,
			content: {
				kind: "document",
				blocks: [{ type: "paragraph", text: "Second draft" }],
			},
			expectedRevision: 1,
		});
		expect(revised.status).toBe("saved");
		expect(revised.revision.revision).toBe(2);
		expect((await currentBody(created.output.id)).content).toMatchObject({
			blocks: [{ type: "paragraph", text: "Second draft" }],
		});
		await expect(
			c.machine.outputs.revise({
				outputId: created.output.id,
				content: {
					kind: "document",
					blocks: [{ type: "paragraph", text: "Third draft" }],
				},
				expectedRevision: 1,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(await currentBody(created.output.id)).toMatchObject({
			revision: 2,
			content: { blocks: [{ type: "paragraph", text: "Second draft" }] },
		});
	});

	it("says a revise with identical content changed nothing instead of looking like a save", async () => {
		const created = await document();
		for (const expectedRevision of [undefined, 1]) {
			const same = await c.machine.outputs.revise({
				outputId: created.output.id,
				content: {
					kind: "document",
					blocks: [{ type: "paragraph", text: "First draft" }],
				},
				note: "Nothing new",
				...(expectedRevision ? { expectedRevision } : {}),
			});
			expect(same.status).toBe("unchanged");
			expect(same.revision.id).toBe(created.revision.id);
			expect(same.revision.revision).toBe(1);
		}
		const history = await c.org1.outputs.history({
			outputId: created.output.id,
		});
		expect(history.revisions.map((item) => item.revision)).toEqual([1]);
	});

	it("saves content the server normalises, and treats a second identical send as unchanged", async () => {
		const created = await document();
		// Markdown is rebuilt into blocks and rich text before it is stored.
		const revised = await c.machine.outputs.revise({
			outputId: created.output.id,
			content: "# Offer\n\nSecond draft",
		});
		expect(revised.status).toBe("saved");
		expect(revised.revision.revision).toBe(2);
		expect((await currentBody(created.output.id)).content).toMatchObject({
			blocks: [
				{ type: "heading", level: 1, text: "Offer" },
				{ type: "paragraph", text: "Second draft" },
			],
		});
		// A paragraph holding Markdown is expanded too: the stored body differs
		// from what was sent, and the answer carries the stored body.
		const expanded = await c.machine.outputs.revise({
			outputId: created.output.id,
			content: {
				kind: "document",
				blocks: [],
				richText: { type: "doc", content: [paragraph("## Terms")] },
			},
		});
		expect(expanded.status).toBe("saved");
		expect(expanded.revision.revision).toBe(3);
		expect(expanded.revision.content).toMatchObject({
			blocks: [{ type: "heading", level: 2, text: "Terms" }],
		});
		const again = await c.machine.outputs.revise({
			outputId: created.output.id,
			content: {
				kind: "document",
				blocks: [],
				richText: { type: "doc", content: [paragraph("## Terms")] },
			},
		});
		expect(again.status).toBe("unchanged");
		expect(again.revision.revision).toBe(3);
	});
});

describe("create_os_output with a richText body", () => {
	// The HTTP handler names the refused field the same way before answering.
	const create = async (content: unknown) =>
		c.machine.outputs
			.create({
				workspaceId: await homeWorkspaceId(c.env),
				kind: "document",
				title: "Letter",
				content: content as never,
			})
			.catch((error: unknown) => {
				throw enrichInputValidationError(error);
			});

	it("creates a document from richText alone", async () => {
		const created = await create({
			kind: "document",
			richText: {
				type: "doc",
				content: [
					{
						type: "heading",
						attrs: { level: 1 },
						content: [{ type: "text", text: "Offer" }],
					},
					paragraph("Dear customer"),
				],
			},
		});
		expect(created.revision.revision).toBe(1);
		expect((await currentBody(created.output.id)).content).toMatchObject({
			kind: "document",
			blocks: [
				{ type: "heading", level: 1, text: "Offer" },
				{ type: "paragraph", text: "Dear customer" },
			],
			richText: { type: "doc" },
		});
	});

	it("creates a document from richText plus blocks, with blocks rebuilt from the rich text", async () => {
		const created = await create({
			kind: "document",
			blocks: [{ type: "paragraph", text: "Stale projection" }],
			richText: {
				type: "doc",
				content: [
					paragraph("Dear customer"),
					{
						type: "bulletList",
						content: [
							{ type: "listItem", content: [paragraph("One")] },
							{ type: "listItem", content: [paragraph("Two")] },
						],
					},
					{ type: "paragraph" },
					{
						type: "table",
						content: [
							{
								type: "tableRow",
								content: [
									{ type: "tableHeader", content: [paragraph("Item")] },
									{ type: "tableHeader", content: [paragraph("Price")] },
								],
							},
							{
								type: "tableRow",
								content: [
									{ type: "tableCell", content: [paragraph("Car")] },
									{ type: "tableCell", content: [paragraph("1")] },
								],
							},
						],
					},
				],
			},
		});
		expect((await currentBody(created.output.id)).content).toMatchObject({
			blocks: [
				{ type: "paragraph", text: "Dear customer" },
				{ type: "list", items: ["One", "Two"] },
				{ type: "paragraph", text: "" },
				{ type: "table", headers: ["Item", "Price"], rows: [["Car", "1"]] },
			],
		});
	});

	it.each([
		["richText as a string", { kind: "document", richText: "Dear customer" }],
		[
			"a node list instead of a doc",
			{ kind: "document", richText: [paragraph("Dear customer")] },
		],
		[
			"children instead of content",
			{
				kind: "document",
				blocks: [],
				richText: { type: "doc", children: [paragraph("Dear customer")] },
			},
		],
		[
			"a node without a type",
			{
				kind: "document",
				blocks: [],
				richText: { type: "doc", content: [{ text: "Dear customer" }] },
			},
		],
		[
			"content that is not a list",
			{
				kind: "document",
				richText: { type: "doc", content: { type: "paragraph" } },
			},
		],
		[
			"a table row without cells, which the block form cannot hold",
			{
				kind: "document",
				richText: {
					type: "doc",
					content: [
						{ type: "table", content: [{ type: "tableRow", content: [] }] },
					],
				},
			},
		],
	])("refuses %s as BAD_REQUEST naming richText", async (_name, content) => {
		const refused = await create(content).then(
			() => undefined,
			(error: { code?: string; message?: string }) => error,
		);
		expect(refused?.code).toBe("BAD_REQUEST");
		expect(refused?.message).toContain("content.richText");
		const listed = await c.org1.outputs.list({
			workspaceId: await homeWorkspaceId(c.env),
		});
		expect(listed.items).toEqual([]);
	});
});

describe("move_os_output refusals", () => {
	const runtime = () =>
		(c.env as unknown as { WORKSPACE_RUNTIME: WorkspaceOutputRuntime })
			.WORKSPACE_RUNTIME;

	async function fileInDrafts() {
		const { workspace: from } = await c.org1.workspaces.create({
			name: "Drafts",
		});
		const { workspace: to } = await c.org1.workspaces.create({
			name: "Launch",
		});
		const created = await c.org1.outputs.create({
			workspaceId: from.id,
			kind: "document",
			title: "Launch brief",
			content: "First draft",
		});
		return { from, to, outputId: created.output.id };
	}

	/** One workspace's store answers that it does not keep its own files yet. */
	function storeNotReady(workspaceId: string) {
		const store = runtime();
		const query = store.outputQuery.bind(store);
		vi.spyOn(store, "outputQuery").mockImplementation(((
			scope: Parameters<typeof query>[0],
			request: Parameters<typeof query>[1],
		) =>
			request.op === "authority" && scope.workspaceId === workspaceId
				? Promise.resolve("shared")
				: query(scope, request)) as typeof store.outputQuery);
	}

	async function expectStillIn(outputId: string, workspaceId: string) {
		const read = await c.org1.outputs.get({ outputId });
		expect(read.output.workspaceId).toBe(workspaceId);
	}

	it("names the target workspace when it does not exist or the caller cannot open it", async () => {
		const { from, outputId } = await fileInDrafts();
		const { workspace: foreign } = await c.org2.workspaces.create({
			name: "Elsewhere",
		});
		for (const workspaceId of [crypto.randomUUID(), foreign.id])
			await expect(
				c.org1.outputs.move({ outputId, workspaceId }),
			).rejects.toMatchObject({
				code: "NOT_FOUND",
				message:
					"The target workspace was not found, or you cannot open it. The file was not moved.",
			});
		await expectStillIn(outputId, from.id);
	});

	it("says the target's file storage is not ready instead of reporting a move in progress", async () => {
		const { from, to, outputId } = await fileInDrafts();
		storeNotReady(to.id);
		const transfer = vi.spyOn(runtime(), "transferOutput");
		await expect(
			c.org1.outputs.move({ outputId, workspaceId: to.id }),
		).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
			message:
				"The target workspace's file storage is not set up yet, so it cannot take files. The file was not moved.",
		});
		expect(transfer).not.toHaveBeenCalled();
		await expectStillIn(outputId, from.id);
	});

	it("says the file's own workspace storage is not ready", async () => {
		const { from, to, outputId } = await fileInDrafts();
		storeNotReady(from.id);
		const transfer = vi.spyOn(runtime(), "transferOutput");
		await expect(
			c.org1.outputs.move({ outputId, workspaceId: to.id }),
		).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
			message:
				"The workspace this file is in does not keep its own files yet, so the file cannot be moved out of it. The file was not moved.",
		});
		expect(transfer).not.toHaveBeenCalled();
	});

	it("reports a move in progress only when the store says one is", async () => {
		const { to, outputId } = await fileInDrafts();
		vi.spyOn(runtime(), "transferOutput").mockResolvedValue({
			ok: false,
			reason: "conflict",
		});
		await expect(
			c.org1.outputs.move({ outputId, workspaceId: to.id }),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message:
				"Another move of this file is still in progress. Wait for it to finish, then read the file to see which workspace it is in.",
		});
	});

	it("says the file is gone when the store no longer has it", async () => {
		const { to, outputId } = await fileInDrafts();
		vi.spyOn(runtime(), "transferOutput").mockResolvedValue({
			ok: false,
			reason: "not_found",
		});
		await expect(
			c.org1.outputs.move({ outputId, workspaceId: to.id }),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
			message:
				"The file is no longer in its workspace: it was deleted or already moved. Read it again to see where it is.",
		});
	});

	it("says a move that broke part-way did not finish", async () => {
		const { to, outputId } = await fileInDrafts();
		vi.spyOn(runtime(), "transferOutput").mockRejectedValue(
			new Error("Injected lost transfer reply"),
		);
		vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(
			c.org1.outputs.move({ outputId, workspaceId: to.id }),
		).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
			message:
				"The move did not finish. Read the file to see which workspace it is in, then move it again if needed.",
		});
	});

	it("changes nothing when the file is already in the target workspace", async () => {
		const { from, outputId } = await fileInDrafts();
		const transfer = vi.spyOn(runtime(), "transferOutput");
		const moved = await c.org1.outputs.move({ outputId, workspaceId: from.id });
		expect(moved).toMatchObject({
			previousWorkspaceId: from.id,
			output: { id: outputId, workspaceId: from.id },
		});
		expect(transfer).not.toHaveBeenCalled();
	});
});
