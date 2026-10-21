import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { TediSetup } from "@tedix/api-contract/contracts/tedis";
import { SetupChecklist, SetupChip } from "./tedi-setup";

const setup: TediSetup = {
	tediId: "worker",
	observedAt: "2026-10-20T17:00:00Z",
	items: [
		{
			id: "connection",
			kind: "connection",
			state: "missing",
			label: "Mail",
			detail: "Connect mail",
			href: "/admin/connections?connect=mail",
		},
		{
			id: "human",
			kind: "human",
			state: "needs_you",
			label: "Consent",
			detail: "Review consent",
			href: "/skills/inbox",
		},
		{
			id: "build",
			kind: "build",
			state: "missing",
			label: "Build still owed: sync_stock",
			detail: "No registered tool",
			href: "/skills/stock",
		},
		{
			id: "tool",
			kind: "tool",
			state: "ready",
			label: "Read",
			detail: "Enabled",
			href: "/apps/mail/tools",
		},
	],
};

function markup(element: Parameters<typeof renderToStaticMarkup>[0]) {
	const root = document.createElement("div");
	root.innerHTML = renderToStaticMarkup(element);
	return root;
}

describe("Setup", () => {
	it("renders a bounded summary and exact review destinations", () => {
		const root = markup(<SetupChecklist setup={setup} />);
		expect(root.textContent).toContain(
			"3 requirements to resolve across 3 setup groups",
		);
		for (const item of setup.items.filter((x) => x.state !== "ready")) {
			expect(root.querySelector(`a[href="${item.href}"]`)).not.toBeNull();
		}
		expect(root.textContent).not.toContain("Build still owed:");
		expect(root.textContent).toContain("execution permission");
	});
	it("groups missing builds by skill and preserves the full inventory in diagnostics", async () => {
		const builds = Array.from({ length: 18 }, (_, index) => ({
			...setup.items[2]!,
			id: `build:planning:tool-${index}`,
			label: `Build still owed: tool-${index}`,
			detail:
				"Required by Release planning; no tool is registered in this organization.",
		}));
		const node = document.createElement("div");
		document.body.append(node);
		const root = createRoot(node);
		try {
			await act(async () =>
				root.render(<SetupChecklist setup={{ ...setup, items: builds }} />),
			);
			expect(node.textContent).toContain(
				"18 requirements to resolve across 1 setup group",
			);
			expect(node.textContent).toContain("Release planning");
			expect(node.textContent).toContain("Review skill");
			expect(node.textContent).not.toContain("tool-0");
			const trigger = [...node.querySelectorAll("button")].find((button) =>
				button.textContent?.includes("diagnostics"),
			)!;
			expect(trigger.getAttribute("aria-expanded")).toBe("false");
			await act(async () => trigger.click());
			expect(trigger.getAttribute("aria-expanded")).toBe("true");
			for (const item of builds) {
				const link = [...node.querySelectorAll("a")].find(
					(a) => a.textContent === item.label,
				);
				expect(link?.getAttribute("href")).toBe(item.href);
				expect(link?.closest("li")?.textContent).toContain(item.id);
				expect(link?.closest("li")?.textContent).toContain(item.detail);
			}
		} finally {
			await act(async () => root.unmount());
			node.remove();
		}
	});
	it("bounds the initial groups without dropping other destinations or conflating credential scopes", () => {
		const items = ["tenant", "user", "instance-a", "instance-b"].map(
			(scope) => ({
				...setup.items[0]!,
				id: scope,
				href: `/admin/connections?connect=mail&scope=${scope}`,
			}),
		);
		const root = markup(<SetupChecklist setup={{ ...setup, items }} />);
		expect(root.textContent).toContain(
			"4 requirements to resolve across 4 setup groups",
		);
		expect(root.querySelectorAll("a")).toHaveLength(3);
		expect(root.textContent).toContain("1 more setup group");
	});
	it("links the compact chip to Setup and reflects unresolved items", () => {
		const root = markup(<SetupChip tediId="worker" setup={setup} />);
		expect(root.querySelector("a")?.getAttribute("href")).toBe(
			"/team/worker#setup",
		);
		expect(root.textContent).toContain("Setup · 3 to do");
	});
	it("distinguishes no configured requirements from verified readiness", () => {
		expect(
			markup(<SetupChecklist setup={{ ...setup, items: [] }} />).textContent,
		).toContain("No setup requirements are configured.");
	});
	it("shows unavailable without claiming ready", () => {
		expect(markup(<SetupChip tediId="worker" failed />).textContent).toContain(
			"Setup · unavailable",
		);
	});
});
