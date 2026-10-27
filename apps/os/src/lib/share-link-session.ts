/**
 * A permanent share link lives at `/s/<id>` on the organization's own host.
 * The browser keeps the short-lived session it was exchanged for in
 * sessionStorage under that id, so two links open in one tab never overwrite
 * each other. Storage is never authority: every read is rechecked on the
 * server, and the link id itself grants nothing on another host.
 */

import { OS_SHARE_PUBLIC_ID_PATTERN } from "@tedix/api-contract/contracts/os-shares";

export function isShareLinkId(value: string): boolean {
	return OS_SHARE_PUBLIC_ID_PATTERN.test(value);
}

export function shareLinkPath(id: string): string {
	return `/s/${encodeURIComponent(id)}`;
}

function key(id: string): string {
	return `tedix.os.share.${id}`;
}

export function readShareLinkSession(id: string): string | null {
	try {
		return window.sessionStorage.getItem(key(id));
	} catch {
		return null;
	}
}

export function storeShareLinkSession(id: string, token: string | null): void {
	try {
		if (token) window.sessionStorage.setItem(key(id), token);
		else window.sessionStorage.removeItem(key(id));
	} catch {
		/* Blocked storage still permits this in-memory session. */
	}
}

/**
 * An old `#token=` link was redeemed: keep its session under the link id and
 * show the permanent address, so a bookmark or reload opens the same link.
 */
export function adoptShareLinkAddress(id: string, sessionToken: string): void {
	storeShareLinkSession(id, sessionToken);
	window.history.replaceState(null, "", shareLinkPath(id));
}
