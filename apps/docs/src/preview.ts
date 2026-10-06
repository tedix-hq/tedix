import { getBuild, getSiteById } from "./registry";
import type { AppBindings } from "./types";

const CONTENT_TYPES: Record<string, string> = {
	".css": "text/css; charset=utf-8",
	".gif": "image/gif",
	".html": "text/html; charset=utf-8",
	".ico": "image/x-icon",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".txt": "text/plain; charset=utf-8",
	".webmanifest": "application/manifest+json",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".xml": "application/xml; charset=utf-8",
};

function candidatePaths(pathname: string): string[] {
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return [];
	}
	if (decoded.includes("\0") || decoded.split("/").includes("..")) return [];
	const path = decoded.replace(/^\/+/, "");
	if (!path) return ["index.html"];
	if (path.endsWith("/")) return [`${path}index.html`];
	if (path.endsWith(".md")) {
		if (path === "index/index.md") return [path, "index.md"];
		if (!path.endsWith("/index.md")) {
			return [path, `${path.slice(0, -".md".length)}/index.md`];
		}
		return [path];
	}
	if (path.includes(".")) return [path];
	return [path, `${path}/index.html`];
}

function contentType(path: string): string {
	const dot = path.lastIndexOf(".");
	return (
		CONTENT_TYPES[dot === -1 ? "" : path.slice(dot).toLowerCase()] ??
		"application/octet-stream"
	);
}

type DocsEntryPath = "/index" | "/readme";

async function getBuildEntryPath(
	bucket: R2Bucket,
	siteId: string,
	buildId: string,
): Promise<DocsEntryPath | null> {
	const manifest = await bucket.get(
		`sites/${siteId}/builds/${buildId}/manifest.json`,
	);
	if (!manifest) return null;
	try {
		const metadata = await manifest.json<{ entryPath?: DocsEntryPath }>();
		return metadata.entryPath === "/index" || metadata.entryPath === "/readme"
			? metadata.entryPath
			: null;
	} catch {
		return null;
	}
}

export function rewritePreviewHtml(html: string, buildId: string): string {
	const prefix = `/preview/${buildId}/`;
	return html.replace(
		/((?:href|src)=["'])\/(?!\/)/g,
		(_match, attribute: string) => `${attribute}${prefix}`,
	);
}

export const DOCS_PREVIEW_ROBOTS_POLICY = "noindex, nofollow, noarchive";

export function withDocsPreviewRobotsPolicy(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.set("X-Robots-Tag", DOCS_PREVIEW_ROBOTS_POLICY);
	return new Response(response.body, {
		headers,
		status: response.status,
		statusText: response.statusText,
	});
}

export async function serveDocsPreview(input: {
	buildId: string;
	env: AppBindings;
	orgSlug: string;
	pathname: string;
	request: Request;
}): Promise<Response> {
	const build = await getBuild(input.env.DB, input.buildId);
	if (build?.status !== "complete") {
		return new Response("Documentation preview is not ready", { status: 404 });
	}
	const site = await getSiteById(input.env.DB, build.siteId);
	if (!site || site.orgSlug !== input.orgSlug) {
		return new Response("Documentation preview not found", { status: 404 });
	}
	const mightBeEntryAlias = [
		"/index",
		"/index/",
		"/readme",
		"/readme/",
	].includes(input.pathname);
	const entryPath = mightBeEntryAlias
		? await getBuildEntryPath(input.env.DOCS_BUILDS, site.id, build.id)
		: null;
	if (
		entryPath &&
		(input.pathname === entryPath || input.pathname === `${entryPath}/`)
	) {
		const requestUrl = new URL(input.request.url);
		requestUrl.pathname = `/preview/${build.id}/`;
		return new Response(null, {
			status: 308,
			headers: {
				"Cache-Control": "private, no-store",
				Location: requestUrl.toString(),
				"Referrer-Policy": "no-referrer",
				"X-Robots-Tag": DOCS_PREVIEW_ROBOTS_POLICY,
			},
		});
	}
	for (const path of candidatePaths(input.pathname)) {
		const object = await input.env.DOCS_BUILDS.get(
			`sites/${site.id}/builds/${build.id}/${path}`,
		);
		if (!object) continue;
		const headers = new Headers({
			"Cache-Control": "private, no-store",
			"Content-Type": contentType(path),
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
			"X-Robots-Tag": "noindex, nofollow, noarchive",
			"X-Tedix-Docs-Preview": build.id,
		});
		object.writeHttpMetadata(headers);
		if (path.endsWith(".html")) {
			const body =
				input.request.method === "HEAD"
					? null
					: rewritePreviewHtml(await object.text(), build.id);
			return new Response(body, { headers });
		}
		return new Response(input.request.method === "HEAD" ? null : object.body, {
			headers,
		});
	}
	return new Response("Not Found", { status: 404 });
}
