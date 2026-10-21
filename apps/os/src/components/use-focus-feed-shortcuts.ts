import { useEffect, type RefObject } from "react";

export function useFocusFeedShortcuts(root: RefObject<HTMLDivElement | null>) {
	useEffect(() => {
		const key = (e: KeyboardEvent) => {
			const owner = root.current;
			const target = e.target;
			if (
				e.defaultPrevented ||
				e.isComposing ||
				e.altKey ||
				e.ctrlKey ||
				e.metaKey ||
				e.shiftKey ||
				!owner ||
				!(target instanceof HTMLElement) ||
				!owner.contains(target) ||
				target !== document.activeElement ||
				target.isContentEditable ||
				target.closest(
					"[role=dialog],[role=alertdialog],[role=menu],[role=listbox],dialog[open],[contenteditable]:not([contenteditable=false])",
				) ||
				(target !== owner && !target.matches("[data-focus-row]"))
			)
				return;
			const rows = [...owner.querySelectorAll<HTMLElement>("[data-focus-row]")];
			if (!rows.length) return;
			let index = rows.indexOf(target);
			if (e.key === "j" || e.key === "k") {
				e.preventDefault();
				index = Math.max(
					0,
					Math.min(rows.length - 1, index + (e.key === "j" ? 1 : -1)),
				);
				rows[index]?.focus();
				rows[index]?.scrollIntoView?.({
					block: "nearest",
					behavior: "instant",
				});
				return;
			}
			if (index < 0 || e.repeat) return;
			const row = rows[index];
			if (e.key === "o") {
				e.preventDefault();
				row?.querySelector<HTMLAnchorElement>("a")?.click();
			}
			const action = (
				{ p: "Pin", h: "Hide", n: "Not important" } as Record<string, string>
			)[e.key];
			if (action) {
				e.preventDefault();
				row
					?.querySelector<HTMLButtonElement>(`button[aria-label="${action}"]`)
					?.click();
			}
		};
		document.addEventListener("keydown", key);
		return () => document.removeEventListener("keydown", key);
	}, [root]);
}
