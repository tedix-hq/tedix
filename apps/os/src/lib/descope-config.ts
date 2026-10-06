/**
 * Descope console-noise filtering for the OS product zone. Style/logger
 * props and the brand override live in the zone-neutral
 * `@/shared/descope-theme`.
 */

let activeDescopeWarningFilters = 0;
let originalConsoleWarn: typeof console.warn | null = null;

function isDescopeHostedMarkupWarning(args: unknown[]): boolean {
	const message = args.map(String).join(" ");
	return (
		message.includes("missing base element for component descope-tooltip") ||
		message.includes(
			"has no value, should it be added to the boolean attributes list",
		)
	);
}

export function installDescopeConsoleWarningFilter(): () => void {
	if (typeof window === "undefined") return () => {};

	activeDescopeWarningFilters += 1;
	if (!originalConsoleWarn) {
		originalConsoleWarn = console.warn.bind(console);
		console.warn = (...args: unknown[]) => {
			if (isDescopeHostedMarkupWarning(args)) return;
			originalConsoleWarn?.(...args);
		};
	}

	return () => {
		activeDescopeWarningFilters = Math.max(0, activeDescopeWarningFilters - 1);
		if (activeDescopeWarningFilters === 0 && originalConsoleWarn) {
			console.warn = originalConsoleWarn;
			originalConsoleWarn = null;
		}
	};
}

if (typeof window !== "undefined") {
	installDescopeConsoleWarningFilter();
}
