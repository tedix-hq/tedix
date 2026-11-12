/**
 * The Cache Storage entry that holds app files this browser has downloaded
 * (`lib/app-runtime-code-store.ts`). It lives here so the sign-in pages can
 * clear it without depending on the product.
 */
export const APP_FILES_CACHE_NAME = "tedix-app-files-v1";

/** Remove the app files a previous session left on this device. */
export async function clearStoredAppFiles(): Promise<void> {
	try {
		if (typeof caches !== "undefined")
			await caches.delete(APP_FILES_CACHE_NAME);
	} catch {
		// Blocked storage holds nothing to remove.
	}
}
