import {
	firstPartyReleaseHost,
	type FirstPartyRelease,
} from "@tedix/db/queries/catalog/sync-tools-to-app";
import { createCatalogScanFetch } from "../lib/catalog-internal-scan";

type ReleaseEnv = Parameters<typeof createCatalogScanFetch>[1];

/** Called only after an authoritative scan over the platform-token binding. */
export async function verifyFirstPartyToolRelease(
	endpoint: string,
	env: ReleaseEnv,
): Promise<FirstPartyRelease | undefined> {
	const host = firstPartyReleaseHost(endpoint);
	if (
		!host ||
		!env.PLATFORM_SERVICE_TOKEN ||
		!createCatalogScanFetch(endpoint, env)
	)
		return;
	const binding = host === "builder.tedix.dev" ? env.CMS : env.MCP_SERVICE;
	if (!binding) return;
	try {
		const response = await binding.fetch(
			new Request(`https://${host}/health`, {
				headers: {
					Authorization: `Bearer ${env.PLATFORM_SERVICE_TOKEN}`,
					"X-Service-Binding": "true",
				},
				redirect: "manual",
				signal: AbortSignal.timeout(10_000),
			}),
		);
		if (!response.ok) return;
		const { deployedSha } = (await response.json()) as { deployedSha?: string };
		if (!deployedSha || !/^[a-f0-9]{40}$/.test(deployedSha)) return;
		// Comparing SHA...main proves the deployed commit is an ancestor of main.
		const compare = await fetch(
			`https://api.github.com/repos/tedix-hq/tedix/compare/${deployedSha}...main`,
			{
				headers: {
					Accept: "application/vnd.github+json",
					"User-Agent": "Tedix-catalog",
				},
				redirect: "error",
				signal: AbortSignal.timeout(10_000),
			},
		);
		if (!compare.ok) return;
		const result = (await compare.json()) as {
			status?: string;
			merge_base_commit?: { sha?: string };
		};
		if (
			!["ahead", "identical"].includes(result.status ?? "") ||
			result.merge_base_commit?.sha !== deployedSha
		)
			return;
		return { mcpServerUrl: endpoint, deployedSha };
	} catch {
		// Unavailable release proof retains the owner's review card.
		return;
	}
}
