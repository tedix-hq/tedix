import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@cloudflare/kumo/components/dropdown", () => {
	type PartProps = {
		children?: ReactNode;
		checked?: boolean;
		className?: string;
		href?: string;
		variant?: string;
		value?: string;
	};

	function Part({ children, className }: PartProps) {
		return <div className={className}>{children}</div>;
	}

	function MenuItem({ children, className, variant }: PartProps) {
		return (
			<div className={className} data-variant={variant} role="menuitem">
				{children}
			</div>
		);
	}

	function LinkItem({ children, className, href }: PartProps) {
		return (
			<a className={className} href={href} role="menuitem">
				{children}
			</a>
		);
	}

	function CheckboxItem({ children, checked, className }: PartProps) {
		return (
			<div aria-checked={checked} className={className} role="menuitemcheckbox">
				{children}
			</div>
		);
	}

	function RadioItem({ children, className, value }: PartProps) {
		return (
			<div className={className} data-value={value} role="menuitemradio">
				{children}
			</div>
		);
	}

	const DropdownMenu = Object.assign(Part, {
		Portal: Part,
		Trigger: Part,
		Content: Part,
		Group: Part,
		Label: Part,
		Item: MenuItem,
		LinkItem,
		CheckboxItem,
		RadioGroup: Part,
		RadioItem,
		RadioItemIndicator: () => <span data-radio-indicator="true" />,
		Separator: Part,
		Shortcut: Part,
		Sub: Part,
		SubContent: Part,
		SubTrigger: Part,
	});

	return { DropdownMenu };
});

vi.mock("@cloudflare/kumo/primitives/menu", () => {
	function Part({
		children,
		className,
	}: {
		children?: ReactNode;
		className?: string;
	}) {
		return <div className={className}>{children}</div>;
	}

	return { Menu: { Portal: Part, Positioner: Part, Popup: Part } };
});

import { DropdownMenuItem, DropdownMenuLinkItem } from "./dropdown-menu";

describe("Kumo Dropdown Menu adapter", () => {
	it("maps the destructive item variant to Kumo danger and renders link items as real anchors", () => {
		const item = renderToStaticMarkup(
			<DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>,
		);
		expect(item).toContain('data-variant="danger"');
		expect(item).toContain('role="menuitem"');

		const link = renderToStaticMarkup(
			<DropdownMenuLinkItem href="/settings">Settings</DropdownMenuLinkItem>,
		);
		expect(link).toMatch(/^<a /);
		expect(link).toContain('href="/settings"');
		expect(link).toContain('role="menuitem"');
	});
});
