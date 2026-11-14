import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DecisionLearningContext } from "./decision-learning-context";
import { CardFaceContext } from "./deck-presentation-context";
import { act, type ContextType } from "react";
import { createRoot } from "react-dom/client";
import { setOsFormattingPreferences } from "@/lib/format";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	WorkDecisionCard,
	type DecisionCardFeedback,
} from "./work-decision-card";
import {
	createAgentSlot,
	DeckCardAgentContext,
	type DeckCardAgentHandle,
	type DeckNotUsefulHandle,
} from "@/lib/deck-card-agent";

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
	if (!button) {
		// Quiet controls such as "Give feedback" live in the "⋯" menu.
		const more = host.querySelector<HTMLButtonElement>(
			'button[aria-label="More actions"]',
		);
		if (more) {
			await act(async () => more.click());
			const item = [
				...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
			].find((entry) => entry.textContent === label);
			if (item) {
				await act(async () => item.click());
				return;
			}
		}
	}
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
	it("pages with the arrow keys and answers only with Y, N or a button", async () => {
		const next = vi.fn();
		const previous = vi.fn();
		const decide = await mount({ onNext: next, onPrevious: previous });
		const press = (key: string) =>
			act(async () => {
				host
					.querySelector("section")!
					.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
			});
		await press("ArrowRight");
		await press("ArrowLeft");
		expect(next).toHaveBeenCalledTimes(1);
		expect(previous).toHaveBeenCalledTimes(1);
		expect(decide).not.toHaveBeenCalled();
		await press("y");
		expect(decide).toHaveBeenCalledWith(
			expect.objectContaining({ action: "send" }),
		);
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
	it("keeps Enter for newlines and submits offered answers with Ctrl+Enter", async () => {
		const decide = await mount({
			kind: "question",
			suggestedAnswers: ["Tuesday", "Friday"],
			actions: [{ id: "answer", label: "Answer", intent: "approve" }],
		});
		await type("textarea", "Thursday");
		await act(async () =>
			host
				.querySelector("textarea")!
				.dispatchEvent(
					new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
				),
		);
		expect(decide).not.toHaveBeenCalled();
		await click("Friday");
		await act(async () =>
			host.querySelector("textarea")!.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "Enter",
					ctrlKey: true,
					bubbles: true,
				}),
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
			"Your decision was not saved. Connection unavailable. Check your connection and try again.",
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

it("keeps shortcuts out of the button label and announces them through aria-keyshortcuts", async () => {
	await mount({
		kind: "decision",
		actions: [
			{ id: "yes", label: "Approve", intent: "approve" },
			{ id: "no", label: "Not this", intent: "reject" },
			{ id: "later", label: "Later", intent: "later" },
			{ id: "delegate", label: "Decide for me", intent: "delegate" },
		],
	});
	const buttons = [
		...host.querySelectorAll<HTMLButtonElement>("[data-decision-intent]"),
	];
	expect(
		buttons.map((button) => [
			button.textContent,
			button.getAttribute("aria-keyshortcuts"),
		]),
	).toEqual([
		["Approve", "Y"],
		["Not this", "N"],
		["Later", "L"],
		["Decide for me", "D"],
	]);
	// No reserved key chip inside the label: the width is the text's alone.
	expect(host.querySelector("[data-decision-intent] kbd")).toBeNull();
	expect(host.querySelector(".fd-action-key")).toBeNull();
});

const FACE = {
	version: 2 as const,
	title: "Review the workshop plan?",
	context: "Morgan needs the room choice today.",
	body: "Saves the proposed room for review.",
	recommendation: "Review first because the group size changed.",
};
const FACE_ACTIONS = [
	{ id: "yes", label: "Yes", intent: "approve" as const },
	{ id: "later", label: "Later", intent: "later" as const },
];
async function mountFace(
	state: NonNullable<ContextType<typeof CardFaceContext>>,
	decide = vi.fn(async (_feedback: DecisionCardFeedback) => {}),
	props: Partial<Parameters<typeof WorkDecisionCard>[0]> = {},
) {
	if (!host?.isConnected) {
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
	}
	await act(async () =>
		root.render(
			<CardFaceContext.Provider value={state}>
				<WorkDecisionCard
					kind="decision"
					askedBy="Robin"
					title="Confirm who staffs the booth?"
					body="Confirm who staffs the booth and send the guest list yourself for the Demo Day on 20 October. Booth setup must finish by 13:59 Berlin."
					actions={FACE_ACTIONS}
					onDecision={decide}
					{...props}
				/>
			</CardFaceContext.Provider>,
		),
	);
	return decide;
}
const heading = () => host.querySelector("h2")?.textContent ?? "";
const actionButtons = () => [
	...host.querySelectorAll<HTMLButtonElement>("[data-decision-intent]"),
];

const WAITING_WORDS = [
	"Writing a short summary",
	"Summary pending",
	"Summary unavailable",
	"Retry",
];

it("leads with the question, why now with a relative due date, and what each option does", async () => {
	const context = "Morgan picks the room at the Friday stand-up.";
	await mountFace({
		presentation: { ...FACE, context },
		confidence: null,
		now: new Date("2026-10-30T09:00:00Z"),
		dates: ["2026-10-27T10:30:00Z"],
	});
	expect(heading()).toBe(FACE.title);
	expect(host.querySelector("[data-why-now]")?.textContent).toBe(
		`3 days overdue · ${context}`,
	);
	expect(host.querySelector("[data-context-item]")).toBeNull();
	const outcomes = host.querySelector(".fd-outcomes")!.textContent;
	expect(outcomes).toContain(`Yes${FACE.body}`);
	expect(outcomes).toContain("Not nowSkips it for now");
	// The recommendation reads at a glance; the original ask stays in Context.
	expect(host.querySelector(".fd-recommendation")?.textContent).toBe(
		`Recommended: ${FACE.recommendation}`,
	);
	expect(
		host.querySelector(".fd-recommendation")?.closest("[hidden]"),
	).toBeNull();
});

it("shows the reader's story and a separate why-you line on the card face", async () => {
	const story = "Morgan needs a room choice. Agreeing saves the proposed room.";
	await mountFace({
		presentation: {
			...FACE,
			story,
			whyMe: "You know the group size.",
			recommendedIntent: "approve",
		},
		confidence: null,
	});
	expect(host.querySelector("[data-why-now]")?.textContent).toBe(story);
	expect(host.querySelector("[data-why-me]")?.textContent).toBe(
		"Why you: You know the group size.",
	);
	expect(host.querySelector("[data-recommended]")?.textContent).toBe(
		"Yes · Recommended",
	);
});

it("marks the asker's recommended choice without enabling an automatic answer", async () => {
	const decide = await mountFace(
		{ presentation: FACE, confidence: null },
		undefined,
		{
			actions: [
				{
					id: "small",
					label: "Small room",
					description: "Saves the smaller room.",
				},
				{
					id: "large",
					label: "Large room",
					description: "Saves the larger room.",
					recommended: true,
				},
			],
		},
	);
	expect(host.querySelector("[data-recommended]")?.textContent).toBe(
		"Large room · Recommended",
	);
	expect(host.querySelector(".fd-auto-decide")).toBeNull();
	expect(decide).not.toHaveBeenCalled();
});

it("shows the original ask at once, with no waiting or error face, and keeps actions live", async () => {
	const decide = await mountFace({ presentation: null, confidence: null });
	expect(heading()).toBe("Confirm who staffs the booth?");
	expect(host.querySelector(".fd-face-original")?.textContent).toContain(
		"Confirm who staffs the booth and send the guest list yourself",
	);
	expect(host.querySelector('[data-slot="skeleton"]')).toBeNull();
	expect(host.querySelector('[aria-busy="true"]')).toBeNull();
	for (const word of WAITING_WORDS)
		expect(host.textContent).not.toContain(word);
	expect(actionButtons().every((button) => !button.disabled)).toBe(true);
	await click("Yes");
	expect(decide).toHaveBeenCalledWith(
		expect.objectContaining({ action: "yes", signal: "approve-as-is" }),
	);
});

it("drops list numbers such as 'Review 07 —' from the headline", async () => {
	await mountFace({ presentation: null, confidence: null }, undefined, {
		title: "Review 07 — Renewal quote and support plan for Morgan?",
	});
	expect(heading()).toBe("Renewal quote and support plan for Morgan?");
});

it("names every action by its outcome and keeps the decline in view", async () => {
	await mountFace(
		{
			presentation: { ...FACE, actionLabels: { approve: "Save the room" } },
			confidence: null,
		},
		undefined,
		{
			actions: [
				{ id: "yes", label: "Reviewed", intent: "approve" },
				{ id: "no", label: "No / Not needed", intent: "reject" },
				{ id: "later", label: "Later", intent: "later" },
				{ id: "delegate", label: "Delegate", intent: "delegate" },
			],
			editAction: { id: "change", label: "Save changes" },
			feedbackAction: { id: "feedback", label: "Send feedback" },
			why: <p>Source receipt</p>,
		},
	);
	const row = host.querySelector("[data-outcome-row]")!;
	const visible = [...row.querySelectorAll<HTMLButtonElement>("button")]
		.filter(
			(button) =>
				!button.closest("[data-deck-overflow], .fd-card-why") &&
				!button.hasAttribute("data-deck-overflow") &&
				!button.classList.contains("fd-action-more"),
		)
		.map((button) => button.textContent);
	expect(visible).toEqual([
		"Save the room",
		"Decline",
		"Not now",
		"Decide for me",
		"Change…",
	]);
	for (const label of ["Reviewed", "No / Not needed", "Not useful"])
		expect(visible).not.toContain(label);
});

it("decides for the person with the recommended answer when no tedi can take it", async () => {
	const decide = await mountFace(
		{
			presentation: { ...FACE, recommendedIntent: "approve" },
			confidence: null,
		},
		undefined,
		{
			actions: [
				{ id: "yes", label: "Yes", intent: "approve" },
				{ id: "no", label: "No", intent: "reject" },
			],
		},
	);
	await act(async () =>
		host.querySelector<HTMLButtonElement>("[data-decide-for-me]")!.click(),
	);
	expect(decide).toHaveBeenCalledWith(
		expect.objectContaining({ action: "yes" }),
	);
});

it.each([
	["Review first because the group size changed.", "approve"],
	["Wait — the room is not confirmed yet.", undefined],
	["Decline — the group no longer needs a room.", "reject"],
])(
	"fills the button the recommendation %j gives",
	async (recommendation, intent) => {
		await mountFace(
			{ presentation: { ...FACE, recommendation }, confidence: null },
			undefined,
			{
				actions: [
					{ id: "yes", label: "Yes", intent: "approve" },
					{ id: "no", label: "No", intent: "reject" },
				],
			},
		);
		expect(
			host
				.querySelector("[data-highlighted]")
				?.getAttribute("data-decision-intent") ?? undefined,
		).toBe(intent);
	},
);

it("leaves out the option list in compact density", async () => {
	await mountFace({
		presentation: FACE,
		confidence: null,
		dates: ["2026-10-27T10:30:00Z"],
		preferences: { density: "compact" },
	});
	expect(heading()).toBe(FACE.title);
	expect(host.querySelector(".fd-outcomes")).toBeNull();
	expect(actionButtons().length).toBeGreaterThan(0);
});

it("auto-decides a confident card after a visible countdown the person can stop", async () => {
	vi.useFakeTimers();
	try {
		const face = {
			presentation: { ...FACE, recommendedIntent: "approve" as const },
			confidence: 0.9,
			preferences: { decideForMe: { decision: "auto" as const } },
		};
		const stopped = await mountFace(face);
		expect(host.querySelector(".fd-auto-decide")?.textContent).toContain(
			"Tedix picks “Yes” in 5s",
		);
		await click("Stop");
		await act(async () => {
			vi.advanceTimersByTime(6000);
		});
		expect(stopped).not.toHaveBeenCalled();
		act(() => root.unmount());
		host.remove();
		const decide = await mountFace(face);
		await act(async () => {
			vi.advanceTimersByTime(5000);
		});
		await act(async () => {});
		expect(decide).toHaveBeenCalledWith(
			expect.objectContaining({ action: "yes" }),
		);
	} finally {
		vi.useRealTimers();
	}
});

it("leaves focus alone on mount and supports Enter after keyboard focus", async () => {
	const decide = await mount({ autoFocus: true });
	expect(document.activeElement).not.toBe(host.querySelector("section"));
	host.querySelector("section")!.focus();
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
	await key("y");
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
			(button) => button.textContent === "Why am I seeing this?",
		),
	).toHaveLength(1);
	await click("Why am I seeing this?");
	expect(host.textContent).toContain("The workshop is waiting on this answer.");
	await click("How this was ranked");
	expect(host.textContent).toContain("Your recent workshop decisions");
	expect(host.textContent).toContain(
		"Applicable lesson: confirm the time before promising delivery",
	);
	expect(
		[...host.querySelectorAll("button[aria-expanded]")].find(
			(button) => button.textContent === "Evidence",
		)?.parentElement?.textContent,
	).toContain("fictional-choice-1");
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

it("routes credential cards to settings without an answer or feedback field", async () => {
	const decide = await mount({
		kind: "question",
		title: "Replace the Firecrawl key for the radar?",
		body: "Opens the existing connection settings.",
		actions: [{ id: "answer", label: "Answer", intent: "approve" }],
	});
	expect(host.querySelector("textarea")).toBeNull();
	expect(
		host.querySelector('a[href="/account/connections"]')?.textContent,
	).toBe("Open connection settings");
	expect(decide).not.toHaveBeenCalled();
});

it("refuses a secret-like answer before invoking any card mutation", async () => {
	const decide = await mount({
		kind: "question",
		title: "What should change?",
		body: "Tell the agent your preference",
		actions: [{ id: "answer", label: "Answer", intent: "approve" }],
	});
	await type(
		'textarea[aria-label="Your answer"]',
		"fc-" + "fictional".repeat(5),
	);
	await click("Answer");
	expect(host.querySelector('[role="alert"]')?.textContent).toContain(
		"use connection settings",
	);
	expect(decide).not.toHaveBeenCalled();
});

it("does not repeat the If yes label inside the consequence sentence", async () => {
	await mountFace({
		presentation: { ...FACE, body: "If yes, saves the proposed room." },
		confidence: null,
	});
	expect(host.querySelector(".fd-outcomes dd")?.textContent).toBe(
		"Saves the proposed room.",
	);
});

it("keeps confidence scores off the card", async () => {
	await mountFace({ presentation: FACE, confidence: 0.8 });
	expect(host.querySelector(".fd-recommendation")?.textContent).toBe(
		`Recommended: ${FACE.recommendation}`,
	);
	expect(host.textContent).not.toContain("% sure");
});

it.each([
	["send", "outbound", "Send"],
	["decide", "decision", "Yes"],
	["approve_draft", "proposal", "Approve draft"],
	["answer", "question", "Answer"],
	["consent", "approval", "Approve"],
] as const)(
	"renders an enabled primary control for %s",
	async (_ask, kind, label) => {
		await mount({
			kind,
			initialAnswer: kind === "question" ? "Friday" : "",
			actions: [{ id: "primary", label, intent: "approve" }],
		});
		const button = host.querySelector<HTMLButtonElement>(
			"[data-decision-intent=approve]",
		);
		expect(button?.textContent).toBe(label);
		expect(button?.disabled).toBe(false);
	},
);

it("keeps revision controls hidden until the person asks for changes", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { enabled: false } },
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<WorkDecisionCard
					kind="decision"
					title="Review?"
					askedBy="Robin"
					revisionTarget={{
						requestId: "11111111-1111-4111-8111-111111111111",
						version: 2,
					}}
					onDecision={vi.fn()}
				/>
			</QueryClientProvider>,
		),
	);
	const panel = () => host.querySelector('[aria-label="Card revisions"]');
	expect(panel()?.closest("[hidden]")).not.toBeNull();
	await act(async () => {
		host
			.querySelector("section")!
			.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
	});
	expect(panel()?.closest("[hidden]")).toBeNull();
});

it.each(["outbound", "decision", "proposal", "question", "approval"] as const)(
	"allows an explicit decline without an answer for %s",
	async (kind) => {
		const decide = await mount({
			kind,
			body: "Approve the proposed action.",
			actions: [
				{ id: "yes", label: "Yes", intent: "approve" },
				{ id: "no", label: "No / Not needed", intent: "reject" },
			],
		});
		const button = host.querySelector<HTMLButtonElement>(
			"[data-decision-intent=reject]",
		);
		expect(button?.disabled).toBe(false);
		await click("Decline");
		if (kind === "outbound") await click("don't send");
		expect(decide).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "no",
				signal: kind === "outbound" ? "reason" : "rejected",
				body: "No / Not needed",
			}),
		);
	},
);

it("refreshes a stored face date on rerender without rewriting its source", async () => {
	vi.useFakeTimers();
	try {
		const presentation = {
			...FACE,
			generatedAt: "2026-10-19T12:00:00Z",
			context: "The workshop is tomorrow.",
		};
		vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
		await mountFace({ presentation, confidence: null, dates: ["2026-10-20"] });
		expect(host.textContent).toContain("The workshop is today.");
		vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
		await mountFace({ presentation, confidence: null, dates: ["2026-10-20"] });
		expect(host.textContent).toContain("The workshop is 2 days ago.");
		expect(presentation.context).toBe("The workshop is tomorrow.");
	} finally {
		vi.useRealTimers();
	}
});

describe("chat-driven card controls", () => {
	it("fills, prepares and submits through the card's own controls", async () => {
		const slots = {
			card: createAgentSlot<DeckCardAgentHandle>(),
			notUseful: createAgentSlot<DeckNotUsefulHandle>(),
		};
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		const decide = vi.fn(async (_feedback: DecisionCardFeedback) => {});
		await act(async () =>
			root.render(
				<DeckCardAgentContext.Provider value={slots}>
					<WorkDecisionCard
						kind="question"
						title="When should we ship?"
						askedBy="Robin"
						actions={[
							{ id: "answer", label: "Answer", intent: "approve" },
							{
								id: "always",
								label: "Always",
								confirm: "Apply to every release?",
							},
						]}
						onDecision={decide}
					/>
				</DeckCardAgentContext.Provider>,
			),
		);
		const handle = () => slots.card.get()!;
		expect(handle().field).toBe("answer");
		await act(async () => {
			expect(handle().fill("Friday")).toEqual({ ok: true, status: "filled" });
		});
		expect(host.querySelector("textarea")!.value).toBe("Friday");
		await act(async () => {
			expect(handle().stage("missing")).toMatchObject({ ok: false });
			expect(handle().stage("answer")).toEqual({ ok: true, status: "staged" });
		});
		expect(handle().stagedOptionId).toBe("answer");
		expect(host.querySelector("[data-agent-staged-note]")?.textContent).toBe(
			"Prepared in chat: Answer",
		);
		expect(decide).not.toHaveBeenCalled();
		// A choice that needs confirmation still opens the person's dialog.
		await act(async () => {
			await expect(handle().submit("always")).resolves.toEqual({
				ok: true,
				status: "confirming",
			});
		});
		expect(decide).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("Apply to every release?");
		await click("Go back");
		await act(async () => {
			await expect(handle().submit("answer")).resolves.toEqual({
				ok: true,
				status: "saved",
			});
		});
		expect(decide).toHaveBeenCalledWith(
			expect.objectContaining({ action: "answer", body: "Friday" }),
		);
		act(() => root.unmount());
		expect(slots.card.get()).toBeNull();
		root = createRoot(host);
	});
});

it("shows stored ISO dates in a face in the operator's date format", async () => {
	setOsFormattingPreferences({ locale: "en-US", timezone: "Europe/Berlin" });
	try {
		await mountFace({
			presentation: {
				...FACE,
				title: "Book the room by 2026-10-20?",
				context: "Morgan asked on 2026-10-19T23:30:00Z.",
			},
			confidence: null,
		});
		expect(heading()).toBe("Book the room by Oct 20, 2026?");
		expect(host.textContent).toContain(
			"Morgan asked on Oct 20, 2026, 1:30 AM.",
		);
		expect(host.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
	} finally {
		setOsFormattingPreferences({ locale: null, timezone: null });
	}
});

async function mountQuestion(
	title: string,
	decide = vi.fn(async (_feedback: DecisionCardFeedback) => {}),
	actionLabels?: Record<string, string>,
) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root.render(
			<CardFaceContext.Provider
				value={{
					presentation: { ...FACE, title, actionLabels },
					confidence: null,
				}}
			>
				<WorkDecisionCard
					kind="question"
					askedBy="Robin"
					title="Original request"
					actions={[
						{ id: "answer", label: "Answer", intent: "approve" },
						{ id: "no", label: "No / Not needed", intent: "reject" },
					]}
					onDecision={decide}
				/>
			</CardFaceContext.Provider>,
		),
	);
	return decide;
}

it.each([
	["Keep dark-factory private?", "Keep private"],
	["Should we archive the board?", "Yes"],
	["Move the meeting to Friday?", "Yes"],
	["What budget should we set?", "Answer"],
	["Publish now or wait?", "Answer"],
	["Choose the launch date?", "Answer"],
])("states what yes does for the question %s", async (title, label) => {
	const decide = await mountQuestion(title);
	const primary = host.querySelector<HTMLButtonElement>(
		"[data-decision-intent=approve]",
	)!;
	expect(primary.textContent).toBe(label);
	// The card asks a question, so a typed answer is always one field away.
	expect(host.querySelector("textarea")?.getAttribute("placeholder")).toBe(
		label === "Answer" ? "Your answer…" : "Or write your own answer…",
	);
	if (label === "Answer") return;
	await act(async () => primary.click());
	expect(decide).toHaveBeenCalledWith(
		expect.objectContaining({
			action: "answer",
			body: `Yes: ${title.replace(/\?$/, "")}`,
		}),
	);
});

it("shows the summary's own yes and no labels instead of guessing from the wording", async () => {
	await mountQuestion("Should we archive the board?", undefined, {
		approve: "Archive board",
		reject: "Keep board",
	});
	expect(
		host.querySelector("[data-decision-intent=approve]")?.textContent,
	).toBe("Archive board");
	expect(host.querySelector("[data-decision-intent=reject]")?.textContent).toBe(
		"Keep board",
	);
});

it("shows and saves a chat-filled answer on a yes/no question", async () => {
	const slots = {
		card: createAgentSlot<DeckCardAgentHandle>(),
		notUseful: createAgentSlot<DeckNotUsefulHandle>(),
	};
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const decide = vi.fn(async (_feedback: DecisionCardFeedback) => {});
	await act(async () =>
		root.render(
			<DeckCardAgentContext.Provider value={slots}>
				<CardFaceContext.Provider
					value={{
						presentation: { ...FACE, title: "Keep dark-factory private?" },
						confidence: null,
					}}
				>
					<WorkDecisionCard
						kind="question"
						askedBy="Robin"
						title="Original request"
						actions={[
							{ id: "answer", label: "Answer", intent: "approve" },
							{ id: "no", label: "No / Not needed", intent: "reject" },
						]}
						onDecision={decide}
					/>
				</CardFaceContext.Provider>
			</DeckCardAgentContext.Provider>,
		),
	);
	const handle = () => slots.card.get()!;
	await act(async () => {
		expect(handle().fill("Only until the audit is done")).toEqual({
			ok: true,
			status: "filled",
		});
	});
	// The typed answer replaces the yes/no face: visible, and submitted as is.
	expect(host.querySelector("textarea")!.value).toBe(
		"Only until the audit is done",
	);
	await act(async () => {
		await expect(handle().submit("answer")).resolves.toEqual({
			ok: true,
			status: "saved",
		});
	});
	expect(decide).toHaveBeenCalledWith(
		expect.objectContaining({
			action: "answer",
			body: "Only until the audit is done",
		}),
	);
});

it("answers a yes/no question in the person's own words from the card", async () => {
	const decide = await mountQuestion("Keep dark-factory private?");
	await type("textarea", "Only until the audit is done");
	expect(
		host.querySelector("[data-decision-intent=approve]")?.textContent,
	).toBe("Send answer");
	expect(host.querySelector(".fd-outcomes")?.textContent).toContain(
		"Sends your answer to Robin.",
	);
	await click("Send answer");
	expect(decide).toHaveBeenCalledWith(
		expect.objectContaining({
			action: "answer",
			signal: "answer",
			body: "Only until the audit is done",
		}),
	);
});

it("shows the last related decision under Context only when the list supplies one", async () => {
	const state = {
		presentation: FACE,
		confidence: null,
		lastRelatedDecision: {
			subject: "Keep the existing service",
			body: "Use the current provider for this project.",
			decidedAt: "2026-10-25T12:00:00.000Z",
		},
	};
	await mountFace(state);
	expect(host.textContent).toContain(
		"Last time: Use the current provider for this project.",
	);
	await mountFace({ ...state, lastRelatedDecision: null });
	expect(host.textContent).not.toContain("Last time:");
});

it("hides IDs, hashes and agent notes from the card but keeps them for agents", async () => {
	await mountFace(
		{
			presentation: {
				...FACE,
				title: "Open share 57e61f8a to the research team?",
				context:
					"Work cbf08453 is waiting (trace 894b5978-1c2d-4e5f-8a9b-0c1d2e3f4a5b).",
			},
			confidence: null,
		},
		undefined,
		{
			body: "The pilot needs the terms. Then dispatch this Work to a lane admitted for the Willowbrook org. See https://tedix.example/work/items/cbf08453.",
		},
	);
	expect(heading()).toBe("Open the share to the research team?");
	expect(host.querySelector("[data-why-now]")?.textContent).toBe(
		"The linked task is waiting.",
	);
	await click("Context");
	const context = host.querySelector(".fd-proposal-body")!;
	expect(context.textContent).toContain("The pilot needs the terms.");
	expect(context.textContent).not.toMatch(/dispatch|cbf08453|https?:/);
	await click("Details for agents");
	expect(host.textContent).toContain(
		"Then dispatch this Work to a lane admitted for the Willowbrook org.",
	);
});

it("recovers a stale card in one click by answering against the newer note", async () => {
	const decide = vi
		.fn(async (_feedback: DecisionCardFeedback) => {})
		.mockRejectedValueOnce(
			Object.assign(new Error("The linked Work has a newer comment: raw"), {
				code: "CONFLICT",
				data: {
					reason: "newer_comment",
					reviewedChangesThrough: "2026-11-04T09:20:00.000Z",
					note: "Checks for Work 47464594-e486-401b-97ba-5d286a6a41b1 are green.",
				},
			}),
		);
	await mountQuestion("Keep dark-factory private?", decide);
	await click("Keep private");
	const alert = host.querySelector(".fd-stale")!;
	expect(alert.textContent).toContain("Something changed since this was asked");
	expect(alert.textContent).toContain("Checks for the linked task are green.");
	expect(alert.textContent).not.toContain("47464594");
	await click("Save with the latest version");
	expect(decide).toHaveBeenLastCalledWith(
		expect.objectContaining({
			action: "answer",
			reviewedChangesThrough: "2026-11-04T09:20:00.000Z",
		}),
	);
	expect(host.querySelector(".fd-stale")).toBeNull();
	expect(host.textContent).toContain("Decision saved");
});

it("binds the next plain Answer to the newer note it showed", async () => {
	const stale = (through: string) =>
		Object.assign(new Error("The linked Work has a newer comment: raw"), {
			code: "CONFLICT",
			data: { reason: "newer_comment", reviewedChangesThrough: through },
		});
	const decide = vi
		.fn(async (_feedback: DecisionCardFeedback) => {})
		.mockRejectedValueOnce(stale("2026-11-04T09:20:00.000Z"))
		.mockRejectedValueOnce(stale("2026-11-04T09:30:00.000Z"));
	await mountQuestion("Keep dark-factory private?", decide);
	await click("Keep private");
	expect(host.querySelector(".fd-stale")).not.toBeNull();
	await click("Keep private");
	expect(decide).toHaveBeenLastCalledWith(
		expect.objectContaining({
			reviewedChangesThrough: "2026-11-04T09:20:00.000Z",
		}),
	);
	// A note newer than the one read still blocks, and is shown in turn.
	expect(host.querySelector(".fd-stale")).not.toBeNull();
	expect(host.textContent).not.toContain("Decision saved");
	await click("Keep private");
	expect(decide).toHaveBeenCalledTimes(3);
	expect(decide).toHaveBeenLastCalledWith(
		expect.objectContaining({
			reviewedChangesThrough: "2026-11-04T09:30:00.000Z",
		}),
	);
	expect(host.textContent).toContain("Decision saved");
});

it("shows a short plain reason for other refusals", async () => {
	const decide = vi
		.fn(async (_feedback: DecisionCardFeedback) => {})
		.mockRejectedValueOnce(
			Object.assign(
				new Error(
					"The linked Work was superseded by 1a2b3c4d-1111-4111-8111-111111111111. Review the fresh card 2b3c4d5e-2222-4222-8222-222222222222.",
				),
				{ code: "CONFLICT" },
			),
		);
	await mountQuestion("Keep dark-factory private?", decide);
	await click("Keep private");
	const alert = host.querySelector('[role="alert"]')!.textContent;
	expect(alert).toContain("The linked Work was superseded.");
	expect(alert).not.toMatch(/[0-9a-f]{8}-/);
});
