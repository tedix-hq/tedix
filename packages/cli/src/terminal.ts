/** Terminal color capability shared by formatting and markdown rendering. */
export interface ColorMode {
	enabled: boolean;
}

const ESC = "\\u001b";
const BEL = "\\u0007";
const ESC_SEQUENCE_RE = new RegExp(
	`${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|P[^${ESC}]*${ESC}\\\\|[@-Z\\\\-_]|${ESC})`,
	"g",
);
const C0_CONTROL_RE = new RegExp(
	`[${"\\u0000-\\u0008"}\\u000b-\\u001f\\u007f]`,
	"g",
);

/** Remove terminal escape sequences and unsafe C0 bytes from untrusted text. */
export function stripControlChars(text: string): string {
	return text.replace(ESC_SEQUENCE_RE, "").replace(C0_CONTROL_RE, "");
}
