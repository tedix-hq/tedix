import type { FocusClipHit } from "./focus-clip-findings";

/**
 * The in-page half of the clipped-control audit. focus-clip.spec.ts
 * serializes these functions into its page.evaluate source, so each one may
 * reference browser globals and the other exported names here, but no other
 * module-scope value (including this import, which is type-only and erased).
 */

export function describeControl(el: Element) {
	const name =
		el.getAttribute("aria-label") ??
		el.getAttribute("name") ??
		el.getAttribute("placeholder") ??
		(el.textContent ?? "").trim().slice(0, 32);
	const cls = [...el.classList].slice(0, 3).join(".");
	const id =
		el.id && !el.id.startsWith("base-ui-") && !/_r_/.test(el.id)
			? `#${el.id}`
			: "";
	return `${el.tagName.toLowerCase()}${id}${cls ? `.${cls}` : ""}${name ? ` "${name}"` : ""}`;
}

/**
 * The shortest chain of `tag`/stable-attribute/`:nth-of-type` segments from
 * the element up through its ancestors that resolves to exactly that
 * element. The result is verified live, so a reported hit can never carry an
 * identifier that does not map back to the owning element; it feeds straight
 * into `page.locator()`.
 */
export function controlSelector(el: Element) {
	const doc = el.ownerDocument;
	const segment = (node: Element) => {
		const tag = node.tagName.toLowerCase();
		const id = node.id;
		if (
			id &&
			!id.startsWith("base-ui-") &&
			!/_r_/.test(id) &&
			/^[A-Za-z_][\w-]*$/.test(id)
		)
			return `#${id}`;
		let part = tag;
		for (const attr of ["data-testid", "data-slot", "name", "aria-label"]) {
			const value = node.getAttribute(attr);
			if (value && !/["\\\n\r\f]/.test(value)) {
				part = `${tag}[${attr}="${value}"]`;
				break;
			}
		}
		const parent = node.parentElement;
		if (parent) {
			const siblings = [...parent.children].filter(
				(child) => child.tagName === node.tagName,
			);
			if (siblings.length > 1)
				part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
		}
		return part;
	};
	const parts: string[] = [];
	let selector = "";
	for (
		let node: Element | null = el;
		node && node !== doc.documentElement;
		node = node.parentElement
	) {
		parts.unshift(segment(node));
		selector = parts.join(" > ");
		try {
			const matches = doc.querySelectorAll(selector);
			if (matches.length === 1 && matches[0] === el) return selector;
		} catch {
			// A fragment can still be malformed; keep climbing.
		}
	}
	// The body-rooted chain is unique by construction; verify anyway so a hit
	// can never report a selector that does not map to its element.
	const matches = doc.querySelectorAll(selector);
	if (matches.length !== 1 || matches[0] !== el)
		throw new Error(`clipped-control selector misses its element: ${selector}`);
	return selector;
}

export function focusClipAudit(): FocusClipHit[] {
	const px = (value: string) => Number.parseFloat(value) || 0;
	const visible = (el: Element) => {
		const css = getComputedStyle(el);
		const rect = el.getBoundingClientRect();
		return (
			css.visibility !== "hidden" &&
			css.display !== "none" &&
			Number(css.opacity) > 0.05 &&
			rect.width > 2 &&
			rect.height > 2 &&
			!el.closest(".sr-only, [hidden], [inert], [aria-hidden='true']")
		);
	};
	// How far the painted edge (outer box-shadow rings, outline) reaches past the border box.
	const paintExtent = (el: Element) => {
		const css = getComputedStyle(el);
		const extent = { top: 0, right: 0, bottom: 0, left: 0 };
		for (const shadow of css.boxShadow.split(/,(?![^(]*\))/)) {
			if (shadow === "none" || shadow.includes("inset")) continue;
			const lengths = (
				shadow
					.replace(
						/rgba?\([^)]*\)|oklch\([^)]*\)|color\([^)]*\)|oklab\([^)]*\)/g,
						"",
					)
					.match(/-?[\d.]+px/g) ?? []
			).map(px);
			const [x = 0, y = 0, blur = 0, spread = 0] = lengths;
			// Rings and borders are hard edges; a soft elevation shadow may fade into a clip.
			const reach = spread;
			if (blur > 0 || reach <= 0 || /rgba?\([^)]*,\s*0\)|\/\s*0\)/.test(shadow))
				continue;
			extent.top = Math.max(extent.top, reach - y);
			extent.bottom = Math.max(extent.bottom, reach + y);
			extent.left = Math.max(extent.left, reach - x);
			extent.right = Math.max(extent.right, reach + x);
		}
		if (css.outlineStyle !== "none") {
			const reach = px(css.outlineWidth) + px(css.outlineOffset);
			for (const side of ["top", "right", "bottom", "left"] as const)
				extent[side] = Math.max(extent[side], reach);
		}
		return extent;
	};
	const owner = (el: Element) =>
		el.closest(
			"[class*='deck'], [class*='feed'], [class*='decision-card'], [class*='card-review'], [data-deck], [data-feed]",
		)
			? "deck-feed"
			: "";
	const findings: FocusClipHit[] = [];
	const controls = [
		...document.querySelectorAll<HTMLElement>(
			"input:not([type=hidden]), textarea, select, button, a[href], summary, [role=combobox], [role=tab], [role=switch], [role=checkbox], [role=radio], [role=menuitem], [role=option], [contenteditable=true], [tabindex]:not([tabindex='-1'])",
		),
	].filter((el) => visible(el) && !(el as HTMLButtonElement).disabled);
	for (const el of controls) {
		// Focus can paint on the box or on a pseudo-element (a resize rail's bar).
		const look = (target: Element) =>
			[null, "::before", "::after"]
				.map((pseudo) => {
					const css = getComputedStyle(target, pseudo);
					return `${css.outlineStyle === "none" ? "" : `${css.outlineWidth} ${css.outlineColor}`}|${css.boxShadow}|${css.backgroundColor}|${css.borderColor}`;
				})
				.join("/");
		// A dialog may have focused the control already; compare from rest.
		if (document.activeElement === el) el.blur();
		const hadFocus = document.activeElement === el;
		const resting = look(el);
		el.focus({ preventScroll: true });
		if (document.activeElement !== el) continue;
		const rect = el.getBoundingClientRect();
		const reach = paintExtent(el);
		const tag = owner(el);
		const control = `${tag ? "[deck-feed] " : ""}${describeControl(el)}`;
		let selector: string | undefined;
		const locate = () => (selector ??= controlSelector(el));
		// Buttons, links and tabs must show that they hold focus.
		if (
			el.matches("button, a[href], [role=tab]") &&
			!hadFocus &&
			look(el) === resting &&
			!el.matches(":has(:focus-visible)")
		)
			findings.push({
				control,
				selector: locate(),
				kind: "focus",
				sides: "",
				overshoot: 0,
				clipper: "no focus indicator",
				clipperSelector: "",
			});
		let node: Element | null = el.parentElement;
		let scrolledAway = false;
		while (node && node !== document.documentElement) {
			const css = getComputedStyle(node);
			const clipsX = css.overflowX !== "visible";
			const clipsY = css.overflowY !== "visible";
			if (clipsX || clipsY) {
				const box = node.getBoundingClientRect();
				const margin =
					css.overflowX === "clip" || css.overflowY === "clip"
						? px(css.overflowClipMargin)
						: 0;
				const left = box.left + node.clientLeft - margin;
				const top = box.top + node.clientTop - margin;
				const clip = {
					left,
					top,
					right: left + node.clientWidth + 2 * margin,
					bottom: top + node.clientHeight + 2 * margin,
				};
				const scrollsX =
					css.overflowX !== "hidden" &&
					css.overflowX !== "clip" &&
					node.scrollWidth > node.clientWidth + 1;
				const scrollsY =
					css.overflowY !== "hidden" &&
					css.overflowY !== "clip" &&
					node.scrollHeight > node.clientHeight + 1;
				const inside = {
					left: rect.left >= clip.left - 0.5,
					right: rect.right <= clip.right + 0.5,
					top: rect.top >= clip.top - 0.5,
					bottom: rect.bottom <= clip.bottom + 0.5,
				};
				const intersects =
					rect.right > clip.left &&
					rect.left < clip.right &&
					rect.bottom > clip.top &&
					rect.top < clip.bottom;
				// Scrolled out of this container's view is not clipping; outer clips are moot.
				if (
					!intersects ||
					(scrollsX && !(inside.left && inside.right)) ||
					(scrollsY && !(inside.top && inside.bottom))
				)
					break;
				// A border box cut on an axis the container cannot scroll is always a defect.
				const borderCut: string[] = [];
				let borderOver = 0;
				for (const [side, axisClips, scrolls, over] of [
					["left", clipsX, scrollsX, clip.left - rect.left],
					["right", clipsX, scrollsX, rect.right - clip.right],
					["top", clipsY, scrollsY, clip.top - rect.top],
					["bottom", clipsY, scrollsY, rect.bottom - clip.bottom],
				] as const) {
					if (axisClips && !scrolls && over > 0.5 && over < 48) {
						borderCut.push(side);
						borderOver = Math.max(borderOver, over);
					}
				}
				if (borderCut.length)
					findings.push({
						control,
						selector: locate(),
						kind: "border",
						sides: borderCut.join(","),
						overshoot: Math.round(borderOver * 10) / 10,
						clipper: describeControl(node),
						clipperSelector: controlSelector(node),
					});
				// A fully visible control whose ring or outline is cut.
				else if (inside.left && inside.right && inside.top && inside.bottom) {
					const ringCut: string[] = [];
					let ringOver = 0;
					// On a scrolling axis only the scroll extent clips for good;
					// any other edge is just the current scroll position.
					const atStart = (scrolls: boolean, offset: number) =>
						!scrolls || Math.abs(offset) <= 1;
					const atEnd = (scrolls: boolean, offset: number, max: number) =>
						!scrolls || Math.abs(offset) >= max - 1;
					for (const [side, axisClips, over, edge] of [
						[
							"left",
							clipsX,
							clip.left - (rect.left - reach.left),
							atStart(scrollsX, node.scrollLeft),
						],
						[
							"right",
							clipsX,
							rect.right + reach.right - clip.right,
							atEnd(
								scrollsX,
								node.scrollLeft,
								node.scrollWidth - node.clientWidth,
							),
						],
						[
							"top",
							clipsY,
							clip.top - (rect.top - reach.top),
							atStart(scrollsY, node.scrollTop),
						],
						[
							"bottom",
							clipsY,
							rect.bottom + reach.bottom - clip.bottom,
							atEnd(
								scrollsY,
								node.scrollTop,
								node.scrollHeight - node.clientHeight,
							),
						],
					] as const) {
						if (axisClips && over > 0.5) {
							if (!edge) scrolledAway = true;
							else {
								ringCut.push(side);
								ringOver = Math.max(ringOver, over);
							}
						}
					}
					if (ringCut.length)
						findings.push({
							control,
							selector: locate(),
							kind: "ring",
							sides: ringCut.join(","),
							overshoot: Math.round(ringOver * 10) / 10,
							clipper: describeControl(node),
							clipperSelector: controlSelector(node),
						});
				}
			}
			if (scrolledAway) break;
			if (css.position === "fixed") break;
			node = node.parentElement;
		}
		// Form fields stay inside the parent's content column.
		if (el.matches("input, textarea, select, [role=combobox]")) {
			const parent = el.parentElement;
			if (parent && getComputedStyle(parent).display !== "contents") {
				const box = parent.getBoundingClientRect();
				const css = getComputedStyle(parent);
				const left = box.left + parent.clientLeft + px(css.paddingLeft);
				const right =
					box.left +
					parent.clientLeft +
					parent.clientWidth -
					px(css.paddingRight);
				const over = Math.max(left - rect.left, rect.right - right);
				if (over > 0.5 && parent.scrollWidth <= parent.clientWidth + 1)
					findings.push({
						control,
						selector: locate(),
						kind: "column",
						sides: left - rect.left > 0.5 ? "left" : "right",
						overshoot: Math.round(over * 10) / 10,
						clipper: describeControl(parent),
						clipperSelector: controlSelector(parent),
					});
			}
		}
		el.blur();
	}
	return findings;
}
