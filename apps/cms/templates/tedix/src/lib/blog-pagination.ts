export function blogPagination(requestedPage: number, configuredSize: unknown) {
	const pageSize =
		typeof configuredSize === "number" &&
		Number.isInteger(configuredSize) &&
		configuredSize >= 1 &&
		configuredSize <= 100
			? configuredSize
			: 12;
	// Search fetches one sentinel result beyond this page; keep its limit safe too.
	const page =
		Number.isSafeInteger(requestedPage) &&
		requestedPage > 0 &&
		Number.isSafeInteger(requestedPage * pageSize + 1)
			? requestedPage
			: 1;
	return {
		page,
		pageSize,
		offset: (page - 1) * pageSize,
		searchLimit: page * pageSize + 1,
	};
}

export function blogPageHref(
	indexHref: string,
	targetPage: number,
	query = "",
) {
	const url = new URL(indexHref);
	if (query) url.searchParams.set("q", query);
	else url.searchParams.delete("q");
	if (targetPage > 1) url.searchParams.set("page", String(targetPage));
	else url.searchParams.delete("page");
	return url.toString();
}
