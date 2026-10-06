import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
	Collection,
	Page,
	PageActions,
	PageBack,
	PageDescription,
	PageHeader,
	PageHeading,
	PageMeta,
	PageToolbar,
	PageTitle,
	SectionCollection,
} from "./page";

describe("Kumo Page adapter", () => {
	it("renders a section lane and makes full-height layout an explicit variant", () => {
		expect(renderToStaticMarkup(<Page>Content</Page>)).toMatch(
			/^<section[^>]*data-slot="page"/,
		);
		expect(renderToStaticMarkup(<Page>Content</Page>)).not.toContain(
			"data-full-height",
		);
		expect(
			renderToStaticMarkup(
				<Page fullHeight width="bleed">
					Canvas
				</Page>,
			),
		).toContain('data-full-height="true"');
	});

	it("composes a semantic header with a heading, description, and labelled actions", () => {
		const html = renderToStaticMarkup(
			<PageHeader divided>
				<PageHeading>
					<PageTitle>Outputs</PageTitle>
					<PageDescription>Governed work products.</PageDescription>
				</PageHeading>
				<PageActions aria-label="Output actions">
					<button type="button">Create output</button>
				</PageActions>
			</PageHeader>,
		);

		expect(html).toContain("<header");
		expect(html).toContain('data-divided="true"');
		expect(html).toContain(">Outputs</h1>");
		expect(html).toContain("Governed work products.");
		expect(html).toContain('aria-label="Output actions"');
	});

	it("provides inspector back navigation and compact metadata slots", () => {
		const html = renderToStaticMarkup(
			<>
				<PageBack>All apps</PageBack>
				<PageMeta>
					<li>
						Status <strong>Active</strong>
					</li>
				</PageMeta>
			</>,
		);

		expect(html).toContain('data-page-back=""');
		expect(html).toContain("All apps");
		expect(html).toContain('data-slot="page-meta"');
		expect(html).toContain("Active");
	});

	it("renders labelled collections and falls back to the empty copy", () => {
		expect(
			renderToStaticMarkup(
				<Collection appearance="inline" aria-label="Apps">
					<li>Mail</li>
				</Collection>,
			),
		).toContain('data-appearance="inline"');

		const html = renderToStaticMarkup(
			<SectionCollection
				title="Responses"
				description="Bounded response history."
				empty="No responses."
			>
				<li>Approved by Ada</li>
			</SectionCollection>,
		);
		expect(html).toContain('data-slot="page-section"');
		expect(html).toContain('data-slot="section-collection"');
		expect(html).toContain('aria-label="Responses"');
		expect(html).toContain("Approved by Ada");

		const emptyHtml = renderToStaticMarkup(
			<SectionCollection
				title="Responses"
				description="Bounded response history."
				empty="No responses."
			/>,
		);
		expect(emptyHtml).toContain("No responses.");
	});

	it("exposes the toolbar appearance so an existing surface can own its boundary", () => {
		expect(
			renderToStaticMarkup(
				<PageToolbar>
					<div>Filters</div>
				</PageToolbar>,
			),
		).toContain('data-appearance="bounded"');
		expect(
			renderToStaticMarkup(
				<PageToolbar appearance="inline">
					<div>Window</div>
				</PageToolbar>,
			),
		).toContain('data-appearance="inline"');
	});
});
