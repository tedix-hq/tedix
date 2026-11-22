import { parse, type ParseError } from "jsonc-parser";
import platform from "../../../../package.json";
import { snapshotForTemplate } from "./template-sync";

/** Resolved build inputs, including bundled plugins, rather than tenant requests. */
export function themePackageVersions(lock: string): Record<string, string[]> {
	const versions: Record<string, string[]> = {};
	const errors: ParseError[] = [];
	const data = parse(lock, errors, { allowTrailingComma: true }) as {
		packages?: Record<string, unknown>;
	} | null;
	if (errors.length || !data?.packages)
		throw new Error("Invalid theme bun.lock");
	for (const tuple of Object.values(data.packages)) {
		if (!Array.isArray(tuple) || typeof tuple[0] !== "string") continue;
		const match = /^(emdash|@emdash-cms\/[^@]+|emprivacy)@(.+)$/.exec(tuple[0]);
		if (!match) continue;
		const values = (versions[match[1]!] ??= []);
		if (!values.includes(match[2]!)) values.push(match[2]!);
	}
	if (!versions.emdash)
		throw new Error("Theme bun.lock has no resolved EmDash package");
	return versions;
}

/** Locked starter dependencies and patches belong to the platform release. */
export function platformThemeManifest(templateSlug: string): string {
	const { snapshot } = snapshotForTemplate(templateSlug);
	const manifest = JSON.parse(snapshot["package.json"]!);
	const pins = themePackageVersions(snapshot["bun.lock"]!);
	for (const [name, versions] of Object.entries(pins)) {
		if (versions.length !== 1)
			throw new Error(`Ambiguous platform theme pin: ${name}`);
		const version =
			(platform.catalog as Record<string, string>)[name] ?? versions[0]!;
		if (manifest.dependencies?.[name]) manifest.dependencies[name] = version;
		if (manifest.devDependencies?.[name])
			manifest.devDependencies[name] = version;
		manifest.overrides = { ...manifest.overrides, [name]: version };
	}
	return JSON.stringify(manifest, null, "\t") + "\n";
}
