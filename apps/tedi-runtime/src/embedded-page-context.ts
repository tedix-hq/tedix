export type EmbeddedPageContext = {
	pathname: string;
	title?: string;
	description?: string;
	sections?: string[];
	entity?: { type: string; id: string; label?: string };
	event?: {
		name: string;
		metadata?: Record<string, string | number | boolean>;
	};
};

const safeText = (value: unknown, max: number): string | undefined =>
	typeof value === "string" && value.trim().length > 0
		? value.trim().slice(0, max)
		: undefined;

export function normalizeEmbeddedPageContext(
	value: unknown,
): EmbeddedPageContext | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const input = value as Record<string, unknown>;
	const pathname = safeText(input.pathname, 500);
	if (
		!pathname ||
		!pathname.startsWith("/") ||
		pathname.startsWith("//") ||
		pathname.includes("://") ||
		/^\/(?:api|auth|cli|mcp|widgets|sandbox_proxy)(?:\/|$)/.test(pathname)
	)
		return undefined;

	const title = safeText(input.title, 200);
	const description = safeText(input.description, 500);
	const sections = Array.isArray(input.sections)
		? input.sections
				.map((section) => safeText(section, 160))
				.filter((section): section is string => Boolean(section))
				.slice(0, 12)
		: [];
	const result: EmbeddedPageContext = {
		pathname,
		...(title ? { title } : {}),
		...(description ? { description } : {}),
		...(sections.length ? { sections } : {}),
	};
	if (
		input.entity &&
		typeof input.entity === "object" &&
		!Array.isArray(input.entity)
	) {
		const entity = input.entity as Record<string, unknown>;
		const type = safeText(entity.type, 64);
		const id = safeText(entity.id, 128);
		const label = safeText(entity.label, 160);
		if (
			type &&
			id &&
			/^[A-Za-z0-9_.:-]+$/.test(type) &&
			/^[A-Za-z0-9_.:-]+$/.test(id)
		) {
			result.entity = { type, id, ...(label ? { label } : {}) };
		}
	}
	if (
		input.event &&
		typeof input.event === "object" &&
		!Array.isArray(input.event)
	) {
		const event = input.event as Record<string, unknown>;
		const name = safeText(event.name, 80);
		if (name && /^[A-Za-z0-9_.:-]+$/.test(name)) {
			const metadata: Record<string, string | number | boolean> = {};
			if (
				event.metadata &&
				typeof event.metadata === "object" &&
				!Array.isArray(event.metadata)
			) {
				for (const [key, raw] of Object.entries(event.metadata).slice(0, 12)) {
					if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(key)) continue;
					if (typeof raw === "boolean" || typeof raw === "number")
						metadata[key] = raw;
					else if (typeof raw === "string") metadata[key] = raw.slice(0, 160);
				}
			}
			result.event = {
				name,
				...(Object.keys(metadata).length ? { metadata } : {}),
			};
		}
	}
	return result;
}
