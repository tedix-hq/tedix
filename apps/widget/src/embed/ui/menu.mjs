/**
 * A compact single-choice menu for the Shadow DOM widget, drawn like the OS
 * Kumo dropdown: a ghost trigger naming the current choice, and a floating
 * list with a check beside the selected item. Framework-neutral on purpose:
 * the widget ships to third-party hosts that do not load React.
 *
 * Items are `{ value, label, group?, avatar?, selected? }`: items sharing a
 * `group` render under one heading, and `avatar` adds a monogram.
 */

const CHECK =
	'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
const CHEVRON =
	'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4"/></svg>';

function monogram(label) {
	const avatar = document.createElement("span");
	avatar.className = "tedix-menu-avatar";
	avatar.setAttribute("aria-hidden", "true");
	avatar.textContent = [...label.trim()][0]?.toUpperCase() ?? "?";
	return avatar;
}

/**
 * @param {{ className: string, label: string, placement: "above" | "below", onSelect: (value: string) => void }} input
 * `placement` opens the list above the trigger when it sits at the bottom of the panel.
 */
export function createWidgetMenu(input) {
	const element = document.createElement("div");
	element.className = `tedix-menu ${input.className}`;
	element.dataset.placement = input.placement;
	element.hidden = true;
	const trigger = document.createElement("button");
	trigger.type = "button";
	trigger.className = "tedix-menu-trigger";
	trigger.setAttribute("aria-haspopup", "menu");
	trigger.setAttribute("aria-expanded", "false");
	const list = document.createElement("div");
	list.className = "tedix-menu-list";
	list.setAttribute("role", "menu");
	list.setAttribute("aria-label", input.label);
	list.hidden = true;
	element.append(trigger, list);

	const items = () => [...list.querySelectorAll(".tedix-menu-item")];
	const onOutside = (event) => {
		if (!event.composedPath().includes(element)) close();
	};
	const open = () => {
		if (trigger.disabled || !list.hidden) return;
		list.hidden = false;
		trigger.setAttribute("aria-expanded", "true");
		const all = items();
		(
			all.find((item) => item.getAttribute("aria-checked") === "true") ?? all[0]
		)?.focus();
		document.addEventListener("pointerdown", onOutside, true);
	};
	const close = () => {
		if (list.hidden) return;
		list.hidden = true;
		trigger.setAttribute("aria-expanded", "false");
		document.removeEventListener("pointerdown", onOutside, true);
	};
	trigger.addEventListener("click", () => (list.hidden ? open() : close()));
	trigger.addEventListener("keydown", (event) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			open();
		}
	});
	list.addEventListener("keydown", (event) => {
		const all = items();
		const index = all.indexOf(event.target);
		const move = (next) => {
			event.preventDefault();
			all[(next + all.length) % all.length]?.focus();
		};
		if (event.key === "ArrowDown") move(index + 1);
		else if (event.key === "ArrowUp") move(index - 1);
		else if (event.key === "Home") move(0);
		else if (event.key === "End") move(all.length - 1);
		else if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			close();
			trigger.focus();
		} else if (event.key === "Tab") close();
	});
	list.addEventListener("click", (event) => {
		const item = event.target.closest(".tedix-menu-item");
		if (!item) return;
		close();
		trigger.focus();
		input.onSelect(item.dataset.value);
	});

	return {
		element,
		trigger,
		close,
		render({ items: next, triggerLabel, triggerAvatar, hidden, disabled }) {
			element.hidden = hidden;
			trigger.disabled = disabled;
			if (hidden || disabled) close();
			trigger.setAttribute("aria-label", `${input.label}: ${triggerLabel}`);
			trigger.title = triggerLabel;
			const text = document.createElement("span");
			text.className = "tedix-menu-trigger-label";
			text.textContent = triggerLabel;
			const chevron = document.createElement("span");
			chevron.className = "tedix-menu-chevron";
			chevron.innerHTML = CHEVRON;
			trigger.replaceChildren(
				...(triggerAvatar ? [monogram(triggerLabel)] : []),
				text,
				chevron,
			);
			element.dataset.value = next.find((item) => item.selected)?.value ?? "";
			let group;
			const nodes = [];
			for (const item of next) {
				if (item.group && item.group !== group) {
					const heading = document.createElement("div");
					heading.className = "tedix-menu-group";
					heading.setAttribute("role", "presentation");
					heading.textContent = item.group;
					nodes.push(heading);
				}
				group = item.group;
				const button = document.createElement("button");
				button.type = "button";
				button.className = "tedix-menu-item";
				button.setAttribute("role", "menuitemradio");
				button.setAttribute("aria-checked", String(Boolean(item.selected)));
				button.tabIndex = -1;
				button.dataset.value = item.value;
				const check = document.createElement("span");
				check.className = "tedix-menu-check";
				check.innerHTML = item.selected ? CHECK : "";
				const label = document.createElement("span");
				label.className = "tedix-menu-label";
				label.textContent = item.label;
				button.append(
					check,
					...(item.avatar ? [monogram(item.label)] : []),
					label,
				);
				nodes.push(button);
			}
			list.replaceChildren(...nodes);
		},
	};
}
