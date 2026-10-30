import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { EntityAvatar } from "./entity-avatar";

describe("EntityAvatar", () => {
	it("preserves identity colors across renames", () => {
		const render = (name: string) =>
			renderToStaticMarkup(
				<EntityAvatar id="workspace-1" name={name} kind="workspace" />,
			);
		const first = render("Research");
		const renamed = render("Notes");
		expect(first.match(/style="[^"]+"/)?.[0]).toBe(
			renamed.match(/style="[^"]+"/)?.[0],
		);
		expect(first).toContain('aria-hidden="true"');
	});

	it("shows uploaded images, falls back on errors, and accepts replacement images", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		try {
			const render = (image: string) =>
				act(async () =>
					root.render(
						<EntityAvatar id="tedi-1" name="CTO" kind="tedi" image={image} />,
					),
				);
			await render("/portrait.png");
			expect(host.querySelector("img")?.getAttribute("src")).toBe(
				"/portrait.png",
			);
			await act(async () =>
				host.querySelector("img")?.dispatchEvent(new Event("error")),
			);
			expect(host.querySelector("img")).toBeNull();
			expect(host.querySelector("svg")).not.toBeNull();
			await render("/new-portrait.png");
			expect(host.querySelector("img")?.getAttribute("src")).toBe(
				"/new-portrait.png",
			);
		} finally {
			await act(async () => root.unmount());
			host.remove();
		}
	});
});
