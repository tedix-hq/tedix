/** Platform credentials an internal caller may send; never for tenant code. */
const PLATFORM_CREDENTIAL_HEADERS = [
	"Authorization",
	"X-Forwarded-Authorization",
	"X-Tedix-Admin-Token",
	"X-Tedix-CMS-Internal-Auth",
];

/**
 * Headers for the site-builder container, which runs organization-authored
 * site code. It receives the signed-in person's own token, which the site's
 * admin checks, and never the platform credential an internal caller used.
 */
export function previewContainerHeaders(
	inbound: Headers,
	userToken: string | undefined,
): Headers {
	const headers = new Headers(inbound);
	for (const name of PLATFORM_CREDENTIAL_HEADERS) headers.delete(name);
	if (userToken) headers.set("Authorization", `Bearer ${userToken}`);
	return headers;
}
