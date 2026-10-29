import { expect, test } from "bun:test";
import { deliverDevinWorkResult } from "./devin-work-result";

test("delivers the actual multiline note and preserves an incomplete outcome", async () => {
	for (const outcome of ["succeeded", "failed"] as const) {
		const notes: string[] = [];
		const note = "First paragraph.\nEvidence: https://example.invalid/proof";
		const result = await deliverDevinWorkResult(
			`Reading README.\nTEDIX_WORK_RESULT ${JSON.stringify({ outcome, note })}`,
			async (value) => {
				notes.push(value);
			},
		);
		expect(result.outcome).toBe(outcome);
		expect(notes).toEqual([note]);
	}
});

test.each([
	"I could not post the requested result.",
	'TEDIX_WORK_RESULT {"outcome":"succeeded","note":""}',
	'TEDIX_WORK_RESULT {"outcome":"succeeded","note":"result","workItemId":"other-work"}',
	'TEDIX_WORK_RESULT {"outcome":"succeeded","note":"result"}\nActually incomplete.',
	'TEDIX_WORK_RESULT {}\nTEDIX_WORK_RESULT {"outcome":"succeeded","note":"result"}',
	`TEDIX_WORK_RESULT ${JSON.stringify({ outcome: "succeeded", note: "x".repeat(10001) })}`,
])(
	"rejects incomplete or unbounded result without a write",
	async (message) => {
		let writes = 0;
		await expect(
			deliverDevinWorkResult(message, async () => {
				writes++;
			}),
		).rejects.toThrow();
		expect(writes).toBe(0);
	},
);

test("delivery denial is a failure, not a successful result", async () => {
	await expect(
		deliverDevinWorkResult(
			'TEDIX_WORK_RESULT {"outcome":"succeeded","note":"result"}',
			async () => {
				throw new Error("existing authority denied");
			},
		),
	).rejects.toThrow("existing authority denied");
});
