import { act, type ComponentProps, type ContextType } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vite-plus/test";
import { osApi } from "@/lib/api";
import { WorkApprovalDecisionCard } from "./work-approval-decision-card";
import type { WorkDecisionCard } from "./work-decision-card";
import { CardFaceContext } from "@/components/deck-presentation-context";
import { WorkActorDirectoryContext } from "@/components/work-actor-avatar";
import type { ActorDirectory } from "@/lib/work-actor";

vi.mock("@/lib/api", () => ({
	osApi: {
		workApprovals: { decide: vi.fn() },
		learningFeedback: { model: vi.fn() },
		workItems: { getReadiness: vi.fn() },
		workScheduler: { listReady: vi.fn() },
		workFleet: { getControlTower: vi.fn() },
	},
}));
vi.mock("./work-decision-card", () => ({
	WorkDecisionCard: (props: ComponentProps<typeof WorkDecisionCard>) => (
		<section>
			<h2>{props.title}</h2>
			<p data-asker>{props.askedBy}</p>
			<div data-face>{props.faceContent}</div>
			<div data-content>{props.content}</div>
			<ul>
				{props.actions?.map((action) => (
					<li key={action.id} data-action={action.id}>
						{action.label}: {action.description}
					</li>
				))}
			</ul>
			<button
				disabled={props.disabled}
				onClick={() =>
					void props.onDecision({
						action: "approve",
						body: "",
						signal: "approve-as-is",
					})
				}
			>
				Approve
			</button>
			<div data-why>{props.why}</div>
		</section>
	),
}));

it("requires a reason and sends the exact proposal version through the existing approval API", async () => {
	const decide = vi
		.mocked(osApi.workApprovals.decide)
		.mockResolvedValue({ decision: { id: "saved-approval" } } as never);
	const client = new QueryClient();
	const invalidate = vi.spyOn(client, "invalidateQueries");
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const row = {
		canDecide: true,
		effectiveStatus: "pending",
		workItem: {
			id: "11111111-1111-4111-8111-111111111111",
			title: "Review supplier shortlist",
		},
		proposal: {
			id: "22222222-2222-4222-8222-222222222222",
			version: 7,
			requestedAt: "2026-10-17T12:00:00Z",
			requestRationale: "The shortlist is ready for review.",
			proposal: { budget: 40 },
		},
	} as unknown as ComponentProps<typeof WorkApprovalDecisionCard>["row"];
	try {
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<WorkApprovalDecisionCard
						row={row}
						onNext={() => {}}
						onPrevious={() => {}}
					/>
				</QueryClientProvider>,
			),
		);
		expect(host.textContent).toContain(row.proposal.requestRationale);
		expect(host.querySelector("button")?.disabled).toBe(true);
		await act(async () => host.querySelector("button")!.click());
		expect(decide).not.toHaveBeenCalled();
		await act(async () => {
			const input = host.querySelector("textarea")!;
			Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)!.set!.call(input, " The evidence supports this scope. ");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(host.querySelector("button")?.disabled).toBe(false);
		await act(async () => host.querySelector("button")!.click());
		expect(decide).toHaveBeenCalledWith({
			proposalId: row.proposal.id,
			expectedProposalVersion: 7,
			decision: "approved",
			rationale: "The evidence supports this scope.",
		});
		expect(invalidate).toHaveBeenCalledTimes(5);
	} finally {
		await act(async () => root.unmount());
		host.remove();
		client.clear();
	}
});

const pendingRow = (
	proposal: Record<string, unknown> = {},
	workItem: Record<string, unknown> = {},
) =>
	({
		canDecide: true,
		effectiveStatus: "pending",
		workItem: {
			id: "11111111-1111-4111-8111-111111111111",
			title: "Review supplier shortlist",
			version: 3,
			disposition: "accepted",
			...workItem,
		},
		proposal: {
			id: "22222222-2222-4222-8222-222222222222",
			version: 7,
			action: "admission",
			workItemVersion: 3,
			requestedByType: "user",
			requestedById: "user-robin",
			requestedBySessionId: null,
			requestedAt: "2026-10-17T12:00:00Z",
			requestRationale: "The shortlist is ready for review.",
			proposal: { budget: 40 },
			...proposal,
		},
	}) as unknown as ComponentProps<typeof WorkApprovalDecisionCard>["row"];

async function show(
	row: ComponentProps<typeof WorkApprovalDecisionCard>["row"],
	options: {
		directory?: ActorDirectory;
		face?: ContextType<typeof CardFaceContext>;
	} = {},
) {
	const client = new QueryClient();
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<WorkActorDirectoryContext.Provider
					value={options.directory ?? new Map()}
				>
					<CardFaceContext.Provider value={options.face ?? null}>
						<WorkApprovalDecisionCard
							row={row}
							onNext={() => {}}
							onPrevious={() => {}}
						/>
					</CardFaceContext.Provider>
				</WorkActorDirectoryContext.Provider>
			</QueryClientProvider>,
		),
	);
	return {
		host,
		async close() {
			await act(async () => root.unmount());
			host.remove();
			client.clear();
		},
	};
}

it("names the action and the task, who asks, and what Approve and Reject each do", async () => {
	const card = await show(pendingRow(), {
		directory: new Map([["user:user-robin", { name: "Robin Example" }]]),
	});
	try {
		const { host } = card;
		expect(host.querySelector("h2")?.textContent).toBe(
			'Let work start on "Review supplier shortlist"?',
		);
		expect(host.querySelector("[data-asker]")?.textContent).toBe(
			"Robin Example",
		);
		const face = host.querySelector("[data-face]")!.textContent!;
		expect(face).toContain(
			'What: Allow work to start on "Review supplier shortlist" as the task is written now.',
		);
		expect(face).toContain("Why now: The shortlist is ready for review.");
		expect(face).toContain(
			"If you approve: Work on this task may start, as long as the task stays as it is written now.",
		);
		expect(face).toContain(
			"If you reject: The task does not start and the requester sees your reason.",
		);
		// Nothing in this request argues for an answer, so none is suggested.
		expect(face).not.toContain("Tedix suggests");
		// The buttons say the same as the lines above them.
		expect(host.querySelector('[data-action="approve"]')?.textContent).toBe(
			"Approve: Work on this task may start, as long as the task stays as it is written now.",
		);
		expect(host.querySelector('[data-action="reject"]')?.textContent).toBe(
			"Reject: The task does not start and the requester sees your reason.",
		);
		expect(host.textContent).not.toContain("Work reviewer");
	} finally {
		await card.close();
	}
});

it("keeps the reason required and says why it is needed", async () => {
	const card = await show(pendingRow());
	try {
		const { host } = card;
		const reason = host.querySelector("textarea")!;
		// The reason sits on the card face, not behind Context.
		expect(reason.closest("[data-face]")).not.toBeNull();
		expect(reason.required).toBe(true);
		expect(host.querySelector("[data-face] label")?.textContent).toContain(
			"Your reason (required)",
		);
		expect(host.querySelector("[data-face]")?.textContent).toContain(
			"It is saved with your decision, so the requester and anyone who checks this approval later can see why.",
		);
		expect(host.querySelector("section > button")).toHaveProperty(
			"disabled",
			true,
		);
	} finally {
		await card.close();
	}
});

it("keeps the raw request behind Technical details", async () => {
	const card = await show(pendingRow());
	try {
		const { host } = card;
		for (const visible of ["[data-face]", "[data-content]", "h2"])
			expect(host.querySelector(visible)?.textContent).not.toContain("budget");
		const why = host.querySelector("[data-why]")!;
		expect(why.querySelector("button")?.textContent).toBe("Technical details");
		expect(why.querySelector("pre")?.textContent).toContain('"budget": 40');
		expect(host.textContent).not.toContain("Exact proposal");
	} finally {
		await card.close();
	}
});

it("names an asker without a known name by its role in plain words", async () => {
	for (const [requestedByType, name] of [
		["user", "A teammate"],
		["tedi", "A tedi"],
		["external_agent", "An agent"],
		["team", "A team"],
		["system", "Tedix"],
	]) {
		const card = await show(pendingRow({ requestedByType }));
		try {
			expect(card.host.querySelector("[data-asker]")?.textContent).toBe(name);
		} finally {
			await card.close();
		}
	}
	// A coding agent's session names the agent.
	const card = await show(
		pendingRow({
			requestedByType: "external_agent",
			requestedBySessionId: "codex:fixture-session",
		}),
	);
	try {
		expect(card.host.querySelector("[data-asker]")?.textContent).toBe("Codex");
	} finally {
		await card.close();
	}
});

it("suggests one answer only when the task changed or closed since the request", async () => {
	const changed = await show(pendingRow({}, { version: 4 }));
	try {
		expect(changed.host.querySelector("[data-face]")?.textContent).toContain(
			"Tedix suggests: Reject. The task changed after this was requested, so the request no longer matches it.",
		);
	} finally {
		await changed.close();
	}
});

it("leaves the story to the written summary and the answers to the deck's own list", async () => {
	const card = await show(pendingRow(), {
		face: {
			presentation: {
				version: 2,
				title: "Let work start on the supplier shortlist?",
				context: "Robin is waiting to start.",
				body: "Work on the task may start.",
				recommendation: "Check the scope first.",
			},
			confidence: null,
		},
	});
	try {
		const face = card.host.querySelector("[data-face]")!.textContent!;
		// The deck lists each button's sentence itself, and the summary tells the story.
		expect(face).not.toContain("If you approve:");
		expect(face).not.toContain("What:");
		expect(face).toContain("Your reason (required)");
		expect(
			card.host.querySelector('[data-action="approve"]')?.textContent,
		).toContain("Work on this task may start");
	} finally {
		await card.close();
	}
});
