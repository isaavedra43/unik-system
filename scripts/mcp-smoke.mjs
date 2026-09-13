import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL(process.env.MCP_URL ?? 'http://localhost:3001/api/mcp');
const key = process.env.UNIK_MCP_API_KEY;
const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${key}` } } });
const client = new Client({ name: 'smoke', version: '0.0.1' }, { capabilities: {} });
await client.connect(transport);
const { tools } = await client.listTools();
console.log('TOOLS', tools.length, tools.slice(0, 5).map((t) => t.name).join(','));
const has = (n) => tools.some((t) => t.name === n);
console.log('HAS queryQuotes', has('queryQuotes'), 'listChatChannels', has('listChatChannels'), 'listSkills', has('listSkills'), 'createQuote', has('createQuote'));
const r1 = await client.callTool({ name: 'getSystemTime', arguments: {} });
console.log('getSystemTime', JSON.stringify(r1).slice(0, 200));
const r2 = await client.callTool({ name: 'queryQuotes', arguments: { segment: 'all', pageSize: 5 } });
console.log('queryQuotes', JSON.stringify(r2).slice(0, 300));
await client.close();
