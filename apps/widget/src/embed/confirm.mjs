export const confirmPortableWrite = (root, tool, preview, signal) =>
	new Promise((resolve) => {
		if (
			signal?.aborted ||
			root.querySelector("[data-tedix-portable-confirmation]")
		)
			return resolve(false);
		const dialog = document.createElement("dialog");
		dialog.dataset.tedixPortableConfirmation = "";
		dialog.innerHTML =
			"<strong></strong><pre></pre><form method=dialog><button value=no>Cancel</button><button value=yes></button></form>";
		const [title, summary, cancel, confirm] =
			dialog.querySelectorAll("strong,pre,button");
		title.textContent = tool.action.confirmationTitle;
		dialog.setAttribute("aria-label", tool.action.confirmationTitle);
		summary.textContent = JSON.stringify(preview, null, 2).slice(0, 4000);
		confirm.textContent = tool.action.confirmationLabel;
		let settled = false;
		const finish = (accepted) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", abort);
			dialog.remove();
			resolve(accepted);
		};
		const abort = () => finish(false);
		dialog.addEventListener(
			"close",
			() => finish(!signal?.aborted && dialog.returnValue === "yes"),
			{ once: true },
		);
		signal?.addEventListener("abort", abort, { once: true });
		root.append(dialog);
		dialog.showModal();
		cancel.focus();
	});
