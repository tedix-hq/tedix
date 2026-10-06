export interface RuntimeDocsSite {
	id: string;
	orgSlug: string;
	slug: string;
	status: "active" | "paused";
	accessMode: "public" | "organization";
	activeBuildId: string | null;
	descopeTenantId: string | null;
}

type DocsEntryPath = "/index" | "/readme";

interface RuntimeDocsManifest {
	entryPath?: DocsEntryPath;
}

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
	".mdx": "text/markdown; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".txt": "text/plain; charset=utf-8",
	".webmanifest": "application/manifest+json",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".xml": "application/xml; charset=utf-8",
};

export function resolveSiteSlug(
	hostname: string,
	baseDomain: string,
	rootSiteSlug: string,
	hostAliases: Readonly<Record<string, string>> = {},
): string | null {
	const normalizedHost = hostname.toLowerCase();
	const normalizedBase = baseDomain.toLowerCase();
	const alias = hostAliases[normalizedHost];
	if (alias) return alias;
	if (normalizedHost === normalizedBase) return rootSiteSlug;
	const suffix = `.${normalizedBase}`;
	if (!normalizedHost.endsWith(suffix)) return null;
	const slug = normalizedHost.slice(0, -suffix.length);
	if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) return null;
	return slug;
}

export function parseHostAliases(value: string): Record<string, string> {
	const aliases: unknown = JSON.parse(value);
	if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) {
		throw new Error("DOCS_HOST_ALIASES must be a JSON object");
	}
	return Object.fromEntries(
		Object.entries(aliases).map(([hostname, slug]) => {
			if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
				throw new Error(`Invalid Docs site slug for host alias ${hostname}`);
			}
			return [hostname.toLowerCase(), slug];
		}),
	);
}

export function contentTypeFor(path: string): string {
	const index = path.lastIndexOf(".");
	const extension = index === -1 ? "" : path.slice(index).toLowerCase();
	return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

export function candidateObjectPaths(pathname: string): string[] {
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

export function buildObjectKey(
	site: Pick<RuntimeDocsSite, "id" | "activeBuildId">,
	path: string,
): string {
	if (!site.activeBuildId) throw new Error("Site has no active build");
	return `sites/${site.id}/builds/${site.activeBuildId}/${path}`;
}

async function getBuildEntryPath(
	bucket: R2Bucket,
	site: Pick<RuntimeDocsSite, "id" | "activeBuildId">,
): Promise<DocsEntryPath | null> {
	const object = await bucket.get(buildObjectKey(site, "manifest.json"));
	if (!object) return null;
	try {
		const manifest = await object.json<RuntimeDocsManifest>();
		return manifest.entryPath === "/index" || manifest.entryPath === "/readme"
			? manifest.entryPath
			: null;
	} catch {
		return null;
	}
}

export function isSelectedEntryAlias(
	pathname: string,
	entryPath: DocsEntryPath | null,
): boolean {
	return (
		entryPath !== null &&
		(pathname === entryPath || pathname === `${entryPath}/`)
	);
}

export function responseHeaders(
	object: Pick<R2Object, "httpEtag" | "writeHttpMetadata">,
	path: string,
	buildId: string,
	accessMode: RuntimeDocsSite["accessMode"],
): Headers {
	const headers = new Headers();
	object.writeHttpMetadata(headers);
	if (!headers.has("Content-Type")) {
		headers.set("Content-Type", contentTypeFor(path));
	}
	headers.set("ETag", object.httpEtag);
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
	headers.set("X-Tedix-Docs-Build", buildId);
	if (accessMode === "organization") {
		headers.set("Cache-Control", "private, no-store");
		headers.set("Vary", "Cookie, Authorization");
		headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
	} else {
		headers.set(
			"Cache-Control",
			path.startsWith("_astro/") || path.includes("/_astro/")
				? "public, max-age=31536000, immutable"
				: "public, max-age=60, stale-while-revalidate=300",
		);
	}
	return headers;
}

export async function serveDocsSite(
	request: Request,
	bucket: R2Bucket,
	site: RuntimeDocsSite,
): Promise<Response> {
	if (site.status !== "active") {
		return new Response("Documentation site is paused", { status: 503 });
	}
	if (!site.activeBuildId) {
		return new Response("Documentation site has not been published yet", {
			status: 404,
		});
	}

	const url = new URL(request.url);
	if (
		["/index", "/index/", "/readme", "/readme/"].includes(url.pathname) &&
		isSelectedEntryAlias(url.pathname, await getBuildEntryPath(bucket, site))
	) {
		url.pathname = "/";
		return new Response(null, {
			status: 308,
			headers: { "Cache-Control": "no-store", Location: url.toString() },
		});
	}
	for (const path of candidateObjectPaths(url.pathname)) {
		const object = await bucket.get(buildObjectKey(site, path));
		if (!object) continue;
		const headers = responseHeaders(
			object,
			path,
			site.activeBuildId,
			site.accessMode,
		);
		if (request.headers.get("If-None-Match") === object.httpEtag) {
			return new Response(null, { status: 304, headers });
		}
		return new Response(request.method === "HEAD" ? null : object.body, {
			headers,
		});
	}

	const notFound = await bucket.get(buildObjectKey(site, "404.html"));
	if (notFound) {
		const headers = responseHeaders(
			notFound,
			"404.html",
			site.activeBuildId,
			site.accessMode,
		);
		if (site.accessMode === "public") {
			headers.set("Cache-Control", "public, max-age=30");
		}
		return new Response(request.method === "HEAD" ? null : notFound.body, {
			status: 404,
			headers,
		});
	}
	return new Response("Not Found", { status: 404 });
}
