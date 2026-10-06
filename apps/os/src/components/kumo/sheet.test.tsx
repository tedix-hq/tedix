import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@cloudflare/kumo/primitives/dialog", () => {
	type PartProps = {
		children?: ReactNode;
		className?: string;
		render?: ReactElement;
		"data-side"?: string;
	};

	function Part({ children, className }: PartProps) {
		return <div className={className}>{children}</div>;
	}

	function Popup({ children, className, "data-side": side }: PartProps) {
		return (
			<section className={className} data-side={side}>
				{children}
			</section>
		);
	}

	return {
		Dialog: {
			Root: Part,
			Trigger: Part,
			Close: Part,
			Portal: Part,
			Backdrop: Part,
			Popup,
			Title: Part,
			Description: Part,
		},
	};
});

import { SheetContent, SheetDescription, SheetTitle } from "./sheet";

describe("Kumo Sheet adapter", () => {
	it("forwards the drawer side and renders its title, description, and body", () => {
		const html = renderToStaticMarkup(
			<SheetContent side="right" size="md" showCloseButton={false}>
				<SheetTitle>Evidence details</SheetTitle>
				<SheetDescription>Inspect the accepted proof.</SheetDescription>
				Content
			</SheetContent>,
		);

		expect(html).toContain('data-side="right"');
		expect(html).toContain("Evidence details");
		expect(html).toContain("Inspect the accepted proof.");
		expect(html).toContain("Content");
	});
});
