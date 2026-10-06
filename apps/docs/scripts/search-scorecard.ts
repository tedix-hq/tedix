import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
	runSearchScorecard,
	type PagefindSearch,
} from "../src/search-scorecard";

const dist = resolve(process.argv[2] ?? "dist");
const pagefindEntry = join(dist, "pagefind", "pagefind.js");
await stat(pagefindEntry);

const contentTypes: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".wasm": "application/wasm",
};

const server = createServer(async (request, response) => {
	try {
		const pathname = decodeURIComponent(
			new URL(request.url ?? "/", "http://127.0.0.1").pathname,
		);
		const file = resolve(dist, `.${pathname}`);
		if (file !== dist && !file.startsWith(`${dist}${sep}`)) {
			response.writeHead(400).end("invalid path");
			return;
		}
		const metadata = await stat(file);
		if (!metadata.isFile()) throw new Error("not a file");
		response.writeHead(200, {
			"content-type": contentTypes[extname(file)] ?? "application/octet-stream",
		});
		createReadStream(file).pipe(response);
	} catch {
		response.writeHead(404).end("not found");
	}
});

await new Promise<void>((resolveListen, reject) => {
	server.once("error", reject);
	server.listen(0, "127.0.0.1", resolveListen);
});

try {
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Search scorecard server did not bind a TCP port");
	}
	const module = (await import(
		pathToFileURL(pagefindEntry).href
	)) as PagefindSearch & {
		options(options: { basePath: string }): Promise<void>;
		destroy(): Promise<void>;
	};
	await module.options({
		basePath: `http://127.0.0.1:${address.port}/pagefind/`,
	});
	const results = await runSearchScorecard(module);
	for (const result of results) {
		const rank = result.rank === null ? "outside top 3" : `rank ${result.rank}`;
		console.log(
			`${result.passed ? "PASS" : "FAIL"} ${result.task}: ${rank} for ${JSON.stringify(result.query)} -> ${result.expectedRoute}`,
		);
		if (!result.passed) {
			console.log(
				`  actual: ${result.topRoutes.map((route, index) => `${index + 1}. ${route} (${result.topTitles[index]})`).join(", ") || "no results"}`,
			);
		}
	}
	await module.destroy();
	if (results.some((result) => !result.passed)) process.exitCode = 1;
} finally {
	await new Promise<void>((resolveClose, reject) =>
		server.close((error) => (error ? reject(error) : resolveClose())),
	);
}
