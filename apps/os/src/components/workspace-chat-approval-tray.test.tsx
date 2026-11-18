import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ChatApproval } from "@/lib/workspace-chat-state";
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
): ChatApproval {
	return {
		approvalId,
		stepId: `s-${approvalId}`,
		title,
		reason: "approval_pending",
		requestedAt: "2026-11-18T10:00:00.000Z",
		decision: null,
		...(target ? { input: { title: target } } : {}),
		...(input !== undefined ? { input } : {}),
	};
}

async function render(approvals: ChatApproval[]) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const onDecide = vi.fn<ComponentProps<typeof ApprovalTray>["onDecide"]>();
	const onApproveAll =
		vi.fn<ComponentProps<typeof ApprovalTray>["onApproveAll"]>();
	await act(async () =>
		root.render(
			<ApprovalTray
				approvals={approvals}
				onDecide={onDecide}
				onApproveAll={onApproveAll}
			/>,
		),
	);
	return { onDecide, onApproveAll };
}

const button = (name: string) =>
	Array.from(host.querySelectorAll("button")).find(
		(el) => el.getAttribute("aria-label") === name || el.textContent === name,
	);

describe("ApprovalTray", () => {
	it("shows nothing when nothing is waiting", async () => {
		await render([]);
		expect(
			host.querySelector('[data-testid="workspace-chat-tray"]'),
		).toBeNull();
	});

	it("lists what waits with its count and links each item to its card", async () => {
		await render([
			proposal("a1", "Creating a new output", "Budget"),
			proposal("a2", "Saving a document revision", "Plan"),
		]);
		const tray = host.querySelector('[data-testid="workspace-chat-tray"]');
		expect(tray?.textContent).toContain("Waiting for you (2)");
		expect(tray?.textContent).toContain("Creating a new output: Budget");
		const links = [...(tray?.querySelectorAll("a") ?? [])].map((link) =>
			link.getAttribute("href"),
		);
		expect(links).toEqual(["#approval-a1", "#approval-a2"]);
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

	it("approves everything still open with Approve all", async () => {
		const { onApproveAll, onDecide } = await render([
			proposal("a1", "Creating a new output", "Budget"),
			proposal("a2", "Creating a new output", "Forecast"),
			proposal("a3", "Filing a Work Item", "Fix the tab"),
		]);
		await act(async () => button("Deny creating Forecast")?.click());
		expect(onDecide).toHaveBeenCalledWith("a2", "deny");
		await act(async () => button("Approve all")?.click());
		expect(onApproveAll).toHaveBeenCalledWith(["a1", "a3"]);
		expect(button("Approve all")?.disabled).toBe(true);
	});

	it("offers no Approve all for a single item", async () => {
		await render([proposal("a1", "Creating a new output", "Budget")]);
		expect(button("Approve all")).toBeUndefined();
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
});
