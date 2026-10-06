import { WarningCircle } from "@phosphor-icons/react";
import { useQueryErrorResetBoundary } from "@tanstack/react-query";
import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/kumo/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import { Loader } from "@/components/kumo/loader";
import { Page } from "@/components/kumo/page";
import { reportOsIssue } from "@/lib/error-reporting/install";

/**
 * How long the global pending spinner may stand before it escalates to a
 * visible stalled state (otherwise a direct document load can wedge on this
 * spinner forever, with zero console output).
 *
 * The awaits behind this component are a route's lazy chunk imports and its
 * loader. Loader reads go through `osApi`, whose transport aborts at
 * `OS_API_REQUEST_TIMEOUT_MS` (15s) per attempt — but a chunk `import()` has
 * no timeout and no retry, and a fetch that never settles rejects nothing, so
 * nothing downstream can bound it. 20s clears one full bounded API attempt
 * plus chunk-load headroom on a cold path; anything past it is a wedge, not a
 * slow load. The stalled panel self-heals: the router still swaps the real
 * route in whenever the load finally completes.
 */
export const OS_ROUTE_PENDING_STALL_MS = 20_000;

export function OsRoutePending({
	stallAfterMs = OS_ROUTE_PENDING_STALL_MS,
	reload = () => window.location.reload(),
}: {
	stallAfterMs?: number;
	reload?: () => void;
} = {}) {
	const [stalled, setStalled] = useState(false);

	useEffect(() => {
		const timer = window.setTimeout(() => setStalled(true), stallAfterMs);
		return () => window.clearTimeout(timer);
	}, [stallAfterMs]);

	useEffect(() => {
		if (!stalled) return;
		// The wedge this bounds produced ZERO output — nothing rejected, so no
		// boundary and no report ever fired. This single line is what turns the
		// next occurrence into a diagnosis instead of a mystery.
		const error = new Error(
			`OS route load still pending after ${stallAfterMs}ms at ${window.location.pathname}`,
		);
		console.error("Tedix OS route load stalled", error);
		reportOsIssue("os.route-pending-stall", error, {
			handled: true,
			captureMechanism: "explicit",
		});
	}, [stallAfterMs, stalled]);

	if (stalled) {
		return (
			<Page className="min-h-dvh items-center justify-center" role="alert">
				<Empty className="min-h-64">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<WarningCircle aria-hidden="true" />
						</EmptyMedia>
						<EmptyTitle>Tedix OS is taking too long to load</EmptyTitle>
						<EmptyDescription>
							The page has been loading for longer than expected. Reloading
							usually resolves this.
						</EmptyDescription>
					</EmptyHeader>
					<EmptyContent>
						<Button variant="outline" onClick={reload}>
							Reload
						</Button>
					</EmptyContent>
				</Empty>
			</Page>
		);
	}

	// centered-state owns its own viewport height, so this stays centered
	// whether the route renders inside tenant chrome or on a bare account page.
	return (
		<main
			className="centered-state"
			aria-busy="true"
			aria-live="polite"
			role="status"
		>
			<div className="flex items-center gap-2 text-kumo-subtle type-tedix-body">
				<Loader aria-hidden="true" />
				<span>Loading Tedix OS…</span>
			</div>
		</main>
	);
}

// ---------------------------------------------------------------------------
// Stale-chunk recovery
// ---------------------------------------------------------------------------

/**
 * OS is a code-split SPA served with hashed asset names, so every deploy
 * retires the chunk URLs an already-open tab still holds. The next lazy import
 * in that tab rejects — "Failed to fetch dynamically imported module" — and the
 * router renders the dead panel below, which no Retry can fix: the module the
 * router wants no longer exists on the origin.
 *
 * The only recovery is a document reload onto the new manifest. That must be
 * strictly bounded, because a reload triggered by a render failure is exactly
 * the shape of an infinite loop: a marker in `sessionStorage` allows ONE reload
 * per tab, and `clearOsChunkReloadGuard` (armed from the entry, on a delay)
 * re-arms it only for a document that actually stayed alive.
 */
export const OS_CHUNK_RELOAD_GUARD_KEY = "tedix-os-chunk-reload";

/** How long a document must survive before it may reload for a chunk again. */
export const OS_CHUNK_RELOAD_REARM_MS = 10_000;

const STALE_CHUNK_PATTERNS = [
	/failed to fetch dynamically imported module/i,
	/error loading dynamically imported module/i,
	/importing a module script failed/i,
	/unable to preload css/i,
];

export function isStaleChunkError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? "");
	return STALE_CHUNK_PATTERNS.some((pattern) => pattern.test(message));
}

type ReloadWindow = {
	sessionStorage: Pick<Storage, "getItem" | "removeItem" | "setItem">;
	location: { reload: () => void };
};

/**
 * Reload once for a stale chunk. Returns whether a reload was started, so the
 * caller can skip work the unload would discard.
 */
export function reloadOnceForStaleChunk(
	win: ReloadWindow,
	error: unknown,
): boolean {
	if (!isStaleChunkError(error)) return false;
	try {
		if (win.sessionStorage.getItem(OS_CHUNK_RELOAD_GUARD_KEY) !== null) {
			// Already reloaded in this tab and still broken: reloading again
			// would loop. Fall through to the error panel.
			return false;
		}
		win.sessionStorage.setItem(OS_CHUNK_RELOAD_GUARD_KEY, "1");
	} catch {
		// Without a guard there is no loop protection, so do not reload at all.
		return false;
	}
	win.location.reload();
	return true;
}

/**
 * Re-arm the one-shot after a document has stayed up. A looping reload hits the
 * boundary long before this fires, so the guard survives to break the loop.
 */
export function clearOsChunkReloadGuard(win: {
	sessionStorage: Pick<Storage, "removeItem">;
}): void {
	try {
		win.sessionStorage.removeItem(OS_CHUNK_RELOAD_GUARD_KEY);
	} catch {
		// Nothing to clear.
	}
}

/**
 * The router hands every boundary the raw thrown value, not an `Error`
 * (`ErrorComponentProps.error` is `unknown` since router-core 1.171.28), so
 * this reads the props off the router contract rather than a local shape.
 * Everything downstream — stale-chunk detection, the reporter, and the console
 * line — already accepts an arbitrary caught value.
 */
export function OsRouteError({ error, reset }: ErrorComponentProps) {
	const router = useRouter();
	const queryErrorResetBoundary = useQueryErrorResetBoundary();

	useEffect(() => {
		console.error("Tedix OS route failed", error);
		// A tab open across a deploy fails its next lazy import against retired
		// asset URLs; Retry cannot fix that, only a reload onto the new manifest.
		if (reloadOnceForStaleChunk(window, error)) return;
		// This component is both the router's `defaultErrorComponent` and the
		// per-route `errorComponent`, so one capture site covers every React
		// boundary in the app. The "react" mechanism keeps a caught render
		// failure distinguishable from a window error or a rejected promise.
		reportOsIssue("os.route-boundary", error, {
			handled: false,
			captureMechanism: "react",
		});
		queryErrorResetBoundary.reset();
	}, [error, queryErrorResetBoundary]);

	return (
		<Page className="min-h-dvh items-center justify-center" role="alert">
			<Empty className="min-h-64">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<WarningCircle aria-hidden="true" />
					</EmptyMedia>
					<EmptyTitle>This view could not be loaded</EmptyTitle>
					<EmptyDescription>
						Something went wrong loading this view. You can retry without
						reloading the app.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button
						variant="outline"
						onClick={() => {
							queryErrorResetBoundary.reset();
							reset();
							void router.invalidate();
						}}
					>
						Retry
					</Button>
				</EmptyContent>
			</Empty>
		</Page>
	);
}

export function OsRouteNotFound() {
	return (
		<Page className="min-h-dvh items-center justify-center">
			<Empty className="min-h-64">
				<EmptyHeader>
					<EmptyTitle>Page not found</EmptyTitle>
					<EmptyDescription>We couldn't find that page.</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button render={<a href="/" />} variant="outline">
						Go to Activity
					</Button>
				</EmptyContent>
			</Empty>
		</Page>
	);
}
