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
		!/[{}<>_]|^\d{3}\b|\b\w+Error\b|https?:\/\//.test(text)
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
	const message =
		error === "interrupted" || text.includes("no live executor")
			? "This reply was cut off before it finished. Continue to pick up where it stopped."
			: /deprecat|retired|decommission|no such model|model[^.]*not found|unavailable|\b(404|410|503)\b/.test(
						text,
				  )
				? "This model is not available right now. Pick another model and try again."
				: /\b(402|429)\b|rate.?limit|too many requests|quota|capacity|overloaded|credit|billing|insufficient/.test(
							text,
					  )
					? "The model is busy or out of credits right now. Wait a moment and try again, or pick another model."
					: /time.?out|timed out|deadline|\b(408|504)\b/.test(text)
						? "The model took too long to answer. Try again."
						: "The model could not answer. Try again, or pick another model.";
	return { message, detail: error };
}
