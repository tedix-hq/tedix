// @vitest-environment happy-dom

import * as tedixReact from "../templates/tedix/node_modules/react";
import { createRoot as createTedixRoot } from "../templates/tedix/node_modules/react-dom/client";
import * as marketingReact from "../templates/marketing/node_modules/react";
import { createRoot as createMarketingRoot } from "../templates/marketing/node_modules/react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { pages as tedixPages } from "../templates/tedix/node_modules/@emdash-cms/plugin-forms/src/admin.tsx";
import { pages as marketingPages } from "../templates/marketing/node_modules/@emdash-cms/plugin-forms/src/admin.tsx";

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

describe.each([
	["tedix", tedixPages, tedixReact, createTedixRoot],
	["marketing", marketingPages, marketingReact, createMarketingRoot],
] as const)("%s Forms admin", (_name, pages, React, createRoot) => {
	it("shows 30 days in the new-form retention input", async () => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(JSON.stringify({ success: true, data: { items: [] } }), {
					status: 200,
				}),
		);
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const ListPage = pages["/"] as tedixReact.ComponentType;
		await React.act(async () => root.render(React.createElement(ListPage)));
		const newForm = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("New Form"),
		);
		expect(newForm).toBeDefined();
		await React.act(async () => newForm!.click());
		expect(
			container.querySelector<HTMLInputElement>('input[type="number"]')?.value,
		).toBe("30");
		await React.act(async () => root.unmount());
	});
});
