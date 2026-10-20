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
	it("renders a status and exact action link for every missing or human item", () => {
		const root = markup(<SetupChecklist setup={setup} />);
		for (const item of setup.items.filter((x) => x.state !== "ready")) {
			const link = [...root.querySelectorAll("a")].find(
				(a) => a.textContent === item.label,
			);
			expect(link?.getAttribute("href")).toBe(item.href);
			expect(link?.closest("li")?.textContent).toContain(
				item.state === "needs_you" ? "Needs you" : "Missing",
			);
		}
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
		).toContain(
			"No setup requirements are declared in this tedi’s configuration.",
		);
	});
	it("shows unavailable without claiming ready", () => {
		expect(markup(<SetupChip tediId="worker" failed />).textContent).toContain(
			"Setup · unavailable",
		);
	});
});
