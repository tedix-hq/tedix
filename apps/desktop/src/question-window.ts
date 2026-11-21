import type { PanelApi, QuestionView } from "./api";

/**
 * The app's own question window: macOS stacks the buttons of a native
 * dialog with little text and opens it on whichever screen it likes. Here
 * the buttons sit in one row, the default on the right, and the app places
 * the window on the screen the Tedix window is on.
 */
declare const tedixShell: PanelApi;
const message = document.getElementById("message")!;
const detail = document.getElementById("detail")!;
const box = document.getElementById("box")!;
const check = document.getElementById("check") as HTMLInputElement;
const buttons = document.getElementById("buttons")!;

tedixShell.onQuestion((view: QuestionView) => {
	document.title = view.message;
	message.textContent = view.message;
	detail.replaceChildren(
		...view.detail
			.split(/\n\n+/)
			.filter(Boolean)
			.map((text) =>
				Object.assign(document.createElement("p"), { textContent: text }),
			),
	);
	box.hidden = !view.checkboxLabel;
	document.getElementById("boxLabel")!.textContent = view.checkboxLabel ?? "";
	check.checked = view.checkboxChecked === true;
	const answer = (response: number) =>
		void tedixShell.answerQuestion(response, check.checked);
	buttons.replaceChildren(
		...view.buttons.map((label, index) => {
			const button = document.createElement("button");
			button.type = "button";
			button.className = index === view.defaultId ? "btn primary" : "btn";
			button.textContent = label;
			button.onclick = () => answer(index);
			return button;
		}),
	);
	document.onkeydown = (event) => {
		if (event.key === "Escape") answer(view.cancelId);
		if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement))
			answer(view.defaultId);
	};
	(buttons.children[view.defaultId] as HTMLButtonElement | undefined)?.focus();
	void tedixShell.questionSize(Math.ceil(document.body.scrollHeight));
});
