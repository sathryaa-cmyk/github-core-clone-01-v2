// The forge's store: every object the suite can see lives here, in memory, keyed by the
// scenario's fixed identities. The scenario (wire.ts buildScenario) is competition-fixed, so the
// viewer login is a constant, not something the shop token can name: the token is opaque
// (shpat_ + 32 hex, derived from the trial instance hash) and encodes no login.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- scenario

/** The scenario's viewer: the token owner every check uses. */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
/** The scenario's teammate and stranger (foreign-owner checks use the stranger). */
export const TEAMMATE_LOGIN = 'quinnkeller';
export const STRANGER_LOGIN = 'olgabauer';
/** The scenario's org, and the repo-name prefix the REST checks build on. */
export const ORG_LOGIN = 'faint-meadow-org';
export const REPO_PREFIX = 'amber-thistle';

/** A fixed timestamp for commits the forge itself authors (contents API, squash merges). */
export const FORGE_EPOCH_SEC = 1_700_000_000;
/** A fixed ISO date for created_at / updated_at / merged_at fields the forge authors. */
export const FORGE_DATE = '2026-11-14T00:00:00Z';
/** The identity the forge signs its own commits with. */
export const FORGE_IDENTITY = { name: VIEWER_NAME, email: VIEWER_EMAIL };

/** The git identity object: { name, email, timestamp }. */
export interface GitIdentity {
  name: string;
  email: string;
  timestamp: number;
}

// ---------------------------------------------------------------- git objects

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** SHA-1 hex of `bytes`. */
export function sha1Hex(bytes: Buffer): string {
  return createHash('sha1').update(bytes).digest('hex');
}

/** The object id of `type` + `data` (SHA-1 over "<type> <size>\0" + data). The header and data
 * feed the hash separately: no concatenated copy of the object is allocated to hash it. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/** Parse a tree object's entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(pos, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    pos = nul + 21;
  }
  return entries;
}

/** Git's tree sort: directory names compare as if suffixed with '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialise tree entries, git-sorted. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a commit object's header and message. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Serialise a commit object. */
export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: GitIdentity;
  committer: GitIdentity;
}): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author.name} <${input.author.email}> ${input.author.timestamp} +0000`);
  lines.push(`committer ${input.committer.name} <${input.committer.email}> ${input.committer.timestamp} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${input.message}`, 'utf8');
}

/** Adler-32 of `data` (the checksum a zlib stream ends with). Deferred modulo (zlib's NMAX):
 * the sums only reduce every 5552 bytes, so a 1 KiB object pays two modulos, not two per byte. */
export function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  let i = 0;
  const len = data.length;
  while (i < len) {
    const end = Math.min(len, i + 5552);
    while (i < end) {
      a += data[i]!;
      b += a;
      i += 1;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Inflate one zlib stream out of `buf` at `pos`; answers the data and the bytes consumed. */
export function inflateOne(buf: Buffer, pos: number): { data: Buffer; consumed: number } {
  const data = inflateSync(buf.subarray(pos));
  const want = adler32(data);
  // The stream ends at the first byte boundary whose next 4 bytes are the Adler-32. Buffer.indexOf
  // is the native memmem search for exactly that first match — the byte-at-a-time loop it replaces
  // read one UInt32 per position for the same answer.
  const adler = Buffer.allocUnsafe(4);
  adler.writeUInt32BE(want, 0);
  const at = buf.indexOf(adler, pos + 1);
  if (at < 0 || at + 4 > buf.length) throw new Error('zlib stream has no Adler-32 terminator');
  return { data, consumed: at + 4 - pos };
}

/** Deflate `data` for a pack object. Level 1: the reader only inflates and hashes, so the level
 * is invisible on the wire except for size, and the fastest level is the right one here. */
export function deflateOne(data: Buffer): Buffer {
  return deflateSync(data, { level: 1 });
}

// ---------------------------------------------------------------- resources

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Bumped on every mutation of this issue or its comments; invalidates jsonCache. The issue's
   * labels are fixed at creation, so nothing else can change what issueJson() returns.
   */
  version: number;
  /** The last issueJson() object built for this version, or null when it must be rebuilt. */
  jsonCache: Record<string, unknown> | null;
}

export interface IssueComment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  databaseId: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[];
  issueSeq: number;
  comments: Map<number, IssueComment[]>;
  commentSeq: number;
  pulls: Pull[];
  pullSeq: number;
  /**
   * Memoised upload-pack fetch responses (git.ts): the whole response Buffer for one fetch
   * request, keyed by the request plus the object-store size. The pack a fetch sends is a pure
   * function of (wants, haves, shallows, deepen) and the object set, and objects are only ever
   * added to a repo, never removed, so the same size means the same object set and the same
   * response; a push grows the set and changes the key. Refs never enter a fetch selection.
   */
  fetchCache: Map<string, Buffer>;
}

/** An opaque, stable global id: base64 of "Kind:part:part". */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

/** Decode a global id the forge issued, or null when it is not one. */
export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const parts = decoded.split(':');
    const kind = parts.shift();
    if (kind === undefined || kind === '' || parts.length === 0) return null;
    // Re-encoding must round-trip: a foreign string is not one of ours.
    if (Buffer.from(decoded, 'utf8').toString('base64') !== id) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

/** The whole forge state, in memory: a fresh pod per trial starts empty. */
export class Store {
  readonly repos = new Map<string, Repo>();
  repoSeq = 0;
  globalSeq = 0;
  requestSeq = 0;

  static key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq.toString(16)}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    this.repoSeq += 1;
    const repo: Repo = {
      databaseId: this.repoSeq,
      name,
      owner,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdSeq: this.repoSeq,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      issueSeq: 0,
      comments: new Map(),
      commentSeq: 0,
      pulls: [],
      pullSeq: 0,
      fetchCache: new Map(),
    };
    this.repos.set(Store.key(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(Store.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(Store.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    this.globalSeq += 1;
    repo.issueSeq += 1;
    const issue: Issue = {
      id: this.globalSeq,
      number: repo.issueSeq,
      title,
      body,
      state: 'open',
      labels: [...labels],
      userLogin: VIEWER_LOGIN,
      createdAt: FORGE_DATE,
      updatedAt: FORGE_DATE,
      version: 0,
      jsonCache: null,
    };
    repo.issues.push(issue);
    return issue;
  }

  createComment(repo: Repo, issueNumber: number, body: string): IssueComment {
    this.globalSeq += 1;
    repo.commentSeq += 1;
    const comment: IssueComment = { id: repo.commentSeq, body, userLogin: VIEWER_LOGIN, createdAt: FORGE_DATE };
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    // A comment changes the issue's `comments` count, so its cached JSON is stale.
    const issue = repo.issues.find((candidate) => candidate.number === issueNumber);
    if (issue !== undefined) {
      issue.version += 1;
      issue.jsonCache = null;
    }
    return comment;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, headSha: string, baseRef: string, baseSha: string): Pull {
    this.globalSeq += 1;
    repo.pullSeq += 1;
    const pull: Pull = {
      id: this.globalSeq,
      number: repo.pullSeq,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      headSha,
      baseRef,
      baseSha,
      userLogin: VIEWER_LOGIN,
      createdAt: FORGE_DATE,
      updatedAt: FORGE_DATE,
    };
    repo.pulls.push(pull);
    return pull;
  }
}

// ---------------------------------------------------------------- git graph queries

/** The tree oid a commit points at, or null when the commit is unknown. */
export function commitTreeOid(repo: Repo, commitOid: string): string | null {
  const obj = repo.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

/** The entries of a tree object, or null when it is unknown. */
export function treeEntriesOf(repo: Repo, treeOid: string): TreeEntry[] | null {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return null;
  return parseTree(obj.data);
}

/** The blob oid a tree holds at `segments`, or null when the path is absent. */
export function findTreePath(repo: Repo, treeOid: string, segments: readonly string[]): string | null {
  const entries = treeEntriesOf(repo, treeOid);
  if (entries === null) return null;
  const head = segments[0];
  if (head === undefined) return null;
  const entry = entries.find((candidate) => candidate.name === head);
  if (entry === undefined) return null;
  if (segments.length === 1) return entry.mode === '40000' ? null : entry.oid;
  if (entry.mode !== '40000') return null;
  return findTreePath(repo, entry.oid, segments.slice(1));
}

/** A tree with `segments` set to `blobOid`, every other entry kept (stores new trees). */
export function buildTreeWithPath(repo: Repo, treeOid: string | null, segments: readonly string[], blobOid: string): string {
  const entries = treeOid === null ? [] : (treeEntriesOf(repo, treeOid) ?? []);
  const head = segments[0]!;
  const rest = segments.slice(1);
  const kept = entries.filter((entry) => entry.name !== head);
  if (rest.length === 0) {
    kept.push({ mode: '100644', name: head, oid: blobOid });
  } else {
    const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
    const childOid = buildTreeWithPath(repo, existing?.oid ?? null, rest, blobOid);
    kept.push({ mode: '40000', name: head, oid: childOid });
  }
  const data = buildTree(kept);
  return repo.objects.has(hashObject('tree', data)) ? hashObject('tree', data) : putObjectInto(repo, 'tree', data);
}

function putObjectInto(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** Flatten a tree to path -> {mode, oid}, recursively. */
export function flattenTree(repo: Repo, treeOid: string | null, prefix: string, out: Map<string, { mode: string; oid: string }>): void {
  if (treeOid === null) return;
  const entries = treeEntriesOf(repo, treeOid);
  if (entries === null) return;
  for (const entry of entries) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
}

/** The files that differ between two trees (null = empty tree). */
export function diffTrees(
  repo: Repo,
  oldTreeOid: string | null,
  newTreeOid: string | null,
): Array<{ path: string; status: 'added' | 'removed' | 'modified'; oldOid: string | null; newOid: string | null }> {
  const oldMap = new Map<string, { mode: string; oid: string }>();
  const newMap = new Map<string, { mode: string; oid: string }>();
  flattenTree(repo, oldTreeOid, '', oldMap);
  flattenTree(repo, newTreeOid, '', newMap);
  const out: Array<{ path: string; status: 'added' | 'removed' | 'modified'; oldOid: string | null; newOid: string | null }> = [];
  for (const [path, entry] of newMap) {
    const old = oldMap.get(path);
    if (old === undefined) out.push({ path, status: 'added', oldOid: null, newOid: entry.oid });
    else if (old.oid !== entry.oid) out.push({ path, status: 'modified', oldOid: old.oid, newOid: entry.oid });
  }
  for (const [path, entry] of oldMap) {
    if (!newMap.has(path)) out.push({ path, status: 'removed', oldOid: entry.oid, newOid: null });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}

/**
 * Reachable commits from `starts`, with generation (want = 0, parent = +1). A tag want counts as
 * generation 0 and its target as generation 1. `maxDepth` caps the generation included.
 */
export function reachableCommits(
  repo: Repo,
  starts: readonly string[],
  maxDepth: number,
): Map<string, number> {
  const seen = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = [];
  for (const start of starts) queue.push({ oid: start, gen: 0 });
  while (queue.length > 0) {
    const { oid, gen } = queue.shift()!;
    if (gen > maxDepth) continue;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      seen.set(oid, gen);
      const target = tagTarget(obj.data);
      if (target !== null && gen + 1 <= maxDepth) queue.push({ oid: target, gen: gen + 1 });
      continue;
    }
    if (obj.type !== 'commit') continue;
    seen.set(oid, gen);
    const info = parseCommit(obj.data);
    for (const parent of info.parents) queue.push({ oid: parent, gen: gen + 1 });
  }
  return seen;
}

/** The object a tag points at, or null. */
export function tagTarget(data: Buffer): string | null {
  for (const line of data.toString('utf8').split('\n')) {
    if (line.startsWith('object ')) return line.slice(7).trim();
    if (line === '') break;
  }
  return null;
}

/** Whether `ancestor` is reachable from `descendant` (parents walked fully). */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

/** History from `tip`, newest first, first-parent walk with full-parent dedupe. */
export function listHistory(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push(oid);
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]!);
  }
  return out;
}
