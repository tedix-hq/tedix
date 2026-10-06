/**
 * Graph DB Integration — connects the Neo4j projection to the API Worker.
 *
 * Provides:
 * 1. getGraphClient() — the Neo4j read client from Worker env secrets (cached),
 *    or null when the projection is not configured
 * 2. createGraphWriter() — maintenance/workflow projection writer
 * 3. runCypherWithParams() — projection inspection and maintenance queries
 *
 * Graph DB secrets (optional — callers degrade when not configured):
 * - GRAPH_DB_URI: Neo4j connection URI (e.g. neo4j+s://xxx.databases.neo4j.io)
 * - GRAPH_DB_USER: Auth username
 * - GRAPH_DB_PASSWORD: Auth password
 *
 * The driver module is required lazily so Worker startup does not pay for it.
 */

/// <reference path="../../../worker-configuration.d.ts" />

import type { GraphClient } from "./neo4j";
import type { GraphWriter } from "./sync";

type Neo4jModule = typeof import("./neo4j");

function getGraphDbSecrets(env: CloudflareEnv): {
	uri: string;
	user: string;
	password: string;
} | null {
	const uri = env.GRAPH_DB_URI;
	const user = env.GRAPH_DB_USER;
	const password = env.GRAPH_DB_PASSWORD;
	if (uri && user && password) {
		return { uri, user, password };
	}
	return null;
}

/** Singleton cache — one client per Worker isolate lifetime */
let cachedClient: GraphClient | null = null;
let cachedEnvHash: string | null = null;

/** Get or create the graph read client; null when graph DB is not configured. */
export function getGraphClient(env: CloudflareEnv): GraphClient | null {
	const secrets = getGraphDbSecrets(env);
	if (!secrets) return null;

	const envHash = `${secrets.uri}:${secrets.user}`;
	if (cachedClient && cachedEnvHash === envHash) return cachedClient;

	const { createNeo4jGraphClient } = require("./neo4j") as Neo4jModule;
	const { client } = createNeo4jGraphClient(secrets);

	cachedClient = client;
	cachedEnvHash = envHash;
	return client;
}

/** Create the projection writer used only by the Workflow and admin repair. */
export function createGraphWriter(env: CloudflareEnv): GraphWriter | null {
	const secrets = getGraphDbSecrets(env);
	if (!secrets) return null;
	const { createNeo4jGraphClient } = require("./neo4j") as Neo4jModule;
	return createNeo4jGraphClient(secrets).writer;
}

/**
 * Run a parameterized Cypher query against the graph DB.
 * Returns empty array when graph DB is not configured (graceful degradation).
 */
export async function runCypherWithParams(
	env: CloudflareEnv,
	cypher: string,
	params: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
	const secrets = getGraphDbSecrets(env);
	if (!secrets) return [];
	const { runCypherWithParams: run } = require("./neo4j") as Neo4jModule;
	return run(secrets, cypher, params);
}
