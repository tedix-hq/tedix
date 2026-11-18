import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Env } from "./env";
import { imageTransformResponse } from "./tenant-media";

afterEach(() => vi.restoreAllMocks());
describe("native image transform proof", () => {
	it("attests output from the real Images binding chain", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("source", { headers: { "content-type": "image/png" } }),
		);
		const output = vi.fn(async () => ({
			response: () =>
				new Response("transformed", {
					headers: { "content-type": "image/webp" },
				}),
		}));
		const transform = vi.fn(() => ({ output }));
		const input = vi.fn(() => ({ transform }));
		const env = { IMAGES: { input } } as unknown as Env;
		const response = await imageTransformResponse(
			env,
			{ slug: "acme", publicPathPrefix: null, r2BucketName: "fictional-media" },
			"fictional-account",
			"fictional-token",
			new URL(
				"https://site.test/_image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fhero.png&w=64&f=webp",
			),
		);
		expect(transform).toHaveBeenCalledWith({ width: 64 });
		expect(output).toHaveBeenCalledWith(
			expect.objectContaining({ format: "image/webp" }),
		);
		expect(response?.headers.get("X-Tedix-Image-Transform")).toBe("images");
		expect(await response?.text()).toBe("transformed");
	});
});
