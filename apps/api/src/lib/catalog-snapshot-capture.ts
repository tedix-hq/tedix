import {
	CatalogSnapshotManifestSchema,
	CatalogSnapshotPartSchema,
	type CatalogSnapshotItem,
	type CatalogSnapshotManifest,
} from "@tedix/api-contract/schemas/catalog-snapshot";
import {
	SNAPSHOT_PART_SIZE,
	snapshotPartCount,
} from "../workflows/catalog-snapshot-parts";
import { validateUrl } from "@tedix/ssrf-guard";

export function assertSnapshotCaptureUrl(url: string): string {
	const error = validateUrl(url);
	if (error) throw new Error(error);
	const parsed = new URL(url);
	if (parsed.username || parsed.password)
		throw new Error("Capture URLs cannot contain credentials");
	return parsed.origin;
}

type SnapshotPartSink = (
	part: number,
	items: CatalogSnapshotItem[],
) => Promise<void>;

function describeIssues(issues: { path: PropertyKey[]; message: string }[]) {
	return `(${issues.length} issues): ${issues
		.slice(0, 5)
		.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
		.join("; ")}`;
}

/**
 * Run the supplier expression once, keep its result in the page, and read the
 * listings out in bounded parts. A large directory does not fit in one browser
 * message (32 MiB) or comfortably in the API isolate, so it is never moved or
 * held whole.
 */
export async function readSnapshotParts(
	evaluate: (script: string) => Promise<unknown>,
	expression: string,
	onPart: SnapshotPartSink,
): Promise<CatalogSnapshotManifest> {
	const declared = CatalogSnapshotManifestSchema.safeParse(
		await evaluate(`(async () => {
	const snapshot = await (${expression});
	globalThis.__catalogSnapshot = snapshot;
	return {
		expectedSourceCount: snapshot?.expectedSourceCount,
		capturedSourceCount: snapshot?.capturedSourceCount,
		itemCount: Array.isArray(snapshot?.items) ? snapshot.items.length : 0,
	};
})()`),
	);
	if (!declared.success)
		throw new Error(
			`Invalid catalog snapshot ${describeIssues(declared.error.issues)}`,
		);
	const manifest = declared.data;
	const seen = new Set<string>();
	for (let part = 0; part < snapshotPartCount(manifest.itemCount); part++) {
		const offset = part * SNAPSHOT_PART_SIZE;
		const parsed = CatalogSnapshotPartSchema.safeParse(
			await evaluate(
				`globalThis.__catalogSnapshot.items.slice(${offset}, ${offset + SNAPSHOT_PART_SIZE})`,
			),
		);
		if (!parsed.success)
			throw new Error(
				`Invalid catalog snapshot part ${part} ${describeIssues(parsed.error.issues)}`,
			);
		const expected = Math.min(SNAPSHOT_PART_SIZE, manifest.itemCount - offset);
		if (parsed.data.length !== expected)
			throw new Error(
				`Catalog snapshot part ${part} has ${parsed.data.length} listings, expected ${expected}`,
			);
		for (const item of parsed.data) {
			const key = JSON.stringify([item.source, item.sourceAppId]);
			if (seen.has(key)) throw new Error(`Duplicate store listing: ${key}`);
			seen.add(key);
		}
		await onPart(part, parsed.data);
	}
	return manifest;
}

/** Supplier code executes in an empty remote browser, never in the API isolate. */
export async function captureCatalogSnapshot(
	binding: CloudflareEnv["BROWSER"],
	url: string,
	expression: string,
	onPart: SnapshotPartSink,
): Promise<CatalogSnapshotManifest> {
	const origin = assertSnapshotCaptureUrl(url);
	const { default: puppeteer } = await import("@cloudflare/puppeteer");
	const browser = await puppeteer.launch(binding);
	try {
		const page = await browser.newPage();
		await page.setRequestInterception(true);
		page.on("request", (request) => {
			const target = request.url();
			if (target.startsWith("data:") || target.startsWith("blob:")) {
				void request.continue();
				return;
			}
			try {
				if (assertSnapshotCaptureUrl(target) === origin) {
					void request.continue();
					return;
				}
			} catch {
				/* Fail closed for cross-origin and private requests. */
			}
			void request.abort();
		});
		await page.goto(url, { waitUntil: "networkidle0", timeout: 60_000 });
		return await readSnapshotParts(
			async (script) => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					return await Promise.race([
						page.evaluate(script),
						new Promise<never>((_, reject) => {
							timer = setTimeout(
								() => reject(new Error("Catalog capture exceeded 60 seconds")),
								60_000,
							);
						}),
					]);
				} finally {
					if (timer) clearTimeout(timer);
				}
			},
			expression,
			onPart,
		);
	} finally {
		await browser.close();
	}
}
