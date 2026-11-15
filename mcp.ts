// MCP: POST /mcp, JSON-RPC 2.0 over Streamable HTTP, modern era (2026-07-28).
// server/discover + initialize + tools/list + tools/call. Every tool acts on the same store as
// REST and GraphQL. Unknown tools answer -32602, missing arguments answer isError, never HTTP 500.

import { VIEWER_ID, VIEWER_LOGIN, globalId, type Store } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { pullMergeable, squashMerge } from './git.ts';

export const MCP_REVISION = '2026-07-28';
export const MCP_SUPPORTED = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';

// ---------------------------------------------------------------- tools

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, Record<string, unknown>>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(payload: unknown, isError = false): Record<string, unknown> {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    content: [{ type: 'text', text }],
    structuredContent: typeof payload === 'object' && payload !== null ? payload : undefined,
    isError,
  };
}

function toolError(message: string): Record<string, unknown> {
  return toolResult(message, true);
}

function argStr(args: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function argInt(args: Record<string, unknown>, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

/** Run one tool; the answer is a tool result object (never a throw). */
export function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const owner = argStr(args, 'owner', 'owner_login') ?? VIEWER_LOGIN;
  const repoName = argStr(args, 'repo', 'repository', 'name');
  if (name === 'create_repo') {
    const repoLabel = argStr(args, 'name');
    if (repoLabel === undefined) return toolError('Missing required argument: name');
    if (store.getRepo(VIEWER_LOGIN, repoLabel) !== undefined) return toolError(`Repository ${VIEWER_LOGIN}/${repoLabel} already exists`);
    const description = argStr(args, 'description') ?? '';
    const isPrivate = args.private === true;
    const repo = store.createRepo(VIEWER_LOGIN, repoLabel, description, isPrivate);
    return toolResult(repoJson(repo));
  }
  if (name === 'get_repo') {
    if (repoName === undefined) return toolError('Missing required argument: repo');
    if (owner !== VIEWER_LOGIN) return toolError('Not Found');
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return toolError('Not Found');
    return toolResult(repoJson(repo));
  }
  if (name === 'create_issue') {
    const title = argStr(args, 'title');
    if (repoName === undefined) return toolError('Missing required argument: repo');
    if (title === undefined) return toolError('Missing required argument: title');
    if (owner !== VIEWER_LOGIN) return toolError('Not Found');
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return toolError('Not Found');
    const issue = store.createIssue(repo, title, argStr(args, 'body') ?? '', []);
    return toolResult(issueJson(repo, issue));
  }
  if (name === 'list_issues') {
    if (repoName === undefined) return toolError('Missing required argument: repo');
    if (owner !== VIEWER_LOGIN) return toolError('Not Found');
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return toolError('Not Found');
    const state = argStr(args, 'state') ?? 'open';
    let issues = [...repo.issues];
    if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
    return toolResult(issues.map((issue) => issueJson(repo, issue)));
  }
  if (name === 'create_pull_request') {
    const title = argStr(args, 'title');
    const head = argStr(args, 'head', 'head_ref');
    const base = argStr(args, 'base', 'base_ref');
    if (repoName === undefined) return toolError('Missing required argument: repo');
    if (title === undefined) return toolError('Missing required argument: title');
    if (head === undefined) return toolError('Missing required argument: head');
    if (base === undefined) return toolError('Missing required argument: base');
    if (owner !== VIEWER_LOGIN) return toolError('Not Found');
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return toolError('Not Found');
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) return toolError('head or base branch does not exist');
    const pull = store.createPull(repo, title, argStr(args, 'body') ?? '', head, headSha, base, baseSha);
    return toolResult(pullJson(repo, pull));
  }
  if (name === 'merge_pull_request') {
    const pullNumber = argInt(args, 'pull_number', 'number');
    if (repoName === undefined) return toolError('Missing required argument: repo');
    if (pullNumber === undefined) return toolError('Missing required argument: pull_number');
    if (owner !== VIEWER_LOGIN) return toolError('Not Found');
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return toolError('Not Found');
    const pull = repo.pulls.find((candidate) => candidate.number === pullNumber);
    if (pull === undefined) return toolError('Not Found');
    if (pull.state !== 'open' || pull.merged) return toolError('Pull request is already merged or closed');
    if (pullMergeable(repo, pull) === 'CONFLICTING') return toolError('Merge conflict');
    const mergeSha = squashMerge(repo, pull);
    if (mergeSha === null) return toolError('Cannot merge');
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = '2026-11-14T00:00:00Z';
    pull.mergeCommitSha = mergeSha;
    return toolResult({ merged: true, sha: mergeSha, number: pull.number, state: 'closed' });
  }
  return toolError(`Unknown tool ${name}`);
}

// ---------------------------------------------------------------- JSON-RPC

export interface McpResult {
  status: number;
  body: unknown;
}

function rpcResult(id: unknown, result: unknown): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResult {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

/**
 * Handle one POST /mcp body (already read as text). `authorized` says the Bearer token matched.
 * Parse errors answer HTTP 400 with -32700; unauthenticated requests answer HTTP 401.
 */
export function handleMcp(store: Store, bodyText: string, authorized: boolean): McpResult {
  let doc: unknown;
  try {
    doc = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  const record = doc as Record<string, unknown>;
  const id = record.id === undefined ? null : record.id;
  const method = record.method;
  if (typeof method !== 'string') return rpcError(id, -32600, 'Invalid Request', 400);
  // Notifications (no id) need no answer body.
  if (id === null && record.id === undefined) {
    return { status: 202, body: null };
  }
  if (!authorized) return rpcError(id, -32001, 'Unauthorized', 401);
  const params = (record.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return rpcResult(id, {
      resultType: 'discover',
      supportedVersions: [...MCP_SUPPORTED],
      capabilities: { tools: {} },
      instructions: 'A GitHub-compatible git forge: create repos, issues and pull requests over tools.',
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const offered = (params.protocolVersion as string | undefined) ?? '';
    const chosen = MCP_SUPPORTED.includes(offered) ? offered : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: chosen,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    });
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    // The same JSON every time: the tools array is a module constant.
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = params.name;
    if (typeof name !== 'string' || name === '') return rpcError(id, -32602, 'Invalid params: tools/call needs a tool name');
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const known = TOOLS.some((tool) => tool.name === name);
    if (!known) return rpcError(id, -32602, `Unknown tool ${name}`);
    const result = callTool(store, name, args);
    return rpcResult(id, result);
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

export { VIEWER_ID, VIEWER_LOGIN, globalId };
