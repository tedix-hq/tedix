// @vitest-environment happy-dom

import { act, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@cloudflare/kumo/components/dialog", () => {
	type PartProps = {
		children?: ReactNode;
		className?: string;
		render?: ReactElement;
		size?: "sm" | "base" | "lg" | "xl";
	};

	function Part({ children, className }: PartProps) {
		return <div className={className}>{children}</div>;
	}

	function DialogContent({
		children,
		className,
		size,
		...props
	}: PartProps & { container?: HTMLElement | null }) {
		return (
			<section
				className={className}
				data-kumo-dialog-size={size}
				data-portal-layer={props.container?.dataset.tedixLayer}
			>
				{children}
			</section>
		);
	}

	const Dialog = Object.assign(DialogContent, {
		Root: Part,
		Trigger: Part,
		Title: Part,
		Description: Part,
		Close: Part,
	});

	return { Dialog };
});

import { DialogContent } from "./dialog";

describe("Kumo Dialog adapter", () => {
	it("forwards Kumo's size variant and portals through the semantic overlay layer for exactly its lifetime", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);

		await act(async () => {
			root.render(
				<DialogContent size="lg" showCloseButton={false}>
					Content
				</DialogContent>,
			);
		});

		const section = host.querySelector("section");
		expect(section?.dataset.kumoDialogSize).toBe("lg");
		expect(section?.dataset.portalLayer).toBe("overlay");
		expect(
			document.body.querySelector('[data-tedix-layer="overlay"]'),
		).not.toBeNull();

		await act(async () => root.unmount());
		expect(
			document.body.querySelector('[data-tedix-layer="overlay"]'),
		).toBeNull();
		host.remove();
	});
});
