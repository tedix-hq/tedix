// Test stub for the `cloudflare:workers` module so vitest (Node) can import
// @cloudflare/codemode, whose entry module references Workers runtime APIs
// (CodemodeRuntime extends DurableObject). Only the symbols actually touched
// at import time need to be present.

export class WorkerEntrypoint {}
export class DurableObject {}
export class RpcTarget {}
export const env = {};
