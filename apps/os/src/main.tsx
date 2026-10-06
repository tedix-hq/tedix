import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { KumoLinkProvider } from "@/components/kumo/link-provider";
import {
	clearOsChunkReloadGuard,
	OS_CHUNK_RELOAD_REARM_MS,
} from "@/components/os-route-boundaries";
import { TooltipProvider } from "@/components/kumo/tooltip";
import { installOsErrorReporting } from "@/lib/error-reporting/install";
import { captureDescopeContinuation } from "@/lib/step-up-continuation";
import { applyTedixOsTheme } from "@/lib/theme";
import { osQueryClient, osRouter } from "@/router";
import "@fontsource-variable/comfortaa/wght.css";
import "@/styles.css";

// Installed before the root lookup and the first render so a failure in either
// is still captured — that is the whole point of a global handler.
installOsErrorReporting();

// Snapshot Descope's flow-continuation parameters BEFORE the router mounts. A
// route's `validateSearch` schema models only its own keys, so normalizing the
// search string can drop `descope-login-flow`/`code` — and a step-up execution
// that returns from a redirect can then never be resumed. See
// `@/lib/step-up-continuation`.
captureDescopeContinuation(window.location.href);

const root = document.getElementById("root");
if (!root) throw new Error("Tedix OS root element is missing");
applyTedixOsTheme();

createRoot(root).render(
	<StrictMode>
		<QueryClientProvider client={osQueryClient}>
			<KumoLinkProvider>
				<TooltipProvider>
					<RouterProvider router={osRouter} />
				</TooltipProvider>
			</KumoLinkProvider>
		</QueryClientProvider>
	</StrictMode>,
);

// Re-arm the stale-chunk reload only for a document that actually stayed up. A
// reload loop hits the route boundary long before this fires, so the guard it
// set survives and breaks the loop.
window.setTimeout(
	() => clearOsChunkReloadGuard(window),
	OS_CHUNK_RELOAD_REARM_MS,
);
