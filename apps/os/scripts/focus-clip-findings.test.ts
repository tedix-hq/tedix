import { describe, expect, it } from "vite-plus/test";
import {
	controlSelector,
	describeControl,
} from "../browser-tests/focus-clip-page";

const REPEATED_CARDS = `
<main>
	<article class="output-card"><h2>First</h2><button class="card-action" type="button">Open</button></article>
	<article class="output-card"><h2>Second</h2><button class="card-action" type="button">Open</button></article>
	<article class="output-card"><h2>Third</h2><button class="card-action" type="button">Open</button></article>
</main>`;

describe("controlSelector", () => {
	it("maps each repeated identical control back to its own element", () => {
		document.body.innerHTML = REPEATED_CARDS;
		const buttons = [...document.querySelectorAll("button")];
		const selectors = buttons.map((button) => controlSelector(button));
		expect(new Set(selectors).size).toBe(buttons.length);
		for (const [index, button] of buttons.entries()) {
			expect([...document.querySelectorAll(selectors[index]!)]).toEqual([
				button,
			]);
			// The chain names the owning card, not just the control.
			expect(selectors[index]).toContain(`article:nth-of-type(${index + 1})`);
		}
	});

	it("stops at the first uniquely identifying ancestor chain", () => {
		document.body.innerHTML = `
		<main><section id="outputs-list"><div data-testid="clip"><button aria-label="Save draft">x</button></div></section></main>`;
		const button = document.querySelector("button")!;
		const selector = controlSelector(button);
		expect(selector).toBe('button[aria-label="Save draft"]');
		expect([...document.querySelectorAll(selector)]).toEqual([button]);
	});

	it("skips generated ids but keeps stable ones", () => {
		document.body.innerHTML = `
		<main><article><button id="base-ui-trigger-4" class="x">Go</button></article></main>
		<section><article><button class="x">Go</button></article></section>`;
		const generated = document.querySelector("#base-ui-trigger-4")!;
		expect(controlSelector(generated)).not.toContain("#base-ui-");
		document.body.innerHTML = `<main><button id="audit-download">Go</button></main>`;
		expect(controlSelector(document.querySelector("button")!)).toBe(
			"#audit-download",
		);
	});
});

describe("describeControl", () => {
	it("keeps the compact tag/class/name descriptor", () => {
		document.body.innerHTML = REPEATED_CARDS;
		expect(describeControl(document.querySelector("button")!)).toBe(
			'button.card-action "Open"',
		);
	});
});
