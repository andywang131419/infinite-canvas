// Runtime configuration regenerated from environment variables by docker-entrypoint.sh at container startup.
// Local development and deployments without the entrypoint use these empty defaults, leaving analytics disabled.
window.__RUNTIME_CONFIG__ = window.__RUNTIME_CONFIG__ || {};

// Backend API origin. An empty string means "same origin" and is the recommended setting:
// in development vite.config.ts proxies /api to 127.0.0.1:8787, in production Caddy routes
// /api/* to the server container. Only set this when the server lives on its own subdomain.
if (typeof window.__RUNTIME_CONFIG__.API_BASE_URL !== "string") {
    window.__RUNTIME_CONFIG__.API_BASE_URL = "";
}
