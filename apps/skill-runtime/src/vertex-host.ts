/**
 * Exact Vertex AI host checks for the outbound proxy. The proxy attaches the
 * platform Google service-account token to these hosts, so they are matched by
 * an anchored pattern on the parsed hostname rather than a raw suffix check.
 */
const VERTEX_REGIONAL_HOST = /^[a-z0-9-]{1,63}-aiplatform\.googleapis\.com$/;

/** Regional Vertex AI host, e.g. `us-central1-aiplatform.googleapis.com`. */
export function isVertexRegionalHost(host: string): boolean {
	return VERTEX_REGIONAL_HOST.test(host.toLowerCase());
}

/** Global, regional, or dotted-subdomain Vertex AI host. */
export function isVertexHost(host: string): boolean {
	const normalized = host.toLowerCase();
	return (
		normalized === "aiplatform.googleapis.com" ||
		normalized.endsWith(".aiplatform.googleapis.com") ||
		isVertexRegionalHost(normalized)
	);
}
