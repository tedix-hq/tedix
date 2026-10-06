/**
 * Type Utilities for oRPC Contracts
 *
 * Re-exports the client type so apps depend on `@tedix/api-contract` rather than
 * reaching into `@orpc/contract` directly.
 *
 * @example
 * ```typescript
 * import type { RouterContractClient } from "@tedix/api-contract/types";
 * import type { ApiContract } from "@tedix/api-contract/contracts/api";
 *
 * const client: RouterContractClient<ApiContract> = createORPCClient(link);
 * ```
 */

export type { RouterContractClient } from "@orpc/contract";
