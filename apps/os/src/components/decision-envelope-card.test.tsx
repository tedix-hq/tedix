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
		expect(host.querySelector(".chat-markdown")).toBeNull();
		await act(async () => {
			[...host.querySelectorAll("button")]
				.find((button) => button.textContent === "More")!
				.click();
		});
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
