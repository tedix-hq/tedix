import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { DECISION_DECK_EXAMPLES } from "../../dev/decision-deck-fixture";
import { DecisionEnvelopeCard } from "./decision-envelope-card";

vi.mock("@/components/kumo/toast", () => ({ toast: { success: vi.fn() } }));

it("shows the exact source reply before approving its effect and keeps edits out of the reviewed version", async () => {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const decision = structuredClone(DECISION_DECK_EXAMPLES[0]!);
	decision.kind = "outbound";
	decision.preview = {
		body: "Hello Morgan,\n\nYour source reply is ready for review.",
	};
	decision.options[0]!.effect = {
		kind: "publish_support",
		ticketId: "00000000-0000-4000-8000-000000000001",
		expectedVersion: 2,
	};
	try {
		await act(async () =>
			root.render(
				<DecisionEnvelopeCard
					decision={decision}
					askedBy="Support"
					defaultLowStakesToDelegate={false}
					onDecision={vi.fn()}
				/>,
			),
		);
		expect(host.querySelector(".fd-proposal-more")).toBeNull();
		expect(
			[...host.querySelectorAll(".chat-markdown p")].map((p) => p.textContent),
		).toEqual(["Hello Morgan,", "Your source reply is ready for review."]);
		expect(host.textContent).toContain(decision.recommendation);
		expect(host.textContent).not.toContain("Save changes");
		expect(
			[...host.querySelectorAll("button")].some(
				(button) => button.textContent === "Change",
			),
		).toBe(false);
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
});

it("lets the owner narrow a delegation's scope sentence and sends it with Allow", async () => {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const decision = structuredClone(DECISION_DECK_EXAMPLES[0]!);
	decision.kind = "approval";
	decision.reversibility = "two_way";
	decision.protectedEffects = [];
	decision.preview = {
		body: "Codex may handle keys only as this task describes, and nothing beyond it.",
	};
	decision.options = [
		{
			id: "allow",
			label: "Allow",
			intent: "approve",
			consequence: "Posts your permission for this version of the task.",
			cost: "Codex may do what the sentence says.",
			effect: {
				kind: "delegate_work",
				workItemId: "00000000-0000-4000-8000-000000000002",
				executor: "codex",
				workVersion: 3,
			},
		},
		{
			id: "no",
			label: "No",
			intent: "reject",
			consequence: "Nothing is posted; the task stays blocked.",
			cost: "No agent works on it.",
		},
	];
	const onDecision = vi.fn(async () => undefined);
	try {
		await act(async () =>
			root.render(
				<DecisionEnvelopeCard
					decision={decision}
					askedBy="Codex"
					defaultLowStakesToDelegate={false}
					onDecision={onDecision}
				/>,
			),
		);
		const field = host.querySelector<HTMLTextAreaElement>(
			'textarea[aria-label="What the agent may do"]',
		)!;
		expect(field.value).toBe(decision.preview.body);
		expect(host.querySelector("[data-risk]")?.textContent).toContain(
			"Easy to undo",
		);
		await act(async () => {
			const set = Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)!.set!;
			set.call(field, "Codex may rotate only the fictional staging key.");
			field.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () =>
			[...host.querySelectorAll("button")]
				.find(
					(button) => button.getAttribute("data-decision-intent") === "approve",
				)!
				.click(),
		);
		expect(onDecision).toHaveBeenCalledTimes(1);
		const [feedback, choice] = onDecision.mock.calls[0] as unknown as [
			{ body: string; originalBody: string },
			string,
		];
		expect(choice).toBe("approve");
		expect(feedback).toMatchObject({
			body: "Codex may rotate only the fictional staging key.",
			originalBody: decision.preview.body,
		});
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
});
