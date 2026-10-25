// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { DataTableComponent } from "./DataTable";

function renderTitle(title: unknown) {
	const node = document.createElement("div");
	node.innerHTML = renderToStaticMarkup(
		<DataTableComponent
			columns={[{ field: "title", header: "Title", format: "text" }]}
			data={[{ title }]}
		/>,
	);
	return node.querySelector("td")!;
}

describe("provider formatting in widget table cells", () => {
	it("renders the activity title as bold text with a plain tooltip", () => {
		const cell = renderTitle("<strong>Example Airlines</strong>");
		expect(cell.querySelector("strong")?.textContent).toBe("Example Airlines");
		expect(cell.textContent).toBe("Example Airlines");
		expect(cell.querySelector("span")?.title).toBe("Example Airlines");
	});

	it("supports nested, repeated and uppercase emphasis plus line breaks", () => {
		const cell = renderTitle(
			"<STRONG>One <em>two</em></STRONG><br/><b>three</b>",
		);
		expect(cell.querySelector("strong em")?.textContent).toBe("two");
		expect(cell.querySelector("b")?.textContent).toBe("three");
		expect(cell.querySelectorAll("br")).toHaveLength(1);
		expect(cell.querySelector("span")?.title).toBe("One two\nthree");
	});

	it.each([
		"<script>",
		"<script>alert(1)</script>",
		'<img src="https://example.com/track" onerror="alert(1)">',
		'<a href="javascript:alert(1)">Open</a>',
		'<strong onclick="alert(1)">Title</strong>',
		"<svg><script>alert(1)</script></svg>",
	])("keeps unsupported markup and attributes inert: %s", (title) => {
		const cell = renderTitle(title);
		expect(
			cell.querySelector("script, img, a, svg, [onclick], [onerror]"),
		).toBeNull();
		expect(cell.textContent).toBe(title);
	});

	it("leaves ordinary text, comparisons, objects and empty values readable", () => {
		for (const title of [
			"A < B > C",
			"Budget & fare",
			"<strong",
			"plain text",
		]) {
			expect(renderTitle(title).textContent).toBe(title);
		}
		expect(
			renderTitle({ name: "<em>Named item</em>" }).querySelector("em")
				?.textContent,
		).toBe("Named item");
		expect(renderTitle(null).textContent).toBe("—");
	});
});
