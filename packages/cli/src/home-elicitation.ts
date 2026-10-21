import { isRecord } from "@tedix/api-contract/utils/is-record";

type ElicitationRequest = {
	params?: {
		mode?: string;
		requestedSchema?: unknown;
	};
};

/**
 * Resolve the CLI's narrow destructive approval round.
 *
 * The CLI only accepts form elicitation while the user is already executing an
 * explicit destructive client method (currently `cancelHomeRun`). Keeping the
 * reason in call-local state means a server cannot manufacture an unsolicited
 * approval prompt and have the CLI approve it. URL-mode and malformed forms
 * fail closed.
 */
export function resolveCliDestructiveElicitation(
	reason: string | undefined,
	request: ElicitationRequest,
): { action: "accept"; content: { reason: string } } | { action: "decline" } {
	const normalizedReason = reason?.trim();
	if (!normalizedReason || request.params?.mode === "url") {
		return { action: "decline" };
	}
	const schema = request.params?.requestedSchema;
	if (!isRecord(schema)) return { action: "decline" };
	const properties = schema.properties;
	if (!isRecord(properties) || !("reason" in properties)) {
		return { action: "decline" };
	}
	return { action: "accept", content: { reason: normalizedReason } };
}

/**
 * Fill asynchronous Task input requests through the same explicit, call-local
 * destructive approval used by synchronous MRTR. Unsupported request kinds or
 * a missing reason fail closed so Home/runtime approvals stay on their durable
 * product-specific tools.
 */
export function resolveCliTaskInputResponses(
	reason: string | undefined,
	inputRequests: Record<string, unknown>,
): Record<string, unknown> | null {
	const responses: Record<string, unknown> = {};
	for (const [id, rawRequest] of Object.entries(inputRequests)) {
		if (!isRecord(rawRequest) || rawRequest.method !== "elicitation/create") {
			return null;
		}
		const response = resolveCliDestructiveElicitation(reason, rawRequest);
		if (response.action !== "accept") return null;
		responses[id] = response;
	}
	return Object.keys(responses).length > 0 ? responses : null;
}
