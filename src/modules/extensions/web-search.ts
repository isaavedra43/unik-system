/**
 * Web search capability connected as an external tool (Brave Search MCP).
 *
 * Pure module with a structural tool shape, so a domain service (the Sourcing
 * Lab of Compras) picks the capability without importing `ai/tools/*`.
 */

export interface WebSearchToolRef {
  name: string;
  description: string;
}

/** Connected web search capability among the external tools; null when none is installed. */
export function findWebSearchTool(tools: readonly WebSearchToolRef[]): string | null {
  const brave = tools.find(
    (tool) => /brave/i.test(`${tool.name} ${tool.description}`) && /search|busca/i.test(`${tool.name} ${tool.description}`)
  );
  if (brave) return brave.name;
  return tools.find((tool) => /web_search/i.test(tool.name))?.name ?? null;
}
