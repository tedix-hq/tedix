import * as z from "zod";
import { describe, expect, it } from "vite-plus/test";
import {
	PROVIDER_CAPABILITY_PROFILES,
	consentScopeProfile,
	personalAccountCapabilityProfile,
	resourceCapabilityProfile,
	scopesGrantingConsent,
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
	"google-calendar-attach": { version: 1, fingerprint: "9c12ea19" },
	"google-calendar-event-read": { version: 1, fingerprint: "44c94f7a" },
	"google-calendar-event-write": { version: 1, fingerprint: "f1b82b23" },
	"microsoft-calendar-read": { version: 2, fingerprint: "44d0fdc5" },
	"microsoft-calendar-write": { version: 2, fingerprint: "706af951" },
	"google-gmail-compose": { version: 1, fingerprint: "12bee25a" },
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

describe("consent scope profiles", () => {
	const google = "https://www.googleapis.com/auth/";
	it.each([
		["google-calendar-attach", `${google}calendar.calendarlist.readonly`, true],
		["google-calendar-event-read", `${google}calendar.events.readonly`, true],
		[
			"google-calendar-event-read",
			`${google}calendar.calendarlist.readonly`,
			false,
		],
		["google-calendar-event-write", `${google}calendar.events`, true],
		["google-calendar-event-write", `${google}calendar.readonly`, false],
		["google-calendar-event-write", `${google}calendar.events.evil`, false],
		["google-gmail-compose", `${google}gmail.modify`, true],
		["google-gmail-compose", "https://mail.google.com/", true],
		["google-gmail-compose", `${google}gmail.readonly`, false],
		[
			"microsoft-calendar-read",
			"https://graph.microsoft.com/Calendars.Read",
			true,
		],
		["microsoft-calendar-read", "Calendars.Read", true],
		["microsoft-calendar-read", "Calendars.ReadWrite", true],
		[
			"microsoft-calendar-read",
			"https://graph.microsoft.com/Calendars.ReadWrite",
			true,
		],
		["microsoft-calendar-read", "calendars.readwrite", false],
		["microsoft-calendar-read", "https://example.com/Calendars.Read", false],
		["microsoft-calendar-read", "Calendars.ReadBasic", false],
		["microsoft-calendar-write", "Calendars.ReadWrite", true],
		[
			"microsoft-calendar-write",
			"https://graph.microsoft.com/Calendars.ReadWrite",
			true,
		],
		["microsoft-calendar-write", "calendars.readwrite", false],
		[
			"microsoft-calendar-write",
			"https://example.com/Calendars.ReadWrite",
			false,
		],
		["microsoft-calendar-write", "Calendars.Read", false],
	])("%s with %s grants %s", (id, scope, granted) => {
		expect(scopesGrantingConsent(id, ["openid", scope])).toEqual(
			granted ? [scope] : [],
		);
	});
	it("requests only scopes its own consent accepts or reads with", () => {
		expect(consentScopeProfile("google-calendar-event-write").requests).toEqual(
			[`${google}calendar.events`, `${google}calendar.calendarlist.readonly`],
		);
		expect(consentScopeProfile("microsoft-calendar-write").requests).toEqual([
			"Calendars.ReadWrite",
		]);
	});
	it("rejects unknown and prototype ids", () => {
		for (const id of ["unknown", "toString", "__proto__"])
			expect(() => scopesGrantingConsent(id, [])).toThrow();
	});
});
