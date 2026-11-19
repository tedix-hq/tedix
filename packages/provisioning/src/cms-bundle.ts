export const COMPRESSED_CMS_BUNDLE_KEY = "__tedix_packed_bundle.json.gz";

export interface CmsBundle {
	mainModule: string;
	modules: Record<string, { js: string }>;
}

interface CmsBundleBucket {
	get(
		key: string,
	): Promise<{ body: ReadableStream<Uint8Array<ArrayBuffer>> } | null>;
}

/** Read the immutable bundle; loose modules are never activation inputs. */
export async function readCmsBundle(
	bucket: CmsBundleBucket,
	prefix: string,
	catalog?: { mainModule: string; modules: string[] },
): Promise<CmsBundle> {
	const object = await bucket.get(`${prefix}${COMPRESSED_CMS_BUNDLE_KEY}`);
	if (!object) throw new Error(`compressed bundle missing at ${prefix}`);
	let bundle: CmsBundle;
	try {
		bundle = (await new Response(
			object.body.pipeThrough(new DecompressionStream("gzip")),
		).json()) as CmsBundle;
	} catch (cause) {
		throw new Error(`compressed bundle unreadable at ${prefix}`, { cause });
	}
	if (
		!bundle ||
		typeof bundle.mainModule !== "string" ||
		!bundle.mainModule ||
		!bundle.modules ||
		Array.isArray(bundle.modules) ||
		typeof bundle.modules !== "object" ||
		!Object.hasOwn(bundle.modules, bundle.mainModule) ||
		typeof bundle.modules[bundle.mainModule]?.js !== "string" ||
		Object.values(bundle.modules).some(
			(module) => typeof module?.js !== "string",
		)
	)
		throw new Error(`malformed compressed bundle at ${prefix}`);
	if (
		catalog &&
		(bundle.mainModule !== catalog.mainModule ||
			JSON.stringify(Object.keys(bundle.modules).sort()) !==
				JSON.stringify([...catalog.modules].sort()))
	)
		throw new Error(
			`compressed bundle does not match the catalog at ${prefix}`,
		);
	return bundle;
}

/** Auth checks keep their byte limits even though modules share one object. */
export function readCmsBundleModule(
	bundle: CmsBundle,
	module: string,
	maxBytes: number,
): string | null {
	if (!Object.hasOwn(bundle.modules, module)) return null;
	const source = bundle.modules[module]!.js;
	return new TextEncoder().encode(source).byteLength <= maxBytes
		? source
		: null;
}
