#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpNotesServer } from './server.js';
import type { McpNotesConfig } from './types/config.js';

const config: McpNotesConfig = {
  cognitoClientId: process.env.COGNITO_CLIENT_ID ?? '28ede6qudr0af0tt3k0i7aep8g',
  apiGatewayUrl: process.env.API_GATEWAY_URL ?? 'https://api.notlai.com',
  region: process.env.AWS_REGION ?? 'eu-west-1',
  frontendUrl: process.env.FRONTEND_URL ?? 'https://www.notlai.com',
};

const server = createMcpNotesServer({ config });
const transport = new StdioServerTransport();
await server.connect(transport);
