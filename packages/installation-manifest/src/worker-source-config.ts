import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import {
	convertToWranglerConfig,
	resolveAndParseConfig,
} from "@cloudflare/config";

/** Read deployment shape from an already trusted, pinned product checkout. */
export async function readWorkerSourceConfig(path: string): Promise<string> {
	if (path.endsWith(".jsonc")) return readFileSync(path, "utf8");
	if (basename(path) !== "cloudflare.config.ts") {
		throw new Error(`Unsupported Worker source configuration: ${path}`);
	}
	const { default: definition } = await import(pathToFileURL(path).href);
	const parsed = await resolveAndParseConfig(definition, {
		mode: "production",
		isPreview: false,
	});
	if (!parsed.success || !parsed.data.worker) {
		throw new Error(`Invalid Cloudflare Worker configuration: ${path}`, {
			cause: parsed.success ? undefined : parsed.error,
		});
	}
	return JSON.stringify(convertToWranglerConfig(parsed.data));
}
