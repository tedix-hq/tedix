/**
 * Last known branding for a tenant, kept in the visitor's own browser.
 *
 * Published branding decides what the launcher looks like, and it arrives over
 * the network — so the first visit can only paint the right mark after a round
 * trip. Every visit after that can paint it in the first frame: the answer is
 * stored here and read back synchronously, then revalidated in the background.
 * This is the same shape as an HTTP stale-while-revalidate, kept in storage
 * because the launcher is painted before any fetch could resolve.
 *
 * A snapshot is a rendering hint, never authority: it holds only what the
 * public branding endpoint already serves to anyone, and it is scoped to the
 * tenant and locale that produced it. It does not expire — every load
 * revalidates and overwrites it, so the only way to read a stale one is for the
 * endpoint to be failing, which is exactly when the last known logo beats a
 * neutral mark. Storage that is unavailable, full, or disabled is not an error;
 * it just means this visitor pays the round trip.
 */

import type { WidgetBranding } from "./branding";

const KEY_PREFIX = "tedix:branding:";

function store(): Storage | null {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		// A cross-origin or storage-blocked host throws on property access alone.
		return null;
	}
}

function key(tenant: string, locale: string): string {
	return `${KEY_PREFIX}${tenant}:${locale || "-"}`;
}

export function readBrandingSnapshot(
	tenant: string,
	locale: string,
): WidgetBranding | null {
	const storage = store();
	if (!storage || !tenant) return null;
	try {
		const raw = storage.getItem(key(tenant, locale));
		const branding = raw ? (JSON.parse(raw) as WidgetBranding | null) : null;
		return branding && typeof branding === "object" && !Array.isArray(branding)
			? branding
			: null;
	} catch {
		return null;
	}
}

export function writeBrandingSnapshot(
	tenant: string,
	locale: string,
	branding: WidgetBranding | null | undefined,
): void {
	const storage = store();
	if (!storage || !tenant || !branding) return;
	try {
		storage.setItem(key(tenant, locale), JSON.stringify(branding));
	} catch {
		/* A full or disabled quota costs a round trip, never a render. */
	}
}
