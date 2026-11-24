import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { classifyChange } from './content-check.js';
import { blockingIssue } from './diagnostics.js';

const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const coded = (message, code) => Object.assign(new Error(message), { code });
const STORE_LIMIT = 8 * 1024 * 1024;
const sizeOf = values => Buffer.byteLength(JSON.stringify(values));
const attemptFor = (sessionId, path, hash) => digest(JSON.stringify([sessionId || '', path, hash]));

// Apply exact find/replace pairs; each `find` must occur once so the edit is unambiguous.
export function applyEdits(source, edits) {
  if (!Array.isArray(edits) || !edits.length || edits.length > 50) throw new Error('Provide 1–50 edits');
  let result = source;
  for (const edit of edits) {
    if (!edit || typeof edit.find !== 'string' || typeof edit.replace !== 'string' || !edit.find) throw new Error('Each edit needs non-empty find and a replace string');
    const first = result.indexOf(edit.find);
    if (first < 0) throw new Error(`Edit target not found: ${edit.find.slice(0, 80)}`);
    if (result.indexOf(edit.find, first + 1) >= 0) throw new Error(`Edit target is ambiguous; include more surrounding text: ${edit.find.slice(0, 80)}`);
    result = result.slice(0, first) + edit.replace + result.slice(first + edit.find.length);
  }
  return result;
}

export class ProposalStore {
  constructor(domain) { this.domain = domain; this.tail = Promise.resolve(); }
  async location(projectId) {
    const root = await this.domain.projectRoot(projectId);
    const dir = path.join(root, '.folio');
    const stat = await fs.lstat(dir).catch(() => null);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('Invalid proposal storage');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'proposals.json');
    const fileStat = await fs.lstat(file).catch(() => null);
    if (fileStat?.isSymbolicLink() || (fileStat && fileStat.size > STORE_LIMIT)) throw new Error('Invalid proposal data');
    return file;
  }
  async read(projectId) {
    const file = await this.location(projectId);
    const values = await fs.readFile(file, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    if (!Array.isArray(values)) throw new Error('Invalid proposal list');
    return values;
  }
  async pending(projectId) { return (await this.read(projectId)).filter(item => item.status === 'pending'); }
  async save(projectId, values) {
    const file = await this.location(projectId), tmp = `${file}.${crypto.randomUUID()}.tmp`;
    const encoded = JSON.stringify(values);
    if (Buffer.byteLength(encoded) > STORE_LIMIT) throw new Error('Proposal storage limit reached; review or discard large proposals');
    try {
      await fs.writeFile(tmp, encoded, { mode: 0o600, flag: 'wx' });
      await fs.rename(tmp, file);
    } finally { await fs.rm(tmp, { force: true }); }
  }
  serialized(callback) { const result = this.tail.then(callback); this.tail = result.catch(() => {}); return result; }
  renameFile(projectId, from, to) {
    return this.serialized(async () => {
      const values = await this.recover(projectId);
      const affected = values.filter(item => item.path === from);
      const onRenamed = affected.length ? async () => {
        if (!/\.tex$/i.test(to) && affected.some(item => item.status === 'pending')) {
          throw coded('Resolve the pending proposal before changing the source extension', 'PENDING_PROPOSAL_EXTENSION');
        }
        for (const item of affected) {
          item.path = to;
          if (item.attemptKey && item.expectedHash) item.attemptKey = attemptFor(item.sessionId, to, item.expectedHash);
        }
        await this.save(projectId, values);
      } : undefined;
      return this.domain.dispatch('renameFile', { projectId, from, to, onRenamed });
    });
  }
  async review(projectId) {
    return this.serialized(async () => {
      const values = await this.recover(projectId);
      return {
        proposals: values.filter(item => item.status === 'pending'),
        history: values.filter(item => !['pending', 'applying'].includes(item.status)).slice(-10).reverse()
          .map(({ id, path, summary, risk, status, expectedHash, contentHash, approvedAt, finishedAt, validation }) => ({
            id, path, summary, risk, status, expectedHash, contentHash, approvedAt, finishedAt, validation
          }))
      };
    });
  }
  async recover(projectId) {
    const values = await this.read(projectId);
    const interrupted = values.filter(item => item.status === 'applying' || item.status === 'undoing');
    for (const item of interrupted) {
      const { hash } = await this.domain.dispatch('readFile', { projectId, path: item.path }).catch(error => {
        if (error.code === 'NOT_FOUND') return { hash: null };
        throw error;
      });
      const undo = item.status === 'undoing';
      item.status = hash === item.contentHash ? 'applied'
        : hash === item.expectedHash ? (undo ? 'undone' : 'pending') : 'interrupted';
      if (!undo && item.status === 'applied') item.previewError = 'Validation passed, but preview publication may have been interrupted';
    }
    if (interrupted.length) await this.save(projectId, values);
    return values;
  }
  async lastFailure(projectId, sessionId, path) {
    const { hash } = await this.domain.dispatch('readFile', { projectId, path });
    const values = await this.read(projectId);
    const attemptKey = attemptFor(sessionId, path, hash);
    return values.findLast(item => item.attemptKey === attemptKey && item.status === 'validation_failed');
  }
  propose(projectId, filePath, { edits, expectedHash, summary, scope, sessionId, evidenceId } = {}) {
    return this.serialized(async () => {
      if (!/\.tex$/i.test(filePath)) throw new Error('Only existing .tex sources can receive a formatting proposal');
      const current = await this.domain.dispatch('readFile', { projectId, path: filePath });
      if (expectedHash !== current.hash) throw new Error('File changed or missing source hash; read the authorized source again');
      if (scope && scope.hash !== current.hash) throw new Error('Selection changed; ask the author to authorize it again');
      if (!Array.isArray(edits) || edits.length > 8 || edits.some(edit =>
        (edit?.find?.length || 0) > 4000 || (edit?.replace?.length || 0) > 4000)) throw new Error('Provide at most eight localized edits, each no longer than 4000 characters');
      const reason = typeof summary === 'string' ? summary.trim().slice(0, 300) : '';
      if (!reason) throw new Error('Explain the formatting change before proposing it');
      const start = scope ? scope.start : 0;
      const end = scope ? scope.end : current.content.length;
      const next = current.content.slice(0, start) + applyEdits(current.content.slice(start, end), edits) + current.content.slice(end);
      if (Buffer.byteLength(next) > 2 * 1024 * 1024 || next === current.content) throw new Error('Proposal is unchanged or exceeds the text limit');
      const risk = classifyChange(current.content, next);
      const values = await this.recover(projectId);
      const attemptKey = attemptFor(sessionId, filePath, expectedHash);
      const attempts = values.filter(item => item.attemptKey === attemptKey);
      const attempt = Math.max(0, ...attempts.map(item => item.attempt || 0)) + 1;
      const failures = attempts.filter(item => item.status === 'validation_failed');
      const last = failures.at(-1);
      if (attempt > 3 || (last && failures.slice(0, -1).some(item => item.failureSignature === last.failureSignature))) {
        throw new Error('Repair stopped: three proposals or repeated validation failure. The author must inspect the diagnostics.');
      }
      const nextHash = digest(next);
      if (attempts.some(item => item.contentHash === nextHash)) throw new Error('The same patch was already suggested');
      if (last && (last.id !== evidenceId || last.summary === reason)) throw new Error('Read lastBuild and cite its current evidenceId with a new repair reason');
      for (const item of values) if (item.status === 'pending' && item.path === filePath) item.status = 'superseded';
      if (values.filter(item => item.status === 'pending').length >= 8) throw new Error('Review existing proposals first');
      const proposal = {
        id: crypto.randomUUID(), path: filePath, original: current.content, content: next, expectedHash, contentHash: nextHash,
        summary: reason, risk, sessionId, evidenceId, attemptKey, attempt, status: 'pending', createdAt: new Date().toISOString()
      };
      const history = values.filter(item => item.status !== 'pending');
      // Keep repair counters independently of the recent large source snapshots.
      const older = history.slice(0, -10).filter(item => item.attemptKey).slice(-100).map(archive);
      const retained = [...older, ...history.slice(-10), ...values.filter(item => item.status === 'pending'), proposal];
      for (let index = older.length; index < older.length + Math.min(history.length, 10) && sizeOf(retained) > STORE_LIMIT * 0.82; index++) {
        retained[index] = archive(retained[index]);
      }
      if (sizeOf(retained) > STORE_LIMIT * 0.82) throw new Error('Review other proposals to free space for the validation log');
      await this.save(projectId, retained);
      return { ok: true, id: proposal.id, path: filePath, status: 'pending', risk, attempt };
    });
  }
  settle(projectId, id, apply, allowRisky = false) {
    return this.serialized(async () => {
      const values = await this.recover(projectId);
      const proposal = values.find(item => item.id === id && item.status === 'pending');
      if (!proposal) throw new Error('Pending proposal not found');
      const finish = async status => {
        proposal.status = status;
        proposal.finishedAt = new Date().toISOString();
        await this.save(projectId, values);
        return { ok: status === 'applied' || status === 'rejected', path: proposal.path, status, validation: proposal.validation, previewError: proposal.previewError };
      };
      if (!apply) return finish('rejected');
      const current = await this.domain.dispatch('readFile', { projectId, path: proposal.path });
      if (current.hash !== proposal.expectedHash) throw coded('File changed since it was read', 'CONFLICT');
      const risk = classifyChange(current.content, proposal.content);
      if (risk !== proposal.risk) {
        throw coded('The proposal risk changed; review a new proposal', 'PROTECTED_CONTENT');
      }
      if (risk !== 'formatting' && allowRisky !== true) {
        throw coded('The author must explicitly authorize writing this proposal', 'PROTECTED_CONTENT');
      }
      proposal.status = 'applying';
      proposal.approvedAt = new Date().toISOString();
      // Persist the before/after hashes and snapshot before any commit to disk.
      await this.save(projectId, values);
      let result;
      try {
        result = await this.domain.dispatch('verifyProposal', {
          projectId, path: proposal.path, content: proposal.content, expectedHash: proposal.expectedHash
        });
      } catch (error) {
        await this.recover(projectId);
        throw error;
      }
      proposal.validation = result.build;
      proposal.previewError = result.previewError;
      if (result.status === 'validation_failed') {
        proposal.failureSignature = digest(JSON.stringify(result.build.problems.filter(blockingIssue).slice(0, 5)
          .map(item => [item.code, item.file, item.code === 'TEX_ERROR' ? item.message : ''])));
      }
      return finish(result.status);
    });
  }
  undo(projectId, id) {
    return this.serialized(async () => {
      const values = await this.recover(projectId);
      const proposal = values.find(item => item.id === id && item.status === 'applied' && typeof item.original === 'string' && item.contentHash);
      if (!proposal) throw new Error('No restorable snapshot');
      const file = await this.domain.dispatch('readFile', { projectId, path: proposal.path });
      if (file.hash !== proposal.contentHash) throw coded('File changed after this proposal was applied', 'CONFLICT');
      proposal.status = 'undoing';
      await this.save(projectId, values);
      try {
        await this.domain.dispatch('writeFile', { projectId, path: proposal.path, content: proposal.original, expectedHash: proposal.contentHash });
      } catch (error) {
        await this.recover(projectId);
        throw error;
      }
      proposal.status = 'undone';
      proposal.finishedAt = new Date().toISOString();
      await this.save(projectId, values);
      return { status: 'undone', path: proposal.path };
    });
  }
}

function archive({ id, path, status, attemptKey, attempt, sessionId, expectedHash, contentHash, failureSignature, summary, validation }) {
  const build = status === 'validation_failed' && validation
    ? { ok: false, cancelled: validation.cancelled, builtAt: validation.builtAt, problems: validation.problems.slice(0, 10).map(({ code, file, line, level }) => ({ code, file, line, level, message: code })) }
    : undefined;
  return { id, path, status: status === 'applied' ? 'history' : status, attemptKey, attempt, sessionId, expectedHash, contentHash, failureSignature, summary, validation: build };
}

