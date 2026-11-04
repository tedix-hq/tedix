import { sha256Hex } from "@tedix/worker-kit/crypto";

export function canonicalWorkflowRuntimeJson(value: unknown): string {
	const normalize = (current: unknown): unknown => {
		if (Array.isArray(current)) return current.map(normalize);
		if (current && typeof current === "object") {
			return Object.fromEntries(
				Object.entries(current as Record<string, unknown>)
					.filter(([, item]) => item !== undefined)
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([key, item]) => [key, normalize(item)]),
			);
		}
		return current;
	};
	return JSON.stringify(normalize(value));
}

export async function buildWorkflowExecutionCompatibility(input: {
	surface: unknown;
	serviceToken: string;
}): Promise<{
	executionCompatibilityHash: string;
	legacyExecutionCompatibilityHash: string;
	serviceTokenVersion: string;
}> {
	const serviceTokenVersion = await sha256Hex(input.serviceToken);
	return {
		serviceTokenVersion,
		legacyExecutionCompatibilityHash: await sha256Hex(
			canonicalWorkflowRuntimeJson(input.surface),
		),
		executionCompatibilityHash: await sha256Hex(
			canonicalWorkflowRuntimeJson({
				surface: input.surface,
				serviceTokenVersion,
			}),
		),
	};
}

/**
 * Every host value the network-enabled OutboundProxy receives from Worker
 * config. The Loader props and the Loader config hash both read this one
 * object, so a new proxied secret cannot reach the Loader without also
 * selecting a fresh Loader id when it changes.
 */
export function outboundProxyConfig(env: {
	GEMINI_API_KEY?: string;
	GOOGLE_SERVICE_ACCOUNT_KEY?: string;
	VERTEX_VIDEO_ENDPOINT?: string;
}): {
	geminiApiKey: string | null;
	googleServiceAccountKey: string | null;
	vertexVideoEndpoint: string | null;
} {
	return {
		geminiApiKey: env.GEMINI_API_KEY ?? null,
		googleServiceAccountKey: env.GOOGLE_SERVICE_ACCOUNT_KEY ?? null,
		vertexVideoEndpoint: env.VERTEX_VIDEO_ENDPOINT ?? null,
	};
}

/**
 * One-way version of the OutboundProxy config. Each value is digested on its
 * own before the record is digested, so raw credentials never enter the
 * canonical payload.
 */
export async function buildOutboundProxyConfigVersion(
	config: Record<string, string | null>,
): Promise<string> {
	const versions: Record<string, string | null> = {};
	for (const [key, value] of Object.entries(config)) {
		versions[key] = value === null ? null : await sha256Hex(value);
	}
	return sha256Hex(canonicalWorkflowRuntimeJson(versions));
}

export function buildWorkflowLoaderConfigHash(input: {
	executionCompatibilityHash: string;
	deployment: {
		workerVersionId: string;
		workerVersionTag: string;
		workerVersionTimestamp: string;
	};
	secretVersions: {
		serviceToken: string;
		outboundCredential: string | null;
	};
}): Promise<string> {
	return sha256Hex(canonicalWorkflowRuntimeJson(input));
}
