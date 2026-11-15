import { serveLegacyMcp } from "./legacy-mcp-server.test-helper";

/** In-process fictional upstream for cross-service policy integration tests. */
export function fictionalPolicyProvider(state: {
	account: string;
	writes: number;
}): typeof fetch {
	return async (input, init) => {
		const request = new Request(input, init);
		if (request.headers.get("Authorization") !== "Bearer fictional-token")
			return new Response("Unauthorized", { status: 401 });
		return serveLegacyMcp(
			request,
			{ name: "fictional-provider", version: "1" },
			{
				identity: () => ({
					content: [
						{
							type: "text",
							text: JSON.stringify({ account: { id: state.account } }),
						},
					],
				}),
				write: () => {
					state.writes++;
					return { content: [{ type: "text", text: "ok" }] };
				},
			},
		);
	};
}
