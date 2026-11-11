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

/**
 * Model inference calls: the only Vertex requests a skill may send with a
 * platform credential. The service-account token is scoped to the whole Google
 * Cloud API, so without this a skill could list, change or delete any resource
 * the account can reach.
 */
const VERTEX_INFERENCE_PATH =
	/^\/v1(?:beta1)?\/(?:projects\/([^/]+)\/locations\/[^/]+\/)?(?:publishers\/google\/)?models\/[A-Za-z0-9._@-]+:(?:generateContent|streamGenerateContent|countTokens|predict|embedContent)$/;

/**
 * Whether a request is a model inference call the platform credential may
 * sign. A path that names a project must name the platform's own.
 */
export function isVertexInferenceCall(
	method: string,
	pathname: string,
	platformProjectId?: string | null,
): boolean {
	if (method.toUpperCase() !== "POST") return false;
	const match = VERTEX_INFERENCE_PATH.exec(pathname);
	if (!match) return false;
	const project = match[1];
	return !project || !platformProjectId || project === platformProjectId;
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
