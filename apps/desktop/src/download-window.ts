import type { DownloadView, PanelApi } from "./api";

/** The small Updating Tedix window: how far the download is, and Cancel. */
declare const tedixShell: PanelApi;
const title = document.getElementById("title")!;
const bar = document.getElementById("bar") as HTMLProgressElement;
const amount = document.getElementById("amount")!;
const cancel = document.getElementById("cancel") as HTMLButtonElement;

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

function draw(view: DownloadView): void {
	if (view.total > 0) {
		bar.max = view.total;
		bar.value = Math.min(view.received, view.total);
		amount.textContent = `${megabytes(view.received)} of ${megabytes(view.total)}`;
	} else {
		bar.removeAttribute("value");
		amount.textContent = megabytes(view.received);
	}
	if (view.ended) {
		title.textContent = "The update did not download";
		amount.textContent = view.ended;
		cancel.textContent = "Close";
	} else
		title.textContent =
			view.total > 0 && view.received >= view.total
				? "Checking update…"
				: "Downloading update…";
}

cancel.onclick = () => {
	if (cancel.textContent === "Close") window.close();
	else void tedixShell.cancelDownload();
};
cancel.focus();
tedixShell.onDownload(draw);
