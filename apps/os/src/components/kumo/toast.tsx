import {
	createKumoToastManager,
	Toasty,
} from "@cloudflare/kumo/components/toast";
import { type ReactNode, useLayoutEffect, useState } from "react";

/**
 * One Kumo manager shared by the whole app session. Keeping it at module scope
 * lets mutation callbacks report feedback without coupling application code to
 * a React context, while Toasty remains the single accessible viewport.
 */
const osToastManager = createKumoToastManager();

type ToastOptions = {
	description?: ReactNode;
	duration?: number;
	id?: string;
};

type ToastVariant = "default" | "success" | "error" | "warning" | "info";

function notify(
	variant: ToastVariant,
	title: ReactNode,
	{ description, duration, id }: ToastOptions = {},
) {
	return osToastManager.add({
		id,
		title,
		description,
		variant,
		...(duration === undefined ? {} : { timeout: duration }),
	});
}

/**
 * Imperative notification API for mutation callbacks. It intentionally keeps
 * the existing Sonner-shaped success/error/loading methods so application
 * feedback call sites stay terse while Kumo owns the rendered control.
 */
const toast = {
	success: (title: ReactNode, options?: ToastOptions) =>
		notify("success", title, options),
	error: (title: ReactNode, options?: ToastOptions) =>
		notify("error", title, options),
	warning: (title: ReactNode, options?: ToastOptions) =>
		notify("warning", title, options),
	info: (title: ReactNode, options?: ToastOptions) =>
		notify("info", title, options),
	message: (title: ReactNode, options?: ToastOptions) =>
		notify("default", title, options),
	loading: (title: ReactNode, options?: Omit<ToastOptions, "duration">) =>
		notify("info", title, { ...options, duration: 0 }),
	dismiss: (id?: string) => osToastManager.close(id),
};

/**
 * Kumo draws its close control as a 20px square pinned 8px inside the toast
 * corner. On phone widths and coarse pointers this outlet grows that same
 * control to a 44px corner hit area (the glyph stays 12px) and reserves the
 * matching gutter in the text column, so long titles wrap beside it rather
 * than under it. The selectors only reach this outlet's portal container;
 * Kumo still owns the queue, announcements, swipe, Escape and toast lifetime.
 */
const toastOutletClassName = [
	"[&_[data-kumo-part=close]]:max-sm:top-0 [&_[data-kumo-part=close]]:max-sm:right-0 [&_[data-kumo-part=close]]:max-sm:size-11 [&_[data-kumo-part=close]]:max-sm:rounded-tr-xl",
	"[&_[data-kumo-part=close]]:coarse:top-0 [&_[data-kumo-part=close]]:coarse:right-0 [&_[data-kumo-part=close]]:coarse:size-11 [&_[data-kumo-part=close]]:coarse:rounded-tr-xl",
	"[&_:has(>[data-toast-title])]:max-sm:pr-7 [&_:has(>[data-toast-title])]:coarse:pr-7 [&_:has(>[data-toast-title])]:[overflow-wrap:anywhere]",
].join(" ");

function Toaster() {
	// Toasty portals into document.body by default. A body-level container of
	// our own keeps that placement and gives the classes above their scope; it
	// exists from the first render so the manager subscribes as early as before.
	const [outlet] = useState(() => {
		const element = document.createElement("div");
		element.className = toastOutletClassName;
		element.dataset.osToastOutlet = "";
		return element;
	});
	useLayoutEffect(() => {
		document.body.append(outlet);
		return () => outlet.remove();
	}, [outlet]);
	return (
		<Toasty container={outlet} toastManager={osToastManager}>
			{null}
		</Toasty>
	);
}

export { osToastManager, toast, Toaster, type ToastOptions };
