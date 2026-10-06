type ChartColorConfig = Record<
	string,
	{
		color?: string;
		theme?: Partial<Record<"light" | "dark", string>>;
	}
>;

const THEMES = { light: "", dark: ".dark" } as const;
const SAFE_CUSTOM_PROPERTY_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const UNSAFE_COLOR_SYNTAX = /[;@<>{}\\"']|\/\*|\*\//;
const UNSAFE_COLOR_FUNCTION = /(?:expression|image-set|url)\s*\(/i;

function hasControlCharacter(value: string): boolean {
	return Array.from(value).some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint <= 0x1f || codePoint === 0x7f;
	});
}

function safeColorValue(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	if (normalized.length === 0 || normalized.length > 256) return undefined;
	if (hasControlCharacter(normalized)) return undefined;
	if (UNSAFE_COLOR_SYNTAX.test(normalized)) return undefined;
	if (UNSAFE_COLOR_FUNCTION.test(normalized)) return undefined;
	return normalized;
}

function escapeCssString(value: string): string {
	return Array.from(value, (character) =>
		/[A-Za-z0-9_-]/.test(character)
			? character
			: `\\${character.codePointAt(0)?.toString(16)} `,
	).join("");
}

/**
 * Render the chart's theme custom properties without allowing a config key,
 * selector id, or color token to escape its CSS boundary.
 */
export function renderChartStyle(id: string, config: ChartColorConfig): string {
	const selectorId = escapeCssString(id);
	const blocks: string[] = [];

	for (const [theme, prefix] of Object.entries(THEMES)) {
		const declarations: string[] = [];
		for (const [key, itemConfig] of Object.entries(config)) {
			if (!SAFE_CUSTOM_PROPERTY_SEGMENT.test(key)) continue;
			const rawColor =
				itemConfig.theme?.[theme as keyof typeof itemConfig.theme] ??
				itemConfig.color;
			const color = safeColorValue(rawColor);
			if (!color) continue;
			declarations.push(`  --color-${key}: ${color};`);
		}
		if (declarations.length === 0) continue;
		blocks.push(
			`${prefix} [data-chart="${selectorId}"] {\n${declarations.join("\n")}\n}`,
		);
	}

	return blocks.join("\n");
}
