/** String payload sizes only: no JSON copy of a large prompt or tool result. */
export function payloadSize(value: unknown): { chars: number; bytes: number } {
	let chars = 0;
	let bytes = 0;
	const seen = new WeakSet<object>();
	const visit = (part: unknown): void => {
		if (typeof part === "string") {
			chars += part.length;
			for (const char of part) {
				const code = char.codePointAt(0)!;
				bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
			}
		} else if (part instanceof ArrayBuffer || ArrayBuffer.isView(part)) {
			bytes += part.byteLength;
		} else if (part && typeof part === "object" && !seen.has(part)) {
			seen.add(part);
			for (const nested of Object.values(part)) visit(nested);
		}
	};
	visit(value);
	return { chars, bytes };
}

/** Peak bytes held while parallel tool results are projected into native Pi. */
export class TurnHeapProxy {
	promptChars = 0;
	private inFlightToolResultBytes = 0;
	private peakInFlightToolResultBytes = 0;

	holdToolResult(result: unknown): () => void {
		const { bytes } = payloadSize(result);
		this.inFlightToolResultBytes += bytes;
		this.peakInFlightToolResultBytes = Math.max(
			this.peakInFlightToolResultBytes,
			this.inFlightToolResultBytes,
		);
		return () => {
			this.inFlightToolResultBytes -= bytes;
		};
	}

	snapshot() {
		return {
			promptChars: this.promptChars,
			inFlightToolResultBytes: this.inFlightToolResultBytes,
			peakInFlightToolResultBytes: this.peakInFlightToolResultBytes,
		};
	}
}
