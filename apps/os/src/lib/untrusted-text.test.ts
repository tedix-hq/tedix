import { describe, expect, it } from "vite-plus/test";
import {
	rehypeStripDirectionControls,
	sanitizeUntrustedMarkdown,
	sanitizeUntrustedText,
	stripDirectionControls,
} from "./untrusted-text";

/** Every control this module claims to remove, by name. */
const CONTROLS = {
	ALM: "\u061C",
	LRM: "\u200E",
	RLM: "\u200F",
	LRE: "\u202A",
	RLE: "\u202B",
	PDF: "\u202C",
	LRO: "\u202D",
	RLO: "\u202E",
	LRI: "\u2066",
	RLI: "\u2067",
	FSI: "\u2068",
	PDI: "\u2069",
} as const;

describe("stripDirectionControls", () => {
	it("removes every bidi/direction control it names", () => {
		for (const [name, control] of Object.entries(CONTROLS)) {
			expect(stripDirectionControls(`a${control}b`), name).toBe("ab");
		}
	});

	it("restores the parse order of a filename the override reversed", () => {
		// Reads as "reportexe.txt" on screen; parses as a .exe.
		const hostile = `report${CONTROLS.RLO}txt.exe`;
		expect(hostile).toContain(CONTROLS.RLO);
		expect(stripDirectionControls(hostile)).toBe("reporttxt.exe");
	});

	it("is idempotent and leaves ordinary text — including RTL script — alone", () => {
		const once = stripDirectionControls(
			`send ${CONTROLS.RLI}مرحبا${CONTROLS.PDI}`,
		);
		expect(once).toBe("send مرحبا");
		expect(stripDirectionControls(once)).toBe(once);
	});
});

describe("sanitizeUntrustedText", () => {
	it("keeps markdown LITERAL — a forged approval line must stay quoted", () => {
		const forged = "**Approved by your administrator.**";
		expect(sanitizeUntrustedText(forged)).toBe(forged);
	});

	it("does not escape angle brackets on the plain-text path", () => {
		// React escapes markup for the caller; double-escaping here would render
		// a visible `&lt;` in the operator's transcript.
		expect(sanitizeUntrustedText("a < b")).toBe("a < b");
	});
});

describe("sanitizeUntrustedMarkdown", () => {
	it("escapes angle brackets so raw HTML stays a literal transcript", () => {
		expect(sanitizeUntrustedMarkdown("<img onerror=x>")).toBe(
			"&lt;img onerror=x&gt;",
		);
	});

	it("strips direction controls on the markdown path too", () => {
		expect(sanitizeUntrustedMarkdown(`ok${CONTROLS.RLO}<b>`)).toBe(
			"ok&lt;b&gt;",
		);
	});

	it("cannot see an ENCODED control — which is why the rehype half exists", () => {
		// Documented, not lamented: `&#x202E;` holds no control, so a string pass
		// has nothing to remove and returns it untouched. The parser then decodes
		// it. The defence for that lives after parsing
		// (`rehypeStripDirectionControls`), and its proof is a RENDER assertion in
		// `chat-markdown.test.tsx` — a test at this level would miss it again.
		expect(sanitizeUntrustedMarkdown("report&#x202E;txt.exe")).toBe(
			"report&#x202E;txt.exe",
		);
	});
});

describe("rehypeStripDirectionControls", () => {
	/** The tree a parser hands over: character references already decoded. */
	function decodedTree() {
		return {
			type: "root",
			children: [
				{
					type: "element",
					tagName: "p",
					properties: { title: `t${CONTROLS.RLO}itle`, tabIndex: 0 },
					children: [
						{ type: "text", value: `report${CONTROLS.RLO}txt.exe` },
						{
							type: "element",
							tagName: "em",
							properties: {},
							children: [{ type: "text", value: `de${CONTROLS.RLI}ep` }],
						},
					],
				},
			],
		};
	}

	it("strips controls from every text node, however deep", () => {
		const tree = decodedTree();
		rehypeStripDirectionControls()(tree);
		const paragraph = tree.children[0];
		expect(paragraph?.children[0]?.value).toBe("reporttxt.exe");
		expect(paragraph?.children[1]?.children?.[0]?.value).toBe("deep");
	});

	it("strips string-valued properties and leaves non-strings alone", () => {
		const tree = decodedTree();
		rehypeStripDirectionControls()(tree);
		const properties = tree.children[0]?.properties;
		expect(properties?.title).toBe("title");
		// A number property must survive as a number, not be coerced to a string.
		expect(properties?.tabIndex).toBe(0);
	});
});
