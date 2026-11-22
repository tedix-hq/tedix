export const COMPRESSED_CMS_BUNDLE_KEY = "__tedix_packed_bundle.json.gz";

export interface CmsBundle {
	mainModule: string;
	modules: Record<string, { js: string }>;
}

/** Compress one module at a time; whole-bundle JSON copies exceed Worker memory. */
export async function compressCmsBundle(
	mainModule: string,
	modules: string[],
	read: (path: string) => Promise<string>,
): Promise<ArrayBuffer> {
	const encoder = new TextEncoder();
	let index = -1;
	const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
		async pull(controller) {
			if (index === -1) {
				controller.enqueue(
					encoder.encode(
						`{"mainModule":${JSON.stringify(mainModule)},"modules":{`,
					),
				);
			} else if (index < modules.length) {
				const path = modules[index]!;
				controller.enqueue(
					encoder.encode(
						`${index ? "," : ""}${JSON.stringify(path)}:${JSON.stringify({ js: await read(path) })}`,
					),
				);
			} else {
				controller.enqueue(encoder.encode("}}"));
				controller.close();
			}
			index++;
		},
	});
	return new Response(
		stream.pipeThrough(new CompressionStream("gzip")),
	).arrayBuffer();
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
