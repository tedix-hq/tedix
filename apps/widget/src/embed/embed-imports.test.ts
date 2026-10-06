/**
 * Structural guard: the embed runtime reaches for the shared, separately
 * tested modules instead of open-coding its own copy of their rules.
 *
 * Behaviour lives in the runtime-*.test.ts suites and in each module's own
 * tests. What only the import graph can show is that the embed still defers
 * to them: the widget once checked bare `event.isComposing` (missing the
 * keyCode-229 browsers), hardcoded its own scroll threshold, armed its stall
 * watchdog only after text, and kept a second, untested error taxonomy.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vite-plus/test";

function importsOf(file: string) {
	const { program } = parseSync(
		file,
		readFileSync(join(import.meta.dirname, file), "utf8"),
	);
	const imports = new Map<string, Set<string>>();
	for (const statement of program.body) {
		if (statement.type !== "ImportDeclaration") continue;
		const names = imports.get(statement.source.value) ?? new Set<string>();
		for (const specifier of statement.specifiers)
			names.add(
				specifier.type === "ImportSpecifier"
					? specifier.imported.type === "Identifier"
						? specifier.imported.name
						: String(specifier.imported.value)
					: "default",
			);
		imports.set(statement.source.value, names);
	}
	return imports;
}

describe("the embed runtime's import graph", () => {
	const imports = importsOf("./embed.mjs");

	it.each([
		[
			"@tedix/chat-transport/composer-semantics",
			["isImeComposingKey", "isNearBottom", "observeScrollResize"],
		],
		["./turn-stall", ["shouldArmStallWatchdog", "stallWatchdogDelayMs"]],
		["./turn-preparation", ["waitForTurnPreparation"]],
		["./chat-errors", ["classifyChatError", "userFacingChatError"]],
		[
			"./widget-frame",
			["MCP_APP_ORIGIN", "resolveWidgetFrameSource", "WIDGET_FRAME_SANDBOX"],
		],
		[
			"@tedix/chat-transport/transcript-reducer",
			["createTranscriptState", "reduceTranscript"],
		],
		[
			"@tedix/chat-transport/markdown",
			["bindMarkdownCopyButtons", "renderMarkdown", "safeMarkdownHref"],
		],
		["./tool-summary", ["activityRowKey", "activityRowText"]],
		["./ui/index", ["embeddedConnectionMarkup"]],
		["./ui/styles", ["embeddedTediStyles"]],
		[
			"./host-boundary",
			[
				"escapeEmbeddedHtml",
				"normalizeEmbeddedLocale",
				"normalizeEmbeddedPageContext",
				"safeEmbeddedAccent",
				"safeEmbeddedHostRoute",
				"safeEmbeddedImageUrl",
			],
		],
	])("takes %s from its shared owner", (from, names) => {
		expect([...(imports.get(from) ?? [])]).toEqual(
			expect.arrayContaining(names),
		);
	});

	it("renders markdown only through the shared transport renderer", () => {
		expect(imports.has("./ui/markdown")).toBe(false);
	});
});
