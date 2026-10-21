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
		["Approve", "ArrowRight"],
		["Not this", "ArrowLeft"],
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

it("renders real face copy with a cross-fade and never a status word as the headline", async () => {
	await mountFace({ presentation: null, confidence: null });
	expect(heading()).toBe("Confirm who staffs the booth?");
	await mountFace({ presentation: FACE, confidence: null });
	expect(heading()).toBe(FACE.title);
	expect(host.querySelector(".fd-face-enter")?.textContent).toContain(
		FACE.body,
	);
	expect(host.querySelector("[data-face-pending]")).toBeNull();
	await mountFace({ presentation: null, confidence: null, unavailable: true });
	expect(heading()).toBe("Confirm who staffs the booth?");
	for (const word of ["Summary pending", "Summary unavailable."])
		expect(host.textContent).not.toContain(word);
});

it("shows a skeleton with a writing label only while the summary is pending, and keeps actions live", async () => {
	const decide = await mountFace({ presentation: null, confidence: null });
	const skeleton = host.querySelector("[data-face-pending]")!;
	expect(skeleton.getAttribute("role")).toBe("status");
	expect(skeleton.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(3);
	expect(skeleton.textContent).toContain("Writing a short summary…");
	expect(host.querySelector("[data-face-fallback]")).toBeNull();
	expect(actionButtons().map((button) => button.disabled)).toEqual([
		false,
		false,
	]);
	await click("Yes");
	expect(decide).toHaveBeenCalledWith(
		expect.objectContaining({ action: "yes", signal: "approve-as-is" }),
	);
});

it("falls back to the original request with a retry when the summary fails", async () => {
	const retry = vi.fn();
	await mountFace({
		presentation: null,
		confidence: null,
		unavailable: true,
		retry,
	});
	expect(host.querySelector("[data-face-pending]")).toBeNull();
	const note = host.querySelector("[data-face-fallback]")!;
	expect(note.textContent).toContain(
		"Summary unavailable — showing the original request",
	);
	expect(
		host.querySelector(".fd-face-fallback .fd-proposal-preview")?.textContent,
	).toContain("Confirm who staffs the booth and send the guest list yourself");
	expect(actionButtons().every((button) => !button.disabled)).toBe(true);
	await click("Retry");
	expect(retry).toHaveBeenCalledTimes(1);
});

it("replaces the skeleton with the original request once the summary takes too long", async () => {
	vi.useFakeTimers();
	try {
		await mountFace({ presentation: null, confidence: null });
		expect(host.querySelector("[data-face-pending]")).not.toBeNull();
		await act(async () => {
			vi.advanceTimersByTime(7999);
		});
		expect(host.querySelector("[data-face-pending]")).not.toBeNull();
		await act(async () => {
			vi.advanceTimersByTime(1);
		});
		expect(host.querySelector("[data-face-pending]")).toBeNull();
		expect(host.querySelector("[data-face-fallback]")).not.toBeNull();
		expect(heading()).toBe("Confirm who staffs the booth?");
		// A late summary still replaces the fallback.
		await mountFace({ presentation: FACE, confidence: null });
		expect(host.querySelector("[data-face-fallback]")).toBeNull();
		expect(host.textContent).toContain(FACE.body);
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
	expect(host.querySelector(".fd-card-summary")?.textContent).toBe(
		"If yes: Saves the proposed room.",
	);
});

it("omits unknown confidence and retains assessed confidence", async () => {
	await mountFace({ presentation: FACE, confidence: null });
	expect(host.querySelector(".fd-recommendation")?.textContent).toBe(
		FACE.recommendation,
	);
	await mountFace({ presentation: FACE, confidence: 0.8 });
	expect(host.querySelector(".fd-recommendation")?.textContent).toContain(
		"80% sure",
	);
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

it("keeps revision controls behind collapsed Details", async () => {
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
	const trigger = [...host.querySelectorAll("button")].find(
		(button) => button.textContent === "Card revisions",
	);
	expect(trigger?.getAttribute("aria-expanded")).toBe("false");
	expect(
		host.querySelector('[aria-label="Card revisions"]')?.closest("[hidden]"),
	).not.toBeNull();
	await act(async () => {
		host
			.querySelector("section")!
			.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
	});
	expect(trigger?.getAttribute("aria-expanded")).toBe("true");
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
		await click("No / Not needed");
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
