import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fetchOsExportImage, inlineOsExportImages } from "./os-export-images";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("export image boundary", () => {
	it("inlines public HTTPS raster bytes without forwarding credentials", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response("raster", {
				headers: { "content-type": "image/jpeg; charset=binary" },
			}),
		);
		vi.stubGlobal("fetch", fetcher);
		expect(
			await fetchOsExportImage(
				"https://tedix.dev/images/founders/example.jpeg",
			),
		).toBe("data:image/jpeg;base64,cmFzdGVy");
		const init = fetcher.mock.calls[0]![1];
		expect(init.redirect).toBe("manual");
		expect(init.signal).toBeInstanceOf(AbortSignal);
		expect(new Headers(init.headers).has("authorization")).toBe(false);
		expect(new Headers(init.headers).has("cookie")).toBe(false);
	});
	it.each([
		"http://example.com/a.png",
		"https://127.0.0.1/a.png",
		"https://[::1]/a.png",
		"https://169.254.169.254/a",
		"https://api.tedix.dev/a",
		"https://foo.tedix.dev/a",
		"https://user:pass@example.com/a",
	])("blocks %s before fetching", async (url) => {
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		await expect(fetchOsExportImage(url)).rejects.toThrow();
		expect(fetcher).not.toHaveBeenCalled();
	});
	it.each([
		"https://localhost/a",
		"http://example.com/a",
		"https://api.tedix.dev/a",
	])("guards redirect to %s", async (url) => {
		const fetcher = vi
			.fn()
			.mockResolvedValue(
				new Response(null, { status: 302, headers: { location: url } }),
			);
		vi.stubGlobal("fetch", fetcher);
		await expect(fetchOsExportImage("https://example.com/a")).rejects.toThrow();
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it.each(["text/html", "application/octet-stream"])(
		"rejects content type %s",
		async (type) => {
			vi.stubGlobal(
				"fetch",
				vi
					.fn()
					.mockResolvedValue(
						new Response("body", { headers: { "content-type": type } }),
					),
			);
			await expect(fetchOsExportImage("https://example.com/a")).rejects.toThrow(
				/raster/,
			);
		},
	);
	it.each([true, false])(
		"caps bytes with declared length %s",
		async (declared) => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue(
					new Response(new Uint8Array(10 * 1024 * 1024 + 1), {
						headers: {
							"content-type": "image/png",
							...(declared ? { "content-length": "10485761" } : {}),
						},
					}),
				),
			);
			await expect(fetchOsExportImage("https://example.com/a")).rejects.toThrow(
				/10 MB/,
			);
		},
	);
	it("times out a stalled body", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("AbortSignal", {
			timeout: () => {
				const controller = new AbortController();
				setTimeout(() => controller.abort(), 10_000);
				return controller.signal;
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async (_url, init) =>
					new Response(
						new ReadableStream({
							start(controller) {
								init.signal.addEventListener("abort", () =>
									controller.error(new Error("timeout")),
								);
							},
						}),
						{ headers: { "content-type": "image/png" } },
					),
			),
		);
		const result = expect(
			fetchOsExportImage("https://example.com/a"),
		).rejects.toThrow("timeout");
		await vi.advanceTimersByTimeAsync(10_000);
		await result;
	});
	it("keeps uploaded slide data URIs, SVG included, without fetching", async () => {
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		const sources = [
			"data:image/png;base64,iVBORw0KGgo=",
			"data:image/svg+xml;base64,PHN2Zy8+",
		];
		const copy = await inlineOsExportImages({
			kind: "presentation",
			slides: [{ title: "Visuals", bullets: [] }],
			deck: {
				width: 1200,
				height: 675,
				activeSlideId: "one",
				slides: [
					{
						id: "one",
						name: "Visuals",
						layout: "blank",
						background: "#ffffff",
						elements: sources.map((src, index) => ({
							id: `visual-${index}`,
							type: index ? ("svg" as const) : ("image" as const),
							x: 0,
							y: 0,
							width: 100,
							height: 100,
							src,
							style: {},
						})),
					},
				],
			},
		});
		expect(
			copy.kind === "presentation" &&
				copy.deck?.slides[0]?.elements.map((element) => element.src),
		).toEqual(sources);
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("deduplicates document images and preserves the revision", async () => {
		const fetcher = vi
			.fn()
			.mockImplementation(() =>
				Promise.resolve(
					new Response("bytes", { headers: { "content-type": "image/png" } }),
				),
			);
		vi.stubGlobal("fetch", fetcher);
		const image = {
			type: "image" as const,
			attrs: { src: "https://example.com/a.png" },
		};
		const content = {
			kind: "document" as const,
			blocks: [],
			richText: { type: "doc" as const, content: [image, image] },
		};
		const copy = await inlineOsExportImages(content);
		expect(JSON.stringify(copy)).toContain("data:image/png;base64,");
		expect(image.attrs.src).toBe("https://example.com/a.png");
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
});

it("inlines self-contained SVG logos through the guarded image boundary", async () => {
	const svg =
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><path d="M0 0h100v40H0z" fill="#123456"/></svg>';
	vi.stubGlobal(
		"fetch",
		vi
			.fn()
			.mockResolvedValue(
				new Response(svg, { headers: { "content-type": "image/svg+xml" } }),
			),
	);
	expect(await fetchOsExportImage("https://example.org/logo.svg")).toContain(
		"data:image/svg+xml;base64,",
	);
});

it.each([
	"body",
	'<svg onload="alert(1)"/>',
	"<svg><script>alert(1)</script></svg>",
	'<svg><image href="https://example.org/a.png"/></svg>',
	'<svg><style>@import "https://example.org/a.css";</style></svg>',
	'<svg><rect fill="url(https://example.org/a.svg)"/></svg>',
])("rejects active or externally referenced SVG: %s", async (svg) => {
	vi.stubGlobal(
		"fetch",
		vi
			.fn()
			.mockResolvedValue(
				new Response(svg, { headers: { "content-type": "image/svg+xml" } }),
			),
	);
	await expect(
		fetchOsExportImage("https://example.org/logo.svg"),
	).rejects.toThrow("self-contained");
});

describe("inline export image validation", () => {
	const document = (src: string) => ({
		kind: "document" as const,
		blocks: [],
		richText: {
			type: "doc" as const,
			content: [{ type: "image", attrs: { src } }],
		},
	});

	it.each([
		'<svg onload="alert(1)"/>',
		"<svg><script>alert(1)</script></svg>",
		'<svg><image href="https://example.org/a.png"/></svg>',
		'<svg><rect fill="url(https://example.org/a.svg)"/></svg>',
	])("rejects embedded active SVG: %s", async (svg) => {
		for (const source of [
			`data:image/svg+xml;base64,${btoa(svg)}`,
			`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
		]) {
			await expect(inlineOsExportImages(document(source))).rejects.toThrow(
				"self-contained",
			);
		}
	});

	it.each([
		"data:image/png;base64,",
		"data:image/png;base64,%%%",
		"data:image/svg+xml;base64,Ym9keQ==",
	])("rejects empty, malformed or non-image data: %s", async (source) => {
		await expect(inlineOsExportImages(document(source))).rejects.toThrow();
	});

	it("caps decoded embedded bytes", async () => {
		const source = `data:image/png;base64,${Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64")}`;
		await expect(inlineOsExportImages(document(source))).rejects.toThrow(
			"10 MB",
		);
	});

	it.each([
		String.raw`<svg><style>rect { fill: u\72l(https://example.org/a.svg); }</style><rect/></svg>`,
		String.raw`<svg><rect style="fill: \75\000072 l(https://example.org/a.svg)"/></svg>`,
		String.raw`<svg><rect fill="U\52L('https://example.org/a.svg')"/></svg>`,
		String.raw`<svg><style>@\69mport 'https://example.org/a.css';</style></svg>`,
		'<svg><rect style="fill: u&#92;72l(https://example.org/a.svg)"/></svg>',
		'<svg><rect style="fill: u&#x5c;72l(https://example.org/a.svg)"/></svg>',
		'<svg><rect style="fill: &#117;rl(https://example.org/a.svg)"/></svg>',
	])(
		"rejects obfuscated CSS references in inline and fetched SVG: %s",
		async (svg) => {
			const fetcher = vi
				.fn()
				.mockImplementation(
					async () =>
						new Response(svg, { headers: { "content-type": "image/svg+xml" } }),
				);
			vi.stubGlobal("fetch", fetcher);
			for (const source of [
				`data:image/svg+xml;base64,${btoa(svg)}`,
				`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
				"https://example.org/logo.svg",
			]) {
				await expect(inlineOsExportImages(document(source))).rejects.toThrow(
					"self-contained",
				);
			}
			expect(fetcher).toHaveBeenCalledTimes(1);
		},
	);

	it.each([
		'<svg><defs><linearGradient id="paint"/></defs><rect fill="url(#paint)"/></svg>',
		`<svg><style>rect { fill: url( '#paint' ); }</style><defs><linearGradient id="paint"/></defs><rect style="filter: url(&quot;#blur&quot;)"/><filter id="blur"/></svg>`,
		'<svg><path id="shape"/><use href="#shape"/><text>&#71;r&#xfc;&#223;e &amp; hello</text></svg>',
	])("preserves self-contained inline and fetched SVG: %s", async (svg) => {
		const fetcher = vi
			.fn()
			.mockImplementation(
				async () =>
					new Response(svg, { headers: { "content-type": "image/svg+xml" } }),
			);
		vi.stubGlobal("fetch", fetcher);
		const data = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
		for (const source of [
			data,
			`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
		]) {
			const content = document(source);
			expect(await inlineOsExportImages(content)).toEqual(content);
		}
		expect(fetcher).not.toHaveBeenCalled();
		expect(await fetchOsExportImage("https://example.org/logo.svg")).toBe(data);
	});

	it("keeps valid percent-encoded SVG and binary image bytes without fetching", async () => {
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		for (const source of [
			`data:image/svg+xml;charset=utf-8,${encodeURIComponent("<svg><text>Grüße</text></svg>")}`,
			"data:image/png;,%89PNG%0D%0A%1A%0A",
		]) {
			const content = document(source);
			expect(await inlineOsExportImages(content)).toEqual(content);
		}
		expect(fetcher).not.toHaveBeenCalled();
	});
});
