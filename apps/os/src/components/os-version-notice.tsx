import { osToastManager } from "@/components/kumo/toast";
import { reloadOnceForStaleChunk } from "@/components/os-route-boundaries";
import { installOsVersionChecks } from "@/lib/os-version";
import {
	hasUnsavedOsInput,
	OS_RELOAD_NOTICE_ID as NOTICE_ID,
	trackOsDeparture,
	trackOsInput,
} from "@/lib/reload-safety";

export function installOsVersionNotice(): () => void {
	const stopTracking = trackOsInput(document);
	const stopTrackingDeparture = trackOsDeparture(window);
	// Reload confirmation stays in the toast: a native confirm() blocks the
	// page, and automation driving the browser cannot see or answer it.
	const confirmReload = (chunkFailure: boolean) => {
		osToastManager.close(NOTICE_ID);
		osToastManager.add({
			id: NOTICE_ID,
			title: "Reload Tedix OS anyway?",
			description: "Drafts and unsaved changes on this page may be lost.",
			variant: "info",
			timeout: 0,
			actions: [
				{
					children: "Reload anyway",
					onClick: () => window.location.reload(),
				},
				{
					children: "Cancel",
					onClick: () => notify(chunkFailure),
				},
			],
		});
	};
	const notify = (chunkFailure = false) => {
		osToastManager.close(NOTICE_ID);
		osToastManager.add({
			id: NOTICE_ID,
			title: chunkFailure
				? "Reload Tedix OS to recover this view"
				: "New Tedix OS version available",
			description: "Save your work, then reload to load the latest version.",
			variant: "info",
			timeout: 0,
			actions: [
				{
					children: "Reload",
					onClick: () => {
						if (hasUnsavedOsInput(document)) confirmReload(chunkFailure);
						else window.location.reload();
					},
				},
			],
		});
	};
	const stopChecking = installOsVersionChecks({
		buildSha: __OS_BUILD_SHA__,
		notify: () => notify(),
	});
	const onPreloadError = (event: Event & { payload?: unknown }) => {
		// Cancelling resolves Vite's failed import with undefined, which crashes
		// lazyRouteComponent when it reads the export. Keep the import rejected.
		if (event.payload instanceof Error) {
			// TanStack otherwise reloads these errors itself, bypassing our draft,
			// departure and loop guards. Keep the original error and asset URL,
			// but let only OS recovery own the reload.
			event.payload.message = `OS asset preload failed: ${event.payload.message}`;
		}
		// Vite also emits this for CSS failures; use the same bounded recovery.
		if (
			!reloadOnceForStaleChunk(
				window,
				new Error("Failed to fetch dynamically imported module"),
			)
		)
			notify(true);
	};
	window.addEventListener("vite:preloadError", onPreloadError);
	return () => {
		stopTracking();
		stopTrackingDeparture();
		stopChecking();
		window.removeEventListener("vite:preloadError", onPreloadError);
		osToastManager.close(NOTICE_ID);
	};
}
