export class RestRouteInputError extends TypeError {
	override name = "RestRouteInputError";
}

function encodePathValue(value: unknown, catchAll: boolean): string {
	const raw = String(value);
	return catchAll
		? raw
				.split("/")
				.map((segment) => encodeURIComponent(segment))
				.join("/")
		: encodeURIComponent(raw);
}

/**
 * Resolve oRPC-style `{id}` / `{+path}` and conventional `:id` placeholders,
 * consuming path fields so they cannot leak into the query string or override
 * the decoded route identity through a JSON body.
 */
export function materializeRestRoute(
	endpoint: string,
	input: Record<string, unknown>,
): { endpoint: string; params: Record<string, unknown> } {
	const params = { ...input };
	const consume = (placeholder: string, name: string, catchAll: boolean) => {
		const value = params[name];
		if (value === undefined || value === null) {
			throw new RestRouteInputError(
				`Missing REST path parameter: ${name} (${placeholder})`,
			);
		}
		delete params[name];
		return encodePathValue(value, catchAll);
	};

	const resolved = endpoint
		.replace(/\{(\+?)([a-zA-Z_]\w*)\}/g, (placeholder, plus, name) =>
			consume(placeholder, name, plus === "+"),
		)
		.replace(/:([a-zA-Z_]\w*)/g, (placeholder, name) =>
			consume(placeholder, name, false),
		);

	return { endpoint: resolved.replace(/^\/+/, ""), params };
}
