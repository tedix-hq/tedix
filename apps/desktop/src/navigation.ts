export const isOsHost = (host: string): boolean =>
	/^([a-z0-9-]+\.)?os\.tedix\.dev$/.test(host);

export function isOsPage(url: string): boolean {
	const target = URL.parse(url);
	return target?.protocol === "https:" && isOsHost(target.host);
}

export function mainPageAllowed(url: string): boolean {
	const target = URL.parse(url);
	return (
		isOsPage(url) ||
		(target?.protocol === "https:" && target.host === "auth.tedix.dev")
	);
}
