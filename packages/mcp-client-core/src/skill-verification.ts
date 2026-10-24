import type { McpSkillEntry } from "@tedix/mcp-shared/skills";
import { parse as parseYaml } from "yaml";

function failure(category: string): never {
	throw new Error(`Skill verification failed: ${category}`);
}

function resourceIdentity(uri: string) {
	try {
		const url = new URL(uri);
		const segments: string[] = [];
		for (const segment of decodeURIComponent(url.pathname).split("/")) {
			if (segment === "..") segments.pop();
			else if (segment !== ".") segments.push(segment);
		}
		return {
			origin: `${url.protocol}//${url.username}:${url.password}@${url.host}`,
			path: segments.join("/"),
			query: url.search,
		};
	} catch {
		return undefined;
	}
}

function sameResource(left: string, right: string): boolean {
	const a = resourceIdentity(left);
	const b = resourceIdentity(right);
	return Boolean(
		a && b && a.origin === b.origin && a.path === b.path && a.query === b.query,
	);
}

/** Resolve the advertised owner before fetching a skill file. */
export function resolveAdvertisedSkill(
	entries: readonly McpSkillEntry[],
	uri: string,
): McpSkillEntry | undefined {
	const requested = resourceIdentity(uri);
	if (!requested) return undefined;
	// Prefer an exact advertised resource over a containing directory, allowing
	// independently advertised skills nested beneath another skill's root.
	for (const entry of entries) {
		if (
			sameResource(entry.uri, uri) ||
			(Array.isArray(entry.resources) &&
				entry.resources.some((file) => sameResource(file.uri, uri)))
		) {
			return entry;
		}
	}
	let owner: McpSkillEntry | undefined;
	let ownerPathLength = -1;
	for (const entry of entries) {
		const root = resourceIdentity(entry.uri);
		if (!root || requested.origin !== root.origin) continue;
		const directory = root.path.slice(0, root.path.lastIndexOf("/") + 1);
		if (!directory || !requested.path.startsWith(directory)) continue;
		if (directory.length > ownerPathLength) {
			owner = entry;
			ownerPathLength = directory.length;
		}
	}
	if (owner && owner.resources !== "dynamic") failure("unlisted resource");
	return owner;
}

function equalData(left: unknown, right: unknown): boolean {
	const pending: Array<[unknown, unknown]> = [[left, right]];
	const seen = new WeakMap<object, WeakSet<object>>();
	while (pending.length > 0) {
		const [a, b] = pending.pop()!;
		if (Object.is(a, b)) continue;
		if (!a || !b || typeof a !== "object" || typeof b !== "object") {
			return false;
		}
		if (Array.isArray(a) !== Array.isArray(b)) return false;
		if (seen.get(a)?.has(b)) continue;
		const matches = seen.get(a) ?? new WeakSet<object>();
		matches.add(b);
		seen.set(a, matches);
		const aKeys = Object.keys(a);
		const bKeys = Object.keys(b);
		if (aKeys.length !== bKeys.length) return false;
		for (const key of aKeys) {
			if (!Object.hasOwn(b, key)) return false;
			pending.push([
				(a as Record<string, unknown>)[key],
				(b as Record<string, unknown>)[key],
			]);
		}
	}
	return true;
}

/** Verify the complete wire result before guidance parsing or truncation. */
export async function verifySkillResourceRead(
	skill: McpSkillEntry,
	uri: string,
	result: unknown,
): Promise<void> {
	if (resolveAdvertisedSkill([skill], uri) !== skill) {
		failure("unlisted resource");
	}
	const contents = (result as { contents?: unknown } | null)?.contents;
	if (!Array.isArray(contents) || contents.length !== 1) {
		failure("content parts");
	}
	const part = contents[0] as {
		uri?: unknown;
		text?: unknown;
		blob?: unknown;
	} | null;
	if (!part || typeof part.uri !== "string" || !sameResource(part.uri, uri)) {
		failure("content URI");
	}
	const hasText = typeof part.text === "string";
	const hasBlob = typeof part.blob === "string";
	if (
		hasText === hasBlob ||
		(hasText && part.blob !== undefined) ||
		(hasBlob && part.text !== undefined)
	) {
		failure("content encoding");
	}
	let bytes: Uint8Array<ArrayBuffer>;
	if (hasText) {
		bytes = new Uint8Array(new TextEncoder().encode(part.text as string));
	} else {
		try {
			const binary = atob(part.blob as string);
			bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		} catch {
			failure("content encoding");
		}
	}
	if (Array.isArray(skill.resources)) {
		const advertised = skill.resources.find((file) =>
			sameResource(file.uri, uri),
		);
		if (!advertised) failure("unlisted resource");
		if (bytes.byteLength !== advertised.size) failure("size");
		const hash = await crypto.subtle.digest("SHA-256", bytes);
		const digest = `sha256:${Array.from(new Uint8Array(hash), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("")}`;
		if (digest !== advertised.digest) failure("digest");
	}
	if (!sameResource(skill.uri, uri)) return;
	let text: string;
	try {
		const decoderOptions = { fatal: true, ignoreBOM: true };
		text = new TextDecoder("utf-8", decoderOptions).decode(bytes);
	} catch {
		failure("frontmatter");
	}
	const match = text.match(
		/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/,
	);
	if (!match) failure("frontmatter");
	let frontmatter: unknown;
	try {
		frontmatter = parseYaml(match[1]!);
	} catch {
		failure("frontmatter");
	}
	if (!equalData(frontmatter, skill.frontmatter)) failure("frontmatter");
}
