export const PRIVATE_SURFACE_ROBOTS_POLICY = "noindex, nofollow, noarchive";

export function applyPrivateSurfaceRobotsPolicy(headers: Headers): Headers {
	headers.set("X-Robots-Tag", PRIVATE_SURFACE_ROBOTS_POLICY);
	return headers;
}
