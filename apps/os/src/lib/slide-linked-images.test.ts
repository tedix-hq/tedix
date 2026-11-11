import type { OsPresentationElement } from "@tedix/api-contract/schemas/os-workspaces";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createSlideLinkedImages } from "./slide-linked-images";

const link = "https://example.org/logo.png";
const embedded = "data:image/png;base64,AA==";
const element = (
	type: OsPresentationElement["type"],
	src?: string,
): OsPresentationElement => ({
	id: type,
	type,
	x: 0,
	y: 0,
	width: 100,
	height: 100,
	src,
	style: {},
});
function node() {
	const created = document.createElement("div");
	document.body.append(created);
	return created;
}
afterEach(() => document.body.replaceChildren());

describe("slide linked images", () => {
	it("shows the organization logo from its embedded copy and leaves the appearance alone", async () => {
		const read = vi.fn(async () => embedded);
		const linked = createSlideLinkedImages(document.body, read);
		const appearance = { name: "Example", logoUrl: link };
		const first = node();
		linked.element(first, element("logo"), appearance);
		const image = first.querySelector("img")!;
		expect(image.getAttribute("src")).toMatch(/^data:image\/gif/);
		expect(image.dataset.linkedState).toBe("loading");
		await vi.waitFor(() => expect(image.getAttribute("src")).toBe(embedded));
		expect(image.dataset.linkedState).toBeUndefined();
		// A later draw uses the copy at once.
		const second = node();
		linked.element(second, element("logo"), appearance);
		expect(second.querySelector("img")!.getAttribute("src")).toBe(embedded);
		expect(read).toHaveBeenCalledTimes(1);
		expect(appearance.logoUrl).toBe(link);
	});

	it("passes embedded images through and asks for nothing", () => {
		const read = vi.fn(async () => embedded);
		const linked = createSlideLinkedImages(document.body, read);
		const target = node();
		linked.element(target, element("image", embedded));
		expect(target.querySelector("img")!.getAttribute("src")).toBe(embedded);
		expect(target.querySelector("[data-linked-image]")).toBeNull();
		linked.element(target, element("image", "http://example.org/a.png"));
		expect(target.querySelector("img")).toBeNull();
		expect(read).not.toHaveBeenCalled();
	});

	it("marks an unreadable link, refuses an answer that is not an image, and retries on request", async () => {
		const read = vi
			.fn<(url: string) => Promise<string>>()
			.mockRejectedValueOnce(new Error("unreachable"))
			.mockResolvedValueOnce("https://example.org/not-embedded.png")
			.mockResolvedValue(embedded);
		const linked = createSlideLinkedImages(document.body, read);
		const target = node();
		linked.element(target, element("image", link));
		const image = target.querySelector("img")!;
		await vi.waitFor(() => expect(image.dataset.linkedState).toBe("failed"));
		// Drawing again does not ask again.
		linked.element(target, element("image", link));
		expect(read).toHaveBeenCalledTimes(1);
		expect(target.querySelector("img")!.dataset.linkedState).toBe("failed");
		linked.retry();
		await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
		await vi.waitFor(() =>
			expect(target.querySelector("img")!.dataset.linkedState).toBe("failed"),
		);
		expect(target.innerHTML).not.toContain("not-embedded");
		linked.retry();
		await vi.waitFor(() =>
			expect(target.querySelector("img")!.getAttribute("src")).toBe(embedded),
		);
	});
});
