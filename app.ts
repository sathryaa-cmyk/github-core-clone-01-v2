// The forge's HTTP server: one process, Node stdlib only. Routes:
//   GET  /healthz                              the env's boot probe (no auth)
//   GET  /{owner}/{repo}.git/info/refs         git advertisement (auth)
//   POST /{owner}/{repo}.git/git-upload-pack   clone/fetch (auth)
//   POST /{owner}/{repo}.git/git-receive-pack  push (auth)
//   /api/v3/*                                  REST v3 (auth, except the GET / root)
//   POST /api/graphql                          GraphQL v4 (auth)
//   POST /mcp                                  MCP JSON-RPC (auth; parse errors are 400/-32700)
// Anything else is a JSON 404. Malformed requests never crash the server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  handleReceivePack,
  handleUploadPackV0,
  handleUploadPackV2,
  v0Advertisement,
  v2Advertisement,
} from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The bearer token the suite presents; empty in local runs means "any non-empty token". */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/** Whether the request's Authorization header carries the expected token. */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  if (match === null) return false;
  const expected = expectedToken();
  if (expected === '') return match[1]!.length > 0;
  return match[1] === expected;
}

/**
 * Read the whole request body as a Buffer. Plain data/end listeners: the async-iterator form pays
 * the iterator protocol on every request, and these bodies are small and arrive buffered.
 */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (status === 204) {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/**
 * The request path without its query string. A manual split, not a URL parse: the router decodes
 * each segment itself, and this runs on every request.
 */
function pathOf(req: IncomingMessage): string {
  const url = req.url ?? '/';
  const q = url.indexOf('?');
  return q < 0 ? url : url.slice(0, q);
}

/** The request's query parameters, parsed from the raw query string. */
function queryOf(req: IncomingMessage): URLSearchParams {
  const url = req.url ?? '/';
  const q = url.indexOf('?');
  if (q < 0) return new URLSearchParams();
  return new URLSearchParams(url.slice(q + 1));
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await route(store, req, res);
      } catch (err) {
        // A handler must never take the server down with it.
        process.stderr.write(`[forge] handler error: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
}

async function route(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const path = pathOf(req);

  // The env's boot probe: 200 {"ok":true}.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}[.git]/{info/refs|git-upload-pack|git-receive-pack}.
  const gitMatch = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1]!);
    const repoName = decodeURIComponent(gitMatch[2]!);
    const endpoint = gitMatch[3]!;
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Unauthorized');
      return;
    }
    if (owner !== VIEWER_LOGIN) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    if (method === 'GET' && endpoint === 'info/refs') {
      const service = queryOf(req).get('service');
      if (service === 'git-upload-pack') {
        if ((req.headers['git-protocol'] ?? '') === 'version=2') {
          sendBytes(res, 200, v2Advertisement(repo), 'application/x-git-upload-pack-advertisement');
        } else {
          sendBytes(res, 200, v0Advertisement(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
        }
        return;
      }
      if (service === 'git-receive-pack') {
        sendBytes(res, 200, v0Advertisement(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
        return;
      }
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('unknown service');
      return;
    }
    if (method === 'POST' && endpoint === 'git-upload-pack') {
      const body = await readBody(req);
      const out =
        (req.headers['git-protocol'] ?? '') === 'version=2' ? handleUploadPackV2(repo, body) : handleUploadPackV0(repo, body);
      sendBytes(res, 200, out, 'application/x-git-upload-pack-result');
      return;
    }
    if (method === 'POST' && endpoint === 'git-receive-pack') {
      const body = await readBody(req);
      const { report } = handleReceivePack(repo, body);
      sendBytes(res, 200, report, 'application/x-git-receive-pack-result');
      return;
    }
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  // GraphQL v4.
  if (path === '/api/graphql' && method === 'POST') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = raw.length === 0 ? null : JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] }, { 'x-github-request-id': store.nextRequestId() });
      return;
    }
    const result = handleGraphQL(store, body);
    sendJson(res, result.status, result.body, { 'x-github-request-id': store.nextRequestId() });
    return;
  }

  // MCP.
  if (path === '/mcp' && method === 'POST') {
    const raw = await readBody(req);
    const result = handleMcp(store, raw.toString('utf8'), authorized(req));
    if (result.body === null) {
      res.writeHead(result.status);
      res.end();
      return;
    }
    sendJson(res, result.status, result.body);
    return;
  }
  if (path === '/mcp' && method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return;
  }

  // REST v3. The API root answers without auth, like the starter; the rest needs the token.
  if (path === '/api/v3' || path === '/api/v3/') {
    if (method !== 'GET') {
      sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': store.nextRequestId() });
      return;
    }
    const result = handleRest(store, method, req.url ?? '/', undefined, true, req.headers.host ?? '127.0.0.1');
    if (result !== null) {
      sendJson(res, result.status, result.body, { 'x-github-request-id': store.nextRequestId(), ...(result.headers ?? {}) });
    }
    return;
  }
  if (path.startsWith('/api/v3')) {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' }, { 'x-github-request-id': store.nextRequestId() });
      return;
    }
    const raw = await readBody(req);
    let body: unknown;
    let bodyIsJson = true;
    if (raw.length === 0) {
      body = undefined;
    } else {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        // Malformed JSON: a non-undefined body so handleRest's 400 check fires.
        body = null;
        bodyIsJson = false;
      }
    }
    const result = handleRest(store, method, req.url ?? '/', body, bodyIsJson, req.headers.host ?? '127.0.0.1');
    if (result === null) {
      sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': store.nextRequestId() });
      return;
    }
    sendJson(res, result.status, result.body, { 'x-github-request-id': store.nextRequestId(), ...(result.headers ?? {}) });
    return;
  }

  // Everything else: GitHub's 404 body.
  sendJson(res, 404, { message: 'Not Found' });
}
