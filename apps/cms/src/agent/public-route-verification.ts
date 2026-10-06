import { validateUrl } from "@tedix/ssrf-guard";

/** Bounded public-page proof for a CMS site's configured canonical URL. */
export interface PublicCmsRouteExpectation {
	path: string;
	expectedLang?: string;
	expectedTitle?: string;
	expectedTitleContains?: string;
	forbiddenTitle?: string;
}

export interface PublicCmsRouteResult {
	path: string;
	url: string;
	status: number | null;
	ok: boolean;
	title: string | null;
	h1: string | null;
	canonical: string | null;
	lang: string | null;
	error?: string;
}

export interface PublicCmsRouteVerification {
	ok: boolean;
	checkedAt: string;
	origin: string;
	routes: PublicCmsRouteResult[];
}

const MAX_ROUTES = 8;
const MAX_HTML_BYTES = 1_000_000;

function configuredBase(raw: string): URL {
	const authority = raw.match(/^https:\/\/([^/?#]+)/)?.[1] ?? "";
	if (raw.includes("%") || raw.includes("\\") || raw.includes("..")) {
		throw new Error("CMS canonical URL contains an unsafe path or encoding");
	}
	const url = new URL(raw);
	const host = url.hostname.toLowerCase();
	const ssrfError = validateUrl(url.toString(), { allowTedixHosts: true });
	if (
		url.protocol !== "https:" ||
		authority.includes(":") ||
		url.username ||
		url.password ||
		url.port ||
		url.search ||
		url.hash ||
		!host.includes(".") ||
		!/^([a-z0-9-]+\.)+[a-z0-9-]+$/.test(host) ||
		/^(?:\d+\.){3}\d+$/.test(host) ||
		/(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(host) ||
		ssrfError
	) {
		throw new Error(
			"CMS canonical URL must be a public HTTPS hostname without credentials",
		);
	}
	return url;
}

function routePath(path: string): string {
	if (
		path.length === 0 ||
		path.length > 240 ||
		!path.startsWith("/") ||
		path.startsWith("//") ||
		path.includes("//") ||
		!/^\/[a-zA-Z0-9/._~-]*$/.test(path) ||
		path.split("/").some((segment) => segment === "." || segment === "..")
	) {
		throw new Error(
			"CMS verification paths must be bounded relative paths without traversal or encoding",
		);
	}
	return path;
}

function equivalentUrl(actual: string, expected: string): boolean {
	try {
		const url = new URL(actual);
		const target = new URL(expected);
		return (
			url.origin === target.origin &&
			url.search === "" &&
			url.hash === "" &&
			(url.pathname.replace(/\/+$/, "") || "/") ===
				(target.pathname.replace(/\/+$/, "") || "/")
		);
	} catch {
		return false;
	}
}

function attribute(tag: string, name: string): string | null {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = tag.match(
		new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"),
	);
	return match?.[1] ?? match?.[2] ?? null;
}

function plainText(html: string): string {
	return html
		.replace(/<[^>]*>/g, " ")
		.replace(/&(?:amp|#38);/gi, "&")
		.replace(/&(?:lt|#60);/gi, "<")
		.replace(/&(?:gt|#62);/gi, ">")
		.replace(/&(?:quot|#34);/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/\s+/g, " ")
		.trim();
}

function pageIdentity(
	html: string,
): Pick<PublicCmsRouteResult, "title" | "h1" | "canonical" | "lang"> {
	const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
	const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
	const head = html.split(/<\/head\s*>/i, 1)[0] ?? "";
	const links = head.match(/<link\b[^>]*>/gi) ?? [];
	const canonicalTag = links.find((tag) =>
		(attribute(tag, "rel") ?? "").split(/\s+/).includes("canonical"),
	);
	return {
		title: title ? plainText(title) : null,
		h1: h1 ? plainText(h1) : null,
		canonical: canonicalTag ? attribute(canonicalTag, "href") : null,
		lang: attribute(html.match(/<html\b[^>]*>/i)?.[0] ?? "", "lang"),
	};
}

async function boundedHtml(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	let bytes = 0;
	let html = "";
	const decoder = new TextDecoder();
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) break;
		bytes += chunk.value.byteLength;
		if (bytes > MAX_HTML_BYTES) {
			await reader.cancel();
			throw new Error("CMS public page exceeds verification size limit");
		}
		html += decoder.decode(chunk.value, { stream: true });
	}
	return html + decoder.decode();
}

/** Caller must obtain canonicalUrl from the authenticated site's stored CMS row. */
export async function verifyPublicCmsRoutes(input: {
	canonicalUrl: string;
	routes: readonly PublicCmsRouteExpectation[];
	fetcher?: typeof fetch;
	timeoutMs?: number;
}): Promise<PublicCmsRouteVerification> {
	const base = configuredBase(input.canonicalUrl);
	if (input.routes.length === 0 || input.routes.length > MAX_ROUTES) {
		throw new Error(`CMS verification requires 1-${MAX_ROUTES} routes`);
	}
	const prefix = base.pathname.replace(/\/+$/, "");
	const expectations = input.routes.map((route) => ({
		...route,
		path: routePath(route.path),
	}));
	const fetcher = input.fetcher ?? fetch;
	const timeoutMs = Math.max(
		1_000,
		Math.min(input.timeoutMs ?? 15_000, 30_000),
	);
	const checkedAt = new Date().toISOString();
	const routes: PublicCmsRouteResult[] = [];

	for (const expectation of expectations) {
		const path = `${prefix}${expectation.path}`;
		const expectedUrl = `${base.origin}${path}`;
		let currentUrl = expectedUrl;
		let status: number | null = null;
		try {
			let response: Response | null = null;
			for (let redirect = 0; redirect < 3; redirect++) {
				response = await fetcher(currentUrl, {
					redirect: "manual",
					signal: AbortSignal.timeout(timeoutMs),
					headers: { Accept: "text/html" },
				});
				status = response.status;
				if (status < 300 || status >= 400) break;
				const location = response.headers.get("location");
				if (!location)
					throw new Error("CMS public route redirected without a location");
				const next = new URL(location, currentUrl);
				if (!equivalentUrl(next.toString(), expectedUrl)) {
					throw new Error(
						"CMS public route redirected away from its canonical path",
					);
				}
				currentUrl = next.toString();
			}
			if (!response || status !== 200) {
				throw new Error(`CMS public route returned ${status ?? "no response"}`);
			}
			if (
				!response.headers
					.get("content-type")
					?.toLowerCase()
					.includes("text/html")
			) {
				throw new Error("CMS public route did not return HTML");
			}
			const identity = pageIdentity(await boundedHtml(response));
			const title = identity.title ?? "";
			const ok =
				Boolean(title && identity.h1 && identity.lang) &&
				Boolean(
					identity.canonical && equivalentUrl(identity.canonical, expectedUrl),
				) &&
				(!expectation.expectedLang ||
					identity.lang === expectation.expectedLang) &&
				(!expectation.expectedTitle || title === expectation.expectedTitle) &&
				(!expectation.expectedTitleContains ||
					title.includes(expectation.expectedTitleContains)) &&
				(!expectation.forbiddenTitle ||
					!title.includes(expectation.forbiddenTitle));
			routes.push({
				path: expectation.path,
				url: expectedUrl,
				status,
				ok,
				...identity,
				...(ok
					? {}
					: { error: "CMS public page identity did not match expectations" }),
			});
		} catch (error) {
			routes.push({
				path: expectation.path,
				url: expectedUrl,
				status,
				ok: false,
				title: null,
				h1: null,
				canonical: null,
				lang: null,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return {
		ok: routes.every((route) => route.ok),
		checkedAt,
		origin: base.origin,
		routes,
	};
}
