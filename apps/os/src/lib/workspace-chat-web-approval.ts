import type { ChatApproval } from "@/lib/workspace-chat-state";

/** A web page the agent asked to read: the site and the full address. */
export type WebPageRequest = { site: string; url: string };

/**
 * The page a proposal wants to read, when it is one. Reading a web page is
 * the only proposal whose request is a bare https address.
 */
export function webPageRequest(
	approval: Pick<ChatApproval, "input">,
): WebPageRequest | null {
	if (typeof approval.input !== "string") return null;
	let url: URL;
	try {
		url = new URL(approval.input.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || !url.hostname) return null;
	// One approval covers the site with or without "www.".
	const site = url.hostname
		.toLowerCase()
		.replace(/\.$/, "")
		.replace(/^www\./, "");
	return { site, url: url.toString() };
}

/** The card and tray heading: "Read example.com" for a web page. */
export function approvalTitle(
	approval: Pick<ChatApproval, "input" | "title">,
): string {
	const page = webPageRequest(approval);
	return page ? `Read ${page.site}` : approval.title;
}
