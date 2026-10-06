import {
	CodeHighlighted,
	type CodeHighlightedProps,
	type LanguageInput,
	ShikiProvider,
} from "@cloudflare/kumo/code";
import { Text as KumoText } from "@cloudflare/kumo/components/text";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * Why this adapter exists
 * -----------------------
 * OS renders code in two shapes — an inline literal inside prose, and a block
 * holding a payload, command, or config — and both were hand-built at every
 * call site. The 13 independent `<pre>` blocks in the app disagreed on the
 * surface token alone: `bg-kumo-fill`, `bg-kumo-tint`, `bg-kumo-base`,
 * `bg-kumo-control`, and `bg-kumo-recessed` were all in use for the same role,
 * with ad-hoc radii and no syntax highlighting.
 *
 * Which Kumo component this is built on
 * -------------------------------------
 * NOT `Code`/`CodeBlock` from `@cloudflare/kumo/components/code`: both carry an
 * `@deprecated` tag in v2.12.0 ("will be removed in v2.0") pointing at
 * `CodeHighlighted` from `@cloudflare/kumo/code`. So:
 *
 * - `CodeBlock` wraps the non-deprecated `CodeHighlighted` (Shiki, themed
 *   `github-light` / `vesper`, optional line numbers and copy button). Shiki,
 *   its engine, and each grammar are dynamically imported by `ShikiProvider`,
 *   so none of it lands in the initial bundle; the block renders as plain text
 *   until the highlighter resolves, with no layout shift.
 * - `CodeInline` is built on Kumo's `Text` monospace variants rather than the
 *   deprecated inline `Code`, which also takes a `code` *string* instead of
 *   children and so cannot wrap arbitrary nodes.
 *
 * Typography note: the adapter pins the inline case to the Tedix `control`
 * role, but deliberately leaves the block's internal `<pre>` on Kumo's own
 * geometry. Kumo sets that padding and size with `!important` inside the Shiki
 * container, and per `docs/product/design.md` a Kumo component that owns its
 * own fixed geometry keeps it. What this adapter owns is the block's *surface*
 * — the semantic line and the 8px radius — which is the drift being fixed.
 *
 * When to use which
 * -----------------
 * - `CodeInline` — an identifier, path, flag, or short literal inside a
 *   sentence.
 * - `CodeBlock` — a self-contained snippet. It mounts its own highlighter, so
 *   it can be dropped anywhere with no setup.
 * - `CodeSyntaxProvider` + `CodeBlockContent` — a surface rendering several
 *   blocks that wants one shared highlighter instead of one per block.
 */

/** Languages OS actually renders. Kept narrow: each one is a lazy chunk. */
const OS_CODE_LANGUAGES: readonly LanguageInput[] = [
	"bash",
	"css",
	"diff",
	"html",
	"json",
	"jsonc",
	"markdown",
	"sql",
	"tsx",
	"typescript",
	"yaml",
];

type CodeInlineProps = Omit<
	ComponentPropsWithoutRef<typeof KumoText>,
	"variant" | "size" | "bold" | "as" | "DANGEROUS_className" | "DANGEROUS_style"
> & {
	/** Muted monospace for secondary metadata. Defaults to `"default"`. */
	tone?: "default" | "secondary";
	className?: string;
	children?: ReactNode;
};

/**
 * Inline code literal. Renders a real `<code>` element on Kumo's monospace
 * text variant, pinned to the Tedix `control` role (13/18) so it sits on the
 * same tier as the compact UI text around it.
 */
function CodeInline({
	tone = "default",
	className,
	children,
	...props
}: CodeInlineProps) {
	return (
		<KumoText
			as="code"
			variant={tone === "secondary" ? "mono-secondary" : "mono"}
			data-slot="code-inline"
			DANGEROUS_className={cn(
				"rounded-sm bg-kumo-fill px-1 py-0.5 type-tedix-control",
				className,
			)}
			{...props}
		>
			{children}
		</KumoText>
	);
}

type CodeSyntaxProviderProps = {
	/**
	 * Languages to load in addition to {@link OS_CODE_LANGUAGES}. Each one is
	 * an extra lazily-loaded grammar chunk.
	 */
	languages?: readonly LanguageInput[];
	children: ReactNode;
};

/**
 * Mounts one Shiki highlighter for a subtree. Only needed when a surface
 * renders several `CodeBlockContent` blocks; a standalone `CodeBlock` brings
 * its own.
 *
 * Uses the `"javascript"` engine (~50KB) rather than `"wasm"` (~180KB): OS
 * renders short operational snippets, not an editor.
 */
function CodeSyntaxProvider({ languages, children }: CodeSyntaxProviderProps) {
	return (
		<ShikiProvider
			engine="javascript"
			languages={[...OS_CODE_LANGUAGES, ...(languages ?? [])]}
		>
			{children}
		</ShikiProvider>
	);
}

type CodeBlockProps = Omit<CodeHighlightedProps, "lang"> & {
	/**
	 * Language identifier. Canonical Shiki names and Kumo's aliases (`js`,
	 * `ts`, `sh`, `yml`, …) both work. Defaults to `"json"`, the shape most of
	 * the OS blocks carry. Anything outside {@link OS_CODE_LANGUAGES} needs the
	 * language added there or passed to `CodeSyntaxProvider`, or it renders as
	 * plain text.
	 */
	lang?: CodeHighlightedProps["lang"];
};

/**
 * A code block that must already be inside a {@link CodeSyntaxProvider}. Owns
 * the Tedix surface treatment: one semantic line and the 8px radius.
 */
function CodeBlockContent({
	className,
	lang = "json",
	...props
}: CodeBlockProps) {
	return (
		<CodeHighlighted
			lang={lang}
			className={cn("rounded-lg border-kumo-line bg-kumo-base", className)}
			{...props}
		/>
	);
}

/**
 * Self-contained syntax-highlighted code block: mounts its own highlighter, so
 * it can be dropped anywhere. Use `CodeSyntaxProvider` + `CodeBlockContent`
 * instead when one surface renders several blocks.
 */
function CodeBlock({ lang = "json", ...props }: CodeBlockProps) {
	return (
		<CodeSyntaxProvider>
			<CodeBlockContent lang={lang} {...props} />
		</CodeSyntaxProvider>
	);
}

export {
	CodeBlock,
	CodeBlockContent,
	type CodeBlockProps,
	CodeInline,
	type CodeInlineProps,
	CodeSyntaxProvider,
	type CodeSyntaxProviderProps,
	OS_CODE_LANGUAGES,
};
