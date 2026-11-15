// Git smart HTTP: upload-pack (v2 and v0) and receive-pack (v0), over the store in store.ts.
// Plain objects only on the wire (no deltas): the suite's pack reader accepts them, and the
// conformance checks verify hashes and bytes, not delta encoding.

import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import {
  FORGE_IDENTITY,
  FORGE_EPOCH_SEC,
  VIEWER_LOGIN,
  ZERO_OID,
  adler32,
  buildCommit,
  buildTree,
  buildTreeWithPath,
  commitTreeOid,
  deflateOne,
  diffTrees,
  findTreePath,
  hashObject,
  isAncestor,
  parseCommit,
  parseTree,
  reachableCommits,
  tagTarget,
  type GitObject,
  type GitObjectType,
  type Pull,
  type Repo,
  type Store,
  type TreeEntry,
} from './store.ts';

// ---------------------------------------------------------------- pkt-lines

export function pktLine(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

/** Parse pkt-lines from `buf` until a flush packet or the buffer ends. */
export function parsePktLines(buf: Buffer): { lines: string[]; rest: Buffer; flushed: boolean } {
  const lines: string[] = [];
  let pos = 0;
  let flushed = false;
  while (pos + 4 <= buf.length) {
    const len = parseInt(buf.subarray(pos, pos + 4).toString('ascii'), 16);
    if (!Number.isFinite(len) || len < 0) break;
    if (len === 0) {
      pos += 4;
      flushed = true;
      break;
    }
    if (len === 1) {
      pos += 4;
      lines.push('\u0001');
      continue;
    }
    if (pos + len > buf.length) break;
    lines.push(buf.subarray(pos + 4, pos + len).toString('utf8'));
    pos += len;
  }
  return { lines, rest: buf.subarray(pos), flushed };
}

// ---------------------------------------------------------------- packs

const TYPE_NUM: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Serialise plain objects as a version-2 pack (header + objects + SHA-1 trailer). */
export function writePack(objects: ReadonlyArray<{ type: GitObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const typeNum = TYPE_NUM[object.type];
    const size = object.data.length;
    // Object header varint: low 4 bits of size, then 7 bits per byte, type in bits 4..6.
    const head: number[] = [];
    let remaining = size;
    let first = ((typeNum & 0x7) << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    head.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      head.push(byte);
    }
    parts.push(Buffer.from(head));
    parts.push(deflateOne(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(createHash('sha1').update(body).digest('hex'), 'hex');
  return Buffer.concat([body, trailer]);
}

/** Read a pack: plain objects plus OFS_DELTA / REF_DELTA resolution. */
export function readPack(buf: Buffer): { objects: Map<string, GitObject>; error: string | null } {
  const objects = new Map<string, GitObject>();
  try {
    if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') return { objects, error: 'not a packfile' };
    const version = buf.readUInt32BE(4);
    if (version !== 2) return { objects, error: `unsupported pack version ${version}` };
    const count = buf.readUInt32BE(8);
    let pos = 12;
    // Raw entries first (deltas resolve against bases that may come later in the pack).
    const raws: Array<{ type: GitObjectType; data: Buffer; baseOid?: string; baseOffset?: number; start: number }> = [];
    const byOffset = new Map<number, number>();
    for (let i = 0; i < count; i += 1) {
      const start = pos;
      let byte = buf[pos++]!;
      const typeNum = (byte >> 4) & 0x7;
      let size = byte & 0x0f;
      let shift = 4;
      while (byte & 0x80) {
        byte = buf[pos++]!;
        size |= (byte & 0x7f) << shift;
        shift += 7;
      }
      if (typeNum === 6) {
        // OFS_DELTA: offset varint (7-bit groups, +1 bias per byte after the first).
        byte = buf[pos++]!;
        let offset = byte & 0x7f;
        while (byte & 0x80) {
          byte = buf[pos++]!;
          offset = ((offset + 1) << 7) | (byte & 0x7f);
        }
        const { data, consumed } = inflateOne(buf, pos);
        pos += consumed;
        if (data.length !== size) throw new Error('delta size mismatch');
        raws.push({ type: 'commit', data, baseOffset: start - offset, start });
      } else if (typeNum === 7) {
        const baseOid = buf.subarray(pos, pos + 20).toString('hex');
        pos += 20;
        const { data, consumed } = inflateOne(buf, pos);
        pos += consumed;
        if (data.length !== size) throw new Error('delta size mismatch');
        raws.push({ type: 'commit', data, baseOid, start });
      } else {
        const type = NUM_TYPE[typeNum];
        if (type === undefined) throw new Error(`unknown object type ${typeNum}`);
        const { data, consumed } = inflateOne(buf, pos);
        pos += consumed;
        if (data.length !== size) throw new Error(`object size mismatch for ${type}`);
        raws.push({ type, data, start });
        byOffset.set(start, raws.length - 1);
      }
    }
    // Resolve deltas (bases are plain objects in this pack or, for REF_DELTA, already stored).
    const resolved = new Map<number, GitObject>();
    const resolve = (index: number): GitObject => {
      const hit = resolved.get(index);
      if (hit !== undefined) return hit;
      const raw = raws[index]!;
      if (raw.baseOid === undefined && raw.baseOffset === undefined) {
        const obj: GitObject = { type: raw.type, data: raw.data };
        resolved.set(index, obj);
        return obj;
      }
      let base: GitObject;
      if (raw.baseOid !== undefined) {
        const found = objects.get(raw.baseOid);
        if (found === undefined) throw new Error(`delta base ${raw.baseOid} is not in the pack`);
        base = found;
      } else {
        const baseIndex = byOffset.get(raw.baseOffset!);
        if (baseIndex === undefined) throw new Error('delta base offset is not in the pack');
        base = resolve(baseIndex);
      }
      const obj: GitObject = { type: base.type, data: applyDelta(base.data, raw.data) };
      resolved.set(index, obj);
      return obj;
    };
    for (let i = 0; i < raws.length; i += 1) {
      const obj = resolve(i);
      objects.set(hashObject(obj.type, obj.data), obj);
    }
    return { objects, error: null };
  } catch (err) {
    return { objects, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Apply a git delta to `base`, per the delta instruction format. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos++]!;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta source size mismatch');
  const parts: Buffer[] = [];
  let made = 0;
  while (pos < delta.length) {
    const op = delta[pos++]!;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos++]!;
      if (op & 0x02) offset |= delta[pos++]! << 8;
      if (op & 0x04) offset |= delta[pos++]! << 16;
      if (op & 0x08) offset |= delta[pos++]! << 24;
      if (op & 0x10) size = delta[pos++]!;
      if (op & 0x20) size |= delta[pos++]! << 8;
      if (op & 0x40) size |= delta[pos++]! << 16;
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      made += size;
    } else if (op !== 0) {
      parts.push(delta.subarray(pos, pos + op));
      pos += op;
      made += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize || made !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

/** Inflate one zlib stream at `pos` (shared with store.ts's helper, re-exported for clarity). */
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

// ---------------------------------------------------------------- advertisement

const AGENT = 'github-core-clone/1.0.0';
const UPLOAD_V0_CAPS = `side-band-64k thin-pack ofs-delta multi_ack_detailed shallow agent=${AGENT} symref=HEAD:refs/heads/main`;
const RECEIVE_V0_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/main`;

/** Refs sorted the way an advertisement lists them: HEAD first, then heads, then tags. */
export function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const heads: Array<{ name: string; oid: string }> = [];
  const tags: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) {
    if (name.startsWith('refs/heads/')) heads.push({ name, oid });
    else if (name.startsWith('refs/tags/')) tags.push({ name, oid });
  }
  heads.sort((a, b) => (a.name < b.name ? -1 : 1));
  tags.sort((a, b) => (a.name < b.name ? -1 : 1));
  return [...heads, ...tags];
}

/** The v0 advertisement body for `service` (upload-pack or receive-pack). */
export function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = tip ?? refs[0]!.oid;
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.name.startsWith('refs/tags/')) {
        const obj = repo.objects.get(ref.oid);
        if (obj !== undefined && obj.type === 'tag') {
          const target = tagTarget(obj.data);
          if (target !== null) parts.push(pktLine(`${target} ${ref.name}^{}\n`));
        }
      }
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v2 advertisement body (upload-pack only). It names no refs — ls-refs does that — so the
 * bytes are the same for every repository, and one Buffer serves every info/refs request. */
let v2AdvertisementCache: Buffer | null = null;
export function v2Advertisement(repo: Repo): Buffer {
  if (v2AdvertisementCache !== null) return v2AdvertisementCache;
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    pktFlush(),
    pktLine('version 2\n'),
    pktLine(`ls-refs=unborn\n`),
    pktLine(`fetch=shallow wait-for-done\n`),
    pktLine(`object-format=sha1\n`),
    pktLine(`agent=${AGENT}\n`),
    pktLine('server-option\n'),
    pktFlush(),
  ];
  v2AdvertisementCache = Buffer.concat(parts);
  return v2AdvertisementCache;
}

/** One ls-refs answer line for `ref`, honouring peel/symref requests. */
function lsRefsLine(repo: Repo, ref: { name: string; oid: string }, peel: boolean): string {
  let line = `${ref.oid} ${ref.name}`;
  if (ref.name.startsWith('refs/tags/') && peel) {
    const obj = repo.objects.get(ref.oid);
    if (obj !== undefined && obj.type === 'tag') {
      const target = tagTarget(obj.data);
      if (target !== null) line += ` peeled:${target}`;
    }
  }
  return line;
}

// ---------------------------------------------------------------- fetch selection

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallows: string[];
  deepen: number | null;
}

/** Add a tree's closure (subtrees + blobs) to `out`. */
function addTreeClosure(repo: Repo, treeOid: string, out: Set<string>): void {
  if (out.has(treeOid)) return;
  out.add(treeOid);
  const entries = parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
  for (const entry of entries) {
    if (entry.mode === '40000') addTreeClosure(repo, entry.oid, out);
    else out.add(entry.oid);
  }
}

/** Add commits/tags and their tree closures to `out`. */
function addCommitClosure(repo: Repo, oids: Iterable<string>, out: Set<string>): void {
  for (const oid of oids) {
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    out.add(oid);
    if (obj.type === 'tag') {
      const target = tagTarget(obj.data);
      if (target !== null) addCommitClosure(repo, [target], out);
    } else if (obj.type === 'commit') {
      addTreeClosure(repo, parseCommit(obj.data).tree, out);
    }
  }
}

/**
 * The objects a fetch sends, and the shallow-info lines it reports. Generations count from the
 * wants (want = 0); a depth limit D sends generations 0..D-1. A held object — a commit, tree or
 * blob the client already has — is never re-sent.
 */
export function selectFetch(
  repo: Repo,
  req: FetchRequest,
): { objects: Array<{ type: GitObjectType; data: Buffer }>; shallow: string[]; unshallow: string[] } {
  const depth = req.deepen ?? Number.POSITIVE_INFINITY;
  const wantMaxGen = depth === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : depth - 1;
  const wantReach = reachableCommits(repo, req.wants, wantMaxGen);
  // What the client already holds: each have with its full object closure, or just itself and
  // its tree when the have is one of the client's shallow boundaries.
  const held = new Set<string>();
  for (const have of req.haves) {
    const haveMaxGen = req.shallows.includes(have) ? 0 : Number.POSITIVE_INFINITY;
    const commits = reachableCommits(repo, [have], haveMaxGen);
    addCommitClosure(repo, commits.keys(), held);
  }
  // Send = reachable-from-wants minus held, with each commit's tree closure (also minus held).
  const sendCommits = new Map<string, number>();
  for (const [oid, gen] of wantReach) {
    if (held.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || (obj.type !== 'commit' && obj.type !== 'tag')) continue;
    sendCommits.set(oid, gen);
  }
  const send = new Map<string, GitObject>();
  const addObject = (oid: string): void => {
    if (held.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (obj !== undefined && !send.has(oid)) send.set(oid, obj);
  };
  // Emit commits in generation order (wants first), each followed by its tree closure.
  const ordered = [...sendCommits.entries()].sort((a, b) => a[1] - b[1]);
  for (const [oid] of ordered) {
    addObject(oid);
    const obj = repo.objects.get(oid)!;
    const target = obj.type === 'tag' ? tagTarget(obj.data) : oid;
    if (target === null) continue;
    const treeOid = commitTreeOid(repo, target);
    if (treeOid === null) continue;
    const closure = new Set<string>();
    addTreeClosure(repo, treeOid, closure);
    for (const entryOid of closure) addObject(entryOid);
  }
  // New shallow boundaries: only when a depth cut the history. A sent commit at generation
  // depth-1 whose parent was not sent is a boundary.
  const shallow: string[] = [];
  if (req.deepen !== null) {
    for (const [oid, gen] of sendCommits) {
      if (gen !== req.deepen - 1) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      if (parseCommit(obj.data).parents.length > 0) shallow.push(oid);
    }
  }
  // Unshallow: a client's boundary now complete (reachable within depth-1 of a want, or fully
  // fetched when there is no depth limit).
  const unshallow: string[] = [];
  for (const boundary of req.shallows) {
    const gen = wantReach.get(boundary);
    if (gen === undefined) continue;
    if (req.deepen === null || gen <= req.deepen - 1) unshallow.push(boundary);
  }
  return { objects: [...send.values()], shallow, unshallow };
}

/** Wrap a pack in sideband band-1 pkt-lines (max 65515 data bytes: the 4-byte length and the
 * 1-byte band leave 65515 of the 65520 pkt-line budget), then a flush. */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  let pos = 0;
  while (pos < pack.length) {
    const chunk = pack.subarray(pos, Math.min(pack.length, pos + 65515));
    const body = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii'), body]));
    pos += chunk.length;
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Cap on memoised fetch responses per repo (each is a few KiB at most in this suite). */
const FETCH_CACHE_MAX = 64;

/**
 * The memo key for one upload-pack fetch: the protocol, the request, and the object-store size.
 * A fetch's response is a pure function of (wants, haves, shallows, deepen) and the object set;
 * objects are only added, never removed, so equal size means an equal object set, and a push
 * changes the key. Refs never enter the selection, so ref moves need no invalidation.
 */
function fetchCacheKey(repo: Repo, protocol: 'v2' | 'v0', req: FetchRequest): string {
  return [
    protocol,
    req.wants.join(','),
    req.haves.join(','),
    req.shallows.join(','),
    req.deepen === null ? '' : String(req.deepen),
    repo.objects.size,
  ].join('|');
}

/** Store one fetch response, evicting the oldest entry past the cap. */
function cacheFetchResponse(repo: Repo, key: string, response: Buffer): void {
  const cache = repo.fetchCache;
  if (cache.size >= FETCH_CACHE_MAX) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, response);
}

// ---------------------------------------------------------------- upload-pack v2

/** Handle POST git-upload-pack with the v2 protocol (header Git-Protocol: version=2). */
export function handleUploadPackV2(repo: Repo, body: Buffer): Buffer {
  const { lines } = parsePktLines(body);
  let command = '';
  const args: string[] = [];
  for (const line of lines) {
    if (line === '\u0001') continue;
    if (line.startsWith('command=')) command = line.slice(8).trim();
    else args.push(line.trim());
  }
  if (command === 'ls-refs') {
    let peel = false;
    let unborn = false;
    const prefixes: string[] = [];
    for (const arg of args) {
      if (arg === 'peel') peel = true;
      else if (arg === 'unborn') unborn = true;
      else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    }
    const parts: Buffer[] = [];
    const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
    const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (matches('HEAD')) {
      if (tip !== undefined) parts.push(pktLine(`${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
      else if (unborn) parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
    for (const ref of sortedRefs(repo)) {
      if (!matches(ref.name)) continue;
      parts.push(pktLine(`${lsRefsLine(repo, ref, peel)}\n`));
    }
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  if (command === 'fetch') {
    const req: FetchRequest = { wants: [], haves: [], shallows: [], deepen: null };
    for (const arg of args) {
      if (arg.startsWith('want ')) req.wants.push(arg.slice(5).trim());
      else if (arg.startsWith('have ')) req.haves.push(arg.slice(5).trim());
      else if (arg.startsWith('shallow ')) req.shallows.push(arg.slice(8).trim());
      else if (arg.startsWith('deepen ')) req.deepen = Number(arg.slice(7).trim());
    }
    const key = fetchCacheKey(repo, 'v2', req);
    const hit = repo.fetchCache.get(key);
    if (hit !== undefined) return hit;
    const selected = selectFetch(repo, req);
    const pack = writePack(selected.objects);
    const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), pktFlush()];
    if (selected.shallow.length > 0 || selected.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of selected.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of selected.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(pktFlush());
    }
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(pack));
    const out = Buffer.concat(parts);
    cacheFetchResponse(repo, key, out);
    return out;
  }
  // Unknown v2 command: an empty packfile section keeps the client from hanging.
  return Buffer.concat([pktLine('acknowledgments\n'), pktLine('NAK\n'), pktFlush(), pktLine('packfile\n'), sidebandPack(writePack([]))]);
}

/** Parse every pkt-line in `buf`, skipping flush/delim packets (v0's two sections). */
export function parseAllPktLines(buf: Buffer): string[] {
  const lines: string[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const len = parseInt(buf.subarray(pos, pos + 4).toString('ascii'), 16);
    if (!Number.isFinite(len) || len < 0) break;
    if (len === 0 || len === 1) {
      pos += 4;
      continue;
    }
    if (pos + len > buf.length) break;
    lines.push(buf.subarray(pos + 4, pos + len).toString('utf8'));
    pos += len;
  }
  return lines;
}

// ---------------------------------------------------------------- upload-pack v0

/**
 * Handle POST git-upload-pack with the v0 protocol (no Git-Protocol header). v0 is two
 * sections: wants (with shallow/deepen), a flush, then haves + done, a flush.
 */
export function handleUploadPackV0(repo: Repo, body: Buffer): Buffer {
  const lines = parseAllPktLines(body);
  const req: FetchRequest = { wants: [], haves: [], shallows: [], deepen: null };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (trimmed === 'done') continue;
    if (trimmed.startsWith('want ')) {
      const rest = trimmed.slice(5);
      const space = rest.indexOf(' ');
      req.wants.push(space < 0 ? rest : rest.slice(0, space));
    } else if (trimmed.startsWith('have ')) req.haves.push(trimmed.slice(5).trim());
    else if (trimmed.startsWith('shallow ')) req.shallows.push(trimmed.slice(8).trim());
    else if (trimmed.startsWith('deepen ')) req.deepen = Number(trimmed.slice(7).trim());
  }
  const key = fetchCacheKey(repo, 'v0', req);
  const hit = repo.fetchCache.get(key);
  if (hit !== undefined) return hit;
  const selected = selectFetch(repo, req);
  const pack = writePack(selected.objects);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of selected.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selected.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  const out = Buffer.concat(parts);
  cacheFetchResponse(repo, key, out);
  return out;
}

// ---------------------------------------------------------------- receive-pack

export interface PushReport {
  unpackOk: boolean;
  unpackDetail: string;
  refs: Array<{ ref: string; ok: boolean; reason: string }>;
}

/**
 * Handle POST git-receive-pack: command list + pack, per-ref fast-forward, sideband report.
 * Never throws for a malformed body: the report carries the failure and the server stays up.
 */
export function handleReceivePack(repo: Repo, body: Buffer): { report: Buffer; result: PushReport } {
  const result: PushReport = { unpackOk: false, unpackDetail: '', refs: [] };
  try {
    const { lines, rest } = parsePktLines(body);
    if (lines.length === 0) throw new Error('empty command list');
    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    for (const line of lines) {
      if (line === '\u0001') continue;
      const nul = line.indexOf('\0');
      const clean = (nul < 0 ? line : line.slice(0, nul)).trim();
      const parts = clean.split(/\s+/);
      if (parts.length < 3) throw new Error(`unparsable command line ${JSON.stringify(clean)}`);
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
    // Unpack first: a refused ref still reports "unpack ok".
    let packObjects = new Map<string, GitObject>();
    if (rest.length > 0) {
      const read = readPack(rest);
      if (read.error !== null) throw new Error(`unpack failed: ${read.error}`);
      packObjects = read.objects;
    }
    for (const [oid, obj] of packObjects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
    result.unpackOk = true;
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          result.refs.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
        } else {
          repo.refs.delete(cmd.ref);
          result.refs.push({ ref: cmd.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (!repo.objects.has(cmd.newOid)) {
        result.refs.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (cmd.oldOid === ZERO_OID) {
        if (current !== undefined) {
          result.refs.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
        repo.refs.set(cmd.ref, cmd.newOid);
        result.refs.push({ ref: cmd.ref, ok: true, reason: '' });
        continue;
      }
      if (current === undefined) {
        result.refs.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
        continue;
      }
      if (current !== cmd.oldOid) {
        result.refs.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) {
        result.refs.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      result.refs.push({ ref: cmd.ref, ok: true, reason: '' });
    }
  } catch (err) {
    result.unpackOk = false;
    result.unpackDetail = err instanceof Error ? err.message : String(err);
  }
  const parts: Buffer[] = [];
  if (result.unpackOk) parts.push(pktLine('unpack ok\n'));
  else parts.push(pktLine(`unpack ${result.unpackDetail}\n`));
  for (const ref of result.refs) {
    parts.push(pktLine(ref.ok ? `ok ${ref.ref}\n` : `ng ${ref.ref} ${ref.reason}\n`));
  }
  parts.push(pktFlush());
  // The report travels inside sideband band 1.
  const reportBody = Buffer.concat(parts);
  const framed: Buffer[] = [];
  let pos = 0;
  while (pos < reportBody.length) {
    const chunk = reportBody.subarray(pos, Math.min(reportBody.length, pos + 65515));
    const bodyWithBand = Buffer.concat([Buffer.from([1]), chunk]);
    framed.push(Buffer.concat([Buffer.from((bodyWithBand.length + 4).toString(16).padStart(4, '0'), 'ascii'), bodyWithBand]));
    pos += chunk.length;
  }
  framed.push(pktFlush());
  return { report: Buffer.concat(framed), result };
}

// ---------------------------------------------------------------- contents / merge commits

/** Create a commit on `branch` that sets `path` to `content` (the contents API's commit). */
export function contentsCommit(
  repo: Repo,
  branch: string,
  pathSegments: readonly string[],
  content: Buffer,
  message: string,
): { commitOid: string; blobOid: string; created: boolean } {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  const blobOid = (() => {
    const oid = hashObject('blob', content);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'blob', data: content });
    return oid;
  })();
  const currentTree = tip === undefined ? null : commitTreeOid(repo, tip);
  const existed = currentTree !== null && findTreePath(repo, currentTree, pathSegments) !== null;
  const newTree = buildTreeWithPath(repo, currentTree, pathSegments, blobOid);
  const identity = { ...FORGE_IDENTITY, timestamp: FORGE_EPOCH_SEC };
  const commitData = buildCommit({ tree: newTree, parents: tip === undefined ? [] : [tip], message, author: identity, committer: identity });
  const commitOid = hashObject('commit', commitData);
  if (!repo.objects.has(commitOid)) repo.objects.set(commitOid, { type: 'commit', data: commitData });
  repo.refs.set(ref, commitOid);
  return { commitOid, blobOid, created: !existed };
}

/** Delete `path` from `branch`'s tip tree and commit the result. */
export function contentsDeleteCommit(repo: Repo, branch: string, pathSegments: readonly string[], message: string): string | null {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  if (tip === undefined) return null;
  const currentTree = commitTreeOid(repo, tip);
  if (currentTree === null) return null;
  const newTree = removeTreePath(repo, currentTree, pathSegments);
  if (newTree === null) return null;
  const identity = { ...FORGE_IDENTITY, timestamp: FORGE_EPOCH_SEC };
  const commitData = buildCommit({ tree: newTree, parents: [tip], message, author: identity, committer: identity });
  const commitOid = hashObject('commit', commitData);
  if (!repo.objects.has(commitOid)) repo.objects.set(commitOid, { type: 'commit', data: commitData });
  repo.refs.set(ref, commitOid);
  return commitOid;
}

function removeTreePath(repo: Repo, treeOid: string, segments: readonly string[]): string | null {
  const entries = parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
  const head = segments[0]!;
  const index = entries.findIndex((entry) => entry.name === head);
  if (index < 0) return null;
  const entry = entries[index]!;
  if (segments.length === 1) {
    if (entry.mode === '40000') return null;
    entries.splice(index, 1);
  } else {
    if (entry.mode !== '40000') return null;
    const child = removeTreePath(repo, entry.oid, segments.slice(1));
    if (child === null) return null;
    const childEntries = parseTree(repo.objects.get(child)?.data ?? Buffer.alloc(0));
    if (childEntries.length === 0) entries.splice(index, 1);
    else entries[index] = { ...entry, oid: child };
  }
  const data = buildTree(entries);
  const oid = hashObject('tree', data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
  return oid;
}

/** Whether a pull request can merge: MERGEABLE, CONFLICTING, or UNKNOWN. */
export function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open' || pull.merged) return 'UNKNOWN';
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseTip === undefined) return 'UNKNOWN';
  if (baseTip === pull.baseSha) return 'MERGEABLE';
  const baseTree = commitTreeOid(repo, pull.baseSha);
  const headTree = commitTreeOid(repo, pull.headSha);
  const newBaseTree = commitTreeOid(repo, baseTip);
  if (baseTree === null || headTree === null || newBaseTree === null) return 'UNKNOWN';
  const changedOnBase = new Set(diffTrees(repo, baseTree, newBaseTree).map((d) => d.path));
  const changedOnHead = diffTrees(repo, baseTree, headTree).map((d) => d.path);
  for (const path of changedOnHead) if (changedOnBase.has(path)) return 'CONFLICTING';
  return 'MERGEABLE';
}

/** Squash-merge a pull request onto its base branch. Returns the merge commit oid, or null. */
export function squashMerge(repo: Repo, pull: Pull): string | null {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTree = commitTreeOid(repo, pull.headSha);
  if (baseTip === undefined || headTree === null) return null;
  const identity = { ...FORGE_IDENTITY, timestamp: FORGE_EPOCH_SEC };
  const message = `Merge pull request #${pull.number} from ${repo.owner}:${pull.headRef}\n\n${pull.title}`;
  const commitData = buildCommit({ tree: headTree, parents: [baseTip], message, author: identity, committer: identity });
  const commitOid = hashObject('commit', commitData);
  if (!repo.objects.has(commitOid)) repo.objects.set(commitOid, { type: 'commit', data: commitData });
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  return commitOid;
}

export { buildTree, parseTree };
export type { Store };
export { VIEWER_LOGIN };
