/**
 * The largest Output content one save may carry, as UTF-8 bytes of its JSON.
 * The editors' host and the API both refuse more. It lives apart from the
 * schemas so an editor bundle can read it without carrying them.
 */
export const OS_OUTPUT_CONTENT_MAX_BYTES = 8_000_000;
