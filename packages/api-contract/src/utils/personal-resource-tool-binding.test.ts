import { describe, expect, it } from "vite-plus/test";
import {
	personalResourceScopesCover,
	constrainPersonalResourceToolArguments as constrain,
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
