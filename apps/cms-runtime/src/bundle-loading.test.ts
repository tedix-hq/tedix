import { describe, expect, test, vi } from "vite-plus/test";
import { loadBundleModules } from "./index";

const prefix = "acme/v1/";
const key = `${prefix}__tedix_packed_bundle.json.gz`;
const bundle = {
	mainModule: "entry.mjs",
	modules: {
		"entry.mjs": { js: "export default 1;" },
		"chunks/a.mjs": { js: "export const a = 2;" },
	},
};

async function gzip(value: unknown) {
	return new Response(
		new Blob([JSON.stringify(value)])
			.stream()
			.pipeThrough(new CompressionStream("gzip")),
	).arrayBuffer();
}

function store(compressed: ArrayBuffer | null) {
	const get = vi.fn(async (requested: string) => {
		if (requested === key)
			return compressed === null ? null : new Response(compressed);
		throw new Error(`Unexpected bundle read: ${requested}`);
	});
	const put = vi.fn();
	return { env: { TENANT_BUNDLES: { get, put } }, get, put };
}

describe("CMS compressed bundle loading", () => {
	test("loads all modules from one compressed object without writing", async () => {
		const { env, get, put } = store(await gzip(bundle));
		const spans: Record<string, number> = {};
		expect(await loadBundleModules(env as never, prefix, { spans })).toEqual(
			bundle,
		);
		expect(get).toHaveBeenCalledExactlyOnceWith(key);
		expect(put).not.toHaveBeenCalled();
		expect(spans["bundle.packedGzip"]).toBe(1);
	});

	test("fails explicitly when the compressed object is missing", async () => {
		const { env, get, put } = store(null);
		await expect(loadBundleModules(env as never, prefix)).rejects.toThrow(
			`compressed bundle missing at ${prefix}`,
		);
		expect(get).toHaveBeenCalledExactlyOnceWith(key);
		expect(put).not.toHaveBeenCalled();
	});

	test.each(["invalid gzip", "invalid JSON"])(
		"fails explicitly for %s",
		async (label) => {
			const bytes =
				label === "invalid gzip"
					? new Uint8Array([0, 1, 2]).buffer
					: await new Response(
							new Blob(["{"])
								.stream()
								.pipeThrough(new CompressionStream("gzip")),
						).arrayBuffer();
			const { env, get } = store(bytes);
			await expect(loadBundleModules(env as never, prefix)).rejects.toThrow(
				`compressed bundle unreadable at ${prefix}`,
			);
			expect(get).toHaveBeenCalledExactlyOnceWith(key);
		},
	);

	test.each([
		null,
		{},
		{ mainModule: "entry.mjs", modules: {} },
		{ mainModule: "entry.mjs", modules: { "entry.mjs": { js: 1 } } },
		{ ...bundle, modules: { ...bundle.modules, "chunks/a.mjs": null } },
	])("rejects a malformed bundle: %j", async (value) => {
		const { env, get } = store(await gzip(value));
		await expect(loadBundleModules(env as never, prefix)).rejects.toThrow(
			`malformed compressed bundle at ${prefix}`,
		);
		expect(get).toHaveBeenCalledExactlyOnceWith(key);
	});
});
