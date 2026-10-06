/// <reference path="../.astro/types.d.ts" />
/// <reference types="@cloudflare/workers-types" />

interface Env {
	ENVIRONMENT: string;
	API_URL: string;
	CATALOG_API_KEY?: string;
	API_SERVICE?: Fetcher;
	SESSION?: KVNamespace;
	CLI_RELEASES: R2Bucket;
	CLI_DOWNLOAD_HOST: string;
	TEDIX_MARKETING_ORG_ID: string;
	TEDIX_CMO_TEDI_ID: string;
	TEDIX_DEMAND_OBJECTIVE_ID: string;
	TEDIX_DEMAND_PROJECT_ID: string;
	TEDIX_DEMAND_INTAKE_PARENT_ID: string;
}

declare module "cloudflare:workers" {
	interface CloudflareEnv extends Env {}
}

declare namespace App {
	interface Locals {
		cfContext: ExecutionContext;
	}
}

/// <reference types="astro/client" />
