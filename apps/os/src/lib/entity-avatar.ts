import type { CSSProperties } from "react";
import {
	ChartLine,
	Code,
	Crown,
	Factory,
	FileText,
	Headset,
	Lightbulb,
	Lock,
	Megaphone,
	PencilLine,
	Robot,
	ShieldCheck,
	Tray,
	Wallet,
} from "@phosphor-icons/react";

// Categorical blue/violet tints, independent of status and organization accents.
export const ENTITY_AVATAR_PALETTE = [
	{ violet: 0, tint: 18 },
	{ violet: 25, tint: 24 },
	{ violet: 50, tint: 18 },
	{ violet: 75, tint: 24 },
	{ violet: 100, tint: 18 },
	{ violet: 0, tint: 30 },
	{ violet: 35, tint: 30 },
	{ violet: 70, tint: 30 },
	{ violet: 100, tint: 30 },
] as const;

export function entityAvatarIndex(id: string): number {
	let hash = 2166136261;
	for (const character of id) {
		hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
	}
	return (hash >>> 0) % ENTITY_AVATAR_PALETTE.length;
}

export function entityInitials(name: string): string {
	const words = name.match(/\p{L}+/gu) ?? [];
	const letters =
		words.length > 1
			? [Array.from(words[0]!)[0], Array.from(words[1]!)[0]]
			: Array.from(words[0] ?? "").slice(0, 2);
	return letters.join("").toLocaleUpperCase() || "?";
}

const WORKSPACE_GLYPHS = [
	[/\bprivate\b/i, Lock],
	[/\b(?:docs?|documents?)\b/i, FileText],
	[/\b(?:gtm|sales|marketing)\b/i, Megaphone],
	[/\binbox\b/i, Tray],
	[/\b(?:oss|code|engineering)\b/i, Code],
	[/\bfactory\b/i, Factory],
	[/\b(?:analytics|growth)\b/i, ChartLine],
] as const;

const TEDI_GLYPHS = [
	[/\b(?:ceo|chief executive)\b/i, Crown],
	[/\b(?:cfo|finance)\b/i, Wallet],
	[/\b(?:cmo|marketing)\b/i, Megaphone],
	[/\b(?:cpo|product)\b/i, Lightbulb],
	[/\b(?:cro|sales|growth)\b/i, ChartLine],
	[/\b(?:cto|engineering|developer)\b/i, Code],
	[/\b(?:support|service)\b/i, Headset],
	[/\b(?:review\w*|audit\w*)\b/i, ShieldCheck],
	[/\b(?:draft\w*|writ\w*)\b/i, PencilLine],
] as const;

export function entityGlyph(
	kind: "workspace" | "tedi" | "person",
	name: string,
) {
	if (kind === "person") return null;
	const rules = kind === "workspace" ? WORKSPACE_GLYPHS : TEDI_GLYPHS;
	return (
		rules.find(([pattern]) => pattern.test(name))?.[1] ??
		(kind === "tedi" ? Robot : null)
	);
}

export function entityAvatarColors(
	id: string,
): CSSProperties & { "--entity-avatar-background": string } {
	const entry = ENTITY_AVATAR_PALETTE[entityAvatarIndex(id)]!;
	const hue = `color-mix(in srgb, var(--accent-amethyst) ${entry.violet}%, var(--accent-bluetron))`;
	return {
		"--entity-avatar-background": `color-mix(in srgb, ${hue} ${entry.tint}%, var(--background))`,
	};
}
