import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";
import { AppLogo } from "./app-logo";

describe("AppLogo", () => {
	it("tries the next logo when one fails, then shows letters", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		const src = () => host.querySelector("img")?.getAttribute("src") ?? null;
		const fail = () =>
			act(async () =>
				host.querySelector("img")?.dispatchEvent(new Event("error")),
			);
		try {
			await act(async () =>
				root.render(
					<AppLogo
						id="docs-acme"
						name="Acme Docs"
						logoUrl={null}
						inheritedLogoUrl="https://cdn.example/base.png"
						providerLogoUrl="https://cdn.example/provider.png"
					/>,
				),
			);
			expect(src()).toBe("https://cdn.example/base.png");
			expect(
				host.querySelector('[role="img"]')?.getAttribute("aria-label"),
			).toBe("Acme Docs logo");
			await fail();
			expect(src()).toBe("https://cdn.example/provider.png");
			await fail();
			expect(src()).toBeNull();
			expect(host.textContent).toBe("AD");
			expect(host.querySelector("svg")).toBeNull();
		} finally {
			await act(async () => root.unmount());
			host.remove();
		}
	});
});
