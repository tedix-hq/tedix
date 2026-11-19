import { describe, expect, it, vi } from "vite-plus/test";
import { readCmsBundle, readCmsBundleModule } from "./cms-bundle";

const prefix = "acme/v1/";
const bundle = {
	mainModule: "entry.mjs",
	modules: {
		"entry.mjs": { js: "export default {};" },
		"chunks/auth.mjs": { js: "é" },
	},
};

async function gzip(text: string): Promise<Uint8Array<ArrayBuffer>> {
	return new Uint8Array(
		await new Response(
			new Blob([text]).stream().pipeThrough(new CompressionStream("gzip")),
		).arrayBuffer(),
	);
}

function bucket(bytes: Uint8Array | null) {
	return {
		get: vi.fn(async () =>
			bytes === null
				? null
				: { body: new Blob([Uint8Array.from(bytes)]).stream() },
		),
	};
}

describe("CMS compressed bundle reader", () => {
	it("reads one pack and matches its catalog independent of key order", async () => {
		const store = bucket(await gzip(JSON.stringify(bundle)));
		await expect(
			readCmsBundle(store, prefix, {
				mainModule: "entry.mjs",
				modules: ["chunks/auth.mjs", "entry.mjs"],
			}),
		).resolves.toEqual(bundle);
		expect(store.get).toHaveBeenCalledExactlyOnceWith(
			`${prefix}__tedix_packed_bundle.json.gz`,
		);
	});

	it("fails without reading loose objects when the pack is missing", async () => {
		const store = bucket(null);
		await expect(readCmsBundle(store, prefix)).rejects.toThrow(
			"compressed bundle missing",
		);
		expect(store.get).toHaveBeenCalledOnce();
	});

	it.each(["invalid gzip", "invalid JSON"])(
		"rejects unreadable data",
		async (format) => {
			const bytes =
				format === "invalid gzip" ? new Uint8Array([0, 1, 2]) : await gzip("{");
			await expect(readCmsBundle(bucket(bytes), prefix)).rejects.toThrow(
				"compressed bundle unreadable",
			);
		},
	);

	it.each([
		null,
		{},
		{ mainModule: "entry.mjs", modules: [] },
		{ ...bundle, mainModule: "missing.mjs" },
		{ ...bundle, modules: { "entry.mjs": { js: 1 } } },
		{ ...bundle, modules: { ...bundle.modules, "extra.mjs": null } },
	])("rejects malformed data: %j", async (value) => {
		await expect(
			readCmsBundle(bucket(await gzip(JSON.stringify(value))), prefix),
		).rejects.toThrow("malformed compressed bundle");
	});

	it.each([
		{ mainModule: "chunks/auth.mjs", modules: Object.keys(bundle.modules) },
		{ mainModule: "entry.mjs", modules: ["entry.mjs"] },
		{
			mainModule: "entry.mjs",
			modules: [...Object.keys(bundle.modules), "extra.mjs"],
		},
	])("rejects catalog drift: %j", async (catalog) => {
		await expect(
			readCmsBundle(
				bucket(await gzip(JSON.stringify(bundle))),
				prefix,
				catalog,
			),
		).rejects.toThrow("compressed bundle does not match the catalog");
	});

	it("enforces module byte limits and rejects names outside the pack", () => {
		expect(readCmsBundleModule(bundle, "chunks/auth.mjs", 1)).toBeNull();
		expect(readCmsBundleModule(bundle, "chunks/auth.mjs", 2)).toBe("é");
		expect(readCmsBundleModule(bundle, "missing.mjs", 100)).toBeNull();
		expect(readCmsBundleModule(bundle, "toString", 100)).toBeNull();
	});
});
