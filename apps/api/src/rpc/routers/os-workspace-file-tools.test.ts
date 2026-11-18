/**
 * The file tools agents call (`create_os_output`, `revise_os_output`,
 * `move_os_output`), through the router and the workspace-store fixture. Each
 * answer must be true: a save that reports success has saved, a no-op says it
 * changed nothing, and a refusal names its real cause.
 */
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { enrichInputValidationError } from "../input-validation-error";
import { clients, homeWorkspaceId } from "./__tests__/os-workspaces-env";

let c: ReturnType<typeof clients>;
beforeEach(() => {
	c = clients();
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
