import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Button } from "./button";

describe("Kumo Button adapter", () => {
	it("normalizes named decorative-only children without turning text actions into icons", () => {
		const reaction = renderToStaticMarkup(
			<Button aria-label="More like this" size="sm" variant="ghost">
				<svg aria-hidden="true" />
			</Button>,
		);
		expect(reaction).toContain('data-icon-only="true"');
		const text = renderToStaticMarkup(
			<Button aria-label="Save changes" size="sm">
				<svg aria-hidden="true" />
				Save
			</Button>,
		);
		expect(text).not.toContain("data-icon-only");
	});

	it("keeps icon buttons named, renders as a real link on request, and makes a loading link inert", () => {
		const icon = renderToStaticMarkup(
			<Button aria-label="Refresh usage" size="icon-sm" />,
		);
		expect(icon).toContain('aria-label="Refresh usage"');
		expect(icon).toContain('data-icon-only="true"');
		expect(icon).toContain('data-slot="button"');
		for (const render of [undefined, <a href="/inspect" />]) {
			const titled = renderToStaticMarkup(
				<Button title="Inspect item" size="icon-sm" render={render}>
					<svg aria-hidden />
				</Button>,
			);
			expect(titled).toContain('aria-label="Inspect item"');
			expect(titled).not.toContain('title="Inspect item"');
		}

		const link = renderToStaticMarkup(
			<Button render={<a href="/settings" />} size="xs">
				Settings
			</Button>,
		);
		expect(link).toContain('<a href="/settings"');
		expect(link).toContain('data-slot="button"');
		expect(link).not.toContain("data-icon-only");

		const back = renderToStaticMarkup(
			<Button render={<a href="/skills" />} icon={<svg data-back-icon="" />}>
				All skills
			</Button>,
		);
		expect(back).toContain("data-back-icon");

		const loading = renderToStaticMarkup(
			<Button loading render={<a href="/settings" />}>
				Settings
			</Button>,
		);
		expect(loading).toContain('aria-busy="true"');
		expect(loading).toContain('aria-disabled="true"');
		expect(loading).not.toContain('href="/settings"');
		expect(loading).toContain('role="status"');
	});

	it("centres icon buttons as Kumo squares at every size", () => {
		for (const size of ["icon-xs", "icon-sm", "icon", "icon-lg"] as const) {
			const html = renderToStaticMarkup(
				<Button aria-label="Close" size={size} variant="ghost">
					<svg aria-hidden="true" />
				</Button>,
			);
			expect(html).toContain('data-icon-only="true"');
			expect(html).toMatch(/!items-center/);
			expect(html).toMatch(/!justify-center/);
			expect(html).toMatch(/!p-0/);
			expect(html).toMatch(/coarse:min-w-11/);
		}
	});

	it("draws link actions flush with surrounding text on both render paths", () => {
		const action = renderToStaticMarkup(
			<Button size="sm" variant="link">
				try again
			</Button>,
		);
		const anchor = renderToStaticMarkup(
			<Button render={<a href="/preview" />} size="xs" variant="link">
				Open preview
			</Button>,
		);
		for (const html of [action, anchor]) {
			expect(html).toContain("!px-0");
			expect(html).toContain("text-kumo-link");
		}
	});
});
