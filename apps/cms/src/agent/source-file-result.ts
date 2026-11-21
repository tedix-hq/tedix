import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

/** Base64 keeps source bytes intact through the gateway's untrusted HTML sanitizer. */
export function sourceFileResult(content: string) {
	const bytes = Buffer.from(content, "utf8");
	return {
		content,
		contentBase64: bytes.toString("base64"),
		sizeBytes: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
}
