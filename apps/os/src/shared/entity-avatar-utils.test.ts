import { describe, expect, it } from "vite-plus/test";
import { Code, FileText, Lock, Robot } from "@phosphor-icons/react";
import {
	ENTITY_AVATAR_PALETTE,
	entityAvatarColors,
	entityAvatarIndex,
	entityGlyph,
	entityInitials,
} from "./entity-avatar-utils";

describe("entity placeholders", () => {
	it.each([
		["Morgan (private)", "MP"],
		["🌟 Docs [team]", "DT"],
		["Factory", "FA"],
		["Élodie — Ångström", "ÉÅ"],
		[" (🤖) 123", "?"],
	])("uses letters only for %s", (name, expected) => {
		expect(entityInitials(name)).toBe(expected);
	});

	it("keeps color tied to the stable id across renames and render order", () => {
		const ids = Array.from({ length: 100 }, (_, i) => `workspace-${i}`);
		const first = new Map(ids.map((id) => [id, entityAvatarColors(id)]));
		for (const id of ids.reverse())
			expect(entityAvatarColors(id)).toEqual(first.get(id));
		expect(new Set(ids.map(entityAvatarIndex)).size).toBe(
			ENTITY_AVATAR_PALETTE.length,
		);
	});

	it("uses generic workspace and role keywords with a friendly tedi fallback", () => {
		expect(entityGlyph("workspace", "Private files")).toBe(Lock);
		expect(entityGlyph("workspace", "Team docs")).toBe(FileText);
		expect(entityGlyph("workspace", "Miscellaneous")).toBeNull();
		expect(entityGlyph("tedi", "CTO")).toBe(Code);
		expect(entityGlyph("tedi", "A helpful teammate")).toBe(Robot);
	});
});
