#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpNotesServer } from './server.js';
import type { McpNotesConfig } from './types/config.js';

process.on('uncaughtException', (err) => {
  console.error('[notlai-mcp] Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[notlai-mcp] Unhandled rejection:', err);
});

async function main() {
  const debug = process.env.NOTLAI_DEBUG === 'true' || process.env.NOTLAI_DEBUG === '1';

  const config: McpNotesConfig = {
    cognitoClientId: process.env.COGNITO_CLIENT_ID ?? '28ede6qudr0af0tt3k0i7aep8g',
    apiGatewayUrl: process.env.API_GATEWAY_URL ?? 'https://api.notlai.com',
    region: process.env.AWS_REGION ?? 'eu-west-1',
    frontendUrl: process.env.FRONTEND_URL ?? 'https://www.notlai.com',
  };

  if (debug) {
    process.stderr.write(`[notlai-mcp:debug] Debug mode enabled\n`);
    process.stderr.write(`[notlai-mcp:debug] Config: ${JSON.stringify({ ...config, cognitoClientId: '***' })}\n`);
  }

  const server = createMcpNotesServer({ config, debug });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[notlai-mcp] Fatal error:', err);
  process.exit(1);
});
