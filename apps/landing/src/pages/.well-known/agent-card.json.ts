import type { APIRoute } from "astro";
import { agentCardResponse } from "../../lib/agent-card";

export const GET: APIRoute = () => agentCardResponse();
