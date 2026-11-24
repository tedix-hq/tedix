import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@cloudflare/kumo/primitives/select", async () => {
	const { Select: primitive } = await vi.importActual<
		typeof import("@cloudflare/kumo/primitives/select")
	>("@cloudflare/kumo/primitives/select");
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

	function Trigger({ children, className, ...props }: PartProps) {
		return (
			<button className={className} type="button" {...props}>
				{children}
			</button>
		);
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
			Root: primitive.Root,
			Trigger,
			Value: primitive.Value,
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
	it("shows the matching option label in the closed trigger", () => {
		const markup = renderToStaticMarkup(
			<Select value="skill-123">
				<SelectTrigger>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{[{ id: "skill-123", name: "Calendar review" }].map((skill) => (
						<SelectItem key={skill.id} value={skill.id}>
							{skill.name}
						</SelectItem>
					))}
				</SelectContent>
			</Select>,
		);
		expect(markup.split("</button>")[0]).toContain(">Calendar review<");
	});
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
