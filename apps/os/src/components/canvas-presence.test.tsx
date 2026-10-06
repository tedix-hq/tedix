import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { CollabParticipant } from "@/collab/presence";

/*
 * The real Kumo Popover renders its content only while open, and a server
 * render always starts closed — so an unmocked render of `CanvasPresence`
 * contains no popup markup at all and every assertion about the popup's
 * `className` passes for want of a subject. Mock the primitive the way
 * `kumo/tooltip.test.tsx` does, mirroring Kumo's real shape: the portal's
 * positioner (a `div`) wraps the popup (a `section`), and the popup is the only
 * element that receives the call site's `className`.
 */
vi.mock("@cloudflare/kumo/components/popover", () => {
	type PartProps = { children?: ReactNode; className?: string };
	type TriggerProps = PartProps & { render?: ReactElement };
	type ContentProps = PartProps & { align?: string; sideOffset?: number };

	function Part({ children, className }: PartProps) {
		return <div className={className}>{children}</div>;
	}

	function Root({ children }: PartProps) {
		return <div>{children}</div>;
	}

	function Trigger({ children, render }: TriggerProps) {
		return render ?? <>{children}</>;
	}

	function Content({ children, className }: ContentProps) {
		return (
			<div data-part="positioner">
				<section className={className}>{children}</section>
			</div>
		);
	}

	function Title({ children, className }: PartProps) {
		return <h2 className={className}>{children}</h2>;
	}

	const Popover = Object.assign(Root, {
		Trigger,
		Content,
		Title,
		Description: Part,
		Close: Part,
	});

	return {
		Popover,
		PopoverContent: Content,
		PopoverDescription: Part,
		PopoverRoot: Root,
		PopoverTitle: Title,
		PopoverTrigger: Trigger,
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
		Popover: {
			Portal: Part,
			Positioner: ({
				children,
				className,
			}: {
				children?: ReactNode;
				className?: string;
			}) => (
				<div data-part="positioner" className={className}>
					{children}
				</div>
			),
			Popup: ({
				children,
				className,
			}: {
				children?: ReactNode;
				className?: string;
			}) => <section className={className}>{children}</section>,
			Arrow: Part,
		},
	};
});

import { CanvasPresence } from "./canvas-presence";

function participant(
	key: string,
	displayName: string,
	kind: CollabParticipant["kind"] = "human",
): CollabParticipant {
	return {
		key,
		displayName,
		kind,
		role: kind === "human" ? "member" : "operator",
		verified: true,
		clientIds: [1],
		location: { surface: "canvas", artifactLabel: "Launch deck" },
		selection: null,
		sessions: 1,
	};
}

describe("CanvasPresence", () => {
	it("renders an accessible compact Kumo roster without raw IDs", () => {
		const html = renderToStaticMarkup(
			<CanvasPresence
				participants={[
					participant("opaque-a", "Ada Lovelace"),
					participant("opaque-b", "CTO", "tedi"),
					participant("opaque-c", "Codex", "external_agent"),
					participant("opaque-d", "Grace Hopper"),
				]}
			/>,
		);
		expect(html).toContain("4 collaborators here now");
		expect(html).toContain("+1");
		expect(html).toContain("External agent");
		expect(html).not.toContain("opaque-a");
	});

	it("renders nothing when nobody else is present", () => {
		expect(renderToStaticMarkup(<CanvasPresence participants={[]} />)).toBe("");
	});

	it("uses the adapter dropdown layer on the roster positioner", () => {
		const html = renderToStaticMarkup(
			<CanvasPresence
				participants={[participant("opaque-a", "Ada Lovelace")]}
			/>,
		);

		// Prove the popup is present before asserting anything about it. Without
		// this guard the drift assertions below hold trivially whenever the popup
		// stops rendering — which is exactly how this test silently stopped
		// covering the `!z-[1100]` it exists to catch.
		expect(html).toMatch(
			/<div data-part="positioner" class="isolate z-\(--tedix-layer-dropdown\)"><section class="[^"]*!w-\[280px\]/,
		);
		expect(html).toContain("shadow-tedix-floating");
		expect(html).toContain("1 collaborator here now");

		// Kumo's `Popover.Content` lands `className` on the popup, inside Base UI's
		// transformed positioner — a z-index there is trapped in that stacking
		// context. The adapter must put the dropdown layer on the positioner; the
		// compound upstream Content bypasses it and lets the toolbar cover it.
		expect(html).not.toMatch(/z-\[/);
		expect(html).not.toContain("z-index");
		expect(html).not.toMatch(/\bz-\d/);
		expect(html).toContain(
			'data-part="positioner" class="isolate z-(--tedix-layer-dropdown)"',
		);
	});
});
