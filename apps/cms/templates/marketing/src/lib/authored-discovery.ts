export function authoredDiscoveryResponse(
	text: string | undefined,
): Response | null {
	if (!text?.trim()) return null;
	return new Response(text, {
		headers: {
			"Content-Type": "text/markdown; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
		},
	});
}
