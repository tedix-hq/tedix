import {
	type OsSharePreview,
	OsSharePreviewSchema,
} from "@tedix/api-contract/contracts/os-shares";

/**
 * Link previews for `/s/<id>`. Chat apps and social sites read the page's
 * Open Graph and Twitter tags before anyone opens the link, so the Worker
 * writes them into the share document on the server. apps/api decides what
 * a preview may name (only a link a signed-out stranger could open); every
 * other link gets the generic card. The image is one fixed picture with no
 * organization data, so it never leaks what a link holds.
 *
 * Typed against structural HTMLRewriter interfaces, like the WebMCP bridge
 * injection, so the Worker stays importable in the DOM-lib test lane where
 * the workerd global is absent and the rewrite degrades to a pass-through.
 */

export const SHARE_PREVIEW_IMAGE_PATH = "/images/share-preview.png";

const GENERIC_TITLE = "Shared on Tedix";
const GENERIC_DESCRIPTION = "Open the link to see what was shared with you.";

const RESOURCE_NOUN: Record<
	Extract<OsSharePreview, { kind: "content" }>["resourceType"],
	string
> = {
	output: "file",
	gadget: "app",
	workspace: "workspace",
};

function escapeAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function clip(value: string, max: number): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** The words a preview shows: the link's own, or the generic card's. */
export function sharePreviewText(preview: OsSharePreview): {
	title: string;
	description: string;
	siteName: string;
} {
	if (preview.kind === "generic")
		return {
			title: GENERIC_TITLE,
			description: GENERIC_DESCRIPTION,
			siteName: "Tedix",
		};
	const noun = RESOURCE_NOUN[preview.resourceType];
	return {
		title: clip(preview.title, 120),
		description: clip(
			preview.description?.trim() ||
				`A ${noun} shared by ${preview.organizationName} on Tedix.`,
			200,
		),
		siteName: clip(preview.organizationName, 80),
	};
}

/** The `<head>` tags for one share address. */
export function sharePreviewTags(
	preview: OsSharePreview,
	pageUrl: URL,
): string {
	const text = sharePreviewText(preview);
	const image = new URL(SHARE_PREVIEW_IMAGE_PATH, pageUrl.origin).toString();
	const url = new URL(pageUrl.pathname, pageUrl.origin).toString();
	const meta = (attribute: "name" | "property", key: string, value: string) =>
		`<meta ${attribute}="${key}" content="${escapeAttribute(value)}" />`;
	return [
		meta("name", "description", text.description),
		meta("property", "og:type", "website"),
		meta("property", "og:site_name", text.siteName),
		meta("property", "og:title", text.title),
		meta("property", "og:description", text.description),
		meta("property", "og:url", url),
		meta("property", "og:image", image),
		meta("property", "og:image:width", "1200"),
		meta("property", "og:image:height", "630"),
		meta("property", "og:image:alt", GENERIC_TITLE),
		meta("name", "twitter:card", "summary_large_image"),
		meta("name", "twitter:title", text.title),
		meta("name", "twitter:description", text.description),
		meta("name", "twitter:image", image),
	].join("");
}

type FetcherLike = {
	fetch(input: Request | string, init?: RequestInit): Promise<Response>;
};

/**
 * Ask apps/api what this address may show. Any failure, slow answer or
 * unexpected shape falls back to the generic card: a missing preview is
 * fine, a wrong one is not.
 */
export async function fetchSharePreview(
	api: FetcherLike | undefined,
	publicId: string,
	hostTenantId: string,
	timeoutMs = 1_500,
): Promise<OsSharePreview> {
	if (!api) return { kind: "generic" };
	try {
		const response = await api.fetch(
			new Request("https://api/os-shared/preview", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Tedix-Tenant-Id": hostTenantId,
				},
				body: JSON.stringify({ id: publicId }),
				signal: AbortSignal.timeout(timeoutMs),
			}),
		);
		if (!response.ok) return { kind: "generic" };
		const parsed = OsSharePreviewSchema.safeParse(await response.json());
		return parsed.success ? parsed.data : { kind: "generic" };
	} catch {
		return { kind: "generic" };
	}
}

interface ElementLike {
	setInnerContent(content: string): unknown;
	remove(): unknown;
	append(content: string, options?: { html: boolean }): unknown;
}

interface HtmlRewriterLike {
	on(
		selector: string,
		handlers: { element(element: ElementLike): void },
	): HtmlRewriterLike;
	transform(response: Response): Response;
}

type HtmlRewriterConstructor = new () => HtmlRewriterLike;

/**
 * Replace the shell's title and description with the preview's, and add the
 * Open Graph and Twitter tags. Headers, including `noindex` and `no-store`,
 * pass through untouched.
 */
export function injectSharePreview(
	response: Response,
	preview: OsSharePreview,
	pageUrl: URL,
): Response {
	const contentType = response.headers.get("Content-Type") ?? "";
	if (!contentType.toLowerCase().includes("text/html")) return response;
	const Rewriter = (globalThis as { HTMLRewriter?: HtmlRewriterConstructor })
		.HTMLRewriter;
	if (!Rewriter) return response;
	const title = sharePreviewText(preview).title;
	return new Rewriter()
		.on("head > title", {
			element(element) {
				element.setInnerContent(title);
			},
		})
		.on('head > meta[name="description"]', {
			element(element) {
				element.remove();
			},
		})
		.on("head", {
			element(element) {
				element.append(sharePreviewTags(preview, pageUrl), { html: true });
			},
		})
		.transform(response);
}
