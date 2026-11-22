import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import { OsShellBreadcrumbs } from "./os-shell-breadcrumbs";

const query = vi.hoisted(() => vi.fn((): { data?: unknown } => ({})));
vi.mock("@tanstack/react-query", () => ({ useQuery: query }));
vi.mock("@/lib/os-query-options", () => ({
	appDetailQueryOptions: (id: string) => ({ id }),
	outputDetailQueryOptions: (id: string) => ({ id }),
	skillDetailQueryOptions: (id: string) => ({ id }),
	sitesQueryOptions: () => ({}),
}));

describe("shell page titles", () => {
	it.each([
		["/admin/organization", "Settings · Organization"],
		["/account/profile", "Profile"],
		["/team/tedi-1/memory", "Team · Memory"],
	])("uses the registered label for %s", async (pathname, title) => {
		const host = document.createElement("div");
		const root = createRoot(host);
		try {
			await act(async () =>
				root.render(<OsShellBreadcrumbs pathname={pathname} />),
			);
			expect(document.title.startsWith(`${title} · `)).toBe(true);
			expect(host.textContent).not.toContain("OS");
		} finally {
			await act(async () => root.unmount());
		}
	});
	it.each([
		[
			"/apps/app-1/tools",
			{ app: { name: "Calendar" } },
			"Connections · Calendar · Tools",
		],
		[
			"/sites/site-1",
			{
				sites: [
					{ id: "other", name: "Other" },
					{ id: "site-1", name: "Acme" },
				],
			},
			"Sites · Acme",
		],
	])("resolves resource titles for %s", async (pathname, data, title) => {
		query.mockReturnValue({ data });
		const host = document.createElement("div");
		const root = createRoot(host);
		try {
			await act(async () =>
				root.render(<OsShellBreadcrumbs pathname={pathname} />),
			);
			expect(host.textContent).toContain(title.split(" · ")[1]);
			expect(document.title.startsWith(`${title} · `)).toBe(true);
		} finally {
			await act(async () => root.unmount());
			query.mockReturnValue({});
		}
	});
});
