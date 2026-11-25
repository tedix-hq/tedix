import { callRpc, serviceBindingFetch } from "@tedix/api-client/internal";
import { RevokeMcpInstallationInputSchema } from "@tedix/api-contract/schemas/mcp-grant";

/** Possession of a signed installation token permits ending only that installation. */
export async function revokeInstallation(
	request: Request,
	env: CloudflareEnv,
): Promise<Response> {
	if (request.method !== "POST") return new Response(null, { status: 405 });
	if (!request.headers.get("Content-Type")?.startsWith("application/json"))
		return new Response(null, { status: 415 });
	const reader = request.body?.getReader();
	if (!reader) return new Response(null, { status: 400 });
	let text = "";
	let size = 0;
	const decoder = new TextDecoder();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 80_000) {
				await reader.cancel();
				return new Response(null, { status: 413 });
			}
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
		const input = RevokeMcpInstallationInputSchema.parse({
			...JSON.parse(text),
			resourceUrl: new URL("/mcp", request.url).href,
		});
		const result = await callRpc<{ revoked: true }>(
			"organizations/revokeMcpInstallation",
			input,
			{
				apiUrl: "https://api",
				fetch: serviceBindingFetch(env.API_SERVICE),
				headers: { "X-Service-Binding": "true" },
			},
		);
		return Response.json(result, { headers: { "Cache-Control": "no-store" } });
	} catch {
		return Response.json(
			{ error: "Could not end this agent's sign-in. Try Remove again." },
			{ status: 503, headers: { "Cache-Control": "no-store" } },
		);
	} finally {
		reader.releaseLock();
	}
}
