import { describe, expect, it } from "vite-plus/test";
import {
	checkOsWorkspaceIcon,
	decodeOsWorkspaceIcon,
	unsafeSvgReason,
} from "./os-workspace-icon";

const svg = (body: string, attrs = "") =>
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"${attrs}>${body}</svg>`;
const bytes = (text: string) => new TextEncoder().encode(text);

describe("unsafeSvgReason", () => {
	it("accepts a plain single-colour brand icon", () => {
		expect(
			unsafeSvgReason(
				`<?xml version="1.0" encoding="UTF-8"?>\n<!-- logo -->\n${svg(
					'<title>Example</title><path fill="#FF4500" d="M12 0A12 12 0 1 0 24 12 12 12 0 0 0 12 0z"/>',
					' role="img"',
				)}`,
			),
		).toBeNull();
	});

	it("accepts gradients and internal references", () => {
		expect(
			unsafeSvgReason(
				svg(
					'<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="24" height="24" fill="url(#g)" style="fill: url(\'#g\')"/><use xlink:href="#g"/>',
					' xmlns:xlink="http://www.w3.org/1999/xlink"',
				),
			),
		).toBeNull();
	});

	it.each([
		["a script element", svg("<script>alert(1)</script>")],
		["an uppercase script element", svg("<SCRIPT>alert(1)</SCRIPT>")],
		["an event handler", svg('<path d="M0 0" onload="alert(1)"/>')],
		["an event handler on the root", svg("", ' onclick="alert(1)"')],
		[
			"embedded HTML",
			svg(
				'<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>',
			),
		],
		[
			"a javascript link",
			svg('<a href="javascript:alert(1)"><path d="M0 0"/></a>'),
		],
		[
			"an external use reference",
			svg('<use href="https://evil.example/x.svg#a"/>'),
		],
		[
			"an encoded javascript href",
			svg('<use href="&#106;avascript:alert(1)"/>'),
		],
		["an external image", svg('<image href="https://evil.example/a.png"/>')],
		[
			"a style element",
			svg("<style>@import url(https://evil.example/a.css);</style>"),
		],
		[
			"an external CSS url",
			svg('<rect style="fill:url(https://evil.example/a)"/>'),
		],
		[
			"an entity-encoded CSS url",
			svg('<rect style="fill:u&#114;l(https://evil.example/a)"/>'),
		],
		["a data URL attribute", svg('<rect fill="data:text/html,x"/>')],
		[
			"an animation that rewrites href",
			svg('<set attributeName="href" to="javascript:alert(1)"/>'),
		],
		["a DOCTYPE with entities", `<!DOCTYPE svg [<!ENTITY x "y">]>${svg("")}`],
		["CDATA", svg("<![CDATA[<script>alert(1)</script>]]>")],
		[
			"a processing instruction",
			svg('<?xml-stylesheet href="https://evil.example/a.css"?>'),
		],
		["an HTML root", "<html><body><svg/></body></html>"],
		[
			"a rebound default namespace",
			'<svg xmlns="http://www.w3.org/1999/xhtml"><title>x</title></svg>',
		],
		[
			"a foreign namespace",
			svg("", ' xmlns:ev="http://www.w3.org/2001/xml-events"'),
		],
		["an unknown character reference", svg('<path d="&nbsp;"/>')],
		["an unclosed element", '<svg xmlns="http://www.w3.org/2000/svg"><g>'],
		["mismatched tags", svg("<g></path>")],
		["trailing content", `${svg("")}<script>alert(1)</script>`],
		["unquoted attributes", "<svg onload=alert(1)>"],
		["no root", "just text"],
	])("rejects %s", (_label, source) => {
		expect(unsafeSvgReason(source)).toEqual(expect.any(String));
	});
});

describe("checkOsWorkspaceIcon", () => {
	it("accepts raster images whose bytes match their type", () => {
		const png = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0,
		]);
		const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]);
		const webp = bytes("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ");
		expect(checkOsWorkspaceIcon(png, "image/png").ok).toBe(true);
		expect(checkOsWorkspaceIcon(jpeg, "image/jpeg").ok).toBe(true);
		expect(checkOsWorkspaceIcon(webp, "image/webp").ok).toBe(true);
	});

	it("rejects bytes that do not match the declared type", () => {
		const html = bytes("<html><script>alert(1)</script></html>");
		expect(checkOsWorkspaceIcon(html, "image/png").ok).toBe(false);
		expect(checkOsWorkspaceIcon(html, "image/jpeg").ok).toBe(false);
		expect(checkOsWorkspaceIcon(html, "image/webp").ok).toBe(false);
		expect(checkOsWorkspaceIcon(html, "image/svg+xml").ok).toBe(false);
	});

	it("rejects empty and oversized files", () => {
		expect(checkOsWorkspaceIcon(new Uint8Array(), "image/png").ok).toBe(false);
		const big = new Uint8Array(1024 * 1024 + 1);
		big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		expect(checkOsWorkspaceIcon(big, "image/png")).toEqual({
			ok: false,
			reason: "The image must be 1 MB or smaller",
		});
	});

	it("rejects SVG that is not UTF-8", () => {
		expect(
			checkOsWorkspaceIcon(new Uint8Array([0x3c, 0xff, 0xfe]), "image/svg+xml")
				.ok,
		).toBe(false);
	});
});

describe("decodeOsWorkspaceIcon", () => {
	it("decodes base64 and rejects anything else", () => {
		expect(decodeOsWorkspaceIcon(btoa("abc"))).toEqual(bytes("abc"));
		expect(decodeOsWorkspaceIcon("not base64!")).toBeNull();
	});
});
