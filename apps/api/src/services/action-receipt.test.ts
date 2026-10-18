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

describe("Support action receipts", () => {
	const draft = {
		body: "Saved redacted answer",
		evidence: ["https://docs.example.test/guide"],
		nextStep: "Admin review",
	};
	const ticket = {
		receipt: {
			ticketId: "ticket-1",
			workItemId: "reporter-work",
			version: 2,
			status: "in-progress",
		},
		mirrorWorkItemId: "staff-work",
		draft,
	};
	const write = {
		...input,
		operation: "support.draft_support_answer",
		endpoint: "support/draft",
		args: {
			ticketId: "ticket-1",
			answer: { ...draft, body: "Unredacted input" },
		},
		result: ticket,
	};
	it("verifies the returned redacted draft in the canonical staff ticket, without claiming publication", async () => {
		const receipt = await verifyAction({
			...write,
			read: async (tool, args, endpoint) => {
				expect({ tool, args, endpoint }).toEqual({
					tool: "get_support_ticket",
					args: { ticketId: "ticket-1" },
					endpoint: "support/get",
				});
				return { ...ticket, receipt: { ...ticket.receipt, version: 3 } };
			},
		});
		expect(receipt).toMatchObject({
			verified: true,
			url: "https://os.example.test/work/items/staff-work",
			state: "draft present, version 3, in-progress; publication unverified",
		});
	});
	it.each([
		{ ...ticket, receipt: { ...ticket.receipt, ticketId: "other" } },
		{ ...ticket, receipt: { ...ticket.receipt, workItemId: "other" } },
		{ ...ticket, mirrorWorkItemId: "other" },
		{ ...ticket, receipt: { ...ticket.receipt, version: 1 } },
		{ ...ticket, draft: null },
		{ ...ticket, draft: { ...draft, body: "Overwritten" } },
		{
			...ticket,
			draft: { ...draft, evidence: ["https://docs.example.test/other"] },
		},
		{ ...ticket, draft: { ...draft, nextStep: "Different next step" } },
		{ ...ticket, ok: false },
	])(
		"leaves mismatched, stale, overwritten and failed draft reads unverified",
		async (read) => {
			expect(
				(await verifyAction({ ...write, read: async () => read })).verified,
			).toBe(false);
		},
	);
	const review = {
		...input,
		operation: "support.record_support_review",
		endpoint: "support/review",
		args: { summary: "New summary" },
		result: { workItemId: "review-work", interactionId: "review-1" },
	};
	const request = {
		id: "review-1",
		workItemId: "review-work",
		kind: "coordination",
		requestedFromType: "user",
		prompt: "Already saved daily summary",
		state: "open",
	};
	it("verifies an existing daily internal review without claiming a new summary or delivery", async () => {
		const receipt = await verifyAction({
			...review,
			read: async (tool, args, endpoint) => {
				expect({ tool, args, endpoint }).toEqual({
					tool: "get_work_interaction",
					args: { requestId: "review-1" },
					endpoint: "workInteractions/get",
				});
				return { request };
			},
		});
		expect(receipt).toMatchObject({
			verified: true,
			url: "https://os.example.test/work/items/review-work",
			state: "internal review present, open; delivery unverified",
		});
	});
	it.each([
		{ ...request, id: "other" },
		{ ...request, workItemId: "other" },
		{ ...request, kind: "question" },
		{ ...request, requestedFromType: "tedi" },
		{ ...request, prompt: " " },
		{ ...request, state: null },
	])("does not verify an unrelated or incomplete review", async (request) => {
		expect(
			(await verifyAction({ ...review, read: async () => ({ request }) }))
				.verified,
		).toBe(false);
	});
	it("does not map an external endpoint by its Support-like tool name", async () => {
		let reads = 0;
		const receipt = await verifyAction({
			...review,
			endpoint: "external/review",
			read: async () => {
				reads++;
				return { request };
			},
		});
		expect(reads).toBe(0);
		expect(receipt.verified).toBe(false);
	});
});
