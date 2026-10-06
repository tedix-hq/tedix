/** Keep the searchable text projection in step with native page blocks. */
import type { SandboxedPlugin } from "emdash/plugin";

const OMITTED_KEYS = new Set([
	"_key",
	"_type",
	"_version",
	"href",
	"url",
	"image_url",
	"logo_url",
	"primary_cta_url",
	"secondary_cta_url",
	"cta_url",
	"markDefs",
	"marks",
]);
const MEDIA_FIELDS = new Set(["image", "avatar", "darkVariant"]);

function isMediaValue(value: Record<string, unknown>): boolean {
	return (
		typeof value.id === "string" &&
		(typeof value.provider === "string" ||
			typeof value.src === "string" ||
			typeof value.previewUrl === "string" ||
			typeof value.mimeType === "string" ||
			typeof value.filename === "string")
	);
}

function collectMediaText(value: unknown, parts: string[]): void {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const media = value as Record<string, unknown>;
	if (typeof media.alt === "string") collectText(media.alt, parts);
	if (typeof media.caption === "string") collectText(media.caption, parts);
	collectMediaText(media.darkVariant, parts);
}

function collectText(value: unknown, parts: string[], field?: string): void {
	// A native image may arrive with only an id. Emdash calls this hook before
	// normalizing media values, so never walk its transport or tool metadata.
	if (field && MEDIA_FIELDS.has(field)) {
		collectMediaText(value, parts);
		return;
	}
	if (typeof value === "string") {
		const text = value.replace(/\s+/g, " ").trim();
		if (text) parts.push(text);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectText(item, parts);
		return;
	}
	if (!value || typeof value !== "object") return;
	if (isMediaValue(value as Record<string, unknown>)) {
		collectMediaText(value, parts);
		return;
	}
	for (const [key, child] of Object.entries(value)) {
		if (key.startsWith("_") || OMITTED_KEYS.has(key) || key.endsWith("_url"))
			continue;
		collectText(child, parts, key);
	}
}

export function projectPageSearchText(content: unknown): string {
	if (!Array.isArray(content))
		throw new TypeError("pages.content must be an array");
	const parts: string[] = [];
	collectText(content, parts);
	return parts.join("\n");
}

export default {
	hooks: {
		"content:beforeSave": {
			// A rejected save is safer than publishing blocks with a stale search index.
			errorPolicy: "abort",
			handler: async ({ collection, content }) => {
				if (collection !== "pages") return;
				if (!Object.hasOwn(content, "content")) {
					if (Object.hasOwn(content, "search_text"))
						throw new TypeError(
							"pages.search_text is derived from pages.content",
						);
					return;
				}
				return {
					...content,
					search_text: projectPageSearchText(content.content),
				};
			},
		},
	},
} satisfies SandboxedPlugin;
