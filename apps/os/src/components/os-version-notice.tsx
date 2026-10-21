import { osToastManager } from "@/components/kumo/toast";
import { reloadOnceForStaleChunk } from "@/components/os-route-boundaries";
import { installOsVersionChecks } from "@/lib/os-version";
import { hasUnsavedOsInput, trackOsInput } from "@/lib/reload-safety";

const NOTICE_ID = "os-version-reload";

export function installOsVersionNotice(): () => void {
	const stopTracking = trackOsInput(document);
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
						if (
							hasUnsavedOsInput(document) &&
							!window.confirm(
								"Reload Tedix OS? Drafts and unsaved changes may be lost.",
							)
						)
							return;
						window.location.reload();
					},
				},
			],
		});
	};
	const stopChecking = installOsVersionChecks({
		buildSha: __OS_BUILD_SHA__,
		notify: () => notify(),
	});
	const onPreloadError = (event: Event) => {
		event.preventDefault();
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
		stopChecking();
		window.removeEventListener("vite:preloadError", onPreloadError);
		osToastManager.close(NOTICE_ID);
	};
}
