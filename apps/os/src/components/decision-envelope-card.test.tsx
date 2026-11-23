import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { osQuery } from "@/lib/os-query-options";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { DECISION_DECK_EXAMPLES } from "../../dev/decision-deck-fixture";
import {
	laneHoldDecision,
	laneHoldFace,
} from "@tedix/api-contract/utils/lane-hold-decision";
import { CardFaceContext } from "@/components/deck-presentation-context";
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
			'textarea[aria-label="Edit permission"]',
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

it("gives a stopped task three answers and asks before closing it", async () => {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const decision = laneHoldDecision({
		workItemId: "00000000-0000-4000-8000-000000000002",
		subject: 'What should happen with "Port the landing page"?',
		prompt:
			'Claude Code stopped working on "Port the landing page". Three runs failed or expired on this version of the task.\n\nLast note from the runner: the browser check timed out.',
		metadata: {
			source: "lane-dispatch-blocker",
			laneBlocker: {
				kind: "execution_hold",
				executor: "claude-code",
				workVersion: 7,
			},
		},
	})!;
	const onDecision = vi.fn(async () => undefined);
	const press = (label: string) =>
		act(async () =>
			[...document.querySelectorAll("button")]
				.find((button) => button.textContent?.startsWith(label))!
				.click(),
		);
	try {
		await act(async () =>
			root.render(
				<DecisionEnvelopeCard
					decision={decision}
					askedBy="Claude Code"
					onDecision={onDecision}
				/>,
			),
		);
		expect(host.textContent).toContain(
			'What should happen with "Port the landing page"?',
		);
		expect(host.textContent).toContain(
			"Three runs failed or expired on this version of the task.",
		);
		expect(host.textContent).toContain("the browser check timed out");
		for (const label of ["Try again", "Give it to Codex", "Close the task"])
			expect(
				[...host.querySelectorAll("button")].some((button) =>
					button.textContent?.startsWith(label),
				),
			).toBe(true);
		// No free-text answer: nobody reads one.
		expect(host.querySelector("textarea")).toBeNull();
		await press("Close the task");
		expect(onDecision).not.toHaveBeenCalled();
		expect(
			document.querySelector('[role="alertdialog"]')?.textContent,
		).toContain("Cancels the task.");
		await press("Go back");
		expect(onDecision).not.toHaveBeenCalled();
		await press("Try again");
		expect(onDecision).toHaveBeenCalledTimes(1);
		const [feedback, choice] = onDecision.mock.calls[0] as unknown as [
			{ action: string },
			string,
		];
		expect(feedback.action).toBe("retry");
		expect(choice).toBe("approve");
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
});

it.each(["execution_hold", "result_unverified", "accountable_owner"] as const)(
	"waits for a person on a %s card even with auto when confident",
	async (kind) => {
		vi.useFakeTimers();
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		const filed = {
			workItemId: "00000000-0000-4000-8000-000000000002",
			subject: 'What should happen with "Port the landing page"?',
			prompt: 'Claude Code stopped working on "Port the landing page".',
			metadata: {
				source: "lane-dispatch-blocker",
				laneBlocker: { kind, executor: "claude-code", workVersion: 7 },
			},
		};
		const onDecision = vi.fn(async () => undefined);
		try {
			await act(async () =>
				root.render(
					<CardFaceContext.Provider
						value={{
							// The worst case: a summary that names an answer to pick.
							presentation: {
								...laneHoldFace(filed)!,
								recommendedIntent: "approve",
							},
							confidence: 0.99,
							preferences: { decideForMe: { decision: "auto" } },
						}}
					>
						<DecisionEnvelopeCard
							decision={laneHoldDecision(filed)!}
							askedBy="Claude Code"
							onDecision={onDecision}
						/>
					</CardFaceContext.Provider>,
				),
			);
			expect(host.querySelector(".fd-auto-decide")).toBeNull();
			await act(async () => {
				vi.advanceTimersByTime(10000);
			});
			await act(async () => {});
			expect(onDecision).not.toHaveBeenCalled();
		} finally {
			await act(async () => root.unmount());
			host.remove();
			vi.useRealTimers();
		}
	},
);

it("opens a cited slide in one click without answering the decision", async () => {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const queryClient = new QueryClient({
		defaultOptions: { queries: { staleTime: Infinity } },
	});
	const id = "00000000-0000-4000-8000-000000000001",
		revisionId = "00000000-0000-4000-8000-000000000002";
	const decision = structuredClone(DECISION_DECK_EXAMPLES[0]!);
	decision.sources = [
		{ kind: "output", id, revisionId, title: "Pilot brief", slide: 2 },
	];
	queryClient.setQueryData(
		osQuery.osWorkspaces.outputs.history.queryOptions({
			input: { outputId: id, revisionId },
		}).queryKey,
		{
			nextBeforeRevision: null,
			pending: [],
			revisions: [
				{
					id: revisionId,
					revision: 3,
					organizationId: "test-org",
					note: null,
					accessEnvelope: null,
					producedBy: null,
					createdByKind: "user",
					createdById: "author",
					createdAt: "2026-11-22T10:00:00Z",
					outputId: id,
					content: {
						kind: "presentation",
						slides: [
							{ title: "Cover", bullets: [] },
							{ title: "Partner review", bullets: ["Check the local notes."] },
						],
					},
				},
			],
		},
	);
	const onDecision = vi.fn();
	try {
		await act(async () =>
			root.render(
				<QueryClientProvider client={queryClient}>
					<DecisionEnvelopeCard
						decision={decision}
						askedBy="Workspace agent"
						onDecision={onDecision}
					/>
				</QueryClientProvider>,
			),
		);
		const source = [...host.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Pilot brief"),
		);
		expect(source).toBeDefined();
		await act(async () => source!.click());
		await vi.waitFor(() =>
			expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
				"Slide 2 of 2",
			),
		);
		expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
			"Partner review",
		);
		expect(onDecision).not.toHaveBeenCalled();
	} finally {
		await act(async () => root.unmount());
		queryClient.clear();
		host.remove();
	}
});
