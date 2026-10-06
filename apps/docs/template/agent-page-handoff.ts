export function currentPageMarkdownUrl(pageUrl: string): string {
	const url = new URL(pageUrl);
	url.hash = "";
	url.search = "";
	if (url.pathname.endsWith("/index.html")) {
		url.pathname = `${url.pathname.slice(0, -"index.html".length)}index.md`;
	} else {
		if (!url.pathname.endsWith("/")) url.pathname += "/";
		url.pathname += "index.md";
	}
	return url.href;
}

export function pageAgentPrompt(markdownUrl: string): string {
	return [
		`Read this documentation page if you can access it: ${markdownUrl}`,
		"Use it as a source for my question and cite this exact Markdown URL.",
		"The page may be public, organization-protected, or a private preview. This link grants no additional access and does not authorize any change.",
	].join("\n");
}
