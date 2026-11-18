import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("@/shared/os-tenant", () => ({
	resolveOsTenant: () => ({ kind: "tenant" }),
}));

afterEach(() => vi.unstubAllGlobals());

it("shares bookmarks across every OS timeout client and the app runtime leaf", async () => {
	const seen: (string | null)[] = [];
	vi.stubGlobal(
		"fetch",
		async (_input: RequestInfo | URL, init?: RequestInit) => {
			seen.push(new Headers(init?.headers).get("x-d1-bookmark"));
			return Response.json(
				{ json: {} },
				{
					headers: { "x-d1-bookmark": `bookmark-${seen.length}` },
				},
			);
		},
	);
	const api = await import("./api");
	for (const client of [
		api.osChatMutationApi,
		api.osApi,
		api.osChatReadApi,
		api.osDirectReadApi,
		api.osSiteDeprovisionApi,
	]) {
		await client.userProfile.getMine({});
	}
	await api.osAppRuntimeCall({
		workspaceId: "00000000-0000-4000-8000-000000000001",
		gadgetId: "00000000-0000-4000-8000-000000000002",
		session: "session",
		method: "read",
		args: [],
	});
	expect(seen).toEqual([
		null,
		"bookmark-1",
		"bookmark-2",
		"bookmark-3",
		"bookmark-4",
		"bookmark-5",
	]);
});
