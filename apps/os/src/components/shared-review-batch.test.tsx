import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
const api = vi.hoisted(() => ({ get: vi.fn(), saveFeedback: vi.fn() }));
vi.mock("@/lib/api", () => ({ osApi: { osShares: { reviews: api } } }));
import { SharedReviewBatch } from "./shared-review-batch";
const batch = {
	id: "batch",
	shareId: "share",
	title: "Review these cards",
	sourceOutputId: "source",
	sourceRevisionId: "revision",
	createdById: "owner",
	createdAt: "2026-10-06T12:00:00Z",
	cards: [
		{
			id: "card",
			title: "Price question",
			url: "https://example.test/thread",
			relevance: "Price context helps",
			draft: "Original draft",
			effort: "low",
			checks: ["Confirm current price"],
			evidence: [
				{ label: "Price history", url: "https://example.test/prices" },
			],
		},
	],
};
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.resetAllMocks();
});
async function render(shareId = "share") {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	cleanups.push(() => {
		root.unmount();
		container.remove();
	});
	async function show(id: string) {
		await act(async () => {
			root.render(
				<SharedReviewBatch
					shareId={id}
					sessionToken="session"
					fallback={<p>Generic gadget</p>}
				/>,
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}
	await show(shareId);
	return { container, show };
}
describe("focused review UI", () => {
	it("shows source checks and saves only bounded feedback without invoking tools", async () => {
		api.get.mockResolvedValue({ batch, feedback: [] });
		api.saveFeedback.mockResolvedValue({ feedback: { revision: 1 } });
		const { container } = await render();
		expect(container.textContent).toContain("Price context helps");
		expect(container.textContent).toContain("Price history");
		expect(container.textContent).not.toContain("Generic gadget");
		await act(async () => {
			Array.from(container.querySelectorAll("button"))
				.find((b) => b.textContent === "Skip")!
				.click();
		});
		await act(async () => {
			Array.from(container.querySelectorAll("button"))
				.find((b) => b.textContent === "Save feedback")!
				.click();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(api.saveFeedback).toHaveBeenCalledWith({
			shareId: "share",
			sessionToken: "session",
			batchId: "batch",
			cardId: "card",
			expectedRevision: 0,
			decision: "skip",
			editedReply: "Original draft",
			reason: "",
		});
		expect(container.textContent).toContain(
			"Feedback saved. Nothing was posted.",
		);
	});
	it("clears saved status on new decisions and blocks edits during a save", async () => {
		api.get.mockResolvedValue({ batch, feedback: [] });
		let resolveSave: (value: unknown) => void = () => {};
		api.saveFeedback.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveSave = resolve;
				}),
		);
		const { container } = await render();
		const buttons = () => Array.from(container.querySelectorAll("button"));
		await act(async () => {
			buttons()
				.find((b) => b.textContent === "Save feedback")!
				.click();
		});
		expect(
			(container.querySelector("textarea") as HTMLTextAreaElement).disabled,
		).toBe(true);
		expect(buttons().find((b) => b.textContent === "Skip")?.disabled).toBe(
			true,
		);
		await act(async () => {
			resolveSave({ feedback: { revision: 1 } });
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(container.textContent).toContain("Feedback saved.");
		await act(async () => {
			buttons()
				.find((b) => b.textContent === "Skip")!
				.click();
		});
		expect(container.textContent).toContain("Unsaved changes");
		expect(container.textContent).not.toContain("Feedback saved.");
	});

	it("does not fall back to arbitrary widget tools on access failure", async () => {
		api.get.mockRejectedValue(new Error("Forbidden"));
		const { container } = await render();
		expect(container.textContent).toContain("Review unavailable");
		expect(container.textContent).not.toContain("Generic gadget");
	});
	it("loads a new batch with the same card id without carrying over the old decision", async () => {
		api.get
			.mockResolvedValueOnce({
				batch,
				feedback: [
					{
						cardId: "card",
						decision: "skip",
						editedReply: "Earlier edited draft",
						reason: "Earlier feedback",
						revision: 2,
					},
				],
			})
			.mockResolvedValueOnce({
				batch: {
					...batch,
					id: "new-batch",
					cards: [{ ...batch.cards[0], draft: "Fresh draft" }],
				},
				feedback: [],
			});
		const { container, show } = await render();
		expect(
			(container.querySelector("textarea") as HTMLTextAreaElement).value,
		).toBe("Earlier edited draft");
		await show("new-share");
		expect(
			(container.querySelector("textarea") as HTMLTextAreaElement).value,
		).toBe("Fresh draft");
		expect(
			Array.from(container.querySelectorAll("button"))
				.find((b) => b.textContent === "Needs checking")
				?.getAttribute("aria-pressed"),
		).toBe("true");
	});
});
