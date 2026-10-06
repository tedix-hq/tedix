import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@cloudflare/kumo/components/dialog", () => {
	type PartProps = {
		children?: ReactNode;
		className?: string;
		render?: ReactElement;
		role?: "dialog" | "alertdialog";
	};

	function Part({ children, className }: PartProps) {
		return <div className={className}>{children}</div>;
	}

	function Close({ children, className, render: _render }: PartProps) {
		return (
			<div className={className} data-kumo-dialog-close="">
				{children}
			</div>
		);
	}

	const DialogContent = Part;
	const Dialog = Object.assign(DialogContent, {
		Root: Part,
		Trigger: Part,
		Title: Part,
		Description: Part,
		Close,
	});

	return { Dialog };
});

import { AlertDialogAction, AlertDialogCancel } from "./alert-dialog";

describe("Kumo AlertDialog adapter", () => {
	it("routes both confirm and cancel controls through Kumo close semantics", () => {
		const html = renderToStaticMarkup(
			<>
				<AlertDialogAction>Confirm</AlertDialogAction>
				<AlertDialogCancel>Cancel</AlertDialogCancel>
			</>,
		);

		expect(html.match(/data-kumo-dialog-close/g)).toHaveLength(2);
		expect(html).toContain("Confirm");
		expect(html).toContain("Cancel");
	});
});
