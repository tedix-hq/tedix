import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { publishWorkspaceAutoApprovals } from "@/lib/workspace-auto-approvals";
import { WorkspaceAutoApprovalRules } from "./workspace-auto-approval-rules";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	publishWorkspaceAutoApprovals(null);
});

async function render(workspaceId = "w1") {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root.render(<WorkspaceAutoApprovalRules workspaceId={workspaceId} />),
	);
}

const label = "creating and editing docs, sheets and slides in this workspace";

describe("WorkspaceAutoApprovalRules", () => {
	it("asks to open the chat when no chat of this workspace is connected", async () => {
		publishWorkspaceAutoApprovals({
			workspaceId: "other",
			rules: [],
			setRule: vi.fn(),
		});
		await render();
		expect(host.textContent).toContain("Open this workspace's chat");
	});

	it("lists each rule and turns it off", async () => {
		const setRule = vi.fn();
		publishWorkspaceAutoApprovals({
			workspaceId: "w1",
			rules: [
				{
					kind: "files",
					label,
					enabledBy: "u1",
					enabledAt: new Date().toISOString(),
				},
			],
			setRule,
		});
		await render();
		expect(host.textContent).toContain(
			"Creating and editing docs, sheets and slides in this workspace",
		);
		const off = host.querySelector<HTMLButtonElement>(
			`button[aria-label="Turn off always approving ${label}"]`,
		);
		await act(async () => off?.click());
		expect(setRule).toHaveBeenCalledWith("files", false);
	});

	it("says nothing is always approved when there are no rules", async () => {
		publishWorkspaceAutoApprovals({
			workspaceId: "w1",
			rules: [],
			setRule: vi.fn(),
		});
		await render();
		expect(host.textContent).toContain("Every change the agent proposes waits");
	});
});
