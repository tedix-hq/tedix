import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@cloudflare/kumo/primitives/tooltip", () => {
	type PartProps = { children?: ReactNode; className?: string };

	function Part({ children, className }: PartProps) {
		return <div className={className}>{children}</div>;
	}

	function Popup({ children, className }: PartProps) {
		return <section className={className}>{children}</section>;
	}

	return {
		Tooltip: {
			Provider: Part,
			Root: Part,
			Trigger: Part,
			Portal: Part,
			Positioner: Part,
			Popup,
			Arrow: Part,
		},
	};
});

import { TooltipContent } from "./tooltip";

describe("Kumo Tooltip adapter", () => {
	it("renders the hint inside the popup", () => {
		const html = renderToStaticMarkup(<TooltipContent>Hint</TooltipContent>);

		expect(html).toMatch(/<section[^>]*>.*Hint<\/section>/);
	});
});
