import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";
import { useDocumentTitle } from "./use-document-title";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function renderTitle(title: string) {
	const container = document.createElement("div");
	const root: Root = createRoot(container);
	function Harness() {
		useDocumentTitle(title);
		return null;
	}
	act(() => {
		root.render(createElement(Harness));
	});
	return {
		rerender: (next: string) => {
			title = next;
			act(() => {
				root.render(createElement(Harness));
			});
		},
		unmount: () => act(() => root.unmount()),
	};
}

describe("useDocumentTitle", () => {
	it("appends the Tedix OS suffix to a bare page name", () => {
		const rendered = renderTitle("Queue · Work");
		expect(document.title).toBe("Queue · Work · Tedix OS");
		rendered.unmount();
	});

	it("does not double an existing Tedix OS suffix", () => {
		const rendered = renderTitle("Sign in · Tedix OS");
		expect(document.title).toBe("Sign in · Tedix OS");
		rendered.unmount();
	});

	it("normalises a legacy · Tedix suffix to · Tedix OS", () => {
		const rendered = renderTitle("Authorize access · Tedix");
		expect(document.title).toBe("Authorize access · Tedix OS");
		rendered.rerender("Connections · Tools · Tedix");
		expect(document.title).toBe("Connections · Tools · Tedix OS");
		rendered.unmount();
	});

	it("uses the bare product name for an empty title", () => {
		const rendered = renderTitle("");
		expect(document.title).toBe("Tedix OS");
		rendered.unmount();
	});

	it("restores the previous title on unmount", () => {
		document.title = "Tedix OS";
		const rendered = renderTitle("Your profile");
		expect(document.title).toBe("Your profile · Tedix OS");
		rendered.unmount();
		expect(document.title).toBe("Tedix OS");
	});
});
