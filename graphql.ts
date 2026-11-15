// GraphQL v4: POST /api/graphql. A small parser + executor for the documents the suite sends
// (viewer, repository, node, issues/pulls connections, the five mutations, __type introspection).
// Unknown fields answer HTTP 200 with an errors array naming the field; an unknown repository
// answers data.repository = null with no errors. GraphQL and REST share one store.

import {
  VIEWER_ID,
  VIEWER_LOGIN,
  commitTreeOid,
  diffTrees,
  globalId,
  parseGlobalId,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { pullMergeable, squashMerge } from './git.ts';

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: 'brace'; value: '{' | '}' }
  | { kind: 'paren'; value: '(' | ')' }
  | { kind: 'bracket'; value: '[' | ']' }
  | { kind: 'colon' }
  | { kind: 'comma' }
  | { kind: 'spread' }
  | { kind: 'dollar' }
  | { kind: 'bang' }
  | { kind: 'equals' }
  | { kind: 'at' }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '{' || ch === '}' || ch === '(' || ch === ')' || ch === '[' || ch === ']') {
      tokens.push({ kind: ch === '{' || ch === '}' ? 'brace' : ch === '(' || ch === ')' ? 'paren' : 'bracket', value: ch } as Token);
      i += 1;
      continue;
    }
    if (ch === ':') {
      tokens.push({ kind: 'colon' });
      i += 1;
      continue;
    }
    if (ch === '.') {
      if (source.slice(i, i + 3) !== '...') throw new Error('bad spread');
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if (ch === '$') {
      tokens.push({ kind: 'dollar' });
      i += 1;
      continue;
    }
    if (ch === '!') {
      tokens.push({ kind: 'bang' });
      i += 1;
      continue;
    }
    if (ch === '=') {
      tokens.push({ kind: 'equals' });
      i += 1;
      continue;
    }
    if (ch === '@') {
      tokens.push({ kind: 'at' });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else out += esc ?? '';
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) j += 1;
      const raw = source.slice(i, j);
      if (/[.eE]/.test(raw)) tokens.push({ kind: 'float', value: Number(raw) });
      else tokens.push({ kind: 'int', value: Number(raw) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

export interface FieldNode {
  alias: string | null;
  name: string;
  args: Record<string, unknown>;
  children: SelectionNode[] | null;
}

export type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; typeCondition: string | null; children: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variableDefs: Record<string, unknown>;
  fields: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly defaults: Record<string, unknown> = {};
  private readonly tokens: Token[];
  private readonly variables: Record<string, unknown>;
  constructor(tokens: Token[], variables: Record<string, unknown>) {
    this.tokens = tokens;
    this.variables = variables;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectBrace(value: '{' | '}'): void {
    const token = this.next();
    if (token.kind !== 'brace' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private expectParen(value: '(' | ')'): void {
    const token = this.next();
    if (token.kind !== 'paren' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}`);
    return token.value;
  }

  parseDocument(): { operations: Operation[]; fragments: Record<string, SelectionNode[]> } {
    const operations: Operation[] = [];
    const fragments: Record<string, SelectionNode[]> = {};
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'brace' && token.value === '{') {
        operations.push({ kind: 'query', name: null, variableDefs: {}, fields: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const kind = token.value as 'query' | 'mutation';
        this.next();
        let name: string | null = null;
        const next = this.peek();
        if (next?.kind === 'name') name = this.next().value as string;
        const variableDefs: Record<string, unknown> = {};
        if (this.peek()?.kind === 'paren' && this.peek()?.value === '(') this.parseVariableDefinitions(variableDefs);
        operations.push({ kind, name, variableDefs, fields: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeName = this.expectName();
        void typeName;
        fragments[name] = this.parseSelectionSet();
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(token)}`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(out: Record<string, unknown>): void {
    this.expectParen('(');
    for (;;) {
      const peek = this.peek();
      if (peek?.kind === 'paren' && peek.value === ')') {
        this.next();
        return;
      }
      if (peek?.kind === 'comma') {
        this.next();
        continue;
      }
      const dollar = this.next();
      if (dollar.kind !== 'dollar') throw new Error('expected $ in variable definition');
      const name = this.expectName();
      this.next(); // ':'
      // Skip the type (names, [ ], !) until ',' , ')' or a default '='.
      let depth = 0;
      for (;;) {
        const token = this.next();
        if (token.kind === 'bracket' && token.value === '[') depth += 1;
        else if (token.kind === 'bracket' && token.value === ']') depth -= 1;
        else if (token.kind === 'equals' && depth === 0) {
          const value = this.parseValue();
          out[name] = value;
          this.defaults[name] = value;
          break;
        } else if (depth === 0 && (token.kind === 'comma' || (token.kind === 'paren' && token.value === ')'))) {
          this.pos -= 1;
          break;
        }
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectBrace('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'brace' && this.peek()?.value === '}')) {
      const token = this.peek()!;
      if (token.kind === 'spread') {
        this.next();
        const next = this.peek();
        if (next?.kind === 'name' && next.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          selections.push({ kind: 'fragment', typeCondition, children: this.parseSelectionSet() });
        } else {
          const name = this.expectName();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    this.expectBrace('}');
    return selections;
  }

  private parseField(): FieldNode {
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek()?.kind === 'colon') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    let args: Record<string, unknown> = {};
    if (this.peek()?.kind === 'paren' && this.peek()?.value === '(') args = this.parseArguments();
    // Directives (@...) are ignored.
    while (this.peek()?.kind === 'at') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'paren' && this.peek()?.value === '(') this.parseArguments();
    }
    let children: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'brace' && this.peek()?.value === '{') children = this.parseSelectionSet();
    return { alias, name, args, children };
  }

  private parseArguments(): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    this.expectParen('(');
    while (!(this.peek()?.kind === 'paren' && this.peek()?.value === ')')) {
      const name = this.expectName();
      const colon = this.next();
      if (colon.kind !== 'colon') throw new Error('expected : in argument');
      args[name] = this.parseValue();
    }
    this.expectParen(')');
    return args;
  }

  private parseValue(): unknown {
    const token = this.next();
    if (token.kind === 'string' || token.kind === 'int' || token.kind === 'float') return token.value;
    if (token.kind === 'dollar') {
      const name = this.expectName();
      const value = this.variables[name];
      return value === undefined ? this.defaults[name] : value;
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value; // enum value
    }
    if (token.kind === 'bracket' && token.value === '[') {
      const list: unknown[] = [];
      while (!(this.peek()?.kind === 'bracket' && this.peek()?.value === ']')) list.push(this.parseValue());
      this.next();
      return list;
    }
    if (token.kind === 'brace' && token.value === '{') {
      const obj: Record<string, unknown> = {};
      while (!(this.peek()?.kind === 'brace' && this.peek()?.value === '}')) {
        const name = this.expectName();
        const colon = this.next();
        if (colon.kind !== 'colon') throw new Error('expected : in object');
        obj[name] = this.parseValue();
      }
      this.next();
      return obj;
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

// ---------------------------------------------------------------- field tables (for unknown-field errors)

const FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  IssueComment: ['id', 'body'],
  BranchRef: ['name'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  FileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const TYPE_FIELDS: Record<string, readonly string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  SearchType: [],
};

const ENUM_VALUES: Record<string, readonly string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'COMMIT', 'DISCUSSION'],
};

// ---------------------------------------------------------------- execution

interface Ctx {
  store: Store;
  fragments: Record<string, SelectionNode[]>;
  errors: Array<{ message: string }>;
}

type GqlValue =
  | { __type: 'User' }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: Pull }
  | { __type: 'IssueComment'; repo: Repo; issueNumber: number; commentId: number; body: string }
  | { __type: 'BranchRef'; name: string }
  | { __type: 'IssueConnection'; repo: Repo; items: Issue[]; hasNextPage: boolean; endCursor: string | null }
  | { __type: 'PullRequestConnection'; repo: Repo; items: Pull[]; hasNextPage: boolean; endCursor: string | null }
  | { __type: 'FileConnection'; items: Array<{ path: string }> }
  | { __type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __type: 'CommentEdge'; repo: Repo; issueNumber: number; commentId: number; body: string }
  | { __type: '__Type'; name: string }
  | { __type: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { __type: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __type: 'CreatePullRequestPayload'; repo: Repo; pull: Pull }
  | { __type: 'MergePullRequestPayload'; repo: Repo; pull: Pull }
  | { __type: 'AddCommentPayload'; repo: Repo; issueNumber: number; commentId: number; body: string };

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberOfCursor(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function resolveRepoById(ctx: Ctx, repositoryId: unknown): Repo | null {
  if (typeof repositoryId !== 'string') return null;
  const parsed = parseGlobalId(repositoryId);
  if (parsed === null || parsed.kind !== 'Repository') return null;
  const dbid = Number(parsed.parts[0]);
  for (const repo of ctx.store.repos.values()) if (repo.databaseId === dbid) return repo;
  return null;
}

function resolveIssueById(ctx: Ctx, issueId: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof issueId !== 'string') return null;
  const parsed = parseGlobalId(issueId);
  if (parsed === null || parsed.kind !== 'Issue') return null;
  const dbid = Number(parsed.parts[0]);
  const number = Number(parsed.parts[1]);
  for (const repo of ctx.store.repos.values()) {
    if (repo.databaseId !== dbid) continue;
    const issue = repo.issues.find((candidate) => candidate.number === number);
    if (issue !== undefined) return { repo, issue };
  }
  return null;
}

function resolvePullById(ctx: Ctx, pullId: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof pullId !== 'string') return null;
  const parsed = parseGlobalId(pullId);
  if (parsed === null || parsed.kind !== 'PullRequest') return null;
  const dbid = Number(parsed.parts[0]);
  const number = Number(parsed.parts[1]);
  for (const repo of ctx.store.repos.values()) {
    if (repo.databaseId !== dbid) continue;
    const pull = repo.pulls.find((candidate) => candidate.number === number);
    if (pull !== undefined) return { repo, pull };
  }
  return null;
}

/** Execute one field against a value; null when the value itself is null. */
function executeField(ctx: Ctx, typeName: string, value: GqlValue | null, field: FieldNode): unknown {
  const key = field.alias ?? field.name;
  void key;
  if (value === null) return null;
  const allowed = FIELDS[typeName];
  if (allowed !== undefined && !allowed.includes(field.name)) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
    return undefined; // marks the field failed; the caller drops it
  }
  const resolved = resolveField(ctx, typeName, value, field);
  if (resolved === undefined) return undefined;
  if (field.children === null) return resolved;
  if (resolved === null) return null;
  if (Array.isArray(resolved)) return executeList(ctx, typeName, resolved, field.children);
  if (typeof resolved === 'object' && resolved !== null && '__type' in resolved) {
    return executeSelection(ctx, (resolved as GqlValue).__type, resolved as GqlValue, field.children);
  }
  return resolved;
}

function executeSelection(ctx: Ctx, typeName: string, value: GqlValue, selections: SelectionNode[]): Record<string, unknown> | null {
  if (value === null) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const result = executeField(ctx, typeName, value, selection.field);
      if (result !== undefined) out[selection.field.alias ?? selection.field.name] = result;
    } else if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== typeName) continue;
      const nested = executeSelection(ctx, typeName, value, selection.children);
      if (nested !== null) Object.assign(out, nested);
    } else {
      const fragment = ctx.fragments[selection.name];
      if (fragment !== undefined) {
        const nested = executeSelection(ctx, typeName, value, fragment);
        if (nested !== null) Object.assign(out, nested);
      }
    }
  }
  return out;
}

/** Resolve a field to a scalar, a GqlValue, or a list of them (children handled by the caller). */
function resolveField(ctx: Ctx, typeName: string, value: GqlValue, field: FieldNode): unknown {
  const args = field.args;
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') return { __type: 'User' } as GqlValue;
      if (field.name === 'repository') {
        const owner = args.owner;
        const name = args.name;
        if (owner !== VIEWER_LOGIN || typeof name !== 'string') return null;
        const repo = ctx.store.getRepo(VIEWER_LOGIN, name);
        return repo === undefined ? null : ({ __type: 'Repository', repo } as GqlValue);
      }
      if (field.name === 'node') {
        const id = args.id;
        if (typeof id !== 'string') return null;
        const parsed = parseGlobalId(id);
        if (parsed === null) return null;
        if (parsed.kind === 'Repository') {
          const repo = resolveRepoById(ctx, id);
          return repo === null ? null : ({ __type: 'Repository', repo } as GqlValue);
        }
        if (parsed.kind === 'Issue') {
          const found = resolveIssueById(ctx, id);
          return found === null ? null : ({ __type: 'Issue', repo: found.repo, issue: found.issue } as GqlValue);
        }
        if (parsed.kind === 'PullRequest') {
          const found = resolvePullById(ctx, id);
          return found === null ? null : ({ __type: 'PullRequest', repo: found.repo, pull: found.pull } as GqlValue);
        }
        return null;
      }
      if (field.name === '__type') {
        const name = args.name;
        return typeof name === 'string' ? ({ __type: '__Type', name } as GqlValue) : null;
      }
      return null;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = resolveRepoById(ctx, input.repositoryId);
        if (repo === null) return null;
        const issue = ctx.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
        return { __type: 'CreateIssuePayload', repo, issue } as GqlValue;
      }
      if (field.name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = resolveIssueById(ctx, input.issueId);
        if (found === null) return null;
        found.issue.state = 'closed';
        found.issue.version += 1;
        found.issue.jsonCache = null;
        return { __type: 'CloseIssuePayload', repo: found.repo, issue: found.issue } as GqlValue;
      }
      if (field.name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = resolveRepoById(ctx, input.repositoryId);
        if (repo === null) return null;
        const baseRef = String(input.baseRefName ?? '');
        const headRef = String(input.headRefName ?? '');
        const headSha = repo.refs.get(`refs/heads/${headRef}`);
        const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
        if (headSha === undefined || baseSha === undefined) return null;
        const pull = ctx.store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), headRef, headSha, baseRef, baseSha);
        return { __type: 'CreatePullRequestPayload', repo, pull } as GqlValue;
      }
      if (field.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = resolvePullById(ctx, input.pullRequestId);
        if (found === null) return null;
        if (found.pull.state === 'open' && !found.pull.merged && pullMergeable(found.repo, found.pull) !== 'CONFLICTING') {
          const mergeSha = squashMerge(found.repo, found.pull);
          if (mergeSha !== null) {
            found.pull.merged = true;
            found.pull.state = 'closed';
            found.pull.mergedAt = '2026-11-14T00:00:00Z';
            found.pull.mergeCommitSha = mergeSha;
          }
        }
        return { __type: 'MergePullRequestPayload', repo: found.repo, pull: found.pull } as GqlValue;
      }
      if (field.name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = resolveIssueById(ctx, input.subjectId);
        if (found === null) return null;
        const comment = ctx.store.createComment(found.repo, found.issue.number, String(input.body ?? ''));
        return { __type: 'AddCommentPayload', repo: found.repo, issueNumber: found.issue.number, commentId: comment.id, body: comment.body } as GqlValue;
      }
      return null;
    }
    case 'User': {
      if (field.name === 'login') return VIEWER_LOGIN;
      if (field.name === 'id') return VIEWER_ID;
      if (field.name === 'name') return 'ada iversen';
      if (field.name === 'email') return 'adaiversen@example.invalid';
      return null;
    }
    case 'Repository': {
      const repo = (value as { repo: Repo }).repo;
      if (field.name === 'id') return globalId('Repository', repo.databaseId);
      if (field.name === 'databaseId') return repo.databaseId;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field.name === 'owner') return { __type: 'User' } as GqlValue;
      if (field.name === 'defaultBranchRef') return { __type: 'BranchRef', name: repo.defaultBranch } as GqlValue;
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'issue') {
        const number = Number(args.number);
        const issue = repo.issues.find((candidate) => candidate.number === number);
        return issue === undefined ? null : ({ __type: 'Issue', repo, issue } as GqlValue);
      }
      if (field.name === 'issues') {
        return issuesConnection(ctx, repo, args);
      }
      if (field.name === 'pullRequest') {
        const number = Number(args.number);
        const pull = repo.pulls.find((candidate) => candidate.number === number);
        return pull === undefined ? null : ({ __type: 'PullRequest', repo, pull } as GqlValue);
      }
      if (field.name === 'pullRequests') {
        const first = typeof args.first === 'number' ? args.first : 10;
        const items = [...repo.pulls].slice(0, Math.max(0, first));
        return { __type: 'PullRequestConnection', repo, items, hasNextPage: repo.pulls.length > items.length, endCursor: items.length > 0 ? cursorOf(items[items.length - 1]!.number) : null } as GqlValue;
      }
      return null;
    }
    case 'Issue': {
      const { repo, issue } = value as { repo: Repo; issue: Issue };
      if (field.name === 'id') return globalId('Issue', repo.databaseId, issue.number);
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'body') return issue.body;
      if (field.name === 'state') return issueState(issue);
      if (field.name === 'url') return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
      return null;
    }
    case 'PullRequest': {
      const { repo, pull } = value as { repo: Repo; pull: Pull };
      if (field.name === 'id') return globalId('PullRequest', repo.databaseId, pull.number);
      if (field.name === 'number') return pull.number;
      if (field.name === 'title') return pull.title;
      if (field.name === 'body') return pull.body;
      if (field.name === 'headRefName') return pull.headRef;
      if (field.name === 'baseRefName') return pull.baseRef;
      if (field.name === 'mergeable') return pullMergeable(repo, pull);
      if (field.name === 'state') return pullState(pull);
      if (field.name === 'merged') return pull.merged;
      if (field.name === 'files') {
        const baseTree = commitTreeOid(repo, pull.baseSha);
        const headTree = commitTreeOid(repo, pull.headSha);
        const items = baseTree === null || headTree === null ? [] : diffTrees(repo, baseTree, headTree).map((d) => ({ path: d.path }));
        const first = typeof args.first === 'number' ? args.first : 10;
        return { __type: 'FileConnection', items: items.slice(0, Math.max(0, first)) } as GqlValue;
      }
      return null;
    }
    case 'IssueComment': {
      const comment = value as { repo: Repo; issueNumber: number; commentId: number; body: string };
      if (field.name === 'id') return globalId('IssueComment', comment.repo.databaseId, comment.commentId);
      if (field.name === 'body') return comment.body;
      return null;
    }
    case 'BranchRef': {
      if (field.name === 'name') return (value as { name: string }).name;
      return null;
    }
    case 'IssueConnection': {
      const conn = value as { repo: Repo; items: Issue[]; hasNextPage: boolean; endCursor: string | null };
      if (field.name === 'nodes') return conn.items.map((issue) => ({ __type: 'Issue', repo: conn.repo, issue }) as GqlValue);
      if (field.name === 'pageInfo') return { __type: 'PageInfo', hasNextPage: conn.hasNextPage, endCursor: conn.endCursor } as GqlValue;
      if (field.name === 'totalCount') return conn.items.length;
      return null;
    }
    case 'PullRequestConnection': {
      const conn = value as { repo: Repo; items: Pull[]; hasNextPage: boolean; endCursor: string | null };
      if (field.name === 'nodes') return conn.items.map((pull) => ({ __type: 'PullRequest', repo: conn.repo, pull }) as GqlValue);
      if (field.name === 'pageInfo') return { __type: 'PageInfo', hasNextPage: conn.hasNextPage, endCursor: conn.endCursor } as GqlValue;
      if (field.name === 'totalCount') return conn.items.length;
      return null;
    }
    case 'FileConnection': {
      const conn = value as { items: Array<{ path: string }> };
      if (field.name === 'nodes') return conn.items.map((item) => item);
      if (field.name === 'pageInfo') return { __type: 'PageInfo', hasNextPage: false, endCursor: null } as GqlValue;
      if (field.name === 'totalCount') return conn.items.length;
      return null;
    }
    case 'PageInfo': {
      const info = value as { hasNextPage: boolean; endCursor: string | null };
      if (field.name === 'hasNextPage') return info.hasNextPage;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'startCursor') return info.endCursor;
      if (field.name === 'endCursor') return info.endCursor;
      return null;
    }
    case 'CommentEdge': {
      const edge = value as { repo: Repo; issueNumber: number; commentId: number; body: string };
      if (field.name === 'node') return { __type: 'IssueComment', repo: edge.repo, issueNumber: edge.issueNumber, commentId: edge.commentId, body: edge.body } as GqlValue;
      if (field.name === 'cursor') return cursorOf(edge.commentId);
      return null;
    }
    case '__Type': {
      const typeName = (value as { name: string }).name;
      if (field.name === 'name') return typeName;
      if (field.name === 'kind') return typeName in ENUM_VALUES ? 'ENUM' : 'OBJECT';
      if (field.name === 'fields') {
        const names = TYPE_FIELDS[typeName] ?? [];
        return names.map((name) => ({ __type: '__Field', name }) as GqlValue);
      }
      if (field.name === 'enumValues') {
        const names = ENUM_VALUES[typeName] ?? [];
        return names.map((name) => ({ __type: '__EnumValue', name }) as GqlValue);
      }
      return null;
    }
    case '__Field': {
      if (field.name === 'name') return (value as { name: string }).name;
      return null;
    }
    case '__EnumValue': {
      if (field.name === 'name') return (value as { name: string }).name;
      return null;
    }
    case 'CreateIssuePayload': {
      const payload = value as { repo: Repo; issue: Issue };
      if (field.name === 'issue') return { __type: 'Issue', repo: payload.repo, issue: payload.issue } as GqlValue;
      return null;
    }
    case 'CloseIssuePayload': {
      const payload = value as { repo: Repo; issue: Issue };
      if (field.name === 'issue') return { __type: 'Issue', repo: payload.repo, issue: payload.issue } as GqlValue;
      return null;
    }
    case 'CreatePullRequestPayload': {
      const payload = value as { repo: Repo; pull: Pull };
      if (field.name === 'pullRequest') return { __type: 'PullRequest', repo: payload.repo, pull: payload.pull } as GqlValue;
      return null;
    }
    case 'MergePullRequestPayload': {
      const payload = value as { repo: Repo; pull: Pull };
      if (field.name === 'pullRequest') return { __type: 'PullRequest', repo: payload.repo, pull: payload.pull } as GqlValue;
      return null;
    }
    case 'AddCommentPayload': {
      const payload = value as { repo: Repo; issueNumber: number; commentId: number; body: string };
      if (field.name === 'commentEdge') return { __type: 'CommentEdge', repo: payload.repo, issueNumber: payload.issueNumber, commentId: payload.commentId, body: payload.body } as GqlValue;
      return null;
    }
    default:
      return null;
  }
}

/** The issues connection: states filter, CREATED_AT order, cursor pagination. */
function issuesConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): GqlValue {
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
  let items = [...repo.issues];
  if (states !== null) items = items.filter((issue) => states.includes(issueState(issue)));
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = orderBy.direction === 'ASC' ? 1 : -1;
  items.sort((a, b) => (a.number - b.number) * direction);
  const afterNumber = numberOfCursor(args.after as string | null | undefined);
  if (afterNumber !== null) {
    const index = items.findIndex((issue) => issue.number === afterNumber);
    if (index >= 0) items = items.slice(index + 1);
  }
  const first = typeof args.first === 'number' ? args.first : 10;
  const page = items.slice(0, Math.max(0, first));
  return {
    __type: 'IssueConnection',
    repo,
    items: page,
    hasNextPage: items.length > page.length,
    endCursor: page.length > 0 ? cursorOf(page[page.length - 1]!.number) : null,
  } as GqlValue;
}

// ---------------------------------------------------------------- list values in selections

/**
 * A resolved list: each element is executed against the field's children (when the elements are
 * GqlValues), or returned as-is for plain objects (file nodes).
 */
function executeList(ctx: Ctx, typeName: string, items: unknown[], children: SelectionNode[] | null): unknown[] {
  if (children === null) return items;
  return items.map((item) => {
    if (typeof item === 'object' && item !== null && '__type' in item) {
      return executeSelection(ctx, (item as GqlValue).__type, item as GqlValue, children);
    }
    if (typeof item === 'object' && item !== null) {
      // A plain node (file { path }): pick the named scalar fields.
      const out: Record<string, unknown> = {};
      for (const selection of children) {
        if (selection.kind === 'field') {
          const record = item as Record<string, unknown>;
          if (selection.field.name in record) out[selection.field.alias ?? selection.field.name] = record[selection.field.name];
        }
      }
      return out;
    }
    return item;
  });
}

// ---------------------------------------------------------------- entry point

export interface GraphQLResult {
  status: number;
  body: unknown;
}

/** Handle one POST /api/graphql body (an object or an array of operation docs). */
export function handleGraphQL(store: Store, body: unknown): GraphQLResult {
  const docs = Array.isArray(body) ? body : [body];
  const results: unknown[] = [];
  for (const doc of docs) {
    results.push(executeDocument(store, doc));
  }
  return { status: 200, body: Array.isArray(body) ? results : results[0] };
}

function executeDocument(store: Store, doc: unknown): Record<string, unknown> {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { errors: [{ message: 'GraphQL document must be an object' }] };
  }
  const record = doc as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== 'string') return { errors: [{ message: 'GraphQL document needs a query string' }] };
  const variables = (record.variables ?? {}) as Record<string, unknown>;
  const ctx: Ctx = { store, fragments: {}, errors: [] };
  let parsed;
  try {
    parsed = new Parser(lex(query), variables).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  ctx.fragments = parsed.fragments;
  const operation = parsed.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation in document' }] };
  // Apply variable defaults the parser collected.
  for (const [name, value] of Object.entries(operation.variableDefs)) {
    if (variables[name] === undefined && value !== undefined) variables[name] = value;
  }
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(ctx, rootType, { __type: rootType } as GqlValue, operation.fields);
  if (ctx.errors.length > 0) return { data: null, errors: ctx.errors };
  return { data };
}

// Re-exported so executeField's list handling can run through the same path.
export { executeList };
