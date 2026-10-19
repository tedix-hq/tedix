import { readFileSync } from "node:fs";
import { join } from "node:path";
import { devinConfigDirectory } from "../devin-config";
import { isObject } from "./hook-io";

/** Setup and governed lanes already register these hooks; their definitions win. */
export function skipDevinPluginHook(name: string, env = process.env): boolean {
	if (env.TEDIX_DEVIN_LANE_ROOT) return true;
	try {
		const config = JSON.parse(
			readFileSync(join(devinConfigDirectory(env), "config.json"), "utf8"),
		);
		if (!isObject(config.hooks)) return false;
		return Object.values(config.hooks).some(
			(entries) =>
				Array.isArray(entries) &&
				entries.some(
					(entry) =>
						isObject(entry) &&
						Array.isArray(entry.hooks) &&
						entry.hooks.some(
							(hook: unknown) =>
								isObject(hook) &&
								typeof hook.command === "string" &&
								hook.command.endsWith(" # tedix-managed-devin-hook") &&
								hook.command.includes(` hooks ${name} --host devin`),
						),
				),
		);
	} catch {
		return false;
	}
}
