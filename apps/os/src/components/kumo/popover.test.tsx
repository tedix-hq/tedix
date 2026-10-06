import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@cloudflare/kumo/components/popover", () => {
	function Part({ children }: { children?: ReactNode }) {
		return <>{children}</>;
	}

	return {
		Popover: Part,
		PopoverContent: Part,
		PopoverDescription: Part,
		PopoverRoot: Part,
		PopoverTitle: Part,
		PopoverTrigger: Part,
	};
});

vi.mock("@cloudflare/kumo/primitives/popover", () => {
	function Part({
		children,
		className,
	}: {
		children?: ReactNode;
		className?: string;
	}) {
		return <div className={className}>{children}</div>;
	}

	return {
		Popover: { Portal: Part, Positioner: Part, Popup: Part, Arrow: Part },
	};
});

import { PopoverContent } from "./popover";

describe("Kumo Popover adapter", () => {
	it("renders its content inside the anchored popup", () => {
		const html = renderToStaticMarkup(<PopoverContent>Content</PopoverContent>);

		expect(html).toContain("Content");
	});
});
