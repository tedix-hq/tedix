import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { CALLER_TRUST_HEADER } from "@tedix/mcp-shared/auth/caller-trust";

export function buildTediContextWakeRequest(
	slug: string,
	environment: string,
	body: {
		session_key: string;
		client_request_id: string;
		metadata: Record<string, JsonValue>;
		text: string;
	},
): Request {
	return new Request("https://tedi/hooks/inject", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Tedix-Host": `${slug}.tedi.${environment === "production" ? "tedix.dev" : "tedix.tech"}`,
			"X-Service-Binding": "true",
			[CALLER_TRUST_HEADER]: "member",
		},
		body: JSON.stringify({ ...body, async: true }),
	});
}
