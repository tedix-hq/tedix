/**
 * Two-minute tick for SEP-3415 event webhooks. The MCP Worker owns delivery
 * (it holds the sealing key, revalidates each subscriber's OAuth grant and
 * fetches callbacks with strictly-public egress); this path only wakes it
 * over the existing service binding. The pass is bounded and idempotent: a
 * missed tick delays delivery, it never loses an event.
 */
export async function runMcpEventWebhookDelivery(
	env: CloudflareEnv,
): Promise<Record<string, number>> {
	if (!env.MCP_SERVICE) return { skipped: 1 };
	const response = await env.MCP_SERVICE.fetch(
		new Request("https://mcp/__internal/events/deliver", {
			method: "POST",
			headers: { "X-Service-Binding": "true" },
		}),
	);
	if (!response.ok)
		throw new Error(`MCP event delivery failed (${response.status})`);
	const result = (await response.json()) as Record<string, unknown>;
	return Object.fromEntries(
		Object.entries(result).filter(
			(entry): entry is [string, number] => typeof entry[1] === "number",
		),
	);
}
