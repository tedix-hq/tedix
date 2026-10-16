import { describe, expect, it } from "vite-plus/test";
import {
	personalResourceScopesCover,
	constrainPersonalResourceToolArguments as constrain,
	forbiddenPersonalToolArguments,
	personalAccessLevel,
	personalAccessOperations,
	reviewedPersonalResourceBinding,
} from "./personal-resource-tool-binding";
import type { OsDerivedAccessEnvelope } from "../schemas/os-workspaces";
const source = {
	workspaceResourceId: "10000000-0000-4000-8000-000000000001",
	workspaceId: "10000000-0000-4000-8000-000000000001",
	providerId: "google",
	resourceType: "calendar",
	providerResourceId: "a",
	connectionScope: "user",
	personalOwnerUserId: "alice",
	connectionInstanceId: "10000000-0000-4000-8000-000000000001",
	delegationId: "10000000-0000-4000-8000-000000000001",
	requiredScopes: ["read"],
	operations: ["read"],
	toolIds: ["list_events"],
} as OsDerivedAccessEnvelope["sources"][number];
const input = {
	binding: {
		operation: "read",
		resourceType: "calendar",
		paths: [["calendarId"]],
	},
	arguments: { calendarId: "a" },
	sources: [source],
	providerId: "google",
	toolId: "list_events",
};
describe("personal provider argument confinement", () => {
	it("binds the actual provider calendar argument", () =>
		expect(constrain(input).sources).toEqual([source]));
	it.each([
		undefined,
		{},
		{ calendarId: "b" },
		{ calendarId: ["a"] },
		{ calendarId: "" },
	])("denies missing or changed calendar %j", (argumentsValue) =>
		expect(() => constrain({ ...input, arguments: argumentsValue })).toThrow(),
	);
	it("denies undeclared mappings and unapproved operation/tool", () => {
		expect(() => constrain({ ...input, binding: undefined })).toThrow();
		expect(() => constrain({ ...input, toolId: "delete_events" })).toThrow();
		expect(() =>
			constrain({
				...input,
				binding: { ...input.binding, operation: "write" },
			}),
		).toThrow();
	});
	it("confines every resource in a batch and denies mixed accounts", () => {
		const batch = {
			...input,
			binding: { ...input.binding, paths: [["items", "*", "calendarId"]] },
			arguments: { items: [{ calendarId: "a" }, { calendarId: "b" }] },
			sources: [source, { ...source, providerResourceId: "b" }],
		};
		expect(constrain(batch).sources).toHaveLength(2);
		expect(() => constrain({ ...batch, sources: [source] })).toThrow();
		expect(() =>
			constrain({
				...batch,
				sources: [
					source,
					{ ...source, providerResourceId: "b", personalOwnerUserId: "bob" },
				],
			}),
		).toThrow();
		expect(() => constrain({ ...batch, arguments: { items: [] } })).toThrow();
	});
	it("rejects ambiguous resource routes and prototype paths", () => {
		expect(() => constrain({ ...input, sources: [source, source] })).toThrow();
		expect(() =>
			constrain({
				...input,
				binding: { ...input.binding, paths: [["__proto__", "calendarId"]] },
			}),
		).toThrow();
	});
});

it("recognizes exact provider scope implications without upgrading readonly grants", () => {
	const root = "https://www.googleapis.com/auth/calendar";
	expect(
		personalResourceScopesCover(
			[root],
			[`${root}.events`, `${root}.calendarlist.readonly`],
		),
	).toBe(true);
	expect(
		personalResourceScopesCover([`${root}.readonly`], [`${root}.events`]),
	).toBe(false);
	expect(
		personalResourceScopesCover(["Calendars.ReadWrite"], ["Calendars.Read"]),
	).toBe(true);
	expect(
		personalResourceScopesCover(["Calendars.Read"], ["Calendars.ReadWrite"]),
	).toBe(false);
	expect(
		personalResourceScopesCover(
			[root],
			["https://www.googleapis.com/auth/drive"],
		),
	).toBe(false);
});

it("rejects lookalike scopes that only contain or extend the Google root", () => {
	const root = "https://www.googleapis.com/auth/calendar";
	for (const lookalike of [
		`${root}.evil.example`,
		"https://evil.example.com/https://www.googleapis.com/auth/calendar",
		"https://www.googleapis.com.evil.example/auth/calendar",
		`${root}/../drive`,
	]) {
		expect(personalResourceScopesCover([root], [lookalike])).toBe(false);
		expect(personalResourceScopesCover([lookalike], [root])).toBe(false);
		expect(personalResourceScopesCover([lookalike], [`${root}.readonly`])).toBe(
			false,
		);
	}
});
describe("account-target bindings (tools that name no resource)", () => {
	const mailbox = {
		...source,
		providerId: "google-gmail",
		resourceType: "mailbox",
		providerResourceId: "owner@example.test",
		toolIds: ["search_threads"],
	} as OsDerivedAccessEnvelope["sources"][number];
	const binding = reviewedPersonalResourceBinding(
		"google-gmail",
		"search_threads",
	);
	const account = {
		binding,
		arguments: { query: "in:inbox" },
		sources: [mailbox],
		providerId: "google-gmail",
		toolId: "search_threads",
	};
	it("admits the single consented account for a reviewed read tool", () =>
		expect(constrain(account)).toEqual({
			operation: "read",
			sources: [mailbox],
		}));
	it("denies unlisted tools, other providers, write operations and ambiguity", () => {
		expect(() => constrain({ ...account, toolId: "trash_thread" })).toThrow();
		expect(() => constrain({ ...account, providerId: "google" })).toThrow();
		expect(() => constrain({ ...account, sources: [] })).toThrow();
		expect(() =>
			constrain({
				...account,
				sources: [mailbox, { ...mailbox, providerResourceId: "other" }],
			}),
		).toThrow();
		expect(() =>
			constrain({
				...account,
				sources: [{ ...mailbox, operations: ["write"] }],
			}),
		).toThrow();
		expect(() => constrain({ ...account, arguments: [] })).toThrow();
	});
	it("reviews Gmail read and organise tools, never send, trash, spam or delete", () => {
		for (const tool of [
			"search_threads",
			"get_thread",
			"get_message",
			"list_labels",
		])
			expect(reviewedPersonalResourceBinding("google-gmail", tool)).toEqual({
				operation: "read",
				resourceType: "mailbox",
				target: "account",
			});
		for (const tool of [
			"label_thread",
			"unlabel_thread",
			"create_label",
			"create_draft",
		])
			expect(reviewedPersonalResourceBinding("google-gmail", tool)).toEqual({
				operation: "modify",
				resourceType: "mailbox",
				target: "account",
			});
		for (const tool of [
			"send_message",
			"send_draft",
			"trash_thread",
			"trash_message",
			"delete_message",
			"mark_thread_spam",
			"apply_sensitive_thread_label",
			"update_message_labels",
			"__proto__",
			"toString",
		])
			expect(
				reviewedPersonalResourceBinding("google-gmail", tool),
			).toBeUndefined();
		expect(
			reviewedPersonalResourceBinding("google", "search_threads"),
		).toBeUndefined();
		expect(reviewedPersonalResourceBinding("google-gmail", 1)).toBeUndefined();
	});
	describe("organise access", () => {
		const organise = {
			...mailbox,
			operations: ["read", "modify"],
			toolIds: ["label_thread"],
		} as OsDerivedAccessEnvelope["sources"][number];
		const labelCall = {
			binding: reviewedPersonalResourceBinding("google-gmail", "label_thread"),
			arguments: { threadId: "t1", labelIds: ["Label_7"] },
			sources: [organise],
			providerId: "google-gmail",
			toolId: "label_thread",
		};
		it("admits labelling under an organise consent only", () => {
			expect(constrain(labelCall).operation).toBe("modify");
			expect(() =>
				constrain({
					...labelCall,
					sources: [{ ...organise, operations: ["read"] }],
				}),
			).toThrow();
		});
		it.each([["TRASH"], ["spam"], [" Trash "], [7]])(
			"never adds the %s label, which would delete mail",
			(label) =>
				expect(() =>
					constrain({
						...labelCall,
						arguments: { threadId: "t1", labelIds: ["Label_7", label] },
					}),
				).toThrow(),
		);
		it("checks the upstream tool name too, whatever the binding says", () => {
			expect(
				forbiddenPersonalToolArguments(
					"google-gmail",
					"update_message_labels",
					{
						addLabelIds: ["TRASH"],
					},
				),
			).toBe(true);
			expect(() =>
				constrain({
					...labelCall,
					toolId: "organise_mail",
					providerToolName: "label_thread",
					sources: [{ ...organise, toolIds: ["organise_mail"] }],
					arguments: { threadId: "t1", labelIds: ["TRASH"] },
				}),
			).toThrow();
			expect(
				forbiddenPersonalToolArguments("google-gmail", "unlabel_thread", {
					labelIds: ["INBOX"],
				}),
			).toBe(false);
		});
		it("names levels by their operations", () => {
			expect(personalAccessOperations("organise")).toEqual(["read", "modify"]);
			expect(personalAccessOperations("read")).toEqual(["read"]);
			expect(personalAccessOperations("none")).toEqual([]);
			expect(personalAccessLevel(["read", "modify"])).toBe("organise");
			expect(personalAccessLevel(["read"])).toBe("read");
			expect(personalAccessLevel(["subscribe"])).toBe("none");
		});
	});
});
