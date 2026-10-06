import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
const api = vi.hoisted(() => ({ get: vi.fn(), saveFeedback: vi.fn() }));
vi.mock("@/lib/api", () => ({ osApi: { osShares: { reviews: api } } }));
import { SharedReviewBatch, splitRecommendation } from "./shared-review-batch";
const card = {
	id: "card",
	title: "Price question",
	url: "https://example.test/thread",
	relevance: "Needs checking. Price context helps",
	draft: "Original draft",
	effort: "low",
	checks: ["Confirm current price"],
	evidence: [{ label: "Price history", url: "https://example.test/prices" }],
};
const batch = {
	id: "batch",
	shareId: "share",
	title: "Review these cards",
	sourceOutputId: "source",
	sourceRevisionId: "revision",
	createdById: "owner",
	createdAt: "2026-10-06T12:00:00Z",
	cards: [
		card,
		{
			...card,
			id: "second",
			title: "Hostile thread",
			relevance: "Skip. Low effort, but the discussion is hostile.",
			draft: "Second draft",
			checks: [],
			evidence: [],
		},
	],
};
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.resetAllMocks();
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
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
			await tick();
		});
	}
	await show(shareId);
	const buttons = () => Array.from(container.querySelectorAll("button"));
	const button = (text: string, scope = "") =>
		Array.from(
			container.querySelectorAll<HTMLButtonElement>(`${scope} button`.trim()),
		).find((b) => b.textContent?.trim() === text);
	const queueItem = (title: string) =>
		container.querySelector<HTMLButtonElement>(
			`nav [data-card-id="${batch.cards.find((c) => c.title === title)!.id}"]`,
		)!;
	const click = async (element: HTMLElement | undefined) => {
		await act(async () => {
			element!.click();
			await tick();
		});
	};
	return { container, show, button, buttons, queueItem, click };
}
describe("splitRecommendation", () => {
	it("separates a short leading verdict from the rationale", () => {
		expect(splitRecommendation("Deprioritise. Needs PC expertise.")).toEqual({
			recommendation: "Deprioritise",
			rationale: "Needs PC expertise.",
		});
		expect(splitRecommendation("A concrete price question.")).toEqual({
			recommendation: null,
			rationale: "A concrete price question.",
		});
	});
});
describe("focused review app", () => {
	it("shows progress, a queue and separate recommendation and effort badges", async () => {
		api.get.mockResolvedValue({ batch, feedback: [] });
		const { container, queueItem } = await render();
		expect(container.textContent).toContain("0 of 2 reviewed");
		expect(container.textContent).toContain("Nothing is posted to Reddit");
		const first = queueItem("Price question");
		expect(first.getAttribute("aria-current")).toBe("true");
		expect(first.textContent).toContain("Needs checking");
		expect(first.textContent).toContain("low effort");
		expect(queueItem("Hostile thread").textContent).toContain("Skip");
		const detail = container.querySelector("article")!;
		expect(detail.textContent).toContain("Suggested: Needs checking");
		expect(detail.textContent).toContain("Price context helps");
		expect(detail.textContent).not.toContain("Needs checking. Price");
		expect(detail.textContent).toContain("Confirm current price");
		expect(detail.textContent).toContain("Price history");
		expect(container.textContent).not.toContain("Generic gadget");
	});

	it("saves only bounded feedback for the selected card without invoking tools", async () => {
		api.get.mockResolvedValue({ batch, feedback: [] });
		api.saveFeedback.mockResolvedValue({ feedback: { revision: 1 } });
		const { container, button, queueItem, click } = await render();
		await click(queueItem("Hostile thread"));
		await click(button("Skip", "article"));
		await click(button("Save feedback"));
		expect(api.saveFeedback).toHaveBeenCalledWith({
			shareId: "share",
			sessionToken: "session",
			batchId: "batch",
			cardId: "second",
			expectedRevision: 0,
			decision: "skip",
			editedReply: "Second draft",
			reason: "",
		});
		expect(container.textContent).toContain(
			"Feedback saved. Nothing was posted.",
		);
		expect(container.textContent).toContain("1 of 2 reviewed");
		expect(queueItem("Hostile thread").textContent).toContain("Saved · Skip");
	});

	it("keeps unsaved edits per card when switching and blocks edits during a save", async () => {
		api.get.mockResolvedValue({ batch, feedback: [] });
		let resolveSave: (value: unknown) => void = () => {};
		api.saveFeedback.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveSave = resolve;
				}),
		);
		const { container, button, queueItem, click } = await render();
		await click(button("Use with changes"));
		expect(queueItem("Price question").textContent).toContain(
			"Unsaved changes",
		);
		await click(queueItem("Hostile thread"));
		await click(queueItem("Price question"));
		expect(button("Use with changes")?.getAttribute("aria-pressed")).toBe(
			"true",
		);
		await act(async () => {
			button("Save feedback")!.click();
		});
		expect(
			(container.querySelector("textarea") as HTMLTextAreaElement).disabled,
		).toBe(true);
		expect(button("Skip", "article")?.disabled).toBe(true);
		await act(async () => {
			resolveSave({ feedback: { revision: 1 } });
			await tick();
		});
		expect(container.textContent).toContain("Feedback saved.");
		await click(button("Skip", "article"));
		expect(container.textContent).toContain("Unsaved changes");
		expect(container.textContent).not.toContain("Feedback saved.");
	});

	it("keeps the reviewer's text on a conflict and saves against the latest revision", async () => {
		api.get
			.mockResolvedValueOnce({ batch, feedback: [] })
			.mockResolvedValueOnce({
				batch,
				feedback: [
					{
						cardId: "card",
						reviewerId: "me",
						decision: "skip",
						editedReply: "Other tab",
						reason: "Other tab",
						revision: 3,
						updatedAt: "2026-10-06T13:00:00Z",
					},
				],
			});
		api.saveFeedback
			.mockRejectedValueOnce(
				Object.assign(new Error("changed"), { code: "CONFLICT" }),
			)
			.mockResolvedValueOnce({ feedback: { revision: 4 } });
		const { container, button, click } = await render();
		const reply = container.querySelector("textarea") as HTMLTextAreaElement;
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)!.set!;
			setter.call(reply, "My edited reply");
			reply.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await click(button("Save feedback"));
		expect(container.textContent).toContain("Someone saved a newer version");
		await click(button("Load latest version"));
		expect(
			(container.querySelector("textarea") as HTMLTextAreaElement).value,
		).toBe("My edited reply");
		await click(button("Save feedback"));
		expect(api.saveFeedback).toHaveBeenLastCalledWith(
			expect.objectContaining({
				expectedRevision: 3,
				editedReply: "My edited reply",
			}),
		);
		expect(container.textContent).toContain(
			"Feedback saved. Nothing was posted.",
		);
	});

	it("filters the queue and moves selection with the arrow keys", async () => {
		api.get.mockResolvedValue({
			batch,
			feedback: [
				{
					cardId: "second",
					reviewerId: "me",
					decision: "skip",
					editedReply: "Second draft",
					reason: "Hostile",
					revision: 1,
					updatedAt: "2026-10-06T13:00:00Z",
				},
			],
		});
		const { container, button, queueItem, click } = await render();
		expect(container.textContent).toContain("1 of 2 reviewed");
		await click(button("To review 1"));
		expect(container.querySelectorAll("nav [data-card-id]")).toHaveLength(1);
		await click(button("All 2"));
		await click(button("Skip", "nav"));
		expect(
			Array.from(container.querySelectorAll("nav [data-card-id]")).map((b) =>
				b.getAttribute("data-card-id"),
			),
		).toEqual(["second"]);
		await click(button("Any"));
		const first = queueItem("Price question");
		await act(async () => {
			first.focus();
			first.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
			);
			await tick();
		});
		expect(queueItem("Hostile thread").getAttribute("aria-current")).toBe(
			"true",
		);
		expect(document.activeElement).toBe(queueItem("Hostile thread"));
		expect(container.querySelector("article h3")?.textContent).toBe(
			"Hostile thread",
		);
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
					cards: [{ ...card, draft: "Fresh draft" }],
				},
				feedback: [],
			});
		const { container, show, button } = await render();
		expect(
			(container.querySelector("textarea") as HTMLTextAreaElement).value,
		).toBe("Earlier edited draft");
		await show("new-share");
		expect(
			(container.querySelector("textarea") as HTMLTextAreaElement).value,
		).toBe("Fresh draft");
		expect(button("Not sure yet")?.getAttribute("aria-pressed")).toBe("true");
	});
});
