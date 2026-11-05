import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { SharedFileBody } from "./shared-file-view";

const URL =
	"/api/os-shared/file/0e8f2c64-1b1a-4f53-9c51-6b0f1f0a7a11/out-1?sig=s";

function render(mimeType: string, filename = "fictional-file") {
	const host = document.createElement("div");
	host.innerHTML = renderToStaticMarkup(
		<SharedFileBody file={{ filename, mimeType, size: 3_500_000, url: URL }} />,
	);
	return host;
}

describe("SharedFileBody", () => {
	it("plays a video in a native player that can seek", () => {
		const host = render("video/mp4", "highlights.mp4");
		const video = host.querySelector("video");
		expect(video?.getAttribute("src")).toBe(URL);
		expect(video?.hasAttribute("controls")).toBe(true);
		expect(video?.getAttribute("preload")).toBe("metadata");
		expect(host.textContent).toContain("highlights.mp4 · 3.3 MB");
	});

	it("shows an image inline", () => {
		const host = render("image/png", "chart.png");
		expect(host.querySelector("img")?.getAttribute("src")).toBe(URL);
		expect(host.querySelector("img")?.getAttribute("alt")).toBe("chart.png");
		expect(host.querySelector("video")).toBeNull();
	});

	it("opens a PDF in a viewer", () => {
		const host = render("application/pdf", "brief.pdf");
		expect(host.querySelector("iframe")?.getAttribute("src")).toBe(URL);
	});

	it("offers anything else as a download with its name and size", () => {
		const host = render("application/octet-stream", "data.zip");
		expect(host.querySelector("video, img, iframe")).toBeNull();
		const download = host.querySelector("[data-shared-file-download]");
		expect(download?.getAttribute("href")).toBe(URL);
		expect(download?.getAttribute("download")).toBe("data.zip");
		expect(host.textContent).toContain("data.zip · 3.3 MB");
	});
});
