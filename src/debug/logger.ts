/**
 * Debug logger for notlai-mcp.
 * Activated via NOTLAI_DEBUG=true environment variable.
 * Logs to stderr to avoid interfering with stdio MCP transport.
 */

export interface DebugLogger {
  enabled: boolean;
  log(category: string, message: string, data?: unknown): void;
  logRequest(method: string, path: string, body?: unknown): void;
  logResponse(method: string, path: string, status: number, body?: unknown): void;
  logClientDetection(clientInfo: unknown, resolvedSource: string | null): void;
  logToolCall(toolName: string, args?: unknown): void;
  logTokenRefresh(success: boolean, error?: unknown): void;
}

export function createDebugLogger(enabled: boolean): DebugLogger {
  function write(category: string, message: string, data?: unknown): void {
    if (!enabled) return;
    const timestamp = new Date().toISOString();
    const prefix = `[notlai-mcp:debug][${timestamp}][${category}]`;
    if (data !== undefined) {
      const serialized = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      process.stderr.write(`${prefix} ${message}\n${serialized}\n`);
    } else {
      process.stderr.write(`${prefix} ${message}\n`);
    }
  }

  return {
    enabled,

    log(category: string, message: string, data?: unknown): void {
      write(category, message, data);
    },

    logRequest(method: string, path: string, body?: unknown): void {
      write('http', `→ ${method} ${path}`, body);
    },

    logResponse(method: string, path: string, status: number, body?: unknown): void {
      write('http', `← ${method} ${path} [${status}]`, body);
    },

    logClientDetection(clientInfo: unknown, resolvedSource: string | null): void {
      write('client', `Client detection — raw clientInfo: ${JSON.stringify(clientInfo)}, resolved source: ${resolvedSource}`);
    },

    logToolCall(toolName: string, args?: unknown): void {
      write('tool', `Tool called: ${toolName}`, args);
    },

    logTokenRefresh(success: boolean, error?: unknown): void {
      if (success) {
        write('auth', 'Token refreshed successfully');
      } else {
        write('auth', 'Token refresh failed', error instanceof Error ? error.message : error);
      }
    },
  };
}
