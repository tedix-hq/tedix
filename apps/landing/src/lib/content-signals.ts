/**
 * Public Tedix content may be indexed and used for query-time AI answers, but
 * not for model training. `use=reference` is the Cloudflare content-use
 * extension for retaining excerpts and links rather than full reproduction.
 */
export const PUBLIC_CONTENT_SIGNAL = "search=yes, ai-input=yes, ai-train=no";

export const PUBLIC_ROBOTS_CONTENT_SIGNAL = `${PUBLIC_CONTENT_SIGNAL}, use=reference`;
