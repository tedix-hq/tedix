import { CmsDeployFailure, type DeployFailureCode } from "./deploy-failure";

interface Candidate {
	url: string;
	runtimeHealthUrl: string;
	publicUrl?: string;
	fetcher?: (url: string, init: RequestInit) => Promise<Response>;
	version: number;
	etag: string;
	staticFilenames: string[];
	jobId: string;
	signal: AbortSignal;
}

/** Exercise the page's own dependencies; every response must attest the candidate. */
export async function probeCmsDeploy(candidate: Candidate): Promise<{
	response: Response;
	probeUrl: string;
	code?: DeployFailureCode;
	retryable: boolean;
	probeTarget?: ProbeTarget;
	probeError?: ProbeErrorKind;
}> {
	let probeUrl = candidate.url;
	let target: ProbeTarget = "html";
	let status = 502;
	const base = new URL(candidate.url.replace(/\/$/, "") + "/");
	const publicBase = new URL(
		(candidate.publicUrl ?? candidate.url).replace(/\/$/, "") + "/",
	);
	const read = async (url: URL, type: "html" | "asset" | "image") => {
		target = type;
		url.searchParams.set("_tedix_deploy", candidate.jobId);
		url.searchParams.set("_tedix_version", String(candidate.version));
		url.searchParams.set("_tedix_etag", candidate.etag);
		url.searchParams.set("_tedix_nonce", crypto.randomUUID());
		probeUrl = url.href;
		candidate.signal.throwIfAborted();
		const response = await (candidate.fetcher ?? fetch)(url.href, {
			redirect: "error",
			signal: candidate.signal,
			headers: {
				"Cache-Control": "no-cache, no-store",
				Pragma: "no-cache",
				"X-Tedix-Public-Host": publicBase.host,
			},
			cf: { cacheTtl: 0, cacheEverything: false },
		});
		if (candidate.signal.aborted) {
			await response.body?.cancel();
			candidate.signal.throwIfAborted();
		}
		status = response.status;
		if (status !== 200) {
			await response.body?.cancel();
			throw new CmsDeployFailure(
				"PROBE_HTTP_FAILED",
				`Health probe HTTP ${status}`,
				status === 503 || status === 504,
			);
		}
		if (
			response.headers.get("X-Tedix-Bundle-Version") !==
				String(candidate.version) ||
			response.headers.get("X-Tedix-Bundle-Etag") !== candidate.etag
		) {
			await response.body?.cancel();
			status = 409;
			throw new CmsDeployFailure(
				"PROBE_BUNDLE_MISMATCH",
				"Health probe served another bundle",
			);
		}
		const contentType = response.headers.get("content-type") ?? "";
		const body = await response.arrayBuffer();
		if (
			!body.byteLength ||
			(type === "image" &&
				response.headers.get("X-Tedix-Image-Transform") !== "images") ||
			!(type === "html"
				? contentType.startsWith("text/html")
				: type === "image"
					? /^image\/(?:avif|webp|png|jpeg|gif)/.test(contentType)
					: /^(?:text\/css|(?:application|text)\/(?:javascript|ecmascript))/.test(
							contentType,
						))
		) {
			status = 502;
			throw new CmsDeployFailure(
				type === "html"
					? "PROBE_HTML_INVALID"
					: type === "image"
						? "PROBE_IMAGE_INVALID"
						: "PROBE_ASSET_INVALID",
				`Invalid ${type} health response`,
			);
		}
		return new TextDecoder().decode(body);
	};
	try {
		// Negotiate on the installation endpoint before dispatching into a tenant.
		target = "runtime-health";
		probeUrl = candidate.runtimeHealthUrl;
		candidate.signal.throwIfAborted();
		const health = await (candidate.fetcher ?? fetch)(probeUrl, {
			redirect: "error",
			signal: candidate.signal,
			headers: { "Cache-Control": "no-cache, no-store" },
			cf: { cacheTtl: 0, cacheEverything: false },
		});
		if (candidate.signal.aborted) {
			await health.body?.cancel();
			candidate.signal.throwIfAborted();
		}
		status = health.status;
		if (status !== 200) {
			await health.body?.cancel();
			throw new CmsDeployFailure(
				"PROBE_HTTP_FAILED",
				`Runtime health HTTP ${status}`,
				status === 503 || status === 504,
			);
		}
		const capability = (await health.json()) as {
			service?: string;
			deployProbeVersion?: number;
		} | null;
		if (
			capability?.service !== "cms-runtime" ||
			capability.deployProbeVersion !== 1
		) {
			status = 409;
			throw new CmsDeployFailure(
				"runtime-without-attestation",
				"Runtime does not advertise deploy probe version 1",
			);
		}
		const html = await read(base, "html");
		if (!/<html(?:\s|>)/i.test(html)) {
			status = 502;
			throw new CmsDeployFailure(
				"PROBE_HTML_INVALID",
				"Health response is not an HTML page",
			);
		}
		const references = [
			...html.matchAll(/\b(?:href|src|srcset)\s*=\s*["']([^"']+)["']/gi),
		]
			.flatMap((match) =>
				match[1]!
					.replaceAll("&amp;", "&")
					.split(/,\s*/)
					.map((value) => value.trim().split(/\s+/)[0]!),
			)
			.map((value) => {
				try {
					const dependency = new URL(value, publicBase);
					if (dependency.origin === publicBase.origin) {
						dependency.protocol = base.protocol;
						dependency.host = base.host;
					}
					return dependency;
				} catch {
					return null;
				}
			})
			.filter((url): url is URL => Boolean(url && url.origin === base.origin));
		const asset = references.find(
			(url) =>
				url.pathname.includes("/_astro/") &&
				/\.(?:css|m?js)$/.test(url.pathname) &&
				candidate.staticFilenames.includes(
					decodeURIComponent(url.pathname.split("/").pop()!),
				),
		);
		if (!asset) {
			status = 502;
			throw new CmsDeployFailure(
				"PROBE_ASSET_MISSING",
				"Page has no declared CSS or JS dependency",
			);
		}
		await read(asset, "asset");
		const image = references.find(
			(url) => url.pathname.endsWith("/_image") && url.searchParams.has("href"),
		);
		if (!image) {
			status = 502;
			throw new CmsDeployFailure(
				"PROBE_IMAGE_MISSING",
				"Page has no image transform dependency",
			);
		}
		await read(image, "image");
		if (candidate.signal.aborted)
			throw new Error("Health probe deadline exceeded");
		return {
			response: new Response(null, { status: 200 }),
			probeUrl,
			retryable: false,
		};
	} catch (error) {
		let probeError: ProbeErrorKind | undefined;
		if (!(error instanceof CmsDeployFailure)) {
			status = candidate.signal.aborted ? 504 : 502;
			probeError = classifyProbeError(error, candidate.signal.aborted);
			// Full text stays in Worker logs; status details carry only enums.
			console.error("CMS deploy probe request failed", {
				target,
				probeUrl,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return {
			response: new Response(null, { status: status === 200 ? 502 : status }),
			probeUrl,
			code:
				error instanceof CmsDeployFailure ? error.code : "PROBE_NETWORK_FAILED",
			retryable: error instanceof CmsDeployFailure ? error.retryable : true,
			probeTarget: target,
			...(probeError ? { probeError } : {}),
		};
	}
}

export const PROBE_TARGETS = [
	"html",
	"asset",
	"image",
	"runtime-health",
] as const;
export type ProbeTarget = (typeof PROBE_TARGETS)[number];
export const PROBE_ERROR_KINDS = [
	"redirect",
	"timeout",
	"connection",
	"other",
] as const;
export type ProbeErrorKind = (typeof PROBE_ERROR_KINDS)[number];

export function classifyProbeError(
	error: unknown,
	aborted: boolean,
): ProbeErrorKind {
	if (aborted) return "timeout";
	const message = error instanceof Error ? error.message : String(error);
	if (/redirect/i.test(message)) return "redirect";
	if (/network|connect|socket|fetch failed|dns|refused|reset/i.test(message))
		return "connection";
	return "other";
}
