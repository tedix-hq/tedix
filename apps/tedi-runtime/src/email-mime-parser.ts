import PostalMime from "postal-mime";
import { logTediEmailParseFailure } from "./runtime-failure-log";

type RawEmail = Parameters<typeof PostalMime.parse>[0];
type ParsedEmail = Awaited<ReturnType<typeof PostalMime.parse>>;

/** Classify parser failures without changing the ingress failure or retry policy. */
export async function parseInboundEmailMime(
	raw: RawEmail,
	parse: (raw: RawEmail) => Promise<ParsedEmail> = (input) =>
		PostalMime.parse(input),
): Promise<ParsedEmail> {
	try {
		return await parse(raw);
	} catch (error) {
		logTediEmailParseFailure(error);
		throw error;
	}
}
