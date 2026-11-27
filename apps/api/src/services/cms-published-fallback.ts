/** Invalidate before pausing a site; a D1 failure must never revive it. */
export async function controlCmsPublishedFallback(
	env: Pick<CloudflareEnv, "CMS" | "PLATFORM_SERVICE_TOKEN">,
	slug: string,
	action: "ticket" | "block" | "unblock",
	token: "lifecycle" | "deprovision",
	generation?: string,
): Promise<string | null> {
	const response = await env.CMS.fetch(
		new Request("https://cms.internal/_tedix/internal/published-fallback", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.PLATFORM_SERVICE_TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ slug, action, token, generation }),
		}),
	);
	if (!response.ok)
		throw new Error(`CMS fallback invalidation failed: ${response.status}`);
	const result = (await response.json()) as { generation: string | null };
	return result.generation;
}
