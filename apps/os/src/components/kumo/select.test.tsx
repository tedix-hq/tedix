import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@cloudflare/kumo/primitives/select", () => {
	type PartProps = {
		children?: ReactNode;
		className?: string;
		placeholder?: ReactNode;
		value?: string;
		"aria-label"?: string;
		"data-kumo-component"?: string;
		"data-kumo-part"?: string;
		"data-size"?: string;
	};

	function Part({ children, className }: PartProps) {
		return <div className={className}>{children}</div>;
	}

	function Root({ children }: PartProps) {
		return <div>{children}</div>;
	}

	function Trigger({ children, className, ...props }: PartProps) {
		return (
			<button className={className} type="button" {...props}>
				{children}
			</button>
		);
	}

	function Value({ className, placeholder }: PartProps) {
		return <span className={className}>{placeholder}</span>;
	}

	function Popup({ children, className, ...props }: PartProps) {
		return (
			<section className={className} {...props}>
				{children}
			</section>
		);
	}

	function Item({ children, className, value, ...props }: PartProps) {
		return (
			<div className={className} data-value={value} role="option" {...props}>
				{children}
			</div>
		);
	}

	return {
		Select: {
			Root,
			Trigger,
			Value,
			Icon: Part,
			Portal: Part,
			Positioner: Part,
			Popup,
			List: Part,
			Item,
			ItemText: Part,
			ItemIndicator: Part,
			Group: Part,
			GroupLabel: Part,
			Separator: Part,
			ScrollUpArrow: Part,
			ScrollDownArrow: Part,
		},
	};
});

import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./select";

describe("Kumo Select adapter", () => {
	it("names the trigger, forwards its size, and renders options with Kumo's part semantics", () => {
		const trigger = renderToStaticMarkup(
			<Select>
				<SelectTrigger aria-label="Environment" size="sm">
					<SelectValue placeholder="Production" />
				</SelectTrigger>
			</Select>,
		);
		expect(trigger).toContain('aria-label="Environment"');
		expect(trigger).toContain('data-size="sm"');
		expect(trigger).toContain("Production");

		const content = renderToStaticMarkup(
			<SelectContent>
				<SelectItem value="production">Production</SelectItem>
			</SelectContent>,
		);
		expect(content).toContain('role="option"');
		expect(content).toContain('data-kumo-part="option"');
		expect(content).toContain('data-value="production"');
	});
});
