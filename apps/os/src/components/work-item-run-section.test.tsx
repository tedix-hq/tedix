import type { ListWorkAttemptStepsResult } from "@tedix/api-contract/schemas/work-attempt-steps";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	workRunEntries,
	workRunOpenQuestion,
	workRunStatus,
} from "./work-item-run";
import { WorkItemRunView } from "./work-item-run-section";

const START = Date.parse("2026-11-19T10:00:00.000Z");
const ATTEMPT_ID = "44444444-4444-4444-8444-444444444444";

const run = (
	overrides: Partial<ListWorkAttemptStepsResult> = {},
): ListWorkAttemptStepsResult => ({
	attemptId: ATTEMPT_ID,
	live: true,
	steps: [
		{ seq: 0, at: START, kind: "started", text: "The agent started." },
		{ seq: 1, at: START + 60_000, kind: "command", text: "bun test (exit 0)" },
		{ seq: 2, at: START + 180_000, kind: "file_change", text: "src/a.ts" },
	],
	messages: [
		{
			id: "55555555-5555-4555-8555-555555555555",
			kind: "follow_up",
			body: "Keep the old column too.",
			senderType: "user",
			senderId: "user-1",
			interrupt: false,
			createdAt: new Date(START + 120_000).toISOString(),
			deliveredAt: null,
			appliedAt: null,
		},
	],
	...overrides,
});

const page = (element: React.ReactElement) =>
	new DOMParser().parseFromString(renderToStaticMarkup(element), "text/html");

describe("WorkItemRunView", () => {
	it("lists steps oldest first with the follow-up where it was sent", () => {
		const doc = page(
			// The viewer's id alone names their follow-up, as after a reload.
			<WorkItemRunView run={run()} viewerId="user-1" />,
		);
		const rows = [...doc.querySelectorAll("[aria-label='Run steps'] > li")].map(
			(row) => row.textContent ?? "",
		);
		expect(rows).toHaveLength(4);
		expect(rows[0]).toContain("Started");
		expect(rows[1]).toContain("Command");
		expect(rows[1]).toContain("bun test (exit 0)");
		expect(rows[2]).toContain("You: Keep the old column too.");
		expect(rows[2]).toContain("Waiting for the current step to finish");
		expect(rows[3]).toContain("File change");
		expect(doc.querySelector("textarea")).not.toBeNull();
		expect(doc.body.textContent).toContain("Stop run");
	});

	it("names another sender and drops the waiting note once applied", () => {
		const base = run();
		const doc = page(
			<WorkItemRunView
				run={{
					...base,
					steps: [
						...base.steps,
						{
							seq: 3,
							at: START + 200_000,
							kind: "follow_up",
							text: "Keep the old column too.",
						},
					],
					messages: [
						{
							...base.messages[0]!,
							appliedAt: new Date(START + 200_000).toISOString(),
						},
						{
							...base.messages[0]!,
							id: "66666666-6666-4666-8666-666666666666",
							kind: "stop",
							body: "",
							senderType: "tedi",
							createdAt: new Date(START + 240_000).toISOString(),
						},
					],
				}}
				viewerId="user-2"
			/>,
		);
		const text = doc.body.textContent ?? "";
		expect(text).toContain("Team member: Keep the old column too.");
		expect(text).not.toContain("Waiting for the current step");
		// The runner's own record of the follow-up is not listed a second time.
		expect(doc.querySelectorAll("[data-run-step='follow_up']")).toHaveLength(0);
		expect(text).toContain("Stop requested by A tedi");
	});

	it("offers no follow-up box or stop once the run has ended", () => {
		const doc = page(
			<WorkItemRunView
				run={run({ live: false })}
				attempt={{
					id: ATTEMPT_ID,
					executorType: "tedi",
					executorId: "tedi-1",
					outcome: "succeeded",
					finishedAt: new Date(START + 180_000).toISOString(),
				}}
			/>,
		);
		expect(doc.querySelector("textarea")).toBeNull();
		expect(doc.querySelector("button")).toBeNull();
		expect(doc.body.textContent).toContain("Not applied: the run ended first");
	});

	it("keeps a refused follow-up in the box and clears it once sent", async () => {
		const onSend =
			vi.fn<(body: string, interrupt?: boolean) => Promise<unknown>>();
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		const render = (sendError?: unknown) =>
			act(async () =>
				root.render(
					<WorkItemRunView run={run()} onSend={onSend} sendError={sendError} />,
				),
			);
		const submit = () =>
			act(async () => {
				host
					.querySelector("form")!
					.dispatchEvent(
						new Event("submit", { bubbles: true, cancelable: true }),
					);
				await new Promise((resolve) => setTimeout(resolve, 10));
			});
		try {
			await render();
			const textarea = host.querySelector("textarea")!;
			await act(async () => {
				Object.getOwnPropertyDescriptor(
					HTMLTextAreaElement.prototype,
					"value",
				)!.set!.call(textarea, "  Add a test for the last page.  ");
				textarea.dispatchEvent(new Event("input", { bubbles: true }));
			});
			const refusal = Object.assign(new Error("No run is in progress"), {
				code: "CONFLICT",
			});
			onSend.mockRejectedValueOnce(refusal);
			await submit();
			expect(onSend).toHaveBeenCalledExactlyOnceWith(
				"Add a test for the last page.",
				false,
			);
			await render(refusal);
			expect(textarea.value).toContain("Add a test for the last page.");
			expect(host.querySelector('[role="alert"]')?.textContent).toBe(
				"No run is in progress",
			);
			// "Send now" asks for the agent's current step to be stopped.
			onSend.mockResolvedValueOnce({});
			await act(async () => {
				[...host.querySelectorAll("button")]
					.find((button) => button.textContent === "Send now")!
					.click();
				await new Promise((resolve) => setTimeout(resolve, 10));
			});
			expect(onSend).toHaveBeenLastCalledWith(
				"Add a test for the last page.",
				true,
			);
			expect(textarea.value).toBe("");
		} finally {
			act(() => root.unmount());
			host.remove();
		}
	});
});

describe("a question the run is waiting on", () => {
	const question = {
		seq: 3,
		at: START + 200_000,
		kind: "question" as const,
		text: "Which table holds the plan?",
		choices: ["accounts", "subscriptions"],
	};
	const asking = run({ steps: [...run().steps, question] });

	it("is open only while it is the newest step of a live run and nothing was sent since", () => {
		expect(workRunOpenQuestion(asking)).toEqual(question);
		expect(workRunOpenQuestion({ ...asking, live: false })).toBeUndefined();
		expect(
			workRunOpenQuestion({
				...asking,
				steps: [
					...asking.steps,
					{ seq: 4, at: START + 210_000, kind: "message", text: "Thanks." },
				],
			}),
		).toBeUndefined();
		expect(
			workRunOpenQuestion({
				...asking,
				messages: [
					{
						...asking.messages[0]!,
						createdAt: new Date(START + 205_000).toISOString(),
					},
				],
			}),
		).toBeUndefined();
	});

	it("sends an offered answer as an ordinary follow-up", async () => {
		const onSend =
			vi.fn<(body: string, interrupt?: boolean) => Promise<unknown>>();
		onSend.mockResolvedValue({});
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		try {
			await act(async () =>
				root.render(<WorkItemRunView run={asking} onSend={onSend} />),
			);
			const group = host.querySelector('[data-slot="run-question"]')!;
			expect(group.textContent).toContain("Which table holds the plan?");
			await act(async () => {
				[...group.querySelectorAll("button")]
					.find((button) => button.textContent === "subscriptions")!
					.click();
				await new Promise((resolve) => setTimeout(resolve, 10));
			});
			expect(onSend).toHaveBeenCalledExactlyOnceWith("subscriptions", false);
		} finally {
			act(() => root.unmount());
			host.remove();
		}
	});
});

describe("workRunStatus", () => {
	const now = new Date(START + 4 * 60_000);

	it("says who is running it and since when", () => {
		expect(
			workRunStatus(
				run(),
				{
					id: ATTEMPT_ID,
					executorType: "tedi",
					executorId: "tedi-1",
					outcome: null,
					startedAt: new Date(START).toISOString(),
				},
				new Map([["tedi:tedi-1", "Miles"]]),
				now,
			),
		).toBe("Running on Miles, started 4m ago");
		expect(workRunStatus(run(), undefined, undefined, now)).toBe(
			"Running, started 4m ago",
		);
	});

	it("tells a finished, a stopped and a silent run apart", () => {
		const attempt = {
			id: ATTEMPT_ID,
			executorType: "tedi",
			executorId: "tedi-1",
			finishedAt: new Date(START + 60_000).toISOString(),
		};
		const ended = run({ live: false });
		expect(
			workRunStatus(ended, { ...attempt, outcome: "failed" }, undefined, now),
		).toBe("Finished 3m ago: failed");
		expect(
			workRunStatus(
				ended,
				{ ...attempt, outcome: "cancelled" },
				undefined,
				now,
			),
		).toBe("Stopped 3m ago");
		expect(
			workRunStatus(
				ended,
				{ ...attempt, outcome: null, finishedAt: null },
				undefined,
				now,
			),
		).toBe("Stopped reporting, last update 1m ago");
	});
});

it("orders entries by time", () => {
	expect(workRunEntries(run()).map((entry) => entry.key)).toEqual([
		"step-0",
		"step-1",
		"message-55555555-5555-4555-8555-555555555555",
		"step-2",
	]);
});
