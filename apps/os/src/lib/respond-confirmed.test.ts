import { describe, expect, it, vi } from "vite-plus/test";
import { respondConfirmed } from "./respond-confirmed";

const input = {
	requestId: "950fdd5c-0000-4000-8000-000000000000",
	expectedRequestVersion: 3,
	body: "Reviewed: Records your review. Feedback: draft the email",
};
const fast = { checkAfterMs: 1, everyMs: 1, giveUpMs: 50 };

describe("respondConfirmed", () => {
	it("returns the server reply when it arrives", async () => {
		const reply = { response: { id: "r1" } };
		const api = { respond: vi.fn(async () => reply), get: vi.fn() };
		await expect(respondConfirmed(api, input, fast)).resolves.toBe(reply);
	});

	it("treats a stored answer as saved when the reply never arrives", async () => {
		const stored = { body: input.body, id: "r3" };
		const api = {
			respond: vi.fn(() => new Promise<never>(() => {})),
			get: vi
				.fn()
				.mockResolvedValueOnce({
					request: { version: 3 },
					responses: { data: [] },
				})
				.mockResolvedValue({
					request: { version: 4 },
					responses: { data: [{ body: "Later", id: "r2" }, stored] },
				}),
		};
		await expect(respondConfirmed(api, input, fast)).resolves.toEqual({
			request: { version: 4 },
			response: stored,
		});
	});

	it("stops saving with a clear error when nothing was stored", async () => {
		const api = {
			respond: vi.fn(() => new Promise<never>(() => {})),
			get: vi.fn(async () => ({
				request: { version: 3 },
				responses: { data: [] },
			})),
		};
		await expect(respondConfirmed(api, input, fast)).rejects.toThrow(
			/may not have been saved/,
		);
	});

	it("passes a refusal through unchanged", async () => {
		const api = {
			respond: vi.fn(async () => {
				throw new Error("This decision changed; reload the card");
			}),
			get: vi.fn(),
		};
		await expect(respondConfirmed(api, input, fast)).rejects.toThrow(
			"This decision changed",
		);
	});
});
