/**
 * Render a JSON-serializable value as a JavaScript expression that can be
 * spliced into generated source (Code Mode scripts, `new Function` bodies).
 *
 * `JSON.stringify` output is already a valid expression, but it leaves the
 * line separators U+2028/U+2029 and `</` (which ends an inline `<script>`)
 * verbatim; those are escaped here so the literal survives every host.
 * Ordinary inputs render exactly as `JSON.stringify` would.
 */
export function codeModeLiteral(value: unknown): string {
	if (typeof value === "bigint")
		throw new TypeError("codeModeLiteral: BigInt has no JSON literal");
	const json = JSON.stringify(value);
	if (json === undefined)
		throw new TypeError(
			`codeModeLiteral: ${typeof value} has no JSON literal; pass null or a serializable value`,
		);
	return json
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029")
		.replace(/<\//g, "<\\/");
}
