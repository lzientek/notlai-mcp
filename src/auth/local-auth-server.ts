import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { CredentialStore } from '../storage/credentials.js';
import { validateTokenPayload } from './validate-token-payload.js';

export interface LocalAuthServerOptions {
  port: number;
  credentialStore: CredentialStore;
  onSuccess?: () => void;
  onError?: (error: Error) => void;
  timeout?: number;
}

export interface LocalAuthServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  hasReceivedTokens(): boolean;
  getPort(): number;
}

export function createLocalAuthServer(options: LocalAuthServerOptions): LocalAuthServer {
  const { port, credentialStore, onSuccess, onError, timeout = 300_000 } = options;

  let receivedTokens = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let server: ReturnType<typeof createServer> | null = null;

  function setCorsHeaders(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  function parseBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf-8');
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error('Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  async function handleCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setCorsHeaders(res);

    if (receivedTokens) {
      sendJson(res, 409, {
        status: 'error',
        message: 'Tokens have already been received for this session. Start a new web login flow if needed.',
      });
      return;
    }

    let body: unknown;
    try {
      body = await parseBody(req);
    } catch {
      sendJson(res, 400, { status: 'error', message: 'Invalid JSON body' });
      return;
    }

    const result = validateTokenPayload(body);
    if (!result.valid) {
      sendJson(res, 400, { status: 'error', message: result.error });
      return;
    }

    try {
      await credentialStore.save({
        idToken: result.tokens.idToken,
        accessToken: result.tokens.accessToken,
        refreshToken: result.tokens.refreshToken,
        expiresAt: Math.floor(Date.now() / 1000) + result.tokens.expiresIn,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      onError?.(error);
      sendJson(res, 500, { status: 'error', message: 'Failed to store credentials' });
      return;
    }

    receivedTokens = true;
    sendJson(res, 200, {
      status: 'ok',
      message: 'Tokens received and stored. You can close this page and return to Claude Desktop.',
    });

    onSuccess?.();
    setTimeout(() => stopServer(), 500);
  }

  function handleStatus(_req: IncomingMessage, res: ServerResponse): void {
    setCorsHeaders(res);
    sendJson(res, 200, { status: receivedTokens ? 'received' : 'waiting' });
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const { method, url } = req;

    if (method === 'OPTIONS') {
      setCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === 'POST' && url === '/auth/callback') {
      handleCallback(req, res).catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        onError?.(error);
        if (!res.headersSent) {
          sendJson(res, 500, { status: 'error', message: 'Internal server error' });
        }
      });
      return;
    }

    if (method === 'GET' && url === '/auth/status') {
      handleStatus(req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'error', message: 'Not found' }));
  }

  function stopServer(): Promise<void> {
    return new Promise((resolve) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (server) {
        server.close(() => {
          server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  return {
    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server = createServer(handleRequest);

        server.on('error', (err: NodeJS.ErrnoException) => {
          reject(err);
        });

        server.listen(port, '127.0.0.1', () => {
          timeoutHandle = setTimeout(() => {
            if (!receivedTokens) {
              onError?.(new Error('Auth server timed out waiting for tokens'));
            }
            stopServer();
          }, timeout);

          resolve();
        });
      });
    },

    stop(): Promise<void> {
      return stopServer();
    },

    hasReceivedTokens(): boolean {
      return receivedTokens;
    },

    getPort(): number {
      return port;
    },
  };
}
