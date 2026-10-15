import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	centeredSlidePosition,
	fileToSlideImageSource,
	SLIDE_IMAGE_MAX_SOURCE,
	slideImageFile,
	slidePointFromClient,
} from "./slide-image-upload";

function decodedImage(width: number, height: number) {
	vi.stubGlobal(
		"Image",
		class {
			naturalWidth = width;
			naturalHeight = height;
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;
			set src(_value: string) {
				queueMicrotask(() => this.onload?.());
			}
		},
	);
}

function mockCanvas(encode: (type: string) => string) {
	const context = {
		drawImage: vi.fn(),
		clearRect: vi.fn(),
		fillRect: vi.fn(),
		fillStyle: "",
	};
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
		context as unknown as CanvasRenderingContext2D,
	);
	const toDataURL = vi
		.spyOn(HTMLCanvasElement.prototype, "toDataURL")
		.mockImplementation((type?: string) => encode(type ?? "image/png"));
	return { context, toDataURL };
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("fileToSlideImageSource", () => {
	it("keeps SVG verbatim without decoding it", async () => {
		const image = vi.fn();
		vi.stubGlobal("Image", image);
		const src = await fileToSlideImageSource(
			new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" }),
		);
		expect(src).toBe("data:image/svg+xml;base64,PHN2Zy8+");
		expect(image).not.toHaveBeenCalled();
	});

	it("keeps a small raster as uploaded so a GIF keeps its animation", async () => {
		decodedImage(200, 100);
		const { toDataURL } = mockCanvas(() => "data:image/png;base64,YQ==");
		const src = await fileToSlideImageSource(
			new File(["GIF89a"], "spin.gif", { type: "image/gif" }),
		);
		expect(src).toBe("data:image/gif;base64,R0lGODlh");
		expect(toDataURL).not.toHaveBeenCalled();
	});

	it("downscales a large PNG and keeps it a PNG", async () => {
		decodedImage(4000, 2000);
		const { context, toDataURL } = mockCanvas(
			() => "data:image/png;base64,YQ==",
		);
		const src = await fileToSlideImageSource(
			new File([new Uint8Array(10)], "chart.png", { type: "image/png" }),
		);
		expect(src).toBe("data:image/png;base64,YQ==");
		expect(toDataURL).toHaveBeenCalledWith("image/png");
		expect(context.drawImage).toHaveBeenCalledWith(
			expect.anything(),
			0,
			0,
			1920,
			960,
		);
		expect(context.fillRect).not.toHaveBeenCalled();
	});

	it("shrinks until the encoding fits the schema's 1.5 MB source cap", async () => {
		decodedImage(4000, 2000);
		let calls = 0;
		const { context } = mockCanvas(() =>
			calls++ === 0
				? `data:image/jpeg;base64,${"a".repeat(SLIDE_IMAGE_MAX_SOURCE)}`
				: "data:image/jpeg;base64,YQ==",
		);
		const src = await fileToSlideImageSource(
			new File([new Uint8Array(10)], "photo.jpg", { type: "image/jpeg" }),
		);
		expect(src).toBe("data:image/jpeg;base64,YQ==");
		expect(context.fillRect).toHaveBeenCalled();
		expect(context.drawImage).toHaveBeenLastCalledWith(
			expect.anything(),
			0,
			0,
			1440,
			720,
		);
	});

	it("rejects files that are not images", async () => {
		await expect(
			fileToSlideImageSource(
				new File(["x"], "notes.pdf", { type: "application/pdf" }),
			),
		).rejects.toThrow(/PNG, JPEG, GIF, WebP or SVG/);
	});

	it("rejects an SVG larger than the source cap", async () => {
		await expect(
			fileToSlideImageSource(
				new File(["a".repeat(SLIDE_IMAGE_MAX_SOURCE)], "big.svg", {
					type: "image/svg+xml",
				}),
			),
		).rejects.toThrow(/too large/);
	});
});

describe("slide image placement", () => {
	it("finds the first image in a drop or a clipboard paste", () => {
		const png = new File(["x"], "a.png", { type: "image/png" });
		const text = new File(["x"], "a.txt", { type: "text/plain" });
		expect(
			slideImageFile({
				files: [text, png] as unknown as FileList,
				items: [] as unknown as DataTransferItemList,
			}),
		).toBe(png);
		expect(
			slideImageFile({
				files: [] as unknown as FileList,
				items: [
					{ kind: "string", type: "text/plain", getAsFile: () => null },
					{ kind: "file", type: "image/png", getAsFile: () => png },
				] as unknown as DataTransferItemList,
			}),
		).toBe(png);
		expect(slideImageFile(null)).toBeNull();
	});

	it("maps a pointer to slide coordinates and keeps the box on the slide", () => {
		expect(
			slidePointFromClient(350, 150, {
				left: 50,
				top: 0,
				width: 600,
				height: 337.5,
			}),
		).toEqual({ x: 600, y: 300 });
		expect(
			centeredSlidePosition({ x: 600, y: 337.5 }, { width: 420, height: 260 }),
		).toEqual({ x: 390, y: 208 });
		expect(
			centeredSlidePosition({ x: 1190, y: 5 }, { width: 420, height: 260 }),
		).toEqual({ x: 780, y: 0 });
	});
});
