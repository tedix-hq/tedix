import {
	BaseWindow,
	type Menu,
	type Rectangle,
	screen,
	type Tray,
} from "electron";

export function bindTrayMenu(
	tray: Tray,
	openInput: () => void,
	createMenu: () => Menu,
): void {
	const showMenu = (bounds: Rectangle) => {
		// Tray.popUpContextMenu ignores coordinates on macOS and clicks the
		// stored status item. Use the event's icon bounds and a window on its
		// display: Menu.popup coordinates are relative to that window's content.
		const { workArea } = screen.getDisplayMatching(bounds);
		const window = new BaseWindow({
			x: workArea.x,
			y: workArea.y,
			width: 1,
			height: 1,
			show: false,
			frame: false,
			focusable: false,
			skipTaskbar: true,
		});
		const origin = window.getContentBounds();
		createMenu().popup({
			window,
			x: bounds.x - origin.x,
			y: bounds.y + bounds.height - origin.y,
			callback: () => window.destroy(),
		});
	};
	tray.on("click", (event, bounds) => {
		if (event.ctrlKey) return showMenu(bounds);
		openInput();
	});
	tray.on("right-click", (_event, bounds) => showMenu(bounds));
}
