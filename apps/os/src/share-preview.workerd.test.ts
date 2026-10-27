/**
 * The share preview rewrite in a REAL workerd isolate, where HTMLRewriter
 * exists: the tags land in <head>, the shell's own title and description
 * give way, values are escaped, and the stamped headers survive.
 */
import { describe, expect, it } from "vite-plus/test";
import { injectSharePreview } from "./share-preview";

const SHELL_HTML =
	'<!doctype html><html><head><meta charset="utf-8"><meta name="description" content="Tedix OS"><title>Tedix OS</title></head><body><div id="root"></div></body></html>';

function shell(): Response {
	return new Response(SHELL_HTML, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"X-Robots-Tag": "noindex, nofollow, noarchive",
			"Cache-Control": "private, no-store",
		},
	});
}

const PAGE = new URL(
	"https://acme.os.tedix.dev/s/AbCdEfGhIjKlMnOpQrStUv/launch?utm=x",
);

describe("injectSharePreview (workerd)", () => {
	it("writes the link's own title and description for an open link", async () => {
		const result = injectSharePreview(
			shell(),
			{
				kind: "content",
				title: 'Launch "brief" <draft>',
				description: null,
				resourceType: "output",
				organizationName: "Example Co",
			},
			PAGE,
		);
		const html = await result.text();
		const head = html.slice(0, html.indexOf("</head>"));
		expect(head).toContain(
			'<meta property="og:title" content="Launch &quot;brief&quot; &lt;draft&gt;" />',
		);
		expect(head).toContain(
			'<meta property="og:description" content="A file shared by Example Co on Tedix." />',
		);
		expect(head).toContain(
			'<meta property="og:site_name" content="Example Co" />',
		);
		expect(head).toContain(
			'<meta property="og:url" content="https://acme.os.tedix.dev/s/AbCdEfGhIjKlMnOpQrStUv/launch" />',
		);
		expect(head).toContain(
			'<meta property="og:image" content="https://acme.os.tedix.dev/images/share-preview.png" />',
		);
		expect(head).toContain(
			'<meta name="twitter:card" content="summary_large_image" />',
		);
		expect(head).toContain('<title>Launch "brief" &lt;draft&gt;</title>');
		// The shell's own description is replaced, not duplicated.
		expect(head).not.toContain('content="Tedix OS"');
		expect(result.headers.get("X-Robots-Tag")).toContain("noindex");
		expect(result.headers.get("Cache-Control")).toBe("private, no-store");
	});

	it("shows only the generic card for anything else", async () => {
		const html = await injectSharePreview(
			shell(),
			{ kind: "generic" },
			PAGE,
		).text();
		expect(html).toContain(
			'<meta property="og:title" content="Shared on Tedix" />',
		);
		expect(html).toContain('<meta property="og:site_name" content="Tedix" />');
		expect(html).toContain("<title>Shared on Tedix</title>");
		expect(html).not.toContain("Example");
	});
});
