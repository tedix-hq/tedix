export type ThemeMode = "light" | "dark" | "system";

// Kept self-contained so the native cookie preference runs before first paint.
function initializeTheme(mode: ThemeMode) {
	const stored = document.cookie
		.split(";")
		.map((row) => row.trim())
		.find((row) => row.startsWith("theme="))
		?.slice(6);
	const choice = mode === "system" ? stored : mode;
	const dark =
		choice === "dark" ||
		(choice !== "light" &&
			window.matchMedia("(prefers-color-scheme: dark)").matches);
	document.documentElement.classList.toggle("dark", dark);
	document.documentElement.classList.toggle("light", !dark);
}

function bindThemeControls() {
	const root = document.documentElement;
	const media = window.matchMedia("(prefers-color-scheme: dark)");
	const buttons = document.querySelectorAll<HTMLButtonElement>(
		"[data-theme-choice]",
	);
	function storedTheme(): ThemeMode {
		const value = document.cookie
			.split(";")
			.map((row) => row.trim())
			.find((row) => row.startsWith("theme="))
			?.slice(6);
		return value === "light" || value === "dark" ? value : "system";
	}
	function apply(theme: ThemeMode, persist: boolean) {
		if (persist) {
			const secure = location.protocol === "https:" ? "; Secure" : "";
			document.cookie =
				theme === "system"
					? "theme=; path=/; max-age=0; SameSite=Lax" + secure
					: "theme=" +
						theme +
						"; path=/; max-age=31536000; SameSite=Lax" +
						secure;
		}
		const dark = theme === "dark" || (theme === "system" && media.matches);
		root.classList.toggle("dark", dark);
		root.classList.toggle("light", !dark);
		buttons.forEach((button) => {
			const active = button.dataset.themeChoice === theme;
			button.setAttribute("aria-pressed", String(active));
			button.classList.toggle("!border-brand-500", active);
			button.classList.toggle("!text-brand-600", active);
		});
	}
	buttons.forEach((button) =>
		button.addEventListener("click", () => {
			const choice = button.dataset.themeChoice;
			if (choice === "light" || choice === "dark" || choice === "system")
				apply(choice, true);
		}),
	);
	document
		.getElementById("theme-toggle")
		?.addEventListener("click", () =>
			apply(root.classList.contains("dark") ? "light" : "dark", true),
		);
	media.addEventListener("change", () => {
		if (storedTheme() === "system") apply("system", false);
	});
	apply(storedTheme(), false);
}

export function themeInitializationScript(mode: ThemeMode = "system") {
	return `(${initializeTheme.toString()})(${JSON.stringify(mode)})`;
}

export const themeControlsScript = `(${bindThemeControls.toString()})()`;
