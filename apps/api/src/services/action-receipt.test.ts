import { describe, expect, it } from "vite-plus/test";
import {
	verifyAction,
	renderActionReceipt,
} from "@tedix/api-contract/utils/action-receipt";

const input = {
	operation: "os.create_os_output",
	args: {},
	result: { output: { id: "output-1", status: "active" } },
	actor: "tedi:worker-1",
	origin: "https://os.example.test",
};

describe("verified action receipts", () => {
	it("reads after mutation and reports canonical state rather than the write response", async () => {
		const receipt = await verifyAction({
			...input,
			read: async (tool, args) => {
				expect(tool).toBe("get_os_output");
				expect(args).toEqual({ outputId: "output-1" });
				return {
					output: { id: "output-1", status: "archived" },
					currentRevision: { revision: 2 },
				};
			},
		});
		expect(receipt).toMatchObject({
			verified: true,
			state: "archived, revision 2",
			url: "https://os.example.test/outputs/output-1",
			actor: "tedi:worker-1",
		});
		expect(renderActionReceipt(receipt)).toContain("archived, revision 2");
	});
	it("requires the exact Work comment to be present in read-back", async () => {
		const comment = {
			...input,
			operation: "work.add_work_items_comment",
			args: { id: "work-1" },
			result: { id: "comment-1", workItemId: "work-1" },
		};
		const read = async () => ({
			workItem: { id: "work-1", disposition: "accepted" },
			comments: [{ id: "other-comment" }],
		});
		expect((await verifyAction({ ...comment, read })).verified).toBe(false);
		const receipt = await verifyAction({
			...comment,
			read: async () => ({
				...(await read()),
				comments: [{ id: "comment-1" }],
			}),
		});
		expect(receipt).toMatchObject({
			verified: true,
			url: "https://os.example.test/work/items/work-1#comment-comment-1",
			state: "accepted",
		});
	});
	it.each([
		async () => {
			throw new Error("unavailable");
		},
		async () => ({ output: { id: "other", status: "active" } }),
		async () => ({ ok: false }),
	])("does not claim success when verification fails", async (read) => {
		const receipt = await verifyAction({ ...input, read });
		expect(receipt.verified).toBe(false);
		expect(renderActionReceipt(receipt)).toContain("verification unavailable");
	});
	it("does not guess a third-party read tool or treat an action acceptance as completion", async () => {
		let reads = 0;
		const receipt = await verifyAction({
			...input,
			operation: "supplier.send_invoice",
			read: async () => {
				reads++;
			},
		});
		expect(reads).toBe(0);
		expect(receipt.verified).toBe(false);
	});
});
