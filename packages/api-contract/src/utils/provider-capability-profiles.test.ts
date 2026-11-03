import * as z from "zod";
import { describe, expect, it } from "vite-plus/test";
import {
	PROVIDER_CAPABILITY_PROFILES,
	personalAccountCapabilityProfile,
	resourceCapabilityProfile,
} from "./provider-capability-profiles";
import { effectivePersonalResourceBinding } from "./personal-resource-tool-binding";

/** Declarative profile content; reviewed code paths are covered by behaviour tests. */
function fingerprint(profile: unknown): string {
	const text = JSON.stringify(profile, (_key, value: unknown) => {
		if (value instanceof z.ZodType) return z.toJSONSchema(value);
		if (value instanceof Set) return [...value].sort();
		if (typeof value === "function") return undefined;
		return value;
	});
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

// Changing a profile changes its fingerprint. Bump the profile's version and
// record the new fingerprint here in the same reviewed change.
const PINNED: Record<string, { version: number; fingerprint: string }> = {
	github: { version: 1, fingerprint: "4ea8d445" },
	notion: { version: 1, fingerprint: "685d1ef9" },
	"google-gmail": { version: 1, fingerprint: "fddc37df" },
	"google-calendar": { version: 1, fingerprint: "19e8242a" },
	"google-calendar-scopes": { version: 1, fingerprint: "39e19118" },
	"microsoft-graph-calendar-scopes": { version: 1, fingerprint: "11be9888" },
};

describe("reviewed provider capability profiles", () => {
	it("pins every profile's content to its version", () => {
		const actual = Object.fromEntries(
			PROVIDER_CAPABILITY_PROFILES.map((profile) => [
				profile.id,
				{ version: profile.version, fingerprint: fingerprint(profile) },
			]),
		);
		expect(actual).toEqual(PINNED);
	});
	it("has unique ids and no lookups through the prototype", () => {
		const ids = PROVIDER_CAPABILITY_PROFILES.map((profile) => profile.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const key of ["toString", "constructor", "__proto__"]) {
			expect(resourceCapabilityProfile(key)).toBeUndefined();
			expect(personalAccountCapabilityProfile(key)).toBeUndefined();
		}
	});
	it("never reviews a send, trash, spam or delete account tool", () => {
		const gmail = personalAccountCapabilityProfile("google-gmail")!;
		for (const tool of Object.keys(gmail.accountTools))
			expect(tool).not.toMatch(/send|trash|spam|delete/);
	});
});

describe("tenant bindings stay within the reviewed profile", () => {
	const account = {
		operation: "read",
		resourceType: "mailbox",
		target: "account",
	};
	it("uses the reviewed binding when the installed tool has none", () => {
		expect(
			effectivePersonalResourceBinding("google-gmail", "get_thread", undefined),
		).toEqual(account);
	});
	it.each(["send_email", "delete_message", "unknown"])(
		"refuses an installed account-wide binding for unreviewed %s",
		(tool) => {
			expect(
				effectivePersonalResourceBinding("google-gmail", tool, account),
			).toBeUndefined();
			expect(
				effectivePersonalResourceBinding("other-provider", tool, account),
			).toBeUndefined();
		},
	);
	it("refuses an installed binding that relabels an organise tool as read", () => {
		expect(
			effectivePersonalResourceBinding("google-gmail", "create_draft", account),
		).toBeUndefined();
		expect(
			effectivePersonalResourceBinding("google-gmail", "get_thread", {
				...account,
				resourceType: "calendar_account",
			}),
		).toBeUndefined();
	});
	it("keeps tenant argument-path bindings, which only narrow to admitted resources", () => {
		const paths = {
			operation: "read",
			resourceType: "calendar",
			paths: [["calendarId"]],
		};
		expect(
			effectivePersonalResourceBinding("google-calendar", "list_events", paths),
		).toEqual(paths);
		expect(
			effectivePersonalResourceBinding("google-gmail", "get_thread", {
				operation: "read",
			}),
		).toBeUndefined();
	});
});
