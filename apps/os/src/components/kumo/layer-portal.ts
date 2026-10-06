"use client";

import { useEffect, useState } from "react";

let overlayPortal: HTMLElement | null = null;
let overlayPortalConsumers = 0;

/**
 * Kumo's Dialog does not expose its backdrop separately, so the adapter cannot
 * put the overlay rung on both the backdrop and popup. A dedicated portal host
 * gives the whole modal pair one semantic stacking context instead.
 */
function useOverlayPortalContainer(enabled = true): HTMLElement | null {
	const [container, setContainer] = useState<HTMLElement | null>(null);

	useEffect(() => {
		if (!enabled) return;

		if (!overlayPortal) {
			overlayPortal = document.createElement("div");
			overlayPortal.className = "relative isolate z-(--tedix-layer-overlay)";
			overlayPortal.dataset.tedixLayer = "overlay";
			document.body.appendChild(overlayPortal);
		}

		overlayPortalConsumers += 1;
		setContainer(overlayPortal);

		return () => {
			setContainer(null);
			overlayPortalConsumers -= 1;
			if (overlayPortalConsumers === 0) {
				overlayPortal?.remove();
				overlayPortal = null;
			}
		};
	}, [enabled]);

	return container;
}

export { useOverlayPortalContainer };
