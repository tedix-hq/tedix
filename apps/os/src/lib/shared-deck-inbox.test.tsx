import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vite-plus/test";
import { DecisionDeckConfigSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { SharedDeckInboxProvider, useDeckInbox } from "./shared-deck-inbox";

const config = DecisionDeckConfigSchema.parse({ version: 1 });
const inbox = vi.hoisted(() => vi.fn());
vi.mock("@/lib/use-decision-inbox", () => ({ useDecisionInbox: inbox }));
vi.mock("@/lib/use-work-apps", () => ({
	useWorkApps: () => ({
		apps: [{ role: "deck", manifest: { config: { version: 1 } } }],
	}),
}));

it("reads the installed deck's queue once and gives other configs their own read", async () => {
	inbox.mockImplementation((given, destination = "deck") => ({
		for: given ? `${given.projectId ?? "deck"}:${destination}` : "idle",
	}));
	const seen: unknown[] = [];
	function Reader(props: { project?: string; all?: boolean }) {
		seen.push(
			useDeckInbox(
				props.project ? { ...config, projectId: props.project } : config,
				props.all ? "all" : "deck",
			),
		);
		return null;
	}
	const host = document.createElement("div");
	const root = createRoot(host);
	await act(async () =>
		root.render(
			<QueryClientProvider client={new QueryClient()}>
				<SharedDeckInboxProvider>
					<Reader />
					<Reader />
					<Reader project="11111111-1111-4111-8111-111111111111" />
					<Reader all />
				</SharedDeckInboxProvider>
			</QueryClientProvider>,
		),
	);
	// Two readers of the installed deck hold the very same result.
	expect(seen[0]).toBe(seen[1]);
	expect(seen[0]).toEqual({ for: "deck:deck" });
	expect(seen[2]).toEqual({
		for: "11111111-1111-4111-8111-111111111111:deck",
	});
	expect(seen[3]).toEqual({ for: "deck:all" });
	// The shared readers ask for nothing themselves.
	expect(
		inbox.mock.calls.filter(([given]) => given === undefined),
	).toHaveLength(2);
	await act(async () => root.unmount());
});
