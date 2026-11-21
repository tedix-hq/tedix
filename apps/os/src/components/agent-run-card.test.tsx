import type { ListWorkAttemptStepsResult } from "@tedix/api-contract/schemas/work-attempt-steps";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import { AgentRunCardView, type AgentRunTaskLinkProps } from "./agent-run-card";

const START = Date.now() - 10 * 60_000;
const agentRun = {
	workItemId: "11111111-1111-4111-8111-111111111111",
	title: "Fix paging",
	executor: "codex",
};
const TaskLink = ({ params, children }: AgentRunTaskLinkProps) => (
	<a href={`/work/items/${params.workItemId}`}>{children}</a>
);
const run = (
	steps: number,
	overrides: Partial<ListWorkAttemptStepsResult> = {},
): ListWorkAttemptStepsResult => ({
	attemptId: "44444444-4444-4444-8444-444444444444",
	live: true,
	steps: Array.from({ length: steps }, (_, seq) => ({
		seq,
		at: START + seq * 1_000,
		kind: "message" as const,
		text: `Step ${seq}`,
	})),
	messages: [],
	...overrides,
});

async function mount(element: React.ReactElement) {
	const host = document.body.appendChild(document.createElement("div"));
	const root = createRoot(host);
	await act(async () => root.render(element));
	return {
		host,
		unmount: () => {
			act(() => root.unmount());
			host.remove();
		},
	};
}

describe("AgentRunCardView", () => {
	it("shows the newest eight steps of a live run, then all of them", async () => {
		const { host, unmount } = await mount(
			<AgentRunCardView
				agentRun={agentRun}
				run={run(11)}
				LinkComponent={TaskLink}
			/>,
		);
		const steps = () =>
			[...host.querySelectorAll("[data-run-step] p")].map(
				(row) => row.textContent,
			);
		expect(host.textContent).toContain("Fix paging");
		expect(
			host.querySelector("[data-slot=agent-run-executor]")?.textContent,
		).toContain("Codex");
		expect(
			host.querySelector("[data-slot=agent-run-status]")?.textContent,
		).toMatch(/^Running, started/);
		expect(steps()).toEqual(
			Array.from({ length: 8 }, (_, index) => `Step ${index + 3}`),
		);
		expect(host.querySelector("a")?.getAttribute("href")).toBe(
			`/work/items/${agentRun.workItemId}`,
		);
		// The person writes to the tedi, not to the run.
		expect(host.querySelector("textarea")).toBeNull();
		const buttons = () =>
			[...host.querySelectorAll("button")].map((button) => button.textContent);
		expect(buttons()).toEqual(["Show all 11 steps", "Stop run"]);

		await act(async () => host.querySelector("button")?.click());
		expect(steps()).toHaveLength(11);
		expect(buttons()).toEqual(["Stop run"]);
		unmount();
	});

	it("says plainly when no runner took the run or the runner went quiet", async () => {
		const clock = vi.spyOn(Date, "now").mockReturnValue(START + 10 * 60_000);
		try {
			const status = async (element: React.ReactElement) => {
				const card = await mount(element);
				const text = card.host.querySelector(
					"[data-slot=agent-run-status]",
				)?.textContent;
				card.unmount();
				return text;
			};
			expect(
				await status(
					<AgentRunCardView
						agentRun={{
							...agentRun,
							requestedAt: new Date(Date.now() - 6.5 * 60_000).toISOString(),
						}}
						run={run(0, { attemptId: null, live: false })}
						LinkComponent={TaskLink}
					/>,
				),
			).toBe("No runner has picked this up for 6 minutes");
			expect(
				await status(
					<AgentRunCardView
						agentRun={agentRun}
						run={run(2)}
						attempt={{
							id: "44444444-4444-4444-8444-444444444444",
							executorType: "external_agent",
							executorId: "agent-1",
							outcome: null,
							heartbeatAt: new Date(START).toISOString(),
						}}
						LinkComponent={TaskLink}
					/>,
				),
			).toBe("The runner stopped responding 9 minutes ago");
		} finally {
			clock.mockRestore();
		}
	});

	it("offers no stop once the run has ended, and says so when it cannot load", async () => {
		const ended = await mount(
			<AgentRunCardView
				agentRun={agentRun}
				run={run(2, { live: false })}
				attempt={{
					id: "44444444-4444-4444-8444-444444444444",
					executorType: "external_agent",
					executorId: "agent-1",
					outcome: "succeeded",
					finishedAt: new Date(START + 60_000).toISOString(),
				}}
				LinkComponent={TaskLink}
			/>,
		);
		expect(
			ended.host.querySelector("[data-slot=agent-run-status]")?.textContent,
		).toMatch(/^Finished .*: succeeded$/);
		expect(ended.host.querySelector("button")).toBeNull();
		ended.unmount();

		const failed = await mount(
			<AgentRunCardView agentRun={agentRun} failed LinkComponent={TaskLink} />,
		);
		expect(
			failed.host.querySelector("[data-slot=agent-run-status]")?.textContent,
		).toContain("could not be loaded");
		expect(failed.host.querySelector("a")).not.toBeNull();
		failed.unmount();
	});

	it("sends an answer from the chat card after the run ends", async () => {
		const onAnswer = vi.fn(async (_answer: string) => ({}));
		const asking = { ...run(2), live: false };
		asking.steps.push({
			seq: 2,
			at: START + 5_000,
			kind: "question",
			text: "Which table holds the plan?",
			choices: ["accounts", "subscriptions"],
		});
		const { host, unmount } = await mount(
			<AgentRunCardView
				agentRun={agentRun}
				run={asking}
				onAnswer={onAnswer}
				LinkComponent={TaskLink}
			/>,
		);
		const group = host.querySelector('[data-slot="run-question"]')!;
		expect(group.textContent).toContain("Which table holds the plan?");
		await act(async () => {
			[...group.querySelectorAll("button")]
				.find((button) => button.textContent === "accounts")!
				.click();
		});
		const input = group.querySelector("input")!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)!.set!.call(input, " Neither, use plans ");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			group
				.querySelector("form")!
				.dispatchEvent(
					new Event("submit", { bubbles: true, cancelable: true }),
				);
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
		expect(onAnswer.mock.calls).toEqual([["accounts"], ["Neither, use plans"]]);
		unmount();
	});
});
