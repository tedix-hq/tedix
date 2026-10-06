/**
 * Type declarations for CSS module imports
 */

// KaTeX CSS
declare module "katex/dist/katex.min.css";

// Allow all CSS imports
declare module "*.css" {
	const content: Record<string, string>;
	export default content;
}
