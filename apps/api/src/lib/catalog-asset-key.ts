export function catalogAssetKey(pathname: string): string | null {
	if (!pathname.startsWith("/catalog-assets/")) return null;
	let key: string;
	try {
		key = decodeURIComponent(pathname.slice("/catalog-assets/".length));
	} catch {
		return null;
	}
	return /^(app_catalog|app-assets)\/[A-Za-z0-9_./-]+$/.test(key) &&
		key.split("/").every((part) => part && part !== "." && part !== "..")
		? key
		: null;
}
