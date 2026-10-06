import {
	createKumoToastManager,
	Toasty,
} from "@cloudflare/kumo/components/toast";
import type { ReactNode } from "react";

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

function Toaster() {
	return <Toasty toastManager={osToastManager}>{null}</Toasty>;
}

export { osToastManager, toast, Toaster, type ToastOptions };
