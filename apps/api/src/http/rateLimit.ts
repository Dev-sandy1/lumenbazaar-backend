import { type FastifyInstance, type FastifyRequest } from "fastify";

import { failure } from "@lumenbazaar/shared";

import { type RateLimitService } from "../services/rateLimit.js";

export type RateLimitHookOptions = {
  rateLimitService: RateLimitService;
};

export function registerRateLimitHook(app: FastifyInstance, options: RateLimitHookOptions) {
  app.addHook("onRequest", async (request, reply) => {
    const scope = classifyRateLimitScope(request);

    if (scope === undefined) {
      return;
    }

    try {
      const result = await options.rateLimitService.consume({
        key: rateLimitKey(request),
        route: `${request.method} ${requestPath(request.url)}`,
        scope
      });

      reply.header("x-ratelimit-limit", String(result.limit));
      reply.header("x-ratelimit-remaining", String(result.remaining));
      reply.header("x-ratelimit-reset", result.resetAt.toISOString());

      if (!result.allowed) {
        const retryAfterSeconds = Math.ceil((result.resetAt.getTime() - Date.now()) / 1000);
        reply.header("retry-after", String(Math.max(1, retryAfterSeconds)));
        return reply.status(429).send(
          failure(
            {
              code: "RATE_LIMITED",
              message: "Rate limit exceeded.",
              details: {
                scope,
                resetAt: result.resetAt.toISOString()
              }
            },
            request.id
          )
        );
      }

      if (result.error) {
        // Redis outage occurred, log it but allow request to proceed
        // Rate limiting is degraded but service availability is maintained
        console.warn("Rate limit service error:", result.error);
      }
    } catch (error) {
      // If rate limiting service fails catastrophically, log but don't block request
      // This ensures service availability is prioritized over rate limit enforcement
      console.error(
        "Rate limit hook error:",
        error instanceof Error ? error.message : String(error)
      );
    }
  });
}

export function classifyRateLimitScope(request: Pick<FastifyRequest, "method" | "url">) {
  const path = requestPath(request.url);

  if (
    path === "/v1/supported" ||
    path === "/v1/verify" ||
    path === "/v1/settle" ||
    path.startsWith("/v1/receipts/")
  ) {
    return "facilitator" as const;
  }

  if (path.startsWith("/v1/discovery/") || path.startsWith("/v1/resources")) {
    return "discovery" as const;
  }

  if (path.startsWith("/v1/sellers")) {
    return "seller" as const;
  }

  return undefined;
}

function rateLimitKey(request: FastifyRequest) {
  const principal = request.sellerApiKeyPrincipal;

  if (principal !== undefined) {
    // Authenticated keys use their stable key ID as the rate-limit identity.
    return `key:${principal.keyId}`;
  }

  const apiKey = request.headers["x-api-key"];

  if (typeof apiKey === "string" && apiKey.trim().length > 0) {
    return apiKey.trim();
  }

  return request.ip;
}

function requestPath(url: string) {
  return new URL(url, "http://lumenbazaar.local").pathname;
}
