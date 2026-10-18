import { DecisionLearningContext } from "./decision-learning-context";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	WorkDecisionCard,
	type DecisionCardFeedback,
} from "./work-decision-card";

vi.mock("@/components/kumo/toast", () => ({ toast: { success: vi.fn() } }));
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
});
async function mount(
	props: Partial<Parameters<typeof WorkDecisionCard>[0]> = {},
) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const decide = vi.fn(async (_feedback: DecisionCardFeedback) => {});
	await act(async () =>
		root.render(
			<WorkDecisionCard
				kind="outbound"
				title="Reply to Morgan"
				askedBy="Robin"
				body="Thanks, Morgan."
				actions={[
					{ id: "send", label: "Send", intent: "approve" },
					{ id: "manual", label: "Approve, I'll send" },
					{ id: "reject", label: "Not this", intent: "reject" },
				]}
				onDecision={decide}
				{...props}
			/>,
		),
	);
	return decide;
}
async function click(label: string) {
	const button = [...document.querySelectorAll("button")].find(
		(item) => item.textContent === label,
	);
	expect(button).toBeDefined();
	await act(async () => button!.click());
}
async function type(selector: string, value: string) {
	const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(
		selector,
	)!;
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			input instanceof HTMLTextAreaElement
				? HTMLTextAreaElement.prototype
				: HTMLInputElement.prototype,
			"value",
		)!.set!.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("fast decision cards", () => {
	it("keeps search focus when a filtered card mounts", async () => {
		const search = document.createElement("input");
		document.body.append(search);
		search.focus();
		try {
			const decide = await mount({ autoFocus: true });
			expect(document.activeElement).toBe(search);
			await act(async () => {
				search.dispatchEvent(
					new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
				);
			});
			expect(decide).not.toHaveBeenCalled();
		} finally {
			search.remove();
		}
	});
	it("keeps fields hidden and records approval as-is with one click", async () => {
		const decide = await mount();
		expect(host.querySelector("input,textarea")).toBeNull();
		await click("Send");
		expect(decide).toHaveBeenCalledWith({
			action: "send",
			signal: "approve-as-is",
			body: "Thanks, Morgan.",
		});
		expect(host.textContent).toContain("Decision saved");
	});
	it("keeps edits and optional feedback with the final decision", async () => {
		const decide = await mount();
		await click("Change");
		await type("textarea", "Thanks — Friday works.");
		await click("Give feedback");
		await type(
			'textarea[aria-label="Optional feedback"]',
			"Keep replies brief.",
		);
		await click("Approve, I'll send");
		expect(decide).toHaveBeenCalledWith({
			action: "manual",
			signal: "edited",
			body: "Thanks — Friday works.",
			originalBody: "Thanks, Morgan.",
			feedback: "Keep replies brief.",
		});
	});
	it("offers one-tap rejection reasons without submitting prematurely", async () => {
		const decide = await mount();
		await click("Not this");
		expect(decide).not.toHaveBeenCalled();
		await click("wrong facts");
		expect(decide).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "reject",
				signal: "reason",
				reason: "wrong facts",
			}),
		);
	});
	it("requires explicit confirmation for standing rules, including keyboard", async () => {
		const decide = await mount({
			kind: "approval",
			actions: [
				{
					id: "always",
					label: "Always allow this",
					intent: "approve",
					confirm: "Allow this action across the organization?",
				},
			],
		});
		await act(async () =>
			host
				.querySelector("section")!
				.dispatchEvent(
					new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
				),
		);
		expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
		expect(decide).not.toHaveBeenCalled();
		await click("Confirm");
		expect(decide).toHaveBeenCalledTimes(1);
	});
	it("does not approve when typing and accepts offered answers with Enter", async () => {
		const decide = await mount({
			kind: "question",
			suggestedAnswers: ["Tuesday", "Friday"],
			actions: [{ id: "answer", label: "Answer", intent: "approve" }],
		});
		await type("input", "Thursday");
		await act(async () =>
			host
				.querySelector("input")!
				.dispatchEvent(
					new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
				),
		);
		expect(decide).not.toHaveBeenCalled();
		await click("Friday");
		await act(async () =>
			host
				.querySelector("input")!
				.dispatchEvent(
					new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
				),
		);
		expect(decide).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "answer",
				body: "Friday",
				signal: "answer",
			}),
		);
	});
	it("leaves a failed action retryable and never advances on failure", async () => {
		const onDecision = vi
			.fn()
			.mockRejectedValueOnce(new Error("Connection unavailable"))
			.mockResolvedValueOnce(undefined);
		const onNext = vi.fn();
		await mount({ onDecision, onNext });
		await click("Send");
		expect(host.querySelector('[role="alert"]')?.textContent).toBe(
			"Connection unavailable",
		);
		expect(onNext).not.toHaveBeenCalled();
		await click("Send");
		expect(onNext).toHaveBeenCalledTimes(1);
	});
	it("fences repeated keyboard gestures while an action is in flight", async () => {
		const onDecision = vi.fn(() => new Promise(() => {}));
		await mount({ onDecision });
		await act(async () => {
			for (let i = 0; i < 3; i++)
				host
					.querySelector("section")!
					.dispatchEvent(
						new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
					);
		});
		expect(onDecision).toHaveBeenCalledTimes(1);
	});
	it("ignores vertical scrolling and handles a horizontal swipe", async () => {
		const decide = await mount();
		const swipe = async (x: number, y: number) => {
			await act(async () => {
				for (const [name, points] of [
					["touchstart", { clientX: 10, clientY: 10 }],
					["touchend", { clientX: x, clientY: y }],
				] as const) {
					const event = new Event(name, { bubbles: true });
					Object.defineProperty(
						event,
						name === "touchstart" ? "touches" : "changedTouches",
						{ value: [points] },
					);
					host.querySelector("section")!.dispatchEvent(event);
				}
			});
		};
		await swipe(120, 300);
		expect(decide).not.toHaveBeenCalled();
		await swipe(150, 20);
		expect(decide).toHaveBeenCalledTimes(1);
	});
});

it("can send feedback without approving an outbound draft", async () => {
	const decide = await mount({
		feedbackAction: { id: "feedback", label: "Send feedback" },
	});
	await click("Give feedback");
	await type(
		'textarea[aria-label="Optional feedback"]',
		"Use a warmer greeting.",
	);
	await click("Send feedback");
	expect(decide).toHaveBeenCalledWith(
		expect.objectContaining({
			action: "feedback",
			signal: "free-text",
			feedback: "Use a warmer greeting.",
		}),
	);
});

it("keeps consent confirmation current as the connection selection changes", async () => {
	const decide = await mount({
		actions: [
			{
				id: "send",
				label: "Send",
				intent: "approve",
				confirm: "Send with your connection?",
				confirmDisabled: true,
			},
		],
	});
	await click("Send");
	const confirm = [...document.querySelectorAll("button")].find(
		(button) => button.textContent === "Confirm",
	)!;
	expect(confirm.disabled).toBe(true);
	await act(async () =>
		root.render(
			<WorkDecisionCard
				kind="outbound"
				title="Reply to Morgan"
				askedBy="Robin"
				body="Thanks, Morgan."
				actions={[
					{
						id: "send",
						label: "Send",
						intent: "approve",
						confirm: "Send with your connection?",
						confirmDisabled: false,
					},
				]}
				onDecision={decide}
			/>,
		),
	);
	await click("Confirm");
	expect(decide).toHaveBeenCalledTimes(1);
});

it("does not let keyboard shortcuts activate a disabled action", async () => {
	const decide = await mount({
		actions: [{ id: "send", label: "Send", intent: "approve", disabled: true }],
	});
	await act(async () =>
		host
			.querySelector("section")!
			.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
			),
	);
	expect(decide).not.toHaveBeenCalled();
});

it("focuses an expanded stack card so Enter works without an extra click", async () => {
	const decide = await mount({ autoFocus: true });
	expect(document.activeElement).toBe(host.querySelector("section"));
	await act(async () =>
		document.activeElement!.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
		),
	);
	expect(decide).toHaveBeenCalledTimes(1);
});

it("lets an architecture recommendation be changed with its original text preserved", async () => {
	const decide = await mount({
		kind: "adr",
		body: "Remove the old field now.",
		editAction: { id: "change", label: "Save changes" },
	});
	await click("Change");
	await type(
		'textarea[aria-label="Edit draft"]',
		"Backfill and verify readers first.",
	);
	await click("Save changes");
	expect(decide).toHaveBeenCalledWith(
		expect.objectContaining({
			action: "change",
			signal: "edited",
			originalBody: "Remove the old field now.",
			body: "Backfill and verify readers first.",
		}),
	);
});

it("keeps right-arrow approval separate from the preferred delegation and supports D, E and ?", async () => {
	const decide = await mount({
		kind: "decision",
		why: <p>Source receipt</p>,
		editAction: { id: "change", label: "Save changes" },
		actions: [
			{ id: "yes", label: "Approve", intent: "approve" },
			{
				id: "delegate",
				label: "Decide for me",
				intent: "delegate",
				primary: true,
			},
			{ id: "later", label: "Later", intent: "later" },
		],
	});
	const key = async (key: string) =>
		act(async () =>
			host
				.querySelector("section")!
				.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })),
		);
	await key("?");
	expect(host.textContent).toContain("Source receipt");
	await key("e");
	expect(host.querySelector("textarea")).not.toBeNull();
	await key("e");
	await key("d");
	expect(decide).toHaveBeenCalledWith(
		expect.objectContaining({ action: "delegate" }),
	);
	await act(async () => root.unmount());
	host.remove();
	const approve = await mount({
		kind: "decision",
		actions: [
			{ id: "yes", label: "Approve", intent: "approve" },
			{
				id: "delegate",
				label: "Decide for me",
				intent: "delegate",
				primary: true,
			},
		],
	});
	await key("ArrowRight");
	expect(approve).toHaveBeenCalledWith(
		expect.objectContaining({ action: "yes" }),
	);
});

it("keeps ranking evidence inside the selected card's single explanation drawer", async () => {
	await mount({ why: "The workshop is waiting on this answer." });
	const card = (
		<WorkDecisionCard
			kind="question"
			title="Confirm the repair window"
			askedBy="Cedar"
			why="The workshop is waiting on this answer."
			onDecision={async () => {}}
		/>
	);
	await act(async () =>
		root.render(
			<DecisionLearningContext.Provider
				value={{
					score: 12,
					factors: [
						{
							level: "personal",
							contribution: 8,
							evidenceIds: ["fictional-choice-1"],
							reason: "Your recent workshop decisions",
						},
						{
							level: "organization",
							contribution: 4,
							evidenceIds: ["fictional-lesson-1"],
							reason:
								"Applicable lesson: confirm the time before promising delivery",
						},
					],
					lessonIds: ["fictional-lesson-1"],
				}}
			>
				{card}
			</DecisionLearningContext.Provider>,
		),
	);
	expect(
		[...host.querySelectorAll("button")].filter(
			(button) => button.textContent === "Why this?",
		),
	).toHaveLength(1);
	await click("Why this?");
	expect(host.textContent).toContain("The workshop is waiting on this answer.");
	expect(host.textContent).toContain("Your recent workshop decisions");
	expect(host.textContent).toContain(
		"Applicable lesson: confirm the time before promising delivery",
	);
	expect(host.querySelector("details")?.textContent).toContain(
		"fictional-choice-1",
	);
	await act(async () =>
		root.render(
			<DecisionLearningContext.Provider value={null}>
				{card}
			</DecisionLearningContext.Provider>,
		),
	);
	expect(host.textContent).not.toContain("Your recent workshop decisions");
	expect(host.textContent).toContain("The workshop is waiting on this answer.");
});

it("keeps raw URLs out of headings and shows the full source through titled links", async () => {
	const url =
		"https://example.invalid/workspace/fictional?workpiece=output:proposal";
	await mount({
		title: `Review ${url}`,
		body: `One proposal. Read ${url} before choosing.`,
	});
	expect(host.querySelector("h2")?.textContent).toBe("Review linked page");
	expect(host.querySelector("h2 a")?.getAttribute("href")).toBe(url);
	expect(host.querySelector(".fd-proposal-body")?.textContent).not.toContain(
		url,
	);
	await click("More");
	const link = host.querySelector(".fd-proposal-body a");
	expect(link?.getAttribute("href")).toBe(url);
	expect(link?.textContent).toBe("Open workspace document");
});
