import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../src/components/kumo/button";
import { WorkspaceFilePreview } from "../src/components/workspace-file-preview";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.dataset.mode = theme;
document.documentElement.dataset.theme = "tedix";
const client = new QueryClient({
	defaultOptions: {
		queries: { retry: false, refetchOnWindowFocus: false },
	},
});
// The spec dispatches this to reproduce the periodic signed-URL refetch.
window.addEventListener("preview-refresh", () => {
	void client.invalidateQueries();
});

const SELECTIONS = {
	"clip-a": {
		workspaceId: "11111111-1111-4111-8111-111111111111",
		resourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	},
	"clip-b": {
		workspaceId: "22222222-2222-4222-8222-222222222222",
		resourceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	},
	photo: {
		workspaceId: "11111111-1111-4111-8111-111111111111",
		resourceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
	},
} as const;

/** A real WebM clip recorded in-page so no media fixture bytes are checked in. */
async function recordClip(): Promise<string> {
	const canvas = document.createElement("canvas");
	canvas.width = 160;
	canvas.height = 90;
	const context = canvas.getContext("2d")!;
	const stream = canvas.captureStream(30);
	const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
	const chunks: Blob[] = [];
	recorder.ondataavailable = (event) => {
		if (event.data.size > 0) chunks.push(event.data);
	};
	recorder.start(100);
	const started = performance.now();
	while (performance.now() - started < 2000) {
		const progress = (performance.now() - started) / 2000;
		context.fillStyle = "#1d4ed8";
		context.fillRect(0, 0, 160, 90);
		context.fillStyle = "#f8fafc";
		context.fillRect(8 + progress * 120, 36, 24, 18);
		await new Promise((resolve) => setTimeout(resolve, 33));
	}
	recorder.stop();
	await new Promise<void>((resolve) => {
		recorder.onstop = () => resolve();
	});
	const buffer = await new Blob(chunks, { type: "video/webm" }).arrayBuffer();
	let binary = "";
	for (const byte of new Uint8Array(buffer))
		binary += String.fromCharCode(byte);
	return btoa(binary);
}

function Fixture() {
	const [selection, setSelection] = useState<keyof typeof SELECTIONS>("clip-a");
	return (
		<main className="mx-auto grid w-full max-w-3xl gap-4 p-4 text-kumo-default">
			<h1 className="text-lg font-medium">File preview</h1>
			<div
				className="flex flex-wrap gap-2"
				role="group"
				aria-label="File selection"
			>
				<Button
					size="sm"
					variant={selection === "clip-a" ? "secondary" : "outline"}
					onClick={() => setSelection("clip-a")}
				>
					Clip A
				</Button>
				<Button
					size="sm"
					variant={selection === "clip-b" ? "secondary" : "outline"}
					onClick={() => setSelection("clip-b")}
				>
					Clip B
				</Button>
				<Button
					size="sm"
					variant={selection === "photo" ? "secondary" : "outline"}
					onClick={() => setSelection("photo")}
				>
					Photo
				</Button>
			</div>
			<WorkspaceFilePreview {...SELECTIONS[selection]} />
		</main>
	);
}

(window as unknown as { __clipBytes: string }).__clipBytes = await recordClip();
document.documentElement.dataset.mediaReady = "1";
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<Fixture />
	</QueryClientProvider>,
);
