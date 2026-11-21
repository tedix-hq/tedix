/// <reference types="bun-types" />
import { mock, test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type {
	BaseWindowConstructorOptions,
	Menu,
	PopupOptions,
	Rectangle,
	Tray,
} from "electron";

let workArea = { x: 0, y: 25, width: 1920, height: 1055 };
const windows: MenuWindow[] = [];
class MenuWindow {
	destroyed = false;
	constructor(readonly options: BaseWindowConstructorOptions) {
		windows.push(this);
	}
	getContentBounds() {
		return { x: this.options.x!, y: this.options.y! };
	}
	destroy() {
		this.destroyed = true;
	}
}
let matchedBounds: Rectangle | undefined;
mock.module("electron", () => ({
	BaseWindow: MenuWindow,
	screen: {
		getDisplayMatching(bounds: Rectangle) {
			matchedBounds = bounds;
			return { workArea };
		},
	},
}));
const { bindTrayMenu } = await import("./tray-menu");

test("tray clicks anchor fresh menus below the clicked icon and leave left-click for input", () => {
	const tray = new EventEmitter();
	let inputs = 0;
	const popups: PopupOptions[] = [];
	bindTrayMenu(
		tray as Tray,
		() => inputs++,
		() =>
			({
				popup: (options: PopupOptions) => popups.push(options),
			}) as unknown as Menu,
	);

	for (const display of [
		{ x: 0, y: 0 },
		{ x: -1920, y: -400 },
		{ x: 1920, y: 1080 },
	]) {
		workArea = { x: display.x, y: display.y + 25, width: 1920, height: 1055 };
		const bounds = { x: display.x + 1700, y: display.y, width: 24, height: 25 };
		for (const event of ["right-click", "click"]) {
			tray.emit(event, { ctrlKey: event === "click" }, bounds);
			assert.equal(inputs, 0);
			assert.deepEqual(matchedBounds, bounds);
			const popup = popups.at(-1)!;
			const window = windows.at(-1)!;
			assert.equal(popup.window, window);
			assert.equal(window.options.show, false);
			assert.equal(window.options.focusable, false);
			assert.equal(window.options.x, workArea.x);
			assert.equal(window.options.y, workArea.y);
			const origin = window.getContentBounds();
			assert.equal(origin.x + popup.x!, bounds.x);
			assert.equal(origin.y + popup.y!, bounds.y + bounds.height);
			popup.callback!();
			assert.equal(window.destroyed, true);
		}
	}
	assert.equal(popups.length, 6);
	tray.emit("click", { ctrlKey: false }, { x: 0, y: 0, width: 24, height: 25 });
	assert.equal(inputs, 1);
	assert.equal(popups.length, 6);
	assert.equal(windows.length, 6);
});
