// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vite-plus/test";
import {
	bindMarkdownCopyButtons,
	renderMarkdown,
	safeMarkdownHref,
	stripBidiControls,
} from "./markdown";

const RLO = "‮";

function parse(html: string): HTMLElement {
	const root = document.createElement("div");
	root.innerHTML = html;
	return root;
}

describe("renderMarkdown blocks", () => {
	it("renders GFM tables with alignment and never admits HTML", () => {
		const html = renderMarkdown(
			"| Estado | Total |\n| --- | ---: |\n| En proceso | 101 |\n| <img src=x onerror=alert(1)> | 2 |",
		);
		const root = parse(html);
		expect(root.querySelector(".tedix-markdown-table table")).toBeTruthy();
		expect(root.querySelectorAll("th")[0]?.textContent).toBe("Estado");
		expect(root.querySelectorAll("th")[1]?.getAttribute("style")).toContain(
			"text-align:right",
		);
		expect(root.querySelectorAll("td")[1]?.textContent).toBe("101");
		expect(root.querySelector("img")).toBeNull();
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
	});

	it("renders fenced code with a language class and a copy affordance", () => {
		const html = renderMarkdown(
			["```ts", "const a = 1;", "<script>alert(1)</script>", "```"].join("\n"),
		);
		const root = parse(html);
		const code = root.querySelector("pre code");
		expect(code?.className).toBe("language-ts");
		expect(code?.textContent).toBe("const a = 1;\n<script>alert(1)</script>");
		expect(root.querySelector("script")).toBeNull();
		expect(
			root.querySelector("button[data-md-copy]")?.getAttribute("type"),
		).toBe("button");
		expect(root.querySelector(".tedix-md-code-language")?.textContent).toBe(
			"ts",
		);
	});

	it("closes a fence only on a matching marker and supports tildes", () => {
		const html = renderMarkdown(
			["~~~", "```", "still code", "~~~", "after"].join("\n"),
		);
		const root = parse(html);
		expect(root.querySelector("pre code")?.textContent).toBe("```\nstill code");
		expect(root.querySelector("p")?.textContent).toBe("after");
	});

	it("renders ordered, unordered, nested, and task lists", () => {
		const html = renderMarkdown(
			[
				"3. Third",
				"4. Fourth",
				"   - nested",
				"",
				"- [x] Done",
				"- [ ] Pending",
			].join("\n"),
		);
		const root = parse(html);
		const ol = root.querySelector("ol");
		expect(ol?.getAttribute("start")).toBe("3");
		expect(ol?.querySelectorAll(":scope > li").length).toBe(2);
		expect(ol?.querySelector("li ul li")?.textContent).toBe("nested");
		const checks = root.querySelectorAll(
			"li.tedix-task-item input[type=checkbox]",
		);
		expect(checks.length).toBe(2);
		expect(checks[0]?.hasAttribute("checked")).toBe(true);
		expect(checks[0]?.hasAttribute("disabled")).toBe(true);
		expect(checks[1]?.hasAttribute("checked")).toBe(false);
	});

	it("renders multi-line blockquotes, headings, and rules", () => {
		const html = renderMarkdown(
			["# Title", "", "> line one", "> line two", "", "---", "", "para"].join(
				"\n",
			),
		);
		const root = parse(html);
		expect(root.querySelector("h1")?.textContent).toBe("Title");
		expect(root.querySelector("blockquote p")?.textContent).toBe(
			"line one\nline two",
		);
		expect(root.querySelector("hr")).toBeTruthy();
		expect(root.querySelectorAll("p").length).toBe(2);
	});

	it("keeps raw HTML literal everywhere", () => {
		const html = renderMarkdown(
			"<b onmouseover=x>hi</b> & <a href=javascript:1>x</a>",
		);
		const root = parse(html);
		expect(root.querySelector("b, a")).toBeNull();
		expect(root.textContent).toBe(
			"<b onmouseover=x>hi</b> & <a href=javascript:1>x</a>",
		);
	});
});

describe("renderMarkdown inline", () => {
	it("renders emphasis, strikethrough, inline code, and hard breaks", () => {
		const root = parse(
			renderMarkdown("**bold** *em* _em2_ ~~old~~ `a*b*<c>` first  \nsecond"),
		);
		expect(root.querySelector("strong")?.textContent).toBe("bold");
		expect(root.querySelectorAll("em").length).toBe(2);
		expect(root.querySelector("del")?.textContent).toBe("old");
		expect(root.querySelector("code")?.textContent).toBe("a*b*<c>");
		expect(root.querySelector("br")).toBeTruthy();
	});

	it("links only https destinations with rel=noopener", () => {
		const root = parse(
			renderMarkdown(
				"[ok](https://example.com/a?b=1&c=2) [bad](javascript:alert(1)) [http](http://x.com) see https://auto.link/path.",
			),
		);
		const anchors = [...root.querySelectorAll("a")];
		expect(anchors.map((a) => a.getAttribute("href"))).toEqual([
			"https://example.com/a?b=1&c=2",
			"https://auto.link/path",
		]);
		for (const a of anchors) {
			expect(a.getAttribute("rel")).toBe("noopener noreferrer");
			expect(a.getAttribute("target")).toBe("_blank");
		}
		expect(root.textContent).toContain("[bad](javascript:alert(1))");
		expect(root.textContent).toContain("[http](http://x.com)");
	});

	it("lets the host extend the link policy for same-origin routes", () => {
		const root = parse(
			renderMarkdown("[order](/orders/1) [evil](//evil.com/x)", {
				link: (href) =>
					href.startsWith("/") && !href.startsWith("//")
						? href
						: safeMarkdownHref(href),
			}),
		);
		const anchors = [...root.querySelectorAll("a")];
		expect(anchors.length).toBe(1);
		expect(anchors[0]?.getAttribute("href")).toBe("/orders/1");
		expect(anchors[0]?.hasAttribute("target")).toBe(false);
	});

	it("drops images to their alt text", () => {
		const root = parse(renderMarkdown("see ![diagram](https://x/y.png) here"));
		expect(root.querySelector("img")).toBeNull();
		expect(root.textContent).toBe("see diagram here");
	});

	it("strips bidi controls from text and refuses them in hrefs", () => {
		const html = renderMarkdown(
			`report${RLO}txt.exe [f](https://e.com/a${RLO}b)`,
		);
		expect(html).not.toContain(RLO);
		expect(parse(html).textContent).toContain("reporttxt.exe");
		expect(stripBidiControls(`a${RLO}b‎`)).toBe("ab");
		expect(safeMarkdownHref(`https://e.com/${RLO}x`)).toBe("https://e.com/x");
		expect(safeMarkdownHref("http://e.com")).toBeNull();
		expect(safeMarkdownHref("HTTPS://E.com/p")).toBe("https://e.com/p");
	});

	it("renders streaming prefixes without throwing on unterminated syntax", () => {
		for (const partial of [
			"| a | b",
			"| a | b |\n| ---",
			"```ts\nconst",
			"**bo",
			"[li",
		]) {
			expect(() => renderMarkdown(partial)).not.toThrow();
		}
		expect(
			parse(renderMarkdown("```ts\nconst x")).querySelector("pre code")
				?.textContent,
		).toBe("const x");
	});
});

describe("bindMarkdownCopyButtons", () => {
	it("copies the sibling code and flips the label", async () => {
		const root = parse(
			renderMarkdown('```json\n{"a":1}\n```', { copyLabel: "Copy" }),
		);
		document.body.append(root);
		const write = vi.fn(() => Promise.resolve());
		const dispose = bindMarkdownCopyButtons(root, {
			write,
			copiedLabel: "Copied",
			resetAfterMs: 0,
		});
		const button = root.querySelector<HTMLButtonElement>("[data-md-copy]")!;
		button.click();
		await Promise.resolve();
		await Promise.resolve();
		expect(write).toHaveBeenCalledWith('{"a":1}');
		expect(button.textContent).toBe("Copied");
		dispose();
		button.click();
		expect(write).toHaveBeenCalledTimes(1);
	});
});

/**
 * The emphasis passes run over the whole string AFTER links are generated and
 * have no idea when they are inside an attribute. Underscores are ordinary in
 * real URLs — `__init__.py`, `__tests__`, `__pycache__` — so this produced a
 * live link pointing somewhere the author never wrote.
 */
describe("emphasis never rewrites a generated link", () => {
	const render = (source: string) =>
		renderMarkdown(source).replace(/ class="[^"]*"/g, "");

	it("keeps underscores and asterisks inside an href", () => {
		expect(render("[i](https://h/src/__init__.py)")).toContain(
			'href="https://h/src/__init__.py"',
		);
		expect(render("[t](https://h/a/_x_)")).toContain('href="https://h/a/_x_"');
		expect(render("[t](https://h/a/*x*)")).toContain('href="https://h/a/*x*"');
		expect(render("[i](https://h/src/__init__.py)")).not.toContain("<strong>");
	});

	/**
	 * `target="_blank"` also holds an underscore, so before the fix emphasis
	 * opened on the first anchor's target and closed on the second anchor's
	 * href, corrupting BOTH links from a single stray trailing underscore.
	 */
	it("cannot splice emphasis from one anchor's target into the next href", () => {
		const html = render("[a](https://e.com/p) and [b](https://e.com/q_)");
		expect(html).toContain('href="https://e.com/q_"');
		expect(html).not.toContain('target="<em>blank"');
		expect(html.match(/target="_blank"/g)?.length).toBe(2);
	});

	it("protects a bare autolink's visible text as well as its href", () => {
		// Otherwise the href is repaired while the label still reads
		// `.../src/<strong>init</strong>.py` — a link displaying a different
		// destination from the one it navigates to.
		const html = render("https://e.com/src/__init__.py");
		expect(html).toContain('href="https://e.com/src/__init__.py"');
		expect(html).toContain(">https://e.com/src/__init__.py<");
		expect(html).not.toContain("<strong>");
	});

	it("still formats emphasis inside link TEXT", () => {
		expect(render("[**bold** label](https://e.com/p)")).toContain(
			"<strong>bold</strong> label",
		);
	});

	it("leaves ordinary prose emphasis alone", () => {
		expect(render("plain **b** and _e_")).toContain("<strong>b</strong>");
		expect(render("plain **b** and _e_")).toContain("<em>e</em>");
	});
});
