import {
	CatalogSnapshotSchema,
	type CatalogSnapshot,
} from "@tedix/api-contract/schemas/catalog-snapshot";
import { validateUrl } from "@tedix/ssrf-guard";

export function assertSnapshotCaptureUrl(url: string): string {
	const error = validateUrl(url);
	if (error) throw new Error(error);
	const parsed = new URL(url);
	if (parsed.username || parsed.password)
		throw new Error("Capture URLs cannot contain credentials");
	return parsed.origin;
}

/** Supplier code executes in an empty remote browser, never in the API isolate. */
export async function captureCatalogSnapshot(
	binding: CloudflareEnv["BROWSER"],
	url: string,
	expression: string,
): Promise<CatalogSnapshot> {
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
		const pending = page.evaluate(expression);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await Promise.race([
				pending,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("Catalog capture exceeded 60 seconds")),
						60_000,
					);
				}),
			]);
			const serialized = JSON.stringify(result);
			if (
				!serialized ||
				new TextEncoder().encode(serialized).length > 32 * 1024 * 1024
			)
				throw new Error("Catalog snapshot exceeds capture size limit");
			const validated = CatalogSnapshotSchema.safeParse(result);
			if (!validated.success) {
				const issues = validated.error.issues
					.slice(0, 5)
					.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
				throw new Error(
					`Invalid catalog snapshot (${validated.error.issues.length} issues): ${issues.join("; ")}`,
				);
			}
			return validated.data;
		} finally {
			if (timer) clearTimeout(timer);
		}
	} finally {
		await browser.close();
	}
}
