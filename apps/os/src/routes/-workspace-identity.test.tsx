import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, useContext } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import {
	WorkActorAvatar,
	WorkActorOwnerContext,
} from "@/components/work-actor-avatar";
import {
	membersListQueryOptions,
	operationalContextQueryOptions,
	tediRosterQueryOptions,
	userProfileQueryOptions,
	workExternalPrincipalsQueryOptions,
} from "@/lib/os-query-options";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	createFileRoute: () => (options: { component: () => unknown }) => ({
		options,
		useParams: () => ({ workspaceId: "pine-workspace" }),
	}),
}));
vi.mock("@/components/canvas-page", () => ({
	CanvasPage: () => {
		const ownerId = useContext(WorkActorOwnerContext);
		return (
			<>
				<WorkActorAvatar
					actor={{ type: "user", id: ownerId, harness: "codex" }}
				/>
				<WorkActorAvatar
					actor={{ type: "user", id: ownerId, harness: "claude-code" }}
				/>
				<WorkActorAvatar actor={{ type: "tedi", id: "cedar" }} />
			</>
		);
	},
}));

import { Route } from "./_session/_chrome-free/workspace_.$workspaceId";

it("resolves people and tedis in workspace apps outside the main shell", async () => {
	const organizationId = "11111111-1111-4111-8111-111111111111";
	const client = new QueryClient({
		defaultOptions: { queries: { staleTime: Infinity, retry: false } },
	});
	const seed = (key: readonly unknown[], data: unknown) =>
		client.setQueryData(key, data);
	seed(operationalContextQueryOptions().queryKey, {
		organization: { id: organizationId },
	});
	seed(userProfileQueryOptions().queryKey, {
		id: "pine-owner",
		name: "Morgan Lee",
		email: "morgan@pine.example",
		avatarUrl: null,
	});
	seed(tediRosterQueryOptions(100).queryKey, {
		data: [{ id: "cedar", name: "Cedar", avatar: "🌲" }],
	});
	seed(
		membersListQueryOptions({ organizationId, limit: 100, offset: 0 }).queryKey,
		{ data: [] },
	);
	seed(workExternalPrincipalsQueryOptions(organizationId).queryKey, []);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await (
			Route.options.component as { preload?: () => Promise<unknown> }
		).preload?.();
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					{createElement(Route.options.component!)}
				</QueryClientProvider>,
			),
		);
		expect(
			Array.from(host.querySelectorAll("button"), (button) =>
				button.getAttribute("aria-label"),
			),
		).toEqual(["Morgan Lee", "Morgan Lee", "Cedar"]);
		expect(host.querySelectorAll(".work-actor-badge")).toHaveLength(0);
		expect(
			Array.from(host.querySelectorAll(".work-actor-portrait")).at(-1)
				?.textContent,
		).toBe("🌲");
	} finally {
		await act(async () => root.unmount());
		host.remove();
		client.clear();
	}
});
