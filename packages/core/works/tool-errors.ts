/**
 * A tool that cannot answer right now, for a reason the caller can act on —
 * distinct from a tool that failed. Adapters turn it into a message to the
 * model rather than an error.
 */
export class ToolUnavailableError extends Error {}
