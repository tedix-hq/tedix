/**
 * What the chat says when a reply failed. The workspace records the error as
 * it was thrown, which for a model provider is a status code and a JSON body.
 * The person reads one plain sentence; the recorded text stays available as
 * `detail` for whoever needs to look into it.
 */

/**
 * Text already written for a person: whole sentences without status codes or
 * markup. A credit or plan refusal ends with its gate in brackets and counts.
 */
function reads(error: string): boolean {
	const text = error.replace(/\s*\([a-z_]+\)/g, "").trim();
	return (
		/^[A-Z]/.test(text) &&
		/[.!?]$/.test(text) &&
		text.length <= 300 &&
		!/[{}<>_]|^\d{3}\b|\b\w+Error\b|https?:\/\/|\bD1\b|\bDB\b|Connection error|Durable Object/.test(
			text,
		)
	);
}

export function turnFailure(error: string | undefined): {
	message: string;
	detail?: string;
} {
	if (!error)
		return { message: "The workspace could not finish this reply. Try again." };
	if (reads(error) && !/no live executor/i.test(error))
		return { message: error };
	const text = error.toLowerCase();
	const says = (pattern: RegExp) => pattern.test(text);
	let message: string;
	// The model's reply had no text and no step, e.g. it spent its whole output
	// budget reasoning.
	if (text.startsWith("model returned no answer"))
		message = "The model returned no answer. Try again, or pick another model.";
	else if (error === "interrupted" || text.includes("no live executor"))
		message =
			"This reply was cut off before it finished. Continue to pick up where it stopped.";
	// Tedix's own storage or services, not the model.
	else if (
		says(
			/\bd1\b|database|durable object|could not determine|connection error|internal error/,
		)
	)
		message =
			"Tedix could not finish this reply because one of its own services was busy. Try again in a moment.";
	else if (
		says(
			/deprecat|retired|decommission|no such model|model[^.]*not found|unavailable|\b(404|410|503)\b/,
		)
	)
		message =
			"This model is not available right now. Pick another model and try again.";
	else if (
		says(
			/\b(402|429)\b|rate.?limit|too many requests|quota|capacity|overloaded|credit|billing|insufficient/,
		)
	)
		message =
			"The model is busy or out of credits right now. Wait a moment and try again, or pick another model.";
	else if (says(/time.?out|timed out|deadline|\b(408|504)\b/))
		message = "The model took too long to answer. Try again.";
	else
		message =
			"This reply could not be finished. Try again, or pick another model.";
	return { message, detail: error };
}
