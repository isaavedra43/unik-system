// Vitest runs server modules directly in Node. Next enforces `server-only`
// during its own client/server compilation, so the test resolver uses this
// inert stand-in instead of the package's deliberate throwing entrypoint.
export {};
