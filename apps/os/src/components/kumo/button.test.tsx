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
});
