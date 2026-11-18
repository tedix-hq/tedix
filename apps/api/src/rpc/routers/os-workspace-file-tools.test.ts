/**
 * The file tools agents call (`create_os_output`, `revise_os_output`,
 * `move_os_output`), through the router and the workspace-store fixture. Each
 * answer must be true: a save that reports success has saved, a no-op says it
 * changed nothing, and a refusal names its real cause.
 */
import { beforeEach, describe, expect, it } from "vite-plus/test";
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
