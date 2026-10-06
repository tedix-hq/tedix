/**
 * Component-level proof that a hostile URL in a layout spec never reaches a
 * navigable attribute.
 *
 * `packages/widget-ui/src/lib/safe-url.test.ts` covers the allowlist itself.
 * This file covers the wiring: it renders the actual json-render components
 * with the actual hostile props a model could emit and asserts on the emitted
 * markup, because the interesting failure mode is not "the sanitizer is wrong"
 * but "a component forgot to call it".
 *
 * Rendered with `react-dom/server` rather than a DOM testing library: these
 * components are pure output for the props under test, the assertion is on
 * markup, and this app has no DOM test harness to add one to.
 */

import { StateProvider } from "@json-render/react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { AnswerBlockComponent } from "./components/AnswerBlock";
import { ContentCardComponent } from "./components/ContentCard";
import { KeyValuePanelComponent } from "./components/KeyValuePanel";
import { ProductCardComponent } from "./components/ProductCard";

const HOSTILE = [
	"javascript:alert(document.domain)",
	"JaVaScRiPt:alert(1)",
	"  javascript:alert(1)",
	"java\nscript:alert(1)",
	"javascript:alert(1)",
	"data:text/html,<script>alert(1)</script>",
	"vbscript:msgbox(1)",
];

/**
 * These components read `/_utmParams` out of the json-render state store, so
 * they need the provider the renderer normally supplies. Nothing about the
 * assertion depends on the state — it only has to exist.
 */
function render(element: ReactElement): string {
	return renderToStaticMarkup(
		<StateProvider initialState={{}}>{element}</StateProvider>,
	);
}

/** Every attribute a browser would follow, in the emitted markup. */
function navigableTargets(html: string): string[] {
	return [...html.matchAll(/(?:href|src|action|formaction)="([^"]*)"/gi)].map(
		(match) => match[1] ?? "",
	);
}

function assertNoHostileTargets(html: string) {
	for (const target of navigableTargets(html)) {
		expect(target.toLowerCase().replace(/\s/g, "")).not.toMatch(
			/^(javascript|data|vbscript|blob|file|about):/,
		);
	}
}

describe("hostile spec URLs never reach a navigable attribute", () => {
	it("ProductCard drops a hostile url and keeps the card readable", () => {
		for (const url of HOSTILE) {
			const html = render(
				<ProductCardComponent
					title="Widget"
					url={url}
					ctaLabel="Buy"
					image={url}
				/>,
			);
			assertNoHostileTargets(html);
			// Fails closed, not blank: the product title still renders.
			expect(html).toContain("Widget");
		}
	});

	it("ContentCard degrades to a non-link wrapper", () => {
		for (const url of HOSTILE) {
			const html = render(
				<ContentCardComponent title="Article" url={url} thumbnail={url} />,
			);
			assertNoHostileTargets(html);
			// Not an anchor at all — an <a> with no href still reads as clickable.
			expect(html.startsWith("<a")).toBe(false);
			expect(html).toContain("Article");
		}
	});

	it("AnswerBlock drops a hostile source citation URL", () => {
		for (const url of HOSTILE) {
			const html = render(
				<AnswerBlockComponent
					answer="Because."
					sources={[{ title: "Source", url, snippet: null }]}
				/>,
			);
			assertNoHostileTargets(html);
			expect(html).toContain("Source");
		}
	});

	it("KeyValuePanel renders a hostile item href as plain text", () => {
		for (const href of HOSTILE) {
			const html = render(
				<KeyValuePanelComponent
					items={[{ label: "Website", value: "example.com", href }]}
				/>,
			);
			assertNoHostileTargets(html);
			expect(html).not.toContain("<a ");
			expect(html).toContain("example.com");
		}
	});

	it("still renders legitimate https targets", () => {
		const html = render(
			<ProductCardComponent
				title="Widget"
				url="https://shop.example.com/p/1"
				ctaLabel="Buy"
				image="https://cdn.example.com/p1.png"
			/>,
		);
		expect(navigableTargets(html)).toContain("https://shop.example.com/p/1");
		expect(navigableTargets(html)).toContain("https://cdn.example.com/p1.png");
	});
});
