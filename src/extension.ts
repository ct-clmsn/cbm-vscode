import * as vscode from 'vscode';
import * as path from 'path';
import { McpClient, McpTool } from './mcpClient';

let client: McpClient | null = null;
let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let projectsProvider: ProjectsTreeProvider;
let resultsProvider: SearchResultsProvider;
let selectedProject = '';
// Map of project name -> absolute root path, used to resolve relative
// file paths from indexed projects that may live outside the workspace.
const projectRootPaths: Record<string, string> = {};

// ── Tree Data Provider ─────────────────────────────────────────────

class ProjectItem extends vscode.TreeItem {
  constructor(
    public readonly projectName: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly status?: string,
    public readonly rootPath?: string
  ) {
    super(projectName, collapsibleState);
    this.contextValue = 'project';
    if (status) {
      this.description = status;
    }
    this.iconPath = new vscode.ThemeIcon('database');
    if (rootPath) {
      this.tooltip = rootPath;
      this.command = {
        command: 'cbm.revealProjectFolder',
        title: 'Open Project Folder',
        arguments: [projectName, rootPath],
      };
    }
  }
}

class ProjectsTreeProvider implements vscode.TreeDataProvider<ProjectItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ProjectItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private projects: Array<{ name: string; status?: string; rootPath?: string }> = [];

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  async loadProjects(): Promise<void> {
    if (!client?.isRunning()) return;
    try {
      const text = await client.listProjects();
      this.projects = [];

      // The response is JSON like {"projects":[{name,root_path,...},...]}
      let projects: any[] = [];
      try {
        const parsed = JSON.parse(text);
        projects = parsed.projects || [];
      } catch {
        // Fallback: try to find JSON object within text
        const match = text.match(/\{.*"projects"\s*:\s*\[(.*)\]/s);
        if (match) {
          try {
            const parsed = JSON.parse('{"projects":[' + match[1] + ']}');
            projects = parsed.projects || [];
          } catch { /* ignore */ }
        }
      }

      for (const p of projects) {
        const name = p.name || p.root_path || '';
        if (name) {
          const nodes = p.nodes ? `${p.nodes} nodes` : 'indexed';
          this.projects.push({ name, status: nodes, rootPath: p.root_path });
          if (name && p.root_path) {
            projectRootPaths[name] = p.root_path;
          }
        }
      }
    } catch (err: any) {
      outputChannel.appendLine(`Failed to load projects: ${err.message}`);
    }
  }

  getTreeItem(element: ProjectItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ProjectItem): ProjectItem[] {
    if (!element) {
      if (this.projects.length === 0) {
        return [new ProjectItem('No projects indexed', vscode.TreeItemCollapsibleState.None, 'index a project to get started')];
      }
      return this.projects.map(p =>
        new ProjectItem(p.name, vscode.TreeItemCollapsibleState.None, p.status, p.rootPath)
      );
    }
    return [];
  }
}

// ── Search Results Tree Data Provider ────────────────────────────

class SearchResultsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private results: vscode.TreeItem[] = [];

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  clear(): void {
    this.results = [];
    this.refresh();
  }

  setResults(items: vscode.TreeItem[]): void {
    this.results = items;
    this.refresh();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (!element) {
      return this.results;
    }
    const children = (element as any).children;
    return Array.isArray(children) ? children : [];
  }
}

// Helper to create a leaf TreeItem with a clickable file:line target
function makeFileItem(label: string, filePath: string, line: number, detail?: string): vscode.TreeItem {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.description = detail || `${filePath}:${line}`;
  item.command = {
    command: 'cbm.openFile',
    title: 'Open file',
    arguments: [filePath, line],
  };
  item.iconPath = new vscode.ThemeIcon('file-code');
  (item as any).filePath = filePath;
  (item as any).line = line;
  return item;
}

// ── Helpers ─────────────────────────────────────────────────────────

function ensureClient(): McpClient {
  if (!client) {
    client = new McpClient(outputChannel);
  }
  return client;
}

async function ensureConnected(): Promise<boolean> {
  const c = ensureClient();
  if (c.isRunning()) return true;

  const config = vscode.workspace.getConfiguration('cbm');
  const configPath = config.get<string>('binaryPath', '');

  let binaryPath = McpClient.findBinary(configPath || undefined);
  if (!binaryPath) {
    const selected = await vscode.window.showErrorMessage(
      'codebase-memory-mcp binary not found. Set path in Settings > CBM Search > binaryPath.',
      'Open Settings'
    );
    if (selected === 'Open Settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'cbm.binaryPath');
    }
    return false;
  }

  outputChannel.appendLine(`Starting server: ${binaryPath}`);
  statusBarItem.text = '$(loading~spin) CBM: Starting...';

  const started = await c.start(binaryPath);
  if (!started) {
    vscode.window.showErrorMessage('Failed to start codebase-memory-mcp');
    statusBarItem.text = '$(error) CBM: Error';
    return false;
  }

  outputChannel.appendLine('Server started, initializing...');
  const ok = await c.initialize();
  if (!ok) {
    vscode.window.showErrorMessage('MCP initialization failed');
    statusBarItem.text = '$(error) CBM: Init failed';
    return false;
  }

  outputChannel.appendLine('Initialized, loading tools...');
  await c.loadTools();
  outputChannel.appendLine(`Loaded ${c.getTools().length} tools`);

  statusBarItem.text = '$(check) CBM: Connected';
  return true;
}

function getProjectName(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return '';
  return folder.name;
}

function showResults(result: { content: Array<{ type: string; text: string }>; isError?: boolean }, title: string) {
  const text = result.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n');

  if (result.isError) {
    outputChannel.appendLine(`\n❌ ${title}\n${text}`);
    vscode.window.showErrorMessage(`${title}: ${text.substring(0, 200)}`);
  } else {
    outputChannel.appendLine(`\n── ${title} ──\n${text}`);
    outputChannel.show(true);
  }

  return text;
}

// Run a single search tool call and return the raw JSON text response.
async function runSearch(
  tool: 'search_graph' | 'search_code',
  project: string,
  userArgs: Record<string, any>
): Promise<string> {
  // Request a large limit so we capture as many results as the server allows
  // in one call. search_code has no offset, so a big limit is the only lever.
  // Also request JSON explicitly: newer server versions default to compact
  // tree text (TOON), which this extension has never been able to parse.
  const args: Record<string, any> = { project, ...userArgs, limit: 500, format: 'json' };
  const result = await client!.callTool(tool, args);
  return result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
}

// ── Advanced search options ─────────────────────────────────────────

interface AdvancedOption {
  key: string;
  label: string;
  kind: 'text' | 'boolean' | 'choice' | 'array';
  placeholder?: string;
  choices?: string[];
  current?: any;
}

// Shows a QuickPick letting the user add/change optional search parameters.
// Returns the accumulated args, or null if the user cancelled.
async function collectAdvancedOptions(
  options: AdvancedOption[],
  args: Record<string, any>,
  title: string
): Promise<Record<string, any> | null> {
  for (;;) {
    const list: vscode.QuickPickItem[] = [];

    // "Done" runs the search
    list.push({ label: '$(check) Done — run search', description: 'execute now' });

    for (const o of options) {
      if (o.current === undefined || o.current === null) {
        list.push({ label: `$(add) ${o.label}`, description: o.placeholder });
      } else {
        list.push({ label: `$(clear-all) ${o.label}`, description: String(o.current), detail: 'selected — pick to change' });
      }
    }

    const picked = await vscode.window.showQuickPick(list, {
      title,
      placeHolder: 'Add/change optional search parameters, then Done',
      ignoreFocusOut: true,
    });
    if (!picked) return null; // cancelled

    // Done
    if (picked.label.includes('Done — run search')) return args;

    // Find the option by matching label text
    const opt = options.find(o => picked.label.includes(o.label));
    if (!opt) continue;

    if (opt.kind === 'boolean') {
      const val = await vscode.window.showQuickPick(
        ['true', 'false'],
        { title: `${opt.label} (currently ${opt.current})` }
      );
      if (!val) continue;
      opt.current = val === 'true';
      args[opt.key] = opt.current;
    } else if (opt.kind === 'choice') {
      const val = await vscode.window.showQuickPick(
        opt.choices || [],
        { title: `${opt.label} (currently ${opt.current})` }
      );
      if (!val) continue;
      opt.current = val;
      args[opt.key] = opt.current;
    } else if (opt.kind === 'array') {
      const str = await vscode.window.showInputBox({
        prompt: `${opt.label} (comma or space separated)`,
        value: opt.current ? String((opt.current as string[]).join(',')) : '',
        ignoreFocusOut: true,
      });
      if (str === undefined) continue;
      opt.current = str.split(/[\s,]+/).filter(s => s.length > 0);
      args[opt.key] = opt.current;
    } else {
      // text / number
      const isNum = opt.kind === 'text' && ['min_degree', 'max_degree', 'context', 'limit', 'offset'].includes(opt.key);
      const val = await vscode.window.showInputBox({
        prompt: opt.label,
        placeHolder: opt.placeholder,
        value: opt.current !== undefined ? String(opt.current) : '',
        ignoreFocusOut: true,
      });
      if (val === undefined) continue;
      if (isNum && val.trim() !== '') {
        opt.current = parseInt(val, 10);
      } else if (val.trim() === '') {
        opt.current = undefined;
        delete args[opt.key];
        continue;
      } else {
        opt.current = val;
      }
      if (opt.current !== undefined) args[opt.key] = opt.current;
    }
  }
}

// Build the set of advanced options for search_graph.
function graphAdvancedOptions(current: Record<string, any>): AdvancedOption[] {
  return [
    { key: 'label', label: 'Label filter', kind: 'text', placeholder: 'Function, Class, Method, Route...', current: current.label },
    { key: 'name_pattern', label: 'Name pattern (regex)', kind: 'text', placeholder: '.*Handler.*', current: current.name_pattern },
    { key: 'qn_pattern', label: 'Qualified-name pattern', kind: 'text', placeholder: 'pkg/.*', current: current.qn_pattern },
    { key: 'file_pattern', label: 'File pattern (glob)', kind: 'text', placeholder: '*.go', current: current.file_pattern },
    { key: 'relationship', label: 'Relationship type', kind: 'text', placeholder: 'CALLS, DATA_FLOWS...', current: current.relationship },
    { key: 'semantic_query', label: 'Semantic query (terms)', kind: 'array', placeholder: 'send, publish, pubsub', current: current.semantic_query },
    { key: 'min_degree', label: 'Min degree', kind: 'text', placeholder: 'integer', current: current.min_degree },
    { key: 'max_degree', label: 'Max degree', kind: 'text', placeholder: 'integer', current: current.max_degree },
    { key: 'exclude_entry_points', label: 'Exclude entry points', kind: 'boolean', current: current.exclude_entry_points },
    { key: 'include_connected', label: 'Include connected', kind: 'boolean', current: current.include_connected },
  ];
}

// Build the set of advanced options for search_code.
function codeAdvancedOptions(current: Record<string, any>): AdvancedOption[] {
  return [
    { key: 'mode', label: 'Mode', kind: 'choice', choices: ['compact', 'full', 'files'], current: current.mode },
    { key: 'file_pattern', label: 'File pattern (glob)', kind: 'text', placeholder: '*.go', current: current.file_pattern },
    { key: 'path_filter', label: 'Path filter (regex)', kind: 'text', placeholder: '^src/', current: current.path_filter },
    { key: 'regex', label: 'Regex pattern', kind: 'boolean', current: current.regex },
    { key: 'context', label: 'Context lines', kind: 'text', placeholder: 'e.g. 3', current: current.context },
  ];
}


// A flat, display-ready search row.
interface SearchRow {
  label: string;
  file: string;
  line: number;
  detail?: string;
}

function colIndexOf(cols: string[], names: string[]): number {
  for (const n of names) {
    const i = cols.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

// Map column-name -> cell position, given a `cols` header + row arrays
// (the format both newer search_graph/search_code use: rows + cols).
function rowsFromColumns(cols: string[], rawRows: any[][]): SearchRow[] {
  const iName = colIndexOf(cols, ['name', 'qn', 'qualified_name', 'symbol']);
  const iFile = colIndexOf(cols, ['file', 'file_path', 'path']);
  const iLine = colIndexOf(cols, ['lines', 'line', 'start_line']);
  const iLabel = colIndexOf(cols, ['label']);
  return rawRows.map((r) => {
    const file = iFile >= 0 ? String(r[iFile] ?? '') : '';
    const parsedLine = parseInt(iLine >= 0 ? String(r[iLine] ?? '') : '', 10);
    const line = Number.isFinite(parsedLine) ? parsedLine : 0;
    let label = iName >= 0 ? String(r[iName] ?? '') : '';
    if (!label && iLabel >= 0) label = String(r[iLabel] ?? '');
    if (!label) label = file.split('/').pop() || '(row)';
    return {
      label,
      file,
      line,
      detail: iLabel >= 0 && iName >= 0 && r[iLabel] != null ? String(r[iLabel]) : undefined,
    };
  });
}

// Newer search_graph groups rows under `groups` (each with qn_prefix + file).
function rowsFromGroups(groups: any[], cols: string[]): SearchRow[] {
  const out: SearchRow[] = [];
  for (const g of groups) {
    const prefix = g.qn_prefix ? `${g.qn_prefix}.` : '';
    const file = g.file ? String(g.file) : '';
    const rawRows = Array.isArray(g.rows) ? g.rows : [];
    out.push(...rowsFromColumns(cols, rawRows).map((r) => ({
      ...r,
      label: prefix ? `${prefix}${r.label}` : r.label,
      file: file || r.file,
    })));
  }
  return out;
}

// Legacy format: arrays of row objects (results/matches/semantic_results).
function rowsFromObjects(objects: any[]): SearchRow[] {
  return objects.map((r) => {
    const file = r.file_path || r.file || r.path || '';
    const rawLine = Number(r.start_line || r.line || 0);
    const line = Number.isFinite(rawLine) ? rawLine : 0;
    const label =
      r.name || r.node || r.symbol || r.function || r.qualified_name || r.qn ||
      file.split('/').pop() || '(result)';
    return {
      label: String(label),
      file: String(file),
      line,
      detail: typeof r.label === 'string' ? r.label : undefined,
    };
  });
}

// Flatten any search response shape (old flat JSON, new cols/rows, new
// groups, semantic buckets) into a single list of display rows. Only the
// $rows/$groups column-matrix forms are trusted when a `cols` header is
// present — search responses always carry one, other JSON never does.
function extractSearchRows(parsed: any): SearchRow[] {
  const rows: SearchRow[] = [];
  const cols = Array.isArray(parsed.cols) ? parsed.cols.map(String) : [];
  const isMatrix = (v: any) => Array.isArray(v) && v.every((r) => Array.isArray(r));
  if (cols.length > 0 && Array.isArray(parsed.groups)) {
    rows.push(...rowsFromGroups(parsed.groups, cols));
  } else if (cols.length > 0 && isMatrix(parsed.rows)) {
    rows.push(...rowsFromColumns(cols, parsed.rows));
  } else if (Array.isArray(parsed.results)) {
    rows.push(...rowsFromObjects(parsed.results));
  } else if (Array.isArray(parsed.matches)) {
    rows.push(...rowsFromObjects(parsed.matches));
  }
  const sem = parsed.semantic;
  if (sem && typeof sem === 'object' && Array.isArray(sem.rows)) {
    rows.push(...rowsFromColumns(Array.isArray(sem.cols) ? sem.cols.map(String) : [], sem.rows));
  } else if (Array.isArray(parsed.semantic_results)) {
    rows.push(...rowsFromObjects(parsed.semantic_results));
  }
  // search_code mode:"files" returns a plain list of file paths.
  if (Array.isArray(parsed.files)) {
    rows.push(...parsed.files
      .filter((f: any) => typeof f === 'string' && f.length > 0)
      .map((f: string) => ({
        label: f.split('/').pop() || f,
        file: f,
        line: 0,
      })));
  }
  return rows;
}

// Search metadata surfaced as the header tooltip (search mode, totals, ...).
function collectMeta(parsed: any): string[] {
  const out: string[] = [];
  const push = (k: string, v: any) => {
    if (v === undefined || v === null || v === '' || v === false) return;
    out.push(`${k}: ${v}`);
  };
  push('total', parsed.total);
  push('total_results', parsed.total_results);
  push('count', parsed.count);
  push('search_mode', parsed.search_mode);
  push('mode', parsed.mode);
  push('total_grep_matches', parsed.total_grep_matches);
  push('raw_match_count', parsed.raw_match_count);
  push('dedup_ratio', parsed.dedup_ratio);
  if (parsed.has_more === true) out.push('has_more: true');
  push('elapsed_ms', parsed.elapsed_ms);
  if (Array.isArray(parsed.warnings) && parsed.warnings.length) {
    out.push(`warnings: ${parsed.warnings.join('; ')}`);
  }
  push('hint', parsed.hint);
  push('warning', parsed.warning);
  push('warning_slow', parsed.warning_slow);
  return out;
}

// Best-effort parser for the server's compact tree text (TOON) format,
// used by older binaries that ignore format:"json". Returns null when the
// text does not look like tree output (then it is shown as raw text).
// Handles the indented rows the server emits, plus the condensed
// `k:v <- k:v <- ...` form (no indentation) sometimes seen when a tool
// result is passed through an agent UI: the `results: N (cols: ...)` header
// reserves exactly N following lines as rows.
const TREE_SCALAR_KEYS = new Set([
  'hint', 'warning', 'warning_slow',
]);
function parseTreeText(text: string): { rows: SearchRow[]; meta: string[] } | null {
  const norm = text.replace(/\s*<-\s*/g, '\n');
  const lines = norm.split('\n');
  const meta: string[] = [];
  const rows: SearchRow[] = [];
  let cols: string[] = [];
  let rowsLeft = 0;

  const scalarMatch = (line: string): { key: string; val: string } | null => {
    const m = line.match(/^([A-Za-z_][A-Za-z_0-9]*):\s+(.*)$/);
    if (!m) return null;
    const key = m[1];
    const val = m[2].trim();
    // Indented lines are rows, never scalars.
    if (/^\s/.test(line)) return null;
    return { key, val };
  };
  const isScalar = (key: string, val: string): boolean =>
    TREE_SCALAR_KEYS.has(key) || /^\S+\s*$/.test(val);

  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const sc = scalarMatch(line);
    if (sc) {
      const cm = sc.val.match(/^(\d+)\s*\(cols:\s*(.*)\)$/);
      if (cm) {
        cols = cm[2].split(/\s+/);
        rowsLeft = parseInt(cm[1], 10);
        continue;
      }
      // Genuine scalar (single value or known free-text key): metadata.
      if (isScalar(sc.key, sc.val) || rowsLeft === 0) {
        if (sc.key === 'has_more' && sc.val === 'false') continue;
        meta.push(`${sc.key}: ${isScalar(sc.key, sc.val) ? sc.val : sc.val.split(/\s{2,}/)[0]}`);
        continue;
      }
    }
    // Within an open table the next N lines are rows, indented or not.
    if (rowsLeft > 0) {
      let cells = line.trim().split(/\s{2,}/).filter(Boolean);
      // Condensed rows collapse cells to single spaces; recover them when the
      // token count exactly matches the column count.
      if (cells.length === 1) {
        const toks = line.trim().split(/\s+/);
        if (toks.length === cols.length) cells = toks;
      }
      if (cells.length > 0) {
        rows.push(...rowsFromColumns(cols, [cells]));
      }
      rowsLeft--;
    }
  }
  if (rows.length === 0 && meta.length === 0) return null;
  return { rows, meta };
}

// Parse the search_graph / search_code response (JSON or tree text) and
// populate the Results tree view with a flat, clickable list of results.
// Search metadata (total, search_mode, elapsed_ms, ...) is surfaced as
// the header tooltip rather than occupying a row.
function populateResultsFromJson(text: string, title: string): void {
  const headerItem = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.Expanded);
  headerItem.iconPath = new vscode.ThemeIcon('search');

  let children: vscode.TreeItem[] = [];

  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  let rows: SearchRow[] = [];
  let meta: string[] = [];

  if (parsed && typeof parsed === 'object') {
    rows = extractSearchRows(parsed);
    meta = collectMeta(parsed);
  } else {
    const tree = parseTreeText(text);
    if (tree) {
      rows = tree.rows;
      meta = tree.meta;
    } else {
      const leaf = new vscode.TreeItem(text.slice(0, 100), vscode.TreeItemCollapsibleState.None);
      leaf.tooltip = text;
      children = [leaf];
    }
  }

  if (children.length === 0 && rows.length === 0) {
    const empty = new vscode.TreeItem('No results', vscode.TreeItemCollapsibleState.None);
    empty.description = 'try a different query or pattern';
    empty.iconPath = new vscode.ThemeIcon('info');
    empty.contextValue = 'empty';
    children.push(empty);
  } else if (children.length === 0) {
    // Flat list — one row per result, each clickable to open the file.
    children = rows.map((r) => {
      const item = new vscode.TreeItem(r.label, vscode.TreeItemCollapsibleState.None);
      const location = r.file ? `${r.file}${r.line ? `:${r.line}` : ''}` : '';
      item.description = location && r.detail ? `${location} ${r.detail}` : location || r.detail;
      item.iconPath = new vscode.ThemeIcon('symbol-function');
      if (r.detail) item.tooltip = r.detail;
      if (r.file) {
        item.command = {
          command: 'cbm.openFile',
          title: 'Open file',
          arguments: [r.file, r.line || 0],
        };
      }
      return item;
    });
  }

  // Header metrics: hit count as description, details as a tooltip.
  const count =
    parsed && parsed.total !== undefined ? parsed.total
    : parsed && parsed.total_results !== undefined ? parsed.total_results
    : parsed && parsed.count !== undefined ? parsed.count
    : rows.length;
  if (count !== undefined) {
    headerItem.description = `${count} hit${count === 1 ? '' : 's'}`;
  }
  if (meta.length) {
    headerItem.tooltip = meta.join(', ');
  }

  (headerItem as any).children = children;
  resultsProvider.setResults([headerItem]);
}

// Render an arbitrary JSON value into the Results tree as a nested,
// expandable hierarchy (used for schema, ADR, architecture, cypher, etc.).
// Leaf objects that carry a file reference become clickable to open the file.
function renderJsonTree(json: any, title: string): vscode.TreeItem {
  const header = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.Expanded);
  header.iconPath = new vscode.ThemeIcon('json');

  // If an object has a file reference, surface it as a clickable row and let
  // the remaining keys be child rows beneath it.
  const isOpenable = (v: any) =>
    v && typeof v === 'object' && !Array.isArray(v) &&
    (typeof v.file_path === 'string' || typeof v.file === 'string');

  const toOpenableLeaf = (v: any): vscode.TreeItem => {
    const filePath = v.file_path || v.file || '';
    const line = v.start_line || v.line || 0;
    const label = v.name || v.node || v.symbol || filePath;
    return makeFileItem(String(label), filePath, line, v.qualified_name || '');
  };

  const buildChildren = (val: any): vscode.TreeItem[] => {
    if (Array.isArray(val)) {
      return val.map((v, i) => {
        if (isOpenable(v)) {
          return toOpenableLeaf(v);
        }
        if (v && typeof v === 'object') {
          const it = new vscode.TreeItem(String(i), vscode.TreeItemCollapsibleState.Collapsed);
          (it as any).children = buildChildren(v);
          return it;
        }
        return new vscode.TreeItem(String(v), vscode.TreeItemCollapsibleState.None);
      });
    }
    if (val && typeof val === 'object') {
      return Object.entries(val).map(([k, v]) => {
        if (v !== null && (typeof v === 'object')) {
          if (isOpenable(v)) {
            return toOpenableLeaf(v);
          }
          const it = new vscode.TreeItem(k, vscode.TreeItemCollapsibleState.Collapsed);
          (it as any).children = buildChildren(v);
          return it;
        }
        // A key explicitly naming a file path becomes clickable.
        const it = new vscode.TreeItem(`${k}: ${v === null ? 'null' : String(v)}`, vscode.TreeItemCollapsibleState.None);
        if (k === 'file_path' || k === 'file' || k === 'path' || k === 'src') {
          it.command = { command: 'cbm.openFile', title: 'Open file', arguments: [String(v), 0] };
          it.iconPath = new vscode.ThemeIcon('file-code');
        }
        return it;
      });
    }
    return [];
  };

  (header as any).children = buildChildren(json);
  return header;
}

// Render a trace_path response (callers/callees with hops) into the
// Results tree with clickable file links resolved via the registry.
function renderTrace(parsed: any, project: string, title: string): void {
  const header = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.Expanded);
  header.iconPath = new vscode.ThemeIcon('graph');
  const children: vscode.TreeItem[] = [];

  const addGroup = (groupName: string, list: any[] | undefined) => {
    if (!list || list.length === 0) return;
    const group = new vscode.TreeItem(groupName, vscode.TreeItemCollapsibleState.Collapsed);
    group.iconPath = new vscode.ThemeIcon('symbol-method');
    const gchildren = list.map((n) => {
      const lbl = `${n.name}  (hop ${n.hop ?? '?'})`;
      const filePath = n.file_path || n.file || '';
      const line = n.start_line || n.line || 0;
      if (filePath) {
        return makeFileItem(lbl, filePath, line, `${n.qualified_name || ''}`);
      }
      const it = new vscode.TreeItem(lbl, vscode.TreeItemCollapsibleState.None);
      it.description = n.qualified_name || '';
      return it;
    });
    (group as any).children = gchildren;
    children.push(group);
  };

  if (parsed.function !== undefined) {
    header.description = parsed.function;
  }
  addGroup('Callers', parsed.callers);
  addGroup('Callees', parsed.callees);

  if (children.length === 0) {
    const info = new vscode.TreeItem('No connections in this direction', vscode.TreeItemCollapsibleState.None);
    info.iconPath = new vscode.ThemeIcon('info');
    children.push(info);
  }

  (header as any).children = children;
  resultsProvider.setResults([header]);
  const _ = project; // openFile resolves via selectedProject/registry
}

// Resolve a user-typed function name to an exact qualified_name by querying
// the graph, presenting a disambiguation QuickPick when the name is ambiguous
// or unknown. Returns the chosen qualified_name, or null if cancelled.
async function resolveQualifiedName(project: string, input: string): Promise<string | null> {
  // 1) Try a direct exact graph lookup via qn_pattern first (cheap).
  try {
    const direct = await client!.callTool('search_graph', {
      project,
      qn_pattern: `.*\\.${input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
      limit: 1,
    });
    const dt = direct.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    const dp = JSON.parse(dt);
    if (dp.results && dp.results[0]?.qualified_name) return dp.results[0].qualified_name;
  } catch { /* fall through */ }

  // 2) Natural-language search / suggestions for the typed name.
  const res = await client!.callTool('search_graph', { project, query: input, limit: 30 });
  const text = res.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  let candidates: any[] = [];
  try {
    const p = JSON.parse(text);
    candidates = (p.results || []).filter((r: any) => r.qualified_name || r.name);
  } catch {
    outputChannel.appendLine(text);
    return null;
  }

  if (candidates.length === 1) return candidates[0].qualified_name;
  if (candidates.length === 0) {
    vscode.window.showWarningMessage(`No symbol found for "${input}"`);
    return null;
  }

  const pick = await vscode.window.showQuickPick(
    candidates.map(c => ({
      label: c.name || c.qualified_name || '',
      description: c.file_path || '',
      detail: c.qualified_name,
      qualified_name: c.qualified_name,
    })),
    { title: `Select symbol for "${input}"`, matchOnDetail: true }
  );
  return (pick as any)?.qualified_name || null;
}

// Shared flow for tracing callers/callees: resolve the name, call trace_path,
// and render the path into the Results tree with clickable file links.
async function traceFlow(direction: 'inbound' | 'outbound', label: string): Promise<void> {
  const project = selectedProject || getProjectName();
  if (!project) return;

  const input = await vscode.window.showInputBox({
    prompt: label,
    placeHolder: 'function name, e.g. handleRequest',
  });
  if (!input) return;

  // Optional trace settings
  const depthPick = await vscode.window.showQuickPick(
    ['1', '2', '3', '5'],
    { placeHolder: `Trace depth (default 3)`, ignoreFocusOut: true }
  ).then(v => v === undefined ? null : parseInt(v, 10));
  const includeTests = await vscode.window.showQuickPick(
    ['No', 'Yes'],
    { placeHolder: 'Include test files in the trace?' }
  );
  if (includeTests === undefined) return;

  statusBarItem.text = '$(loading~spin) CBM: Resolving symbol...';
  const qn = await resolveQualifiedName(project, input);
  if (!qn) {
    statusBarItem.text = '$(check) CBM: Connected';
    return;
  }

  outputChannel.appendLine(`\n── ${label}: ${qn} ──`);
  statusBarItem.text = '$(loading~spin) CBM: Tracing...';

  const result = await client!.tracePath(project, qn, direction, {
    depth: depthPick ?? 3,
    include_tests: includeTests === 'Yes',
  });
  const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  outputChannel.appendLine(`\n── ${label}: ${qn} ──\n${text}`);

  try {
    renderTrace(JSON.parse(text), project, `${label}: ${input}`);
  } catch {
    populateResultsFromJson(text, `${label}: ${input}`);
  }

  statusBarItem.text = '$(check) CBM: Connected';
}


// ── Activation ──────────────────────────────────────────────────────

// Delete a project's index (both in-memory and on storage) with a
// confirmation prompt. Shared by the palette, context menu, and hotkey.
async function deleteIndexFor(projectName: string): Promise<void> {
  if (!(await ensureConnected())) return;
  if (!projectName) {
    vscode.window.showWarningMessage('No project selected to delete');
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Delete index for "${projectName}"? This removes it from memory and storage and cannot be undone.`,
    { modal: true },
    'Delete'
  );
  if (confirm !== 'Delete') return;

  try {
    const result = await client!.deleteProject(projectName);
    showResults(result, 'Delete Complete');
    await projectsProvider.loadProjects();
    projectsProvider.refresh();
  } catch (err: any) {
    vscode.window.showErrorMessage(`Delete failed: ${err.message}`);
  }
}

export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('CBM Search');
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusBarItem.text = '$(database) CBM';
  statusBarItem.tooltip = 'Codebase Memory MCP';
  statusBarItem.command = 'cbm.listProjects';
  statusBarItem.show();

  projectsProvider = new ProjectsTreeProvider();
  vscode.window.registerTreeDataProvider('cbm.projects', projectsProvider);

  const projectsTree = vscode.window.createTreeView('cbm.projects', {
    treeDataProvider: projectsProvider,
  });
  projectsTree.onDidChangeSelection((e) => {
    const item = e.selection[0] as ProjectItem | undefined;
    selectedProject = item?.projectName || '';
  });
  context.subscriptions.push(projectsTree);

  resultsProvider = new SearchResultsProvider();
  vscode.window.registerTreeDataProvider('cbm.results', resultsProvider);

  // ── Commands ──────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('cbm.refresh', () => {
      projectsProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cbm.clearResults', () => {
      resultsProvider.clear();
    })
  );

  // Reveal a project's folder in the Explorer (fires on single click of a
  // project row). If the folder is already a workspace root, just reveal it;
  // otherwise show it in a new window.
  context.subscriptions.push(
    vscode.commands.registerCommand('cbm.revealProjectFolder', async (projectName?: string, rootPath?: string) => {
      const resolved = rootPath || projectRootPaths[selectedProject || ''] || projectRootPaths[projectName || ''];
      if (!resolved) {
        vscode.window.showWarningMessage('No folder path recorded for this project');
        return;
      }
      const uri = vscode.Uri.file(resolved);
      const isOpen = vscode.workspace.getWorkspaceFolder(uri) !== undefined;
      if (isOpen) {
        await vscode.commands.executeCommand('revealInExplorer', uri);
      } else {
        await vscode.commands.executeCommand('vscode.openFolder', uri);
      }
    })
  );

  // Context-menu / palette: open a project's folder in a new window.
  context.subscriptions.push(
    vscode.commands.registerCommand('cbm.openProjectInNewWindow', async (arg?: string | ProjectItem) => {
      let rootPath: string | undefined;
      let projectName: string | undefined;
      if (arg instanceof ProjectItem) {
        rootPath = arg.rootPath;
        projectName = arg.projectName;
      } else if (typeof arg === 'string') {
        projectName = arg;
        rootPath = projectRootPaths[arg];
      } else {
        projectName = selectedProject;
        rootPath = projectRootPaths[selectedProject] || projectRootPaths[getProjectName()];
      }
      if (!rootPath) {
        vscode.window.showWarningMessage('No folder path recorded for this project');
        return;
      }
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(rootPath), { forceNewWindow: true });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cbm.openFile', async (filePath: string, line: number) => {
      let uri: vscode.Uri;

      if (path.isAbsolute(filePath)) {
        uri = vscode.Uri.file(filePath);
      } else {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        const wsCandidate = root ? vscode.Uri.joinPath(root, filePath) : null;

        // If the file resolves inside the workspace, use it; otherwise look
        // up the selected project's root (indexed projects may live outside
        // the workspace, e.g. ~/git/other-repo).
        let useWs = false;
        if (wsCandidate) {
          try {
            const stat = await vscode.workspace.fs.stat(wsCandidate);
            useWs = stat.type === vscode.FileType.File;
          } catch { useWs = false; }
        }
        uri = useWs
          ? wsCandidate!
          : vscode.Uri.file(path.join(projectRootPaths[selectedProject] || projectRootPaths[getProjectName()] || '', filePath));
      }

      vscode.window.showTextDocument(uri, {
        preview: true,
        selection: line && line > 0 ? new vscode.Range(line - 1, 0, line - 1, 0) : undefined,
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cbm.listProjects', async () => {
      if (!(await ensureConnected())) return;
      const text = await client!.listProjects();
      outputChannel.appendLine(`\n── Projects ──\n${text}`);
      outputChannel.show(true);
      await projectsProvider.loadProjects();
      projectsProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cbm.indexProject', async () => {
      if (!(await ensureConnected())) return;

      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        vscode.window.showWarningMessage('No workspace folder open');
        return;
      }

      const name = await vscode.window.showInputBox({
        prompt: 'Project name (leave empty to use folder name)',
        value: folder.name,
      });
      if (name === undefined) return;

      statusBarItem.text = '$(loading~spin) CBM: Indexing...';
      outputChannel.appendLine(`\n── Indexing ${folder.uri.fsPath} ──`);

      try {
        const result = await client!.indexRepository(
          folder.uri.fsPath,
          name || folder.name,
          'moderate'
        );
        showResults(result, 'Index Complete');
        statusBarItem.text = '$(check) CBM: Indexed';
        await projectsProvider.loadProjects();
        projectsProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Index failed: ${err.message}`);
        statusBarItem.text = '$(error) CBM: Index failed';
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cbm.deleteIndex', async (arg?: string | ProjectItem) => {
      let name: string | undefined;
      if (typeof arg === 'string') {
        name = arg;
      } else if (arg && (arg as any).projectName) {
        name = (arg as any).projectName;
      }

      if (name) {
        return deleteIndexFor(name);
      }

      // No name passed — prompt for it
      if (!(await ensureConnected())) return;
      const project = await vscode.window.showInputBox({
        prompt: 'Project name to delete',
      });
      if (!project) return;
      return deleteIndexFor(project);
    })
  );

  // Hotkey / context-menu entry: delete the currently selected project.
  context.subscriptions.push(
    vscode.commands.registerCommand('cbm.deleteSelectedProject', async () => {
      if (selectedProject) {
        return deleteIndexFor(selectedProject);
      }
      // Fall back to the palette behavior (prompt)
      if (!(await ensureConnected())) return;
      const project = await vscode.window.showInputBox({
        prompt: 'Project name to delete',
      });
      if (!project) return;
      return deleteIndexFor(project);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cbm.searchGraph', async () => {
      if (!(await ensureConnected())) return;

      const project = getProjectName();
      const query = await vscode.window.showInputBox({
        prompt: 'Search query',
        placeHolder: 'natural-language or keyword (leave empty for name_pattern/semantic)',
      });
      if (query === undefined) return;

      const args: Record<string, any> = {};
      if (query.trim()) args.query = query.trim();

      const opts = graphAdvancedOptions(args);
      const finalArgs = await collectAdvancedOptions(opts, args, 'Search Graph — advanced options');
      if (!finalArgs) return;
      if (finalArgs.semantic_query && !finalArgs.query) {
        vscode.window.showInformationMessage(
          `Semantic search: ${finalArgs.semantic_query.join(', ')}`
        );
      }

      outputChannel.appendLine(`\n── Search Graph: ${args.query || args.name_pattern || '(terms)'} ──`);
      const text = await runSearch('search_graph', project, finalArgs);
      populateResultsFromJson(text, args.query || args.name_pattern || 'Search results');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cbm.searchCode', async () => {
      if (!(await ensureConnected())) return;

      const project = getProjectName();
      const pattern = await vscode.window.showInputBox({
        prompt: 'Search pattern (regex unless regex=false)',
        placeHolder: 'function.*handler',
      });
      if (pattern === undefined) return;

      const args: Record<string, any> = {};
      if (pattern.trim()) args.pattern = pattern.trim();

      const opts = codeAdvancedOptions(args);
      const finalArgs = await collectAdvancedOptions(opts, args, 'Search Code — advanced options');
      if (!finalArgs) return;

      outputChannel.appendLine(`\n── Search Code: ${args.pattern} ──`);
      const text = await runSearch('search_code', project, finalArgs);
      populateResultsFromJson(text, args.pattern || 'Search results');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cbm.traceCallers', async () => {
      if (!(await ensureConnected())) return;
      return traceFlow('inbound', 'Trace Callers');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cbm.traceCallees', async () => {
      if (!(await ensureConnected())) return;
      return traceFlow('outbound', 'Trace Callees');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cbm.getSnippet', async () => {
      if (!(await ensureConnected())) return;

      const project = selectedProject || getProjectName();
      if (!project) return;

      const qn = await vscode.window.showInputBox({
        prompt: 'Qualified name (e.g., pkg.Module.Function)',
        placeHolder: 'main.handleRequest',
      });
      if (!qn) return;

      outputChannel.appendLine(`\n── Snippet: ${qn} ──`);
      const result = await client!.getSnippet(project, qn);
      const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');

      // Some versions return a structured snippet object; render as tree.
      try {
        const obj = JSON.parse(text);
        const snip = obj.snippet ?? obj.source ?? obj;
        const header = new vscode.TreeItem(`Snippet: ${qn}`, vscode.TreeItemCollapsibleState.Expanded);
        header.description = obj.file_path || obj.file || undefined;
        header.iconPath = new vscode.ThemeIcon('symbol-function');
        const leaf = new vscode.TreeItem(
          typeof snip === 'string' ? snip.slice(0, 2000) : text.slice(0, 2000),
          vscode.TreeItemCollapsibleState.None
        );
        if (obj.file_path) leaf.command = { command: 'cbm.openFile', title: 'Open', arguments: [obj.file_path, obj.start_line || 0] };
        (header as any).children = [leaf];
        resultsProvider.setResults([header]);
      } catch {
        populateResultsFromJson(text, `Snippet: ${qn}`);
      }
      outputChannel.appendLine(text);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cbm.getArchitecture', async () => {
      if (!(await ensureConnected())) return;

      const project = selectedProject || getProjectName();
      if (!project) return;
      outputChannel.appendLine(`\n── Architecture: ${project} ──`);

      const aspects = await vscode.window.showQuickPick(
        ['all', 'overview', 'structure', 'dependencies', 'routes', 'languages', 'packages', 'entry_points', 'hotspots', 'boundaries', 'layers', 'clusters'],
        { canPickMany: true, placeHolder: 'Architecture aspects (all by default)' }
      );
      const result = await client!.getArchitecture(project, aspects && aspects.length ? aspects : undefined);
      const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      outputChannel.appendLine(text);
      try {
        resultsProvider.setResults([renderJsonTree(JSON.parse(text), `Architecture: ${project}`)]);
      } catch {
        populateResultsFromJson(text, `Architecture: ${project}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cbm.cypherQuery', async () => {
      if (!(await ensureConnected())) return;

      const project = selectedProject || getProjectName();
      if (!project) return;

      const query = await vscode.window.showInputBox({
        prompt: 'Cypher query',
        placeHolder: 'MATCH (f:Function) RETURN f.qualified_name LIMIT 10',
      });
      if (!query) return;

      outputChannel.appendLine(`\n── Cypher: ${query} ──`);
      const result = await client!.cypherQuery(project, query);
      const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      outputChannel.appendLine(text);
      try {
        const obj = JSON.parse(text);
        const rows = obj.rows ?? obj.results ?? obj;
        resultsProvider.setResults([renderJsonTree(rows, 'Cypher Query')]);
      } catch {
        populateResultsFromJson(text, 'Cypher Query');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cbm.getGraphSchema', async () => {
      if (!(await ensureConnected())) return;

      const project = selectedProject || getProjectName();
      if (!project) return;
      outputChannel.appendLine(`\n── Graph Schema: ${project} ──`);

      const result = await client!.getGraphSchema(project);
      const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      outputChannel.appendLine(text);
      try {
        resultsProvider.setResults([renderJsonTree(JSON.parse(text), `Graph Schema: ${project}`)]);
      } catch {
        populateResultsFromJson(text, `Graph Schema: ${project}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cbm.manageAdr', async () => {
      if (!(await ensureConnected())) return;

      const project = selectedProject || getProjectName();
      if (!project) return;

      const action = await vscode.window.showQuickPick(
        ['Get ADR', 'Create / Update ADR', 'List sections'],
        { placeHolder: 'Architecture Decision Record' }
      );
      if (!action) return;

      if (action === 'Get ADR') {
        const result = await client!.manageAdr(project, { mode: 'get' });
        const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        outputChannel.appendLine(`\n── ADR: ${project} ──\n${text}`);
        try {
          const obj = JSON.parse(text);
          if (obj.status === 'no_adr') {
            vscode.window.showInformationMessage(obj.adr_hint || 'No ADR yet');
            resultsProvider.setResults([renderJsonTree(obj, `ADR: ${project}`)]);
          } else if (obj.content) {
            const header = new vscode.TreeItem(`ADR: ${project}`, vscode.TreeItemCollapsibleState.Expanded);
            const leaf = new vscode.TreeItem(obj.content, vscode.TreeItemCollapsibleState.None);
            (header as any).children = [leaf];
            resultsProvider.setResults([header]);
          } else {
            populateResultsFromJson(text, `ADR: ${project}`);
          }
        } catch {
          populateResultsFromJson(text, `ADR: ${project}`);
        }
        return;
      }

      if (action === 'List sections') {
        const result = await client!.manageAdr(project, { mode: 'sections' });
        const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        outputChannel.appendLine(`\n── ADR sections: ${project} ──\n${text}`);
        try {
          resultsProvider.setResults([renderJsonTree(JSON.parse(text), `ADR Sections: ${project}`)]);
        } catch {
          populateResultsFromJson(text, `ADR Sections: ${project}`);
        }
        return;
      }

      // Create / Update ADR — opens a scratch editor for multi-line content.
      const doc = await vscode.workspace.openTextDocument({
        language: 'markdown',
        content:
          '## PURPOSE\n\n## STACK\n\n## ARCHITECTURE\n\n## PATTERNS\n\n## TRADEOFFS\n\n## PHILOSOPHY\n',
      });
      vscode.window.showTextDocument(doc, { preview: false });

      const save = async () => {
        const content = doc.getText();
        outputChannel.appendLine(`\n── ADR updated: ${project} ──\n${content}`);
        const result = await client!.manageAdr(project, { mode: 'update', content });
        const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        outputChannel.appendLine(text);
        vscode.window.showInformationMessage('ADR saved');
      };

      // Ctrl/Cmd+Enter commits the ADR; saving the scratch doc also commits;
      // closing the tab cancels and cleans up the temporary handlers.
      let settled = false;
      const settle = (msg: string, fn?: () => void) => {
        if (settled) return;
        settled = true;
        if (fn) fn();
        vscode.window.showInformationMessage(msg);
      };

      const saveDisposable = vscode.commands.registerCommand('cbm.saveAdrContent', () => {
        save().then(
          () => settle('ADR saved'),
          (e: any) => vscode.window.showErrorMessage(`Failed to save ADR: ${e.message}`)
        );
      });
      const saveEv = vscode.workspace.onDidSaveTextDocument((d) => {
        if (d.uri.toString() === doc.uri.toString()) save();
      });
      const closeEv = vscode.workspace.onDidCloseTextDocument((d) => {
        if (d.uri.toString() !== doc.uri.toString()) return;
        saveDisposable.dispose();
        saveEv.dispose();
        closeEv.dispose();
      });

      vscode.window.showInformationMessage(
        'Edit the ADR, then save with Cmd/Ctrl+S or Cmd/Ctrl+Enter to commit — closing cancels.'
      );

      // Resolve when the scratch tab closes so the command can return.
      await new Promise<void>((resolve) => {
        const closer = vscode.workspace.onDidCloseTextDocument((d) => {
          if (d.uri.toString() === doc.uri.toString()) {
            closer.dispose();
            resolve();
          }
        });
        if (doc.isClosed) {
          closer.dispose();
          resolve();
        }
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cbm.indexStatus', async () => {
      if (!(await ensureConnected())) return;

      const project = selectedProject || getProjectName();
      const result = await client!.indexStatus(project);
      const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      outputChannel.appendLine(`\n── Index Status: ${project} ──\n${text}`);
      try {
        resultsProvider.setResults([renderJsonTree(JSON.parse(text), `Index Status: ${project}`)]);
      } catch {
        populateResultsFromJson(text, `Index Status: ${project}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cbm.detectChanges', async () => {
      if (!(await ensureConnected())) return;

      const project = selectedProject || getProjectName();
      const result = await client!.detectChanges(project);
      const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      outputChannel.appendLine(`\n── Changes Detected: ${project} ──\n${text}`);
      try {
        resultsProvider.setResults([renderJsonTree(JSON.parse(text), `Changes: ${project}`)]);
      } catch {
        populateResultsFromJson(text, 'Changes Detected');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cbm.ingestTraces', async () => {
      if (!(await ensureConnected())) return;

      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { 'JSON': ['json'], 'Text': ['txt', 'log'] },
        title: 'Select trace file',
      });
      if (!uris || uris.length === 0) return;

      const project = getProjectName();
      try {
        const content = await vscode.workspace.fs.readFile(uris[0]);
        const text = Buffer.from(content).toString('utf8');
        const traces = JSON.parse(text);

        if (!Array.isArray(traces)) {
          vscode.window.showErrorMessage('Trace file must contain a JSON array of {caller, callee, count} objects');
          return;
        }
        const bad = traces.findIndex((t: any) => !t || typeof t !== 'object' || !t.caller || !t.callee);
        if (bad !== -1) {
          vscode.window.showErrorMessage(
            `Trace entry at index ${bad} is missing "caller" or "callee". Expected: [{"caller":"a_fn","callee":"b_fn","count":2}]`
          );
          return;
        }

        // "count" is optional (defaults to 1 on the server); normalize if absent.
        const normalized = traces.map((t: any) => ({
          caller: t.caller,
          callee: t.callee,
          count: typeof t.count === 'number' ? t.count : 1,
        }));

        outputChannel.appendLine(`\n── Ingesting ${normalized.length} traces ──`);

        const result = await client!.ingestTraces(project, normalized);
        showResults(result, 'Traces Ingested');
        statusBarItem.text = '$(check) CBM: Connected';
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to ingest traces: ${err.message}`);
        statusBarItem.text = '$(check) CBM: Connected';
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cbm.openPrompt', async () => {
      const terminal = vscode.window.createTerminal('CBM Prompt');
      const binaryPath = McpClient.findBinary(
        vscode.workspace.getConfiguration('cbm').get<string>('binaryPath') || undefined
      );
      if (binaryPath) {
        terminal.sendText(binaryPath);
        terminal.show();
      } else {
        vscode.window.showErrorMessage('codebase-memory-mcp binary not found');
      }
    })
  );

  // ── Auto-connect on startup ───────────────────────────────────

  const autoIndex = vscode.workspace.getConfiguration('cbm').get<boolean>('autoIndex', true);

  // Try to connect silently
  ensureConnected().then(async (connected) => {
    if (connected) {
      await projectsProvider.loadProjects();
      projectsProvider.refresh();
    }
  });
}

export function deactivate() {
  if (client) {
    client.stop();
    client = null;
  }
  if (statusBarItem) {
    statusBarItem.dispose();
  }
  if (outputChannel) {
    outputChannel.dispose();
  }
}
