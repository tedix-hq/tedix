/**
 * Generate ChatGPT App Store page URL for apps (not GPTs)
 *
 * App store pages use the format: https://chatgpt.com/apps/{name-slug}/{sourceAppId}
 * These contain logos (base64 webp), screenshots (estuary URLs), and prompts.
 *
 * @param name - The app display name (used to generate URL slug)
 * @param sourceAppId - The OpenAI app source ID (e.g., "asdk_app_...")
 * @returns ChatGPT app store page URL
 */
export function getChatGptAppsStoreUrl(
	name: string,
	sourceAppId: string,
): string {
	// Generate a URL-friendly slug from the name
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");

	return `https://chatgpt.com/apps/${slug}/${sourceAppId}`;
}
