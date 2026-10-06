const CONTEXT_OVERFLOW_PATTERN =
	/prompt is too long|context[_ ]length[_ ]exceeded|maximum context length|exceeds the maximum number of tokens|input token count|reduce the length of|input is too long|too many (?:input )?tokens|context window/i;
/** Provider-aware classification preserved from the installed harness contract. */
export function classifyTediContextOverflow(
	error: unknown,
): "context_overflow" | undefined {
	let text: string | undefined;
	if (error instanceof Error) text = error.message;
	else if (typeof error === "string") text = error;
	else
		try {
			text = JSON.stringify(error);
		} catch {
			text = String(error);
		}
	return CONTEXT_OVERFLOW_PATTERN.test(text ?? "")
		? "context_overflow"
		: undefined;
}
