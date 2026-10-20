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
	it("keeps resolved resource titles on nested tabs", async () => {
		query.mockReturnValue({ data: { app: { name: "Calendar" } } });
		const host = document.createElement("div");
		const root = createRoot(host);
		try {
			await act(async () =>
				root.render(<OsShellBreadcrumbs pathname="/apps/app-1/tools" />),
			);
			expect(host.textContent).toContain("Calendar");
			expect(
				document.title.startsWith("Connections · Calendar · Tools · "),
			).toBe(true);
		} finally {
			await act(async () => root.unmount());
			query.mockReturnValue({});
		}
	});
});
