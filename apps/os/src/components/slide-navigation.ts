/**
 * Slide keyboard grammar shared by the editor, the read view and present mode:
 * Right/Down/PageDown/Space go forward, Left/Up/PageUp go back, Home and End
 * jump to the ends.
 */
export function slideNavigationTarget(
	key: string,
	index: number,
	count: number,
): number | null {
	const target = {
		ArrowRight: index + 1,
		ArrowDown: index + 1,
		PageDown: index + 1,
		" ": index + 1,
		ArrowLeft: index - 1,
		ArrowUp: index - 1,
		PageUp: index - 1,
		Home: 0,
		End: count - 1,
	}[key];
	if (target === undefined || count === 0) return null;
	return Math.max(0, Math.min(count - 1, target));
}

/**
 * True when a key event belongs to the control that received it: typing,
 * menus, list boxes and buttons keep their own meaning for arrows and Space.
 */
export function ownsSlideKeys(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	return target.isContentEditable || target.closest(CONTROL_SELECTOR) !== null;
}

const CONTROL_SELECTOR =
	'input, textarea, select, button, a[href], [role="menu"], [role="listbox"], [role="dialog"], [role="option"], [role="tab"]';

/** A bare letter shortcut: no modifier, so Cmd+F and Ctrl+E stay the browser's. */
export function bareKey(event: KeyboardEvent | React.KeyboardEvent) {
	return event.metaKey || event.ctrlKey || event.altKey
		? null
		: event.key.toLowerCase();
}
