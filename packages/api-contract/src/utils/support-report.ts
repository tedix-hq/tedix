import { SupportReportSchema, type SupportReport } from "../schemas/support";

/** Structured metadata only. Never submit full logs, messages or attachments. */
export function redactSupportText(text: string): string {
	return text
		.replace(/https?:\/\/[^\s<>"')]+/gi, (raw) => {
			try {
				const url = new URL(raw);
				url.username = "";
				url.password = "";
				url.search = "";
				url.hash = "";
				return url.toString();
			} catch {
				return "[invalid URL removed]";
			}
		})
		.replace(/(\/[^\s?#]*)[?#][^\s]*/g, "$1")
		.replace(
			/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=\-]+/gi,
			"[credential removed]",
		)
		.replace(
			/\b(?:eyJ[A-Za-z0-9_-]+\.)[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
			"[token removed]",
		)
		.replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{10,}/g, "[token removed]")
		.replace(
			/\b(authorization|cookie|set-cookie|password|secret|client[_-]?secret|api[_-]?key|token|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\n]+/gi,
			"$1: [removed]",
		)
		.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email removed]");
}
export function redactSupportReport(report: SupportReport): SupportReport {
	const parsed = SupportReportSchema.parse(report);
	return SupportReportSchema.parse(
		Object.fromEntries(
			Object.entries(parsed).map(([key, value]) => [
				key,
				Array.isArray(value)
					? value.map(redactSupportText)
					: typeof value === "string"
						? redactSupportText(value)
						: value,
			]),
		),
	);
}
export async function supportPayloadDigest(
	report: SupportReport,
): Promise<string> {
	const canonical = JSON.stringify(SupportReportSchema.parse(report));
	return Array.from(
		new Uint8Array(
			await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(canonical),
			),
		),
		(b) => b.toString(16).padStart(2, "0"),
	).join("");
}
/** Stable UUID keeps intake, mirror and reconciliation retries on the same Work. */
export async function supportObjectId(key: string): Promise<string> {
	const bytes = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)),
	).slice(0, 16);
	bytes[6] = (bytes[6]! & 15) | 80;
	bytes[8] = (bytes[8]! & 63) | 128;
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
		"",
	);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
