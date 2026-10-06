import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { operationalContextQueryOptions } from "@/lib/os-query-options";
import { AdminSectionLayout, canAccessAdminSection } from "./admin-layout";

// A tenant host: the zero-account local lane bypasses the admin gate.
vi.mock("@/shared/os-tenant", () => ({
	resolveOsTenant: () => ({ kind: "tenant", slug: "acme" }),
}));

describe("canAccessAdminSection", () => {
	it("admits settings:manage regardless of role", () => {
		expect(
			canAccessAdminSection({
				role: null,
				permissions: ["settings:manage"],
			}),
		).toBe(true);
	});

	it("admits os:admin", () => {
		expect(
			canAccessAdminSection({ role: "member", permissions: ["os:admin"] }),
		).toBe(true);
	});

	it("admits administrative roles without resolved permissions", () => {
		for (const role of ["owner", "admin", "admin"]) {
			expect(canAccessAdminSection({ role, permissions: [] })).toBe(true);
		}
	});

	it("refuses members, viewers, and empty authority", () => {
		expect(
			canAccessAdminSection({
				role: "member",
				permissions: ["os:read", "os:author", "os:run"],
			}),
		).toBe(false);
		expect(canAccessAdminSection({ role: "viewer", permissions: [] })).toBe(
			false,
		);
		expect(canAccessAdminSection({ role: null, permissions: [] })).toBe(false);
	});

	it("uses compact shared Kumo card geometry for the restricted state", () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, enabled: false } },
		});
		client.setQueryData(operationalContextQueryOptions().queryKey, {
			authority: { role: "member", permissions: ["os:read"] },
		} as never);
		const doc = new DOMParser().parseFromString(
			renderToStaticMarkup(
				createElement(
					QueryClientProvider,
					{ client },
					createElement(AdminSectionLayout),
				),
			),
			"text/html",
		);
		expect(doc.body.textContent).toContain(
			"This area needs administrative authority",
		);
		const card = doc.querySelector('[data-slot="card"]');
		expect(card?.getAttribute("data-size")).toBe("sm");
		const content = card?.querySelector('[data-slot="card-content"]');
		expect(content?.classList.contains("gap-3")).toBe(true);
		expect(content?.classList.contains("p-6")).toBe(false);
	});
});
