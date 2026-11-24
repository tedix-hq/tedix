import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vite-plus/test";
import type { OsCollaborationProposal } from "@tedix/api-contract/schemas/os-workspaces";

const api = vi.hoisted(() => ({
	get: vi.fn(),
	reject: vi.fn(),
	acceptEdit: vi.fn(),
	getCode: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: {
			collaboration: { get: api.get, reject: api.reject, list: vi.fn() },
			gadgets: { getCode: api.getCode },
		},
		osAppRuntime: { acceptEdit: api.acceptEdit },
	},
}));
vi.mock("@/components/canvas-proposals", () => ({ ProposalDiff: () => null }));
import { WorkspaceChatAppDraft } from "./workspace-chat-app-draft";
import { osQuery } from "@/lib/os-query-options";

it("waits for Accept, publishes exactly the staged sequence, and resolves decisions made in the app pane", async () => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	const draft = {
		appId: "app",
		name: "Cards",
		proposalId: "draft",
		sequence: 7,
		baseRevisionId: "base",
		files: ["client.js"],
	};
	let proposal = {
		id: "draft",
		sequence: 7,
		status: "open",
		resultRevision: null,
	} as OsCollaborationProposal;
	api.get.mockImplementation(async () => ({ proposal }));
	api.acceptEdit.mockImplementation(async () => {
		proposal = { ...proposal, status: "merged", resultRevision: 3 };
		return { revision: { revision: 3 } };
	});
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () => {
			root.render(
				<QueryClientProvider client={client}>
					<WorkspaceChatAppDraft workspaceId="workspace" draft={draft} />
				</QueryClientProvider>,
			);
		});
		await vi.waitFor(() =>
			expect(host.textContent).toContain("Accept and publish"),
		);
		expect(api.acceptEdit).not.toHaveBeenCalled();
		expect(host.querySelectorAll("[data-app-draft-card]")).toHaveLength(1);
		const accept = [...host.querySelectorAll("button")].find(
			(button) => button.textContent === "Accept and publish",
		)!;
		await act(async () => accept.click());
		await vi.waitFor(() =>
			expect(host.textContent).toContain("Published · version 3"),
		);
		expect(api.acceptEdit).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				proposalId: "draft",
				expectedSequence: 7,
				gadgetId: "app",
			}),
		);
		expect(host.textContent).not.toContain("Accept and publish");
		// The app pane decides the canonical proposal; the same transcript card follows it.
		await act(async () => {
			client.setQueryData(
				osQuery.osWorkspaces.collaboration.get.queryOptions({
					input: { proposalId: "draft" },
				}).queryKey,
				{ proposal: { ...proposal, status: "rejected", resultRevision: null } },
			);
		});
		await vi.waitFor(() => expect(host.textContent).toContain("Discarded"));
		expect(host.querySelectorAll("[data-app-draft-card]")).toHaveLength(1);
	} finally {
		await act(async () => root.unmount());
		client.clear();
		host.remove();
	}
});
