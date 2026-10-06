import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { prepareDocumentImage } from "./document-images";

function decodedImage(width: number, height: number, fail = false) {
	vi.stubGlobal(
		"Image",
		class {
			naturalWidth = width;
			naturalHeight = height;
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;
			set src(_value: string) {
				queueMicrotask(() => (fail ? this.onerror?.() : this.onload?.()));
			}
		},
	);
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("prepareDocumentImage", () => {
	it("keeps a small GIF unchanged so animation is preserved", async () => {
		decodedImage(200, 100);
		const image = await prepareDocumentImage(
			new File(["GIF89a"], "receipt.gif", { type: "image/gif" }),
		);
		expect(image).toEqual({
			src: "data:image/gif;base64,R0lGODlh",
			alt: "receipt",
			width: 200,
			height: 100,
		});
	});
	it("compresses a large screenshot and preserves its aspect ratio", async () => {
		decodedImage(4000, 2000);
		const draw = vi.fn();
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
			drawImage: draw,
		} as unknown as CanvasRenderingContext2D);
		vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
			"data:image/png;base64,YQ==",
		);
		const result = await prepareDocumentImage(
			new File([new Uint8Array(2_000_000)], "Screenshot.png", {
				type: "image/png",
			}),
		);
		expect(result).toMatchObject({
			width: 1600,
			height: 800,
			alt: "Screenshot",
		});
		expect(result.src.length).toBeLessThan(256 * 1024);
		expect(draw).toHaveBeenCalledWith(expect.anything(), 0, 0, 1600, 800);
	});
	it("converts small WebP to PNG for portable Word exports", async () => {
		decodedImage(100, 50);
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
			drawImage: vi.fn(),
		} as unknown as CanvasRenderingContext2D);
		const encode = vi
			.spyOn(HTMLCanvasElement.prototype, "toDataURL")
			.mockReturnValue("data:image/png;base64,YQ==");
		const result = await prepareDocumentImage(
			new File(["webp"], "Logo.webp", { type: "image/webp" }),
		);
		expect(result).toMatchObject({
			src: "data:image/png;base64,YQ==",
			width: 100,
			height: 50,
		});
		expect(encode).toHaveBeenCalledWith("image/png");
	});
	it("uses a white JPEG background when lossless PNG exceeds the byte budget", async () => {
		decodedImage(2000, 1000);
		const context = { drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: "" };
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
			context as unknown as CanvasRenderingContext2D,
		);
		vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(
			(type) =>
				type === "image/png"
					? "data:image/png;base64," + "x".repeat(256 * 1024)
					: "data:image/jpeg;base64,YQ==",
		);
		const result = await prepareDocumentImage(
			new File(["png"], "Large.png", { type: "image/png" }),
		);
		expect(result.src).toBe("data:image/jpeg;base64,YQ==");
		expect(context.fillStyle).toBe("#ffffff");
		expect(context.fillRect).toHaveBeenCalledWith(0, 0, 1600, 800);
		expect(context.drawImage).toHaveBeenCalledTimes(2);
	});
	it("reports unsupported and unreadable images", async () => {
		await expect(
			prepareDocumentImage(
				new File(["text"], "invoice.pdf", { type: "application/pdf" }),
			),
		).rejects.toThrow("PNG");
		decodedImage(0, 0, true);
		await expect(
			prepareDocumentImage(new File(["bad"], "bad.png", { type: "image/png" })),
		).rejects.toThrow("could not be opened");
	});
});
