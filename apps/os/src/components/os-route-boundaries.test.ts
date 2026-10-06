/**
 * Stale-chunk recovery.
 *
 * A tab open across a deploy fails its next lazy import against retired hashed
 * asset URLs. Retry cannot fix that — only a reload onto the new manifest can —
 * but a reload driven by a render failure is the shape of an infinite loop, so
 * the bound matters as much as the recovery.
 */

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	clearOsChunkReloadGuard,
	isStaleChunkError,
	OS_CHUNK_RELOAD_GUARD_KEY,
	reloadOnceForStaleChunk,
} from "./os-route-boundaries";

function fakeWindow() {
	const map = new Map<string, string>();
	const reload = vi.fn();
	return {
		reload,
		store: map,
		win: {
			sessionStorage: {
				getItem: (key: string) => map.get(key) ?? null,
				setItem: (key: string, value: string) => void map.set(key, value),
				removeItem: (key: string) => void map.delete(key),
			},
			location: { reload },
		},
	};
}

let harness: ReturnType<typeof fakeWindow>;

beforeEach(() => {
	harness = fakeWindow();
});

describe("isStaleChunkError", () => {
	it("recognises the failure a deploy causes in an open tab", () => {
		expect(
			isStaleChunkError(
				new Error(
					"Failed to fetch dynamically imported module: https://acme.os.tedix.dev/assets/descope-wc-B1x9.js",
				),
			),
		).toBe(true);
		expect(
			isStaleChunkError(new Error("error loading dynamically imported module")),
		).toBe(true);
		expect(
			isStaleChunkError(new Error("Importing a module script failed.")),
		).toBe(true);
		expect(
			isStaleChunkError(new Error("Unable to preload CSS for x.css")),
		).toBe(true);
	});

	it("leaves an ordinary render failure alone", () => {
		expect(isStaleChunkError(new Error("Cannot read properties of null"))).toBe(
			false,
		);
		expect(isStaleChunkError(undefined)).toBe(false);
	});
});

describe("reloadOnceForStaleChunk", () => {
	const staleChunk = new Error(
		"Failed to fetch dynamically imported module: /assets/descope-wc-B1x9.js",
	);

	it("reloads at most once per tab, even if the failure repeats", () => {
		expect(reloadOnceForStaleChunk(harness.win, staleChunk)).toBe(true);
		expect(harness.reload).toHaveBeenCalledTimes(1);
		expect(harness.store.get(OS_CHUNK_RELOAD_GUARD_KEY)).toBe("1");

		// The reload did not fix it: a second one would loop forever, so the
		// error panel is the correct outcome instead.
		expect(reloadOnceForStaleChunk(harness.win, staleChunk)).toBe(false);
		expect(harness.reload).toHaveBeenCalledTimes(1);
	});

	it("never reloads for a failure a reload cannot fix", () => {
		expect(
			reloadOnceForStaleChunk(harness.win, new Error("undefined is not a fn")),
		).toBe(false);
		expect(harness.reload).not.toHaveBeenCalled();
	});

	it("refuses to reload when no guard can be stored", () => {
		// Without a durable marker there is no loop protection at all, so the
		// dead panel is safer than an unbounded reload.
		const reload = vi.fn();
		const blocked = {
			sessionStorage: {
				getItem: () => null,
				setItem: () => {
					throw new Error("blocked");
				},
				removeItem: () => {},
			},
			location: { reload },
		};
		expect(reloadOnceForStaleChunk(blocked, staleChunk)).toBe(false);
		expect(reload).not.toHaveBeenCalled();
	});

	it("re-arms only for a document that stayed alive", () => {
		reloadOnceForStaleChunk(harness.win, staleChunk);
		clearOsChunkReloadGuard(harness.win);
		expect(harness.store.get(OS_CHUNK_RELOAD_GUARD_KEY)).toBeUndefined();
		expect(reloadOnceForStaleChunk(harness.win, staleChunk)).toBe(true);
		expect(harness.reload).toHaveBeenCalledTimes(2);
	});
});
