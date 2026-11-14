// git smart HTTP: the pkt-line framing, the v0/v2 upload-pack and the v0
// receive-pack, spoken against the store. No git binary anywhere: objects are
// hashed, packed and unpacked here, on node:zlib and node:crypto.

import {
  ZERO_OID,
  applyDelta,
  buildTree,
  collectReachable,
  flattenTree,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  type GitObject,
  type ObjectType,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------- pkt-lines

export const PKT_MAX = 65520;
/** One pkt-line: 4 hex length digits (payload + 4) and the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  if (len > PKT_MAX) throw new Error(`pkt-line of ${len} bytes exceeds ${PKT_MAX}`);
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}
export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

/** Decode a buffer of pkt-lines into packets ({kind, payload}), stopping at raw tail. */
export function decodePktLines(
  buf: Buffer,
): { packets: Array<{ kind: 'data' | 'flush' | 'delim' | 'response-end'; payload: Buffer }>; tail: Buffer } {
  const packets: Array<{ kind: 'data' | 'flush' | 'delim' | 'response-end'; payload: Buffer }> = [];
  let at = 0;
  while (at + 4 <= buf.length) {
    const head = buf.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (len < 4 || at + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(at + 4, at + len) });
    at += len;
  }
  return { packets, tail: buf.subarray(at) };
}

/** The data payloads of a pkt-line stream as lines of text (without trailing \n). */
export function pktTextLines(buf: Buffer): string[] {
  const { packets } = decodePktLines(buf);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// ---------------------------------------------------------------- sideband

/** Wrap pack bytes into sideband band-1 pkt-lines (each payload ≤ 65516 bytes). */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = PKT_MAX - 4 - 1;
  for (let at = 0; at < pack.length; at += CHUNK) {
    const slice = pack.subarray(at, Math.min(pack.length, at + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- advertisements

const AGENT = 'github-core-clone/1.0';

/** The v2 capability advertisement: `version 2` then one capability per line. */
export function v2Advertisement(): Buffer {
  const lines = [
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done filter\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
  ];
  return Buffer.concat([...lines.map((line) => pktLine(line)), pktFlush()]);
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The ref lines of a v0 advertisement (first line carries the capabilities). */
function v0RefLines(repo: Repo, capabilities: string): Buffer[] {
  const lines: Buffer[] = [];
  const refs = sortedRefs(repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const caps = ` ${capabilities} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
    return lines;
  }
  // HEAD first, carrying the capabilities after a NUL.
  lines.push(pktLine(`${headTip ?? ZERO_OID} HEAD\0${caps}\n`));
  for (const ref of refs) {
    lines.push(pktLine(`${ref.oid} ${ref.name}\n`));
    const object = repo.objects.get(ref.oid);
    if (object?.type === 'tag') {
      const target = parseTag(object.data).object;
      if (isOid(target)) lines.push(pktLine(`${target} ${ref.name}^{}\n`));
    }
  }
  return lines;
}

/** The v0 upload-pack advertisement, with the `# service=` preamble. */
export function v0UploadAdvertisement(repo: Repo): Buffer {
  const caps = 'side-band-64k thin-pack ofs-delta shallow multi_ack';
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    pktFlush(),
    ...v0RefLines(repo, caps),
    pktFlush(),
  ]);
}

/** The v0 receive-pack advertisement, with the `# service=` preamble. */
export function v0ReceiveAdvertisement(repo: Repo): Buffer {
  const caps = 'report-status side-band-64k delete-refs ofs-delta';
  return Buffer.concat([
    pktLine('# service=git-receive-pack\n'),
    pktFlush(),
    ...v0RefLines(repo, caps),
    pktFlush(),
  ]);
}

// ---------------------------------------------------------------- ls-refs (v2)

export interface LsRef {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** The refs a v2 ls-refs answers, after its ref-prefix filter. */
export function lsRefs(repo: Repo, prefixes: readonly string[]): LsRef[] {
  const out: LsRef[] = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix))) {
    if (headTip === undefined) {
      out.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}`, unborn: true });
    } else {
      out.push({ oid: headTip, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}` });
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    const entry: LsRef = { oid: ref.oid, name: ref.name };
    const object = repo.objects.get(ref.oid);
    if (object?.type === 'tag') {
      const target = parseTag(object.data).object;
      if (isOid(target)) entry.peeled = target;
    }
    out.push(entry);
  }
  return out;
}

/** Encode ls-refs results as pkt-lines, ending with a flush. */
export function encodeLsRefs(refs: readonly LsRef[]): Buffer {
  const parts: Buffer[] = [];
  for (const ref of refs) {
    if (ref.unborn === true) {
      parts.push(pktLine(`unborn ${ref.name}${ref.symrefTarget !== undefined ? ` symref-target:${ref.symrefTarget}` : ''}\n`));
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (ref.symrefTarget !== undefined) line += ` symref-target:${ref.symrefTarget}`;
    if (ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch planning

export interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

/**
 * The objects a fetch sends for `included` commits: each commit's tree and
 * blobs, following parent links only while they stay inside `included`, plus
 * any tag objects named. Parents outside the set are boundaries, not history
 * to send — that is what makes a depth-1 fetch shallow.
 */
function collectFetchClosure(
  lookup: (oid: string) => GitObject | undefined,
  included: ReadonlySet<string>,
  tagOids: readonly string[],
): Set<string> {
  const out = new Set<string>();
  const visitTree = (oid: string): void => {
    if (out.has(oid)) return;
    const object = lookup(oid);
    if (object === undefined) return;
    out.add(oid);
    if (object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') visitTree(entry.oid);
      else out.add(entry.oid);
    }
  };
  const visitCommit = (oid: string): void => {
    if (out.has(oid)) return;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') return;
    out.add(oid);
    const commit = parseCommit(object.data);
    visitTree(commit.tree);
    for (const parent of commit.parents) {
      if (included.has(parent)) visitCommit(parent);
    }
  };
  for (const oid of included) visitCommit(oid);
  for (const oid of tagOids) {
    const object = lookup(oid);
    if (object === undefined) continue;
    out.add(oid);
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (!isOid(target)) continue;
      const targetObject = lookup(target);
      if (targetObject?.type === 'commit' && included.has(target)) visitCommit(target);
      else if (targetObject?.type === 'tree') visitTree(target);
      else if (targetObject !== undefined) out.add(target);
    }
  }
  return out;
}

/**
 * Plan a fetch: which objects to send for `wants`, given what the client holds
 * (`haves`), its current shallow boundary, and an optional depth limit.
 *
 * Generations count from the wants (want = generation 1). A commit at the depth
 * limit becomes a new shallow boundary; a commit the client held shallow that is
 * now sent with its parent becomes unshallow. A have that is not a want is never
 * sent, and its ancestors are never traversed.
 */
export function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | null,
): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const haveSet = new Set(haves.filter(isOid));
  const wantSet = new Set(wants.filter(isOid));
  const prevShallow = new Set(shallowBoundaries.filter(isOid));

  // The acks: haves that are ancestors of a want (reachable from a want).
  const reachableFromWants = collectReachable(lookup, [...wantSet]);
  const acks = [...haveSet].filter((oid) => reachableFromWants.has(oid));

  // BFS over commits from the wants, tracking generations.
  const included = new Set<string>();
  const shallow = new Set<string>();
  const queue: Array<{ oid: string; gen: number }> = [];
  const seenGen = new Map<string, number>();
  for (const oid of wantSet) {
    const object = lookup(oid);
    if (object === undefined) continue;
    queue.push({ oid, gen: 1 });
  }
  // Tag wants: include the tag and traverse into its target as a want.
  for (const oid of [...wantSet]) {
    const object = lookup(oid);
    if (object?.type === 'tag') {
      const target = parseTag(object.data).object;
      if (isOid(target)) {
        included.add(oid);
        if (lookup(target)?.type === 'commit') queue.push({ oid: target, gen: 1 });
      }
    }
  }
  while (queue.length > 0) {
    const { oid, gen } = queue.shift()!;
    if (seenGen.has(oid)) continue;
    seenGen.set(oid, gen);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (haveSet.has(oid) && !prevShallow.has(oid)) continue; // a complete have: a hard stop
    if (!haveSet.has(oid)) {
      included.add(oid);
      if (depth !== null && gen >= depth) {
        shallow.add(oid);
        continue; // at the boundary: do not traverse into parents
      }
    }
    // A shallow have is truncated — its parents are not held — so traversal
    // continues through it; a fresh commit's parents are traversed too.
    for (const parent of parents) {
      if (!seenGen.has(parent)) queue.push({ oid: parent, gen: gen + 1 });
    }
  }

  // A previous shallow boundary is unshallow when the fetch moved past it:
  // either it is now sent itself, or one of its parents is.
  const unshallow = [...prevShallow].filter((oid) => {
    if (shallow.has(oid)) return false;
    if (included.has(oid)) return true;
    const object = lookup(oid);
    if (object?.type !== 'commit') return false;
    return parseCommit(object.data).parents.some((parent) => included.has(parent));
  });

  // The objects: the trees and blobs of the included commits, following parents
  // only while they stay inside the included set — a plain reachable closure
  // would re-expand the whole history past a depth or shallow boundary.
  const tagOids = [...wantSet].filter((oid) => lookup(oid)?.type === 'tag');
  const objectIds = collectFetchClosure(lookup, included, tagOids);
  // Never re-send what the client holds: drop the closure of non-want haves.
  const heldClosure = collectReachable(lookup, [...haveSet].filter((oid) => !wantSet.has(oid)));
  for (const oid of heldClosure) {
    if (!wantSet.has(oid)) objectIds.delete(oid);
  }
  const objects: GitObject[] = [];
  for (const oid of objectIds) {
    const object = lookup(oid);
    if (object !== undefined) objects.push(object);
  }
  // Deterministic pack order: commits first by generation (parents before children
  // is not required), then trees, then blobs — any order parses the same.
  objects.sort((a, b) => {
    const ao = hashObject(a.type, a.data);
    const bo = hashObject(b.type, b.data);
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });
  return { objects, shallow: [...shallow].sort(), unshallow: unshallow.sort(), acks: acks.sort() };
}

/** Encode a v2 fetch response: acknowledgments, shallow-info, packfile sections. */
export function encodeV2Fetch(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (plan.acks.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  }
  parts.push(pktDelim());
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  const pack = writePack(plan.objects);
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Encode a v0 fetch response: NAK/ACK lines, shallow lines, then the sideband pack. */
export function encodeV0Fetch(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  if (plan.acks.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const pack = writePack(plan.objects);
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- v2 command parsing

export interface V2FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

/** Parse a v2 upload-pack request body into its command and arguments. */
export function parseV2Request(body: Buffer): { command: string; args: string[] } | null {
  const { packets } = decodePktLines(body);
  // The request is: `command=…`, then agent/object-format lines, then a delim,
  // then the arguments, then a flush. Only the lines after the delim are args.
  const lines: string[] = [];
  let delimAt = -1;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      if (delimAt < 0) delimAt = lines.length;
      continue;
    }
    if (packet.kind !== 'data') continue;
    lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  if (lines.length === 0) return null;
  const first = lines[0]!;
  if (!first.startsWith('command=')) return null;
  const command = first.slice('command='.length);
  const args = delimAt >= 0 ? lines.slice(delimAt) : lines.slice(1);
  return { command, args };
}

/** Parse the fetch arguments of a v2 command into a FetchRequest. */
export function parseV2FetchArgs(args: readonly string[]): V2FetchRequest {
  const out: V2FetchRequest = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) out.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) out.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) out.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number(arg.slice(7).trim());
      if (Number.isFinite(n) && n > 0) out.depth = Math.trunc(n);
    } else if (arg === 'done') out.done = true;
  }
  return out;
}

/** Parse a v0 upload-pack request body (want/have/shallow/deepen across two sections). */
export function parseV0FetchRequest(body: Buffer): V2FetchRequest {
  const lines = pktTextLines(body);
  const out: V2FetchRequest = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim();
      const oid = rest.split(' ')[0]!;
      if (isOid(oid)) out.wants.push(oid);
    } else if (line.startsWith('have ')) out.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) out.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isFinite(n) && n > 0) out.depth = Math.trunc(n);
    } else if (line === 'done') out.done = true;
  }
  return out;
}

// ---------------------------------------------------------------- receive-pack

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushReportLine {
  ref: string;
  ok: boolean;
  reason: string;
}

/**
 * Apply a receive-pack: store the pack's objects, then apply each command in
 * order, fast-forward only. Returns one report line per command.
 */
export function applyPush(
  store: Store,
  repo: Repo,
  commands: readonly PushCommand[],
  pack: Buffer | null,
): { unpackOk: boolean; unpackDetail: string; refs: PushReportLine[] } {
  if (pack !== null && pack.length > 0) {
    let objects: Map<string, GitObject>;
    try {
      objects = readPack(pack, (oid) => repo.objects.get(oid));
    } catch (err) {
      return { unpackOk: false, unpackDetail: err instanceof Error ? err.message : 'pack parse failed', refs: [] };
    }
    for (const [oid, object] of objects) {
      if (!repo.objects.has(oid)) {
        repo.objects.set(oid, object);
        repo.objectSeq.set(oid, store.nextSeq());
      }
    }
  }
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const refs: PushReportLine[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        refs.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        refs.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      } else {
        repo.refs.delete(command.ref);
        refs.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        refs.push({ ref: command.ref, ok: false, reason: 'already exists' });
        continue;
      }
      if (lookup(command.newOid) === undefined) {
        refs.push({ ref: command.ref, ok: false, reason: 'object not found' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      refs.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    // Update: the old value must match, and the new tip must descend from it.
    if (current === undefined) {
      refs.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
      continue;
    }
    if (command.oldOid !== current) {
      refs.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      continue;
    }
    const newObject = lookup(command.newOid);
    if (newObject === undefined) {
      refs.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (newObject.type === 'commit' && !isAncestor(lookup, command.oldOid, command.newOid)) {
      refs.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    refs.push({ ref: command.ref, ok: true, reason: '' });
  }
  return { unpackOk: true, unpackDetail: 'ok', refs };
}

/** Encode a report-status reply inside sideband band-1 packets, ending in a flush. */
export function encodePushReport(result: { unpackOk: boolean; unpackDetail: string; refs: PushReportLine[] }): Buffer {
  const lines: Buffer[] = [];
  lines.push(pktLine(`unpack ${result.unpackOk ? 'ok' : result.unpackDetail}\n`));
  for (const ref of result.refs) {
    lines.push(pktLine(ref.ok ? `ok ${ref.ref}\n` : `ng ${ref.ref} ${ref.reason}\n`));
  }
  lines.push(pktFlush());
  const stream = Buffer.concat(lines);
  const parts: Buffer[] = [];
  const CHUNK = PKT_MAX - 4 - 1;
  for (let at = 0; at < stream.length; at += CHUNK) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), stream.subarray(at, Math.min(stream.length, at + CHUNK))])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Parse a receive-pack request body into its commands and the pack that follows. */
export function parseReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } | null {
  const { packets, tail } = decodePktLines(body);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length < 3) return null;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isOid(oldOid) || !isOid(newOid) || !ref.startsWith('refs/')) return null;
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) return null;
  return { commands, pack: tail.length > 0 ? Buffer.from(tail) : null };
}
