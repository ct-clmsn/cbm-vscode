import * as child_process from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: any;
}

export interface McpResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export interface McpError {
  code: number;
  message: string;
}

export class McpClient {
  private proc: child_process.ChildProcess | null = null;
  private reqId = 0;
  private readBuf = Buffer.alloc(0);
  private pendingRequests = new Map<number, {
    resolve: (val: any) => void;
    reject: (err: Error) => void;
  }>();
  private tools: McpTool[] = [];
  private initialized = false;
  private outputChannel: { appendLine: (msg: string) => void } | null = null;

  constructor(outputChannel?: { appendLine: (msg: string) => void }) {
    this.outputChannel = outputChannel || null;
  }

  private log(msg: string) {
    if (this.outputChannel) {
      this.outputChannel.appendLine(`[MCP] ${msg}`);
    }
  }

  // ── Binary discovery ────────────────────────────────────────────

  static findBinary(configPath?: string): string {
    if (configPath && configPath.length > 0 && fs.existsSync(configPath)) {
      return configPath;
    }

    const name = 'codebase-memory-mcp';
    const home = process.env.HOME || '';

    // Check common locations
    const locations = [
      path.join(home, '.local/bin', name),
      path.join(home, '.cargo/bin', name),
      path.join(home, '.npm/bin', name),
      '/usr/local/bin/' + name,
      '/opt/homebrew/bin/' + name,
      path.join(process.cwd(), name),
      path.join(process.cwd(), 'build/c', name),
    ];

    for (const loc of locations) {
      if (fs.existsSync(loc)) {
        try {
          fs.accessSync(loc, fs.constants.X_OK);
          return loc;
        } catch {
          // not executable
        }
      }
    }

    // Try PATH
    const pathDirs = (process.env.PATH || '').split(':');
    for (const dir of pathDirs) {
      const full = path.join(dir, name);
      if (fs.existsSync(full)) {
        try {
          fs.accessSync(full, fs.constants.X_OK);
          return full;
        } catch {
          // not executable
        }
      }
    }

    return '';
  }

  // ── Process management ──────────────────────────────────────────

  async start(binaryPath: string): Promise<boolean> {
    if (this.proc) {
      this.stop();
    }

    return new Promise((resolve) => {
      try {
        this.proc = child_process.spawn(binaryPath, [], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: process.env,
        });

        this.proc.stdout?.on('data', (data: Buffer) => {
          this.onData(data);
        });

        this.proc.stderr?.on('data', (data: Buffer) => {
          this.log(`stderr: ${data.toString().trim()}`);
        });

        this.proc.on('exit', (code) => {
          this.log(`server exited with code ${code}`);
          this.proc = null;
          this.initialized = false;
          // Reject all pending requests
          for (const [id, pending] of this.pendingRequests) {
            pending.reject(new Error('server exited'));
          }
          this.pendingRequests.clear();
        });

        this.proc.on('error', (err) => {
          this.log(`spawn error: ${err.message}`);
          this.proc = null;
          resolve(false);
        });

        // Wait a moment for process to start
        setTimeout(() => {
          resolve(this.proc !== null);
        }, 100);
      } catch (err: any) {
        this.log(`failed to start: ${err.message}`);
        resolve(false);
      }
    });
  }

  stop() {
    if (this.proc) {
      this.proc.kill('SIGTERM');
      setTimeout(() => {
        if (this.proc) {
          this.proc.kill('SIGKILL');
        }
      }, 200);
      this.proc = null;
    }
    this.initialized = false;
    this.tools = [];
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error('client stopped'));
    }
    this.pendingRequests.clear();
  }

  isRunning(): boolean {
    return this.proc !== null && this.initialized;
  }

  // ── Content-Length framing ───────────────────────────────────────

  private onData(data: Buffer) {
    this.readBuf = Buffer.concat([this.readBuf, data]);
    this.processBuffer();
  }

  private processBuffer() {
    while (true) {
      // Look for Content-Length header
      const headerEnd = this.readBuf.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;

      const header = this.readBuf.toString('utf8', 0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Skip malformed header
        this.readBuf = this.readBuf.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      const totalNeeded = bodyStart + contentLength;

      if (this.readBuf.length < totalNeeded) break; // incomplete message

      const body = this.readBuf.toString('utf8', bodyStart, totalNeeded);
      this.readBuf = this.readBuf.slice(totalNeeded);

      this.handleMessage(body);
    }
  }

  private handleMessage(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.log(`failed to parse message: ${raw.substring(0, 100)}`);
      return;
    }

    // Response to a request
    if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
      const pending = this.pendingRequests.get(msg.id)!;
      this.pendingRequests.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  // ── JSON-RPC communication ──────────────────────────────────────

  private send(body: object): number {
    const id = ++this.reqId;
    const msg = JSON.stringify({ jsonrpc: '2.0', id, ...body });
    const frame = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;
    this.proc?.stdin?.write(frame);
    return id;
  }

  private request(method: string, params: object, timeoutMs = 30000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.send({ method, params });
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`timeout waiting for ${method} response`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  private notify(method: string, params?: object) {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
    const frame = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;
    this.proc?.stdin?.write(frame);
  }

  // ── MCP lifecycle ──────────────────────────────────────────────

  async initialize(): Promise<boolean> {
    try {
      await this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cbm-vscode', version: '0.0.1' },
      });

      this.notify('notifications/initialized');
      this.initialized = true;
      return true;
    } catch (err: any) {
      this.log(`initialize failed: ${err.message}`);
      return false;
    }
  }

  // ── Tools ──────────────────────────────────────────────────────

  async loadTools(): Promise<McpTool[]> {
    this.tools = [];
    let cursor: string | undefined;

    do {
      const params: any = {};
      if (cursor) params.cursor = cursor;

      const result = await this.request('tools/list', params);
      if (!result || !result.tools) break;

      for (const tool of result.tools) {
        this.tools.push({
          name: tool.name || '',
          title: tool.title || tool.name || '',
          description: tool.description || '',
          inputSchema: tool.inputSchema || {},
        });
      }

      cursor = result.nextCursor || undefined;
    } while (cursor);

    return this.tools;
  }

  getTools(): McpTool[] {
    return this.tools;
  }

  // ── Tool calling ───────────────────────────────────────────────

  async callTool(name: string, args: Record<string, any> = {}): Promise<McpResult> {
    const result = await this.request('tools/call', {
      name,
      arguments: args,
    });

    if (!result) {
      return { content: [{ type: 'text', text: 'No response from server' }], isError: true };
    }

    return {
      content: result.content || [],
      isError: result.isError || false,
    };
  }

  // ── Convenience methods ────────────────────────────────────────

  async listProjects(): Promise<string> {
    const result = await this.callTool('list_projects');
    return result.content.map(c => c.text).join('\n');
  }

  async searchGraph(project: string, query: string, options: Record<string, any> = {}): Promise<McpResult> {
    return this.callTool('search_graph', { project, query, ...options });
  }

  async searchCode(project: string, pattern: string, options: Record<string, any> = {}): Promise<McpResult> {
    return this.callTool('search_code', { project, pattern, ...options });
  }

  async tracePath(project: string, functionName: string, direction: string = 'both', options: Record<string, any> = {}): Promise<McpResult> {
    return this.callTool('trace_path', { project, function_name: functionName, direction, ...options });
  }

  async getSnippet(project: string, qualifiedName: string): Promise<McpResult> {
    return this.callTool('get_code_snippet', { project, qualified_name: qualifiedName });
  }

  async getArchitecture(project: string, aspects?: string[]): Promise<McpResult> {
    const args: Record<string, any> = { project };
    if (aspects) args.aspects = aspects;
    return this.callTool('get_architecture', args);
  }

  async indexRepository(repoPath: string, name?: string, mode?: string): Promise<McpResult> {
    const args: Record<string, any> = { repo_path: repoPath };
    if (name) args.name = name;
    if (mode) args.mode = mode;
    return this.callTool('index_repository', args);
  }

  async deleteProject(project: string): Promise<McpResult> {
    return this.callTool('delete_project', { project });
  }

  async indexStatus(project: string): Promise<McpResult> {
    return this.callTool('index_status', { project });
  }

  async detectChanges(project: string, options: Record<string, any> = {}): Promise<McpResult> {
    return this.callTool('detect_changes', { project, ...options });
  }

  async cypherQuery(project: string, query: string): Promise<McpResult> {
    return this.callTool('query_graph', { project, query });
  }

  async ingestTraces(project: string, traces: Array<{ caller: string; callee: string; count: number }>): Promise<McpResult> {
    return this.callTool('ingest_traces', { project, traces });
  }

  async getGraphSchema(project: string): Promise<McpResult> {
    return this.callTool('get_graph_schema', { project });
  }

  async manageAdr(project: string, options: Record<string, any> = {}): Promise<McpResult> {
    return this.callTool('manage_adr', { project, ...options });
  }
}
