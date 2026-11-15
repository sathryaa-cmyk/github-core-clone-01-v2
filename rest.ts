// REST v3: /api/v3/* — repos, branches, commits, contents, labels, issues, pulls.
// Every reply is application/json with a non-empty X-GitHub-Request-Id. A repo under any owner
// other than the token's login is a 404, never a 403. All state lives in the store.

import {
  FORGE_DATE,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  commitTreeOid,
  diffTrees,
  findTreePath,
  globalId,
  listHistory,
  parseCommit,
  treeEntriesOf,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { contentsCommit, contentsDeleteCommit, pullMergeable, sortedRefs, squashMerge } from './git.ts';

// ---------------------------------------------------------------- shapes

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FORGE_DATE,
    updated_at: FORGE_DATE,
  };
}

/**
 * The REST shape of one issue. Memoised on the issue: the shape is rebuilt only after a mutation
 * (Store.createComment and the PATCH/close sites bump `version` and clear the cache), so a hot
 * read of the same issue — the benchmark reads one issue 2,000 times — reuses one object. The
 * object is never mutated after it is built: callers only serialise it.
 */
export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  if (issue.jsonCache !== null) return issue.jsonCache;
  const built: Record<string, unknown> = {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color, description: label.description })),
    user: { login: issue.userLogin, id: VIEWER_ID, type: 'User' },
    comments: (repo.comments.get(issue.number) ?? []).length,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
  issue.jsonCache = built;
  return built;
}

export function commentJson(repo: Repo, issueNumber: number, comment: { id: number; body: string; userLogin: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: comment.userLogin, id: VIEWER_ID, type: 'User' },
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/comments/${comment.id}`,
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'closed' : pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pullMergeable(repo, pull) !== 'CONFLICTING',
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: pull.userLogin, id: VIEWER_ID, type: 'User' },
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

// ---------------------------------------------------------------- helpers

export type RestResult = { status: number; body: unknown; headers?: Record<string, string> };

function ok(body: unknown, status = 200, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function notFound(what = 'Not Found'): RestResult {
  return err(404, what);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strField(body: unknown, field: string): string | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

function boolField(body: unknown, field: string, fallback: boolean): boolean {
  if (!isRecord(body)) return fallback;
  const value = body[field];
  return typeof value === 'boolean' ? value : fallback;
}

function parseQuery(url: string): { path: string; query: URLSearchParams } {
  // A manual split, not a URL parse: the router decodes segments itself, and this runs on every
  // REST request (the caller already split the path once; this is the second parse it replaces).
  const q = url.indexOf('?');
  if (q < 0) return { path: url, query: new URLSearchParams() };
  return { path: url.slice(0, q), query: new URLSearchParams(url.slice(q + 1)) };
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): { pageItems: T[]; hasNext: boolean; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { pageItems: items.slice(start, start + perPage), hasNext: page < totalPages, totalPages };
}

function linkHeader(base: string, path: string, query: URLSearchParams, page: number, totalPages: number): string {
  const build = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    return `<${base}${path}?${q.toString()}>`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`${build(page + 1)}; rel="next"`);
  if (page > 1) parts.push(`${build(page - 1)}; rel="prev"`);
  parts.push(`${build(1)}; rel="first"`);
  parts.push(`${build(totalPages)}; rel="last"`);
  return parts.join(', ');
}

/** Resolve a repo from the URL owner/name; foreign owners and missing repos are 404. */
function resolveRepo(store: Store, owner: string, name: string): Repo | RestResult {
  if (owner !== VIEWER_LOGIN) return notFound('Not Found');
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return notFound('Not Found');
  return repo;
}

function isRepo(value: Repo | RestResult): value is Repo {
  return (value as Repo).databaseId !== undefined;
}

// ---------------------------------------------------------------- contents helpers

function refTip(repo: Repo, ref: string | null): string | undefined {
  if (ref === null || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`);
  if (repo.refs.has(`refs/tags/${ref}`)) return repo.refs.get(`refs/tags/${ref}`);
  if (repo.objects.has(ref)) return ref; // a raw commit sha
  return undefined;
}

function countAddedLines(blob: Buffer, oldBlob: Buffer | null): { additions: number; deletions: number } {
  const newLines = blob.toString('utf8').split('\n');
  if (oldBlob === null) return { additions: newLines.filter((l) => l !== '').length || 1, deletions: 0 };
  const oldSet = new Set(oldBlob.toString('utf8').split('\n'));
  const newSet = new Set(newLines);
  let additions = 0;
  for (const line of newLines) if (!oldSet.has(line) && line !== '') additions += 1;
  let deletions = 0;
  for (const line of oldSet) if (!newSet.has(line) && line !== '') deletions += 1;
  return { additions: Math.max(additions, 1), deletions };
}

// ---------------------------------------------------------------- the router

/**
 * Handle one REST request. `host` is the request's Host header (for absolute Link URLs).
 * Returns null when the path is not a REST route (the caller falls through to git/MCP/404).
 */
export function handleRest(
  store: Store,
  method: string,
  url: string,
  body: unknown,
  bodyIsJson: boolean,
  host: string,
): RestResult | null {
  const { path, query } = parseQuery(url);
  if (!path.startsWith('/api/v3')) return null;
  const base = `http://${host}`;
  const segments = path.split('/').filter((s) => s !== '');

  // GET /api/v3/ — the API root (answered without auth by the caller; see app.ts).
  if (segments.length === 2 && method === 'GET') {
    return ok(
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      200,
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  // Malformed JSON bodies are 400 everywhere else.
  if (body !== undefined && !bodyIsJson && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
    return err(400, 'Problems parsing JSON');
  }

  // GET /api/v3/meta
  if (segments.length === 3 && segments[2] === 'meta' && method === 'GET') {
    return ok({ installed_version: '1.0.0' });
  }

  // GET /api/v3/user
  if (segments.length === 3 && segments[2] === 'user' && method === 'GET') {
    return ok({ login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
  }

  // POST /api/v3/user/repos — create a repo for the token owner.
  if (segments.length === 4 && segments[2] === 'user' && segments[3] === 'repos' && method === 'POST') {
    const name = strField(body, 'name');
    if (name === undefined || name === '') return err(422, 'Validation Failed: name is required');
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return err(422, 'Validation Failed: invalid repository name');
    if (store.getRepo(VIEWER_LOGIN, name) !== undefined) return err(422, 'Repository already exists');
    const repo = store.createRepo(VIEWER_LOGIN, name, strField(body, 'description') ?? '', boolField(body, 'private', false));
    return ok(repoJson(repo), 201);
  }

  // GET /api/v3/user/repos — paginated list of the token owner's repos.
  if (segments.length === 4 && segments[2] === 'user' && segments[3] === 'repos' && method === 'GET') {
    const repos = store.listRepos(VIEWER_LOGIN);
    const { page, perPage } = pageParams(query);
    const { pageItems, hasNext, totalPages } = paginate(repos, page, perPage);
    const headers: Record<string, string> = {};
    if (hasNext || totalPages > 1) headers.link = linkHeader(base, path, query, page, totalPages);
    return ok(pageItems.map(repoJson), 200, headers);
  }

  // /api/v3/repos/{owner}/{name}[...]
  if (segments.length >= 5 && segments[2] === 'repos') {
    const owner = decodeURIComponent(segments[3]!);
    const name = decodeURIComponent(segments[4]!);
    const rest = segments.slice(5);
    const resolved = resolveRepo(store, owner, name);
    if (!isRepo(resolved)) return resolved;
    const repo = resolved;

    // GET / PATCH / DELETE /api/v3/repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') return ok(repoJson(repo));
      if (method === 'PATCH') {
        const description = strField(body, 'description');
        if (description !== undefined) repo.description = description;
        return ok(repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return err(405, 'Method Not Allowed');
    }

    // GET /api/v3/repos/{o}/{r}/branches
    if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
      const branches: Array<Record<string, unknown>> = [];
      for (const [refName, sha] of repo.refs) {
        if (!refName.startsWith('refs/heads/')) continue;
        branches.push({ name: refName.slice('refs/heads/'.length), commit: { sha }, protected: false });
      }
      branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return ok(branches);
    }

    // GET /api/v3/repos/{o}/{r}/branches/{branch}
    if (rest.length === 2 && rest[0] === 'branches' && method === 'GET') {
      const sha = repo.refs.get(`refs/heads/${decodeURIComponent(rest[1]!)}`);
      if (sha === undefined) return notFound('Branch not found');
      return ok({ name: decodeURIComponent(rest[1]!), commit: { sha }, protected: false });
    }

    // GET /api/v3/repos/{o}/{r}/commits[?sha=]
    if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      const shaParam = query.get('sha');
      const tip = refTip(repo, shaParam);
      if (tip === undefined) return notFound(`No commit found for SHA: ${shaParam ?? ''}`);
      const history = listHistory(repo, tip);
      const commits = history.map((oid) => {
        const info = parseCommit(repo.objects.get(oid)!.data);
        return {
          sha: oid,
          commit: {
            message: info.message,
            author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FORGE_DATE },
            committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FORGE_DATE },
            tree: { sha: info.tree },
          },
          parents: info.parents.map((p) => ({ sha: p })),
        };
      });
      return ok(commits);
    }

    // POST /api/v3/repos/{o}/{r}/git/refs — create a branch ref.
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
      const ref = strField(body, 'ref');
      const sha = strField(body, 'sha');
      if (ref === undefined || sha === undefined) return err(422, 'Validation Failed: ref and sha are required');
      if (!ref.startsWith('refs/')) return err(422, 'Validation Failed: invalid ref');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      if (!repo.objects.has(sha)) return err(422, 'Validation Failed: unknown object');
      repo.refs.set(ref, sha);
      return ok({ ref, object: { sha, type: 'commit' }, url: `/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}` }, 201);
    }

    // GET /api/v3/repos/{o}/{r}/git/refs — list all refs.
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'GET') {
      const refs = sortedRefs(repo).map((ref) => ({
        ref: ref.name,
        object: { sha: ref.oid, type: 'commit' },
        url: `/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref.name)}`,
      }));
      return ok(refs);
    }

    // GET /api/v3/repos/{o}/{r}/git/refs/heads/{branch}
    if (rest.length >= 3 && rest[0] === 'git' && rest[1] === 'refs' && method === 'GET') {
      const ref = `refs/${rest.slice(2).map(decodeURIComponent).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return notFound('Reference does not exist');
      return ok({ ref, object: { sha, type: 'commit' }, url: `/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}` });
    }

    // GET /api/v3/repos/{o}/{r}/contents[/{path...}]
    if (rest[0] === 'contents' && (method === 'GET' || method === 'PUT' || method === 'DELETE')) {
      const pathSegments = rest.slice(1).map(decodeURIComponent).filter((s) => s !== '');
      const refParam = query.get('ref');
      if (method === 'GET') {
        const tip = refTip(repo, refParam);
        if (tip === undefined) return notFound('Not Found');
        const treeOid = commitTreeOid(repo, tip);
        if (treeOid === null) return notFound('Not Found');
        if (pathSegments.length === 0) {
          const entries = treeEntriesOf(repo, treeOid) ?? [];
          return ok(
            entries.map((entry) => ({
              type: entry.mode === '40000' ? 'dir' : 'file',
              name: entry.name,
              path: entry.name,
              sha: entry.oid,
              size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
            })),
          );
        }
        const blobOid = findTreePath(repo, treeOid, pathSegments);
        if (blobOid === null) {
          // Maybe a directory: walk to its tree.
          const dirTree = findDirTree(repo, treeOid, pathSegments);
          if (dirTree === null) return notFound('Not Found');
          const entries = treeEntriesOf(repo, dirTree) ?? [];
          const joined = pathSegments.join('/');
          return ok(
            entries.map((entry) => ({
              type: entry.mode === '40000' ? 'dir' : 'file',
              name: entry.name,
              path: `${joined}/${entry.name}`,
              sha: entry.oid,
              size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
            })),
          );
        }
        const blob = repo.objects.get(blobOid);
        if (blob === undefined) return notFound('Not Found');
        return ok({
          type: 'file',
          encoding: 'base64',
          size: blob.data.length,
          name: pathSegments[pathSegments.length - 1],
          path: pathSegments.join('/'),
          sha: blobOid,
          content: blob.data.toString('base64'),
        });
      }
      if (method === 'PUT') {
        const message = strField(body, 'message');
        const contentB64 = strField(body, 'content');
        if (message === undefined || contentB64 === undefined) return err(422, 'Validation Failed: message and content are required');
        const branch = strField(body, 'branch') ?? repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        const currentTree = tip === undefined ? null : commitTreeOid(repo, tip);
        const currentBlob = currentTree === null ? null : findTreePath(repo, currentTree, pathSegments);
        const givenSha = strField(body, 'sha');
        if (givenSha !== undefined && currentBlob !== givenSha) return err(409, 'Conflict: sha does not match the current file');
        if (givenSha === undefined && currentBlob !== null) return err(422, 'Validation Failed: sha is required to update a file');
        const content = Buffer.from(contentB64, 'base64');
        const { commitOid, blobOid, created } = contentsCommit(repo, branch, pathSegments, content, message);
        return ok(
          {
            content: { name: pathSegments[pathSegments.length - 1], path: pathSegments.join('/'), sha: blobOid, size: content.length, encoding: 'base64', type: 'file' },
            commit: { sha: commitOid, message },
          },
          created ? 201 : 200,
        );
      }
      // DELETE
      const message = strField(body, 'message');
      const givenSha = strField(body, 'sha');
      if (message === undefined || givenSha === undefined) return err(422, 'Validation Failed: message and sha are required');
      const branch = strField(body, 'branch') ?? repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) return notFound('Not Found');
      const currentTree = commitTreeOid(repo, tip);
      const currentBlob = currentTree === null ? null : findTreePath(repo, currentTree, pathSegments);
      if (currentBlob === null) return notFound('Not Found');
      if (currentBlob !== givenSha) return err(409, 'Conflict: sha does not match the current file');
      const commitOid = contentsDeleteCommit(repo, branch, pathSegments, message);
      if (commitOid === null) return notFound('Not Found');
      return ok({ commit: { sha: commitOid, message } });
    }

    // POST /api/v3/repos/{o}/{r}/labels
    if (rest.length === 1 && rest[0] === 'labels' && method === 'POST') {
      const name = strField(body, 'name');
      if (name === undefined || name === '') return err(422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) return err(422, 'Label already exists');
      const label: Label = { name, color: strField(body, 'color') ?? 'ededed', description: strField(body, 'description') ?? '' };
      repo.labels.set(name, label);
      return ok({ name: label.name, color: label.color, description: label.description }, 201);
    }

    // GET /api/v3/repos/{o}/{r}/labels
    if (rest.length === 1 && rest[0] === 'labels' && method === 'GET') {
      return ok([...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: label.description })));
    }

    // POST / GET /api/v3/repos/{o}/{r}/issues
    if (rest.length === 1 && rest[0] === 'issues') {
      if (method === 'POST') {
        const title = strField(body, 'title');
        if (title === undefined || title === '') return err(422, 'Validation Failed: title is required');
        const labelNames: string[] = Array.isArray((body as Record<string, unknown>)?.labels)
          ? ((body as Record<string, unknown>).labels as unknown[]).filter((v): v is string => typeof v === 'string')
          : [];
        const labels: Label[] = [];
        for (const labelName of labelNames) {
          const label = repo.labels.get(labelName);
          if (label === undefined) return err(422, `Validation Failed: label ${JSON.stringify(labelName)} does not exist`);
          labels.push(label);
        }
        const issue = store.createIssue(repo, title, strField(body, 'body') ?? '', labels);
        return ok(issueJson(repo, issue), 201);
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const direction = query.get('direction') ?? 'asc';
        const sort = query.get('sort') ?? 'created';
        const labelFilter = query.get('labels');
        let issues = [...repo.issues];
        if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
        if (labelFilter !== null && labelFilter !== '') {
          const wanted = labelFilter.split(',').map((s) => s.trim());
          issues = issues.filter((issue) => wanted.every((w) => issue.labels.some((l) => l.name === w)));
        }
        issues.sort((a, b) => (sort === 'created' ? a.number - b.number : a.number - b.number));
        if (direction === 'desc') issues.reverse();
        const { page, perPage } = pageParams(query);
        const { pageItems, hasNext, totalPages } = paginate(issues, page, perPage);
        const headers: Record<string, string> = {};
        if (hasNext || totalPages > 1) headers.link = linkHeader(base, path, query, page, totalPages);
        return ok(pageItems.map((issue) => issueJson(repo, issue)), 200, headers);
      }
      return err(405, 'Method Not Allowed');
    }

    // /api/v3/repos/{o}/{r}/issues/{n}[/comments]
    if (rest.length >= 2 && rest[0] === 'issues') {
      const number = Number(rest[1]);
      const issue = repo.issues.find((candidate) => candidate.number === number);
      if (issue === undefined) return notFound('Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return ok(issueJson(repo, issue));
        if (method === 'PATCH') {
          const state = strField(body, 'state');
          if (state === 'open' || state === 'closed') issue.state = state;
          const title = strField(body, 'title');
          if (title !== undefined) issue.title = title;
          const bodyText = strField(body, 'body');
          if (bodyText !== undefined) issue.body = bodyText;
          issue.updatedAt = FORGE_DATE;
          issue.version += 1;
          issue.jsonCache = null;
          return ok(issueJson(repo, issue));
        }
        return err(405, 'Method Not Allowed');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'POST') {
          const text = strField(body, 'body');
          if (text === undefined) return err(422, 'Validation Failed: body is required');
          const comment = store.createComment(repo, issue.number, text);
          return ok(commentJson(repo, issue.number, comment), 201);
        }
        if (method === 'GET') {
          const comments = repo.comments.get(issue.number) ?? [];
          return ok(comments.map((comment) => commentJson(repo, issue.number, comment)));
        }
        return err(405, 'Method Not Allowed');
      }
      return notFound('Not Found');
    }

    // POST / GET /api/v3/repos/{o}/{r}/pulls
    if (rest.length === 1 && rest[0] === 'pulls') {
      if (method === 'POST') {
        const title = strField(body, 'title');
        const head = strField(body, 'head');
        const base = strField(body, 'base');
        if (title === undefined || head === undefined || base === undefined) return err(422, 'Validation Failed: title, head and base are required');
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (headSha === undefined || baseSha === undefined) return err(422, 'Validation Failed: head or base branch does not exist');
        const pull = store.createPull(repo, title, strField(body, 'body') ?? '', head, headSha, base, baseSha);
        return ok(pullJson(repo, pull), 201);
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = [...repo.pulls];
        if (state !== 'all') pulls = pulls.filter((pull) => (state === 'open' ? pull.state === 'open' : pull.state === 'closed'));
        const { page, perPage } = pageParams(query);
        const { pageItems, hasNext, totalPages } = paginate(pulls, page, perPage);
        const headers: Record<string, string> = {};
        if (hasNext || totalPages > 1) headers.link = linkHeader(base, path, query, page, totalPages);
        return ok(pageItems.map((pull) => pullJson(repo, pull)), 200, headers);
      }
      return err(405, 'Method Not Allowed');
    }

    // /api/v3/repos/{o}/{r}/pulls/{n}[/files|/merge]
    if (rest.length >= 2 && rest[0] === 'pulls') {
      const number = Number(rest[1]);
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (pull === undefined) return notFound('Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return ok(pullJson(repo, pull));
        if (method === 'PATCH') {
          const state = strField(body, 'state');
          if (state === 'closed') pull.state = 'closed';
          if (state === 'open') pull.state = 'open';
          return ok(pullJson(repo, pull));
        }
        return err(405, 'Method Not Allowed');
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const baseTree = commitTreeOid(repo, pull.baseSha);
        const headTree = commitTreeOid(repo, pull.headSha);
        if (baseTree === null || headTree === null) return notFound('Not Found');
        const diffs = diffTrees(repo, baseTree, headTree);
        const files = diffs.map((diff) => {
          const newBlob = diff.newOid === null ? null : repo.objects.get(diff.newOid)?.data ?? null;
          const oldBlob = diff.oldOid === null ? null : repo.objects.get(diff.oldOid)?.data ?? null;
          const counts = newBlob === null ? { additions: 0, deletions: 1 } : countAddedLines(newBlob, oldBlob);
          return {
            filename: diff.path,
            status: diff.status,
            additions: counts.additions,
            deletions: counts.deletions,
            changes: counts.additions + counts.deletions,
          };
        });
        return ok(files);
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (pull.state !== 'open' || pull.merged) return err(405, 'Pull request is already merged or closed');
        if (pullMergeable(repo, pull) === 'CONFLICTING') return err(405, 'Merge conflict');
        const mergeSha = squashMerge(repo, pull);
        if (mergeSha === null) return err(422, 'Validation Failed: cannot merge');
        pull.merged = true;
        pull.state = 'closed';
        pull.mergedAt = FORGE_DATE;
        pull.mergeCommitSha = mergeSha;
        return ok({ merged: true, sha: mergeSha, message: `Merge pull request #${pull.number} from ${repo.owner}:${pull.headRef}` });
      }
      return notFound('Not Found');
    }

    return notFound('Not Found');
  }

  // Unknown /api/v3 route: JSON 404.
  return notFound('Not Found');
}

/** The tree oid of a directory at `segments` under `treeOid`, or null. */
function findDirTree(repo: Repo, treeOid: string, segments: readonly string[]): string | null {
  const entries = treeEntriesOf(repo, treeOid);
  if (entries === null) return null;
  const head = segments[0];
  if (head === undefined) return treeOid;
  const entry = entries.find((candidate) => candidate.name === head);
  if (entry === undefined || entry.mode !== '40000') return null;
  if (segments.length === 1) return entry.oid;
  return findDirTree(repo, entry.oid, segments.slice(1));
}

export { globalId };
