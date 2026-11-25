import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { WaitingApproval } from "@/lib/workspace-chat-state";
import { ApprovalTray } from "./workspace-chat-approval-tray";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
});

function proposal(
	approvalId: string,
	title: string,
	target?: string,
	input?: unknown,
): WaitingApproval {
	return {
		approvalId,
		conversationId: "here",
		stepId: `s-${approvalId}`,
		title,
		reason: "approval_pending",
		requestedAt: "2026-11-18T10:00:00.000Z",
		decision: null,
		...(target ? { input: { title: target } } : {}),
		...(input !== undefined ? { input } : {}),
	};
}

/** An edit of an existing file; edits of the same file share a group. */
function edit(
	approvalId: string,
	file: string,
	conversationId = "here",
): WaitingApproval {
	return {
		...proposal(approvalId, "Editing document blocks"),
		conversationId,
		target: { id: `out-${file}`, title: file },
	};
}

type Props = ComponentProps<typeof ApprovalTray>;

async function render(
	approvals: WaitingApproval[],
	extra: Partial<Props> = {},
) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const onDecide = vi.fn<Props["onDecide"]>();
	const onDecideAll = vi.fn<Props["onDecideAll"]>();
	const onDismissNotice = vi.fn<Props["onDismissNotice"]>();
	const onOpenConversation = vi.fn<(conversationId: string) => void>();
	const show = (next: Partial<Props> = {}) =>
		act(async () =>
			root.render(
				<ApprovalTray
					approvals={approvals}
					conversationId="here"
					run={null}
					notice={null}
					onDecide={onDecide}
					onDecideAll={onDecideAll}
					onDismissNotice={onDismissNotice}
					onOpenConversation={onOpenConversation}
					{...extra}
					{...next}
				/>,
			),
		);
	await show();
	return { onDecide, onDecideAll, onDismissNotice, onOpenConversation, show };
}

const tray = () => host.querySelector('[data-testid="workspace-chat-tray"]');
const button = (name: string) =>
	Array.from(host.querySelectorAll("button")).find(
		(el) => el.getAttribute("aria-label") === name || el.textContent === name,
	);

describe("ApprovalTray", () => {
	it("shows nothing when nothing is waiting", async () => {
		await render([]);
		expect(tray()).toBeNull();
	});

	it("lists what waits with its count and links each item to its card", async () => {
		await render([
			proposal("a1", "Creating a new output", "Budget"),
			proposal("a2", "Saving a document revision", "Plan"),
		]);
		expect(tray()?.textContent).toContain("Waiting for you (2)");
		expect(tray()?.textContent).toContain("Creating a new output: Budget");
		const links = [...(tray()?.querySelectorAll("a") ?? [])].map((link) =>
			link.getAttribute("href"),
		);
		expect(links).toEqual(["#approval-a1", "#approval-a2"]);
	});

	it("names machine commands in single and grouped rows", async () => {
		const machineRequest = (id: string, command: string) =>
			proposal(id, "Using a machine", undefined, {
				machine: "Test MacBook",
				tool: "run_command",
				input: { command },
			});
		const first = machineRequest("a1", "bun run type-check");
		const second = machineRequest("a2", "bun run build");
		const { show } = await render([first]);
		expect(host.querySelector(".workspace-chat-tray-title")?.textContent).toBe(
			"Run on Test MacBook: bun run type-check",
		);
		await show({ approvals: [first, second] });
		await act(async () =>
			host.querySelector<HTMLButtonElement>("button[aria-expanded]")?.click(),
		);
		expect(
			[
				...host.querySelectorAll(
					".workspace-chat-tray-requests .workspace-chat-tray-title",
				),
			].map((row) => row.textContent),
		).toEqual([
			"Run on Test MacBook: bun run type-check",
			"Run on Test MacBook: bun run build",
		]);
	});

	it("approves or denies one item and disables only that item", async () => {
		const { onDecide } = await render([
			proposal("a1", "Creating a new output", "Budget"),
			proposal("a2", "Saving a document revision", "Plan"),
		]);
		await act(async () => button("Deny changing Plan")?.click());
		expect(onDecide).toHaveBeenCalledWith("a2", "deny");
		expect(button("Deny changing Plan")?.disabled).toBe(true);
		expect(button("Approve changing Plan")?.disabled).toBe(true);
		expect(button("Approve creating Budget")?.disabled).toBe(false);
		await act(async () => button("Approve creating Budget")?.click());
		expect(onDecide).toHaveBeenCalledWith("a1", "approve");
		expect(button("Approve creating Budget")?.textContent).toBe("Approving…");
	});

	it("approves everything still open with Approve all, oldest first", async () => {
		const { onDecideAll, onDecide } = await render([
			proposal("a1", "Creating a new output", "Budget"),
			proposal("a2", "Creating a new output", "Forecast"),
			proposal("a3", "Filing a Work Item", "Fix the tab"),
		]);
		await act(async () => button("Deny creating Forecast")?.click());
		expect(onDecide).toHaveBeenCalledWith("a2", "deny");
		await act(async () => button("Approve all")?.click());
		expect(onDecideAll).toHaveBeenCalledWith(["a1", "a3"], "approve");
		expect(button("Approve all")?.disabled).toBe(true);
		expect(button("Deny all")?.disabled).toBe(true);
	});

	it("denies everything with Deny all, newest first", async () => {
		const { onDecideAll } = await render([
			proposal("a1", "Creating a new output", "Budget"),
			proposal("a2", "Creating a new output", "Forecast"),
			proposal("a3", "Filing a Work Item", "Fix the tab"),
		]);
		await act(async () => button("Deny all")?.click());
		expect(onDecideAll).toHaveBeenCalledWith(["a3", "a2", "a1"], "deny");
	});

	it("offers no Approve all for a single item", async () => {
		await render([proposal("a1", "Creating a new output", "Budget")]);
		expect(button("Approve all")).toBeUndefined();
		expect(button("Deny all")).toBeUndefined();
		expect(button("Approve creating Budget")).toBeDefined();
	});

	it("names an app draft's buttons Accept and Reject, as on its card", async () => {
		await render([
			proposal("a1", "Editing an app draft", undefined, {
				appId: "app1",
				files: { "client.js": "x" },
				expectedRevision: 2,
			}),
		]);
		expect(button("Accept editing an app draft")?.textContent).toBe("Accept");
		expect(button("Reject editing an app draft")?.textContent).toBe("Reject");
	});

	it("names the site of a web page and shows its full address", async () => {
		const url = "https://www.example.com/pricing/teams?plan=annual";
		const { onDecide } = await render([
			proposal("a1", "Reading a web page", undefined, url),
		]);
		const row = host.querySelector(".workspace-chat-tray-item");
		expect(row?.textContent).toContain("Read example.com");
		expect(row?.textContent).toContain(url);
		expect(row?.textContent).not.toContain("Reading a web page");
		await act(async () => button("Approve reading example.com")?.click());
		expect(onDecide).toHaveBeenCalledWith("a1", "approve");
		expect(button("Deny reading example.com")?.disabled).toBe(true);
	});

	it("groups requests by what they change and opens one group at a time", async () => {
		const { onDecideAll } = await render([
			edit("a1", "Plan"),
			edit("a2", "Budget"),
			edit("a3", "Plan"),
			edit("a4", "Budget"),
		]);
		const groups = [...host.querySelectorAll(".workspace-chat-tray-group")].map(
			(group) => group.textContent,
		);
		expect(groups).toHaveLength(2);
		// The group holding the oldest request leads.
		expect(groups[0]).toContain("Plan");
		expect(groups[0]).toContain("2 requests");
		expect(groups[1]).toContain("Budget");
		// Closed groups show no single requests.
		expect(button("Approve changing Plan")).toBeUndefined();
		const toggle = (name: string) =>
			[
				...host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]"),
			].find((el) => el.textContent?.includes(name));
		await act(async () => toggle("Plan")?.click());
		expect(toggle("Plan")?.getAttribute("aria-expanded")).toBe("true");
		expect(
			host.querySelectorAll(".workspace-chat-tray-requests > li"),
		).toHaveLength(2);
		await act(async () => toggle("Budget")?.click());
		expect(toggle("Plan")?.getAttribute("aria-expanded")).toBe("false");
		expect(toggle("Budget")?.getAttribute("aria-expanded")).toBe("true");
		// A group is decided on its own, in its own order.
		await act(async () => button("Deny all for Budget")?.click());
		expect(onDecideAll).toHaveBeenCalledWith(["a4", "a2"], "deny");
		await act(async () => button("Approve all for Plan")?.click());
		expect(onDecideAll).toHaveBeenCalledWith(["a1", "a3"], "approve");
	});

	it("marks what another chat asked for and sorts it after this chat's", async () => {
		const { onOpenConversation } = await render([
			edit("a1", "Notes", "other"),
			edit("a2", "Plan"),
			edit("a3", "Ledger", "other"),
			edit("a4", "Ledger", "third"),
		]);
		expect(tray()?.textContent).toContain("3 from other chats");
		const rows = [
			...host.querySelectorAll(".workspace-chat-tray-list > li"),
		].map((item) => item.textContent ?? "");
		expect(rows[0]).toContain("Plan");
		expect(rows[0]).not.toContain("Asked in another chat");
		expect(rows[1]).toContain("Notes");
		expect(rows[1]).toContain("Asked in another chat");
		expect(rows[2]).toContain("Ledger");
		expect(rows[2]).toContain("2 requests · Asked in another chat");
		// This chat's request links to its card; another chat's opens that chat.
		expect(tray()?.querySelectorAll("a")).toHaveLength(1);
		const notes = [
			...host.querySelectorAll<HTMLButtonElement>(
				"button.workspace-chat-tray-item",
			),
		].find((el) => el.textContent?.includes("Notes"));
		await act(async () => notes?.click());
		expect(onOpenConversation).toHaveBeenCalledWith("other");
	});

	it("says every request came from other chats when none is this chat's", async () => {
		await render([edit("a1", "Notes", "other"), edit("a2", "Plan", "third")]);
		expect(tray()?.textContent).toContain("Asked in other chats");
	});

	it("shows how far a run is and locks every button while it works", async () => {
		const approvals = [
			edit("a1", "Plan"),
			edit("a2", "Budget"),
			edit("a3", "Notes"),
		];
		const { show } = await render(approvals);
		const run = {
			runId: "r1",
			decision: "approve" as const,
			requests: approvals,
		};
		await show({ run });
		expect(tray()?.querySelector('[role="status"]')?.textContent).toBe(
			"Approving 1 of 3…",
		);
		for (const el of host.querySelectorAll("button"))
			expect(el.disabled, el.textContent ?? "").toBe(true);
		// The first landed: it left the list and the run moved on.
		await show({ run, approvals: approvals.slice(1) });
		expect(tray()?.querySelector('[role="status"]')?.textContent).toBe(
			"Approving 2 of 3…",
		);
	});

	it("says where a run stopped and lets the rest be decided again", async () => {
		const approvals = [
			edit("a1", "Plan"),
			edit("a2", "Budget"),
			edit("a3", "Notes"),
		];
		const { show, onDecide, onDismissNotice } = await render(approvals);
		await act(async () => button("Approve all")?.click());
		expect(button("Approve changing Notes")?.disabled).toBe(true);
		await show({
			approvals: approvals.slice(1),
			notice: {
				kind: "stopped",
				decision: "approve",
				total: 3,
				done: 1,
				request: approvals[1]!,
				reason: "failed",
				error: "The document changed since this was proposed",
			},
		});
		expect(tray()?.querySelector('[role="alert"]')?.textContent).toContain(
			"Approved 1 of 3. “Editing document blocks: Budget” could not be applied: The document changed since this was proposed. The rest are still waiting.",
		);
		await act(async () => button("Approve changing Notes")?.click());
		expect(onDecide).toHaveBeenCalledWith("a3", "approve");
		await act(async () => button("Dismiss")?.click());
		expect(onDismissNotice).toHaveBeenCalledTimes(1);
	});

	it("keeps a stopped run's message after the list empties", async () => {
		await render([], {
			notice: {
				kind: "stopped",
				decision: "deny",
				total: 2,
				done: 1,
				request: edit("a1", "Plan"),
				reason: "decided_otherwise",
			},
		});
		expect(tray()?.textContent).toContain(
			"Denied 1 of 2. “Editing document blocks: Plan” was approved before it could be denied.",
		);
		expect(tray()?.textContent).not.toContain("still waiting");
	});

	it("says a single request was already decided", async () => {
		await render([edit("a2", "Budget")], {
			notice: { kind: "already_decided", request: edit("a1", "Plan") },
		});
		expect(tray()?.querySelector('[role="alert"]')?.textContent).toContain(
			"“Editing document blocks: Plan” was already decided by someone else.",
		);
	});
});
