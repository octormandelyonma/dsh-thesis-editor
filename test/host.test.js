import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, RPC_PATH, PDF_PATH } from '../index.js';

// A minimal Host stand-in: captures the fetch routes, the tool and the pre-step waterfall listener.
function fixture(root) {
  const routes = new Map(), disposers = [];
  let tool, activation, preStep;
  const ctx = {
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } },
    tools: { register(value, options) { tool = value; activation = options.when; } },
    on(name, listener) { if (name === 'agent/pre-step') preStep = listener; },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); }
  };
  apply(ctx, { projectRoot: root });
  let guard = null, restrictedTo = null;
  const agent = id => ({ id, ctx: { effect: fn => fn(), tools: { restrict({ allow }) { restrictedTo = allow; return () => { restrictedTo = null; }; }, guard(fn) { guard = fn; return () => { guard = null; }; } } } });
  async function rpc(action, args = {}) {
    const response = await routes.get(RPC_PATH).fetch(new Request(`http://host${RPC_PATH}`, { method: 'POST', body: JSON.stringify({ action, args }) }));
    const body = await response.json();
    if (!body.ok) throw Object.assign(new Error(body.error), { code: body.code, status: response.status });
    return body.value;
  }
  const step = async (target, number = 1) => preStep({ agent: target, step: number, signal: new AbortController().signal }, async () => ({ kind: 'continue', messages: [{ role: 'user', marker: 'original' }] }));
  return { routes, rpc, step, agent, active: target => activation({ agent: target }), get tool() { return tool; }, get guard() { return guard; }, get restrictedTo() { return restrictedTo; }, dispose: () => disposers.forEach(fn => fn()) };
}

test('owner routes serve projects, files and the last PDF', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-host-'));
  try {
    const host = fixture(root);
    assert.deepEqual([...host.routes.keys()].sort(), ['/api/dsh-thesis', '/api/dsh-thesis/pdf', '/api/dsh-thesis/raw']);
    const project = await host.rpc('createProject', { name: 'Harness paper', template: 'blank' });
    assert.equal((await host.rpc('listProjects')).projects[0].id, project.id);
    await assert.rejects(host.rpc('readFile', { projectId: project.id, path: '../x' }));
    await assert.rejects(host.rpc('propose_patch', {}), /Unknown Folio operation/);
    const missing = await host.routes.get(PDF_PATH).fetch(new Request(`http://host${PDF_PATH}?projectId=${project.id}`));
    assert.equal(missing.status, 404);
    host.dispose();
    assert.equal(host.routes.size, 0, 'routes are withdrawn with the plugin');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('checking selected source is revision-guarded and reports only selected issues', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-source-check-'));
  try {
    const host = fixture(root);
    const project = await host.rpc('createProject', { name: 'Check paper', template: 'blank' });
    const args = { projectId: project.id, path: 'main.tex' };
    const { hash } = await host.rpc('readFile', args);
    const source = [
      '\\documentclass{article}',
      '\\begin{document}',
      'Outisde the selection.',
      '\\begin{itemize}',
      '\\item A sentnece. 数据釆集。',
      '% Missspelling in a comment',
      '$\\text{varrname}$ \\cite{papaer} \\verb|{ missspelling|',
      '\\end{enumerate}',
      '\\end{document}'
    ].join('\n');
    const saved = await host.rpc('writeFile', { ...args, expectedHash: hash, content: source.replace(/\n/g, '\r\n') });
    const selection = { ...args, from: source.indexOf('\\item'), to: source.indexOf('\\end{document}') };
    await assert.rejects(host.rpc('checkSelection', { ...selection, expectedHash: hash }), e => e.code === 'CONFLICT');
    const { problems } = await host.rpc('checkSelection', { ...selection, expectedHash: saved.hash });
    assert.deepEqual(problems.map(item => item.text), ['sentnece', '数据釆集', '\\end{enumerate}']);
    assert.ok(problems[0].replacements.includes('sentence'));
    assert.deepEqual(problems[1].replacements, ['数据采集']);
    assert.deepEqual(problems[2].replacements, ['\\end{itemize}']);
    for (const issue of problems) assert.equal(source.slice(issue.from, issue.to), issue.text);
    assert.equal((await host.rpc('readFile', args)).hash, saved.hash);
    assert.equal((await host.rpc('lastBuild', args)).build, null);
    host.dispose();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('CRLF editor offsets select the exact raw source and pending proposals follow a rename', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-crlf-'));
  try {
    const host = fixture(root);
    const project = await host.rpc('createProject', { name: 'CRLF paper', template: 'blank' });
    const agent = host.agent('crlf-chat');
    await host.rpc('updateProject', { projectId: project.id, sessionId: agent.id });
    const args = { projectId: project.id, path: 'main.tex' };
    const { hash } = await host.rpc('readFile', args);
    const selected = 'Alpha line.\r\nBeta line.';
    const manuscript = '\\documentclass{article}\r\n\\begin{document}\r\n' + selected + '\r\nPrivate.\r\n\\end{document}\r\n';
    const saved = await host.rpc('writeFile', { ...args, expectedHash: hash, content: manuscript });
    const display = manuscript.replace(/\r\n/g, '\n');
    const start = display.indexOf('Alpha');
    const end = display.indexOf('\nPrivate');
    await host.rpc('focus', { ...args, sessionId: agent.id, hash: saved.hash, range: { start, end }, related: [] });
    const context = (await host.step(agent)).messages.at(-1);
    assert.match(context.content[0].text, /lines 3–4/);
    const call = async params => JSON.parse(await host.tool.execute({ path: args.path, ...params }, { agent }));
    const file = await call({ action: 'readFile' });
    assert.equal(file.content, selected);
    assert.equal(file.hash, saved.hash);
    const draft = await call({ action: 'propose_patch', expectedHash: saved.hash, summary: 'Emphasize two lines',
      edits: [{ find: selected, replace: '\\textbf{' + selected + '}' }] });
    assert.equal(draft.status, 'pending');
    await assert.rejects(host.rpc('renameFile', { projectId: project.id, from: args.path, to: 'bad.txt' }), e => e.code === 'MAIN_FILE_EXTENSION');
    assert.equal((await host.rpc('readFile', args)).hash, saved.hash);
    await host.rpc('renameFile', { projectId: project.id, from: args.path, to: 'new.tex' });
    const [pending] = (await host.rpc('listProposals', { projectId: project.id })).proposals;
    assert.equal(pending.id, draft.id);
    assert.equal(pending.path, 'new.tex');
    assert.equal(pending.content, manuscript.replace(selected, '\\textbf{' + selected + '}'));
    assert.equal((await host.rpc('getProject', args)).mainFile, 'new.tex');
    assert.equal((await call({ action: 'readFile' })).code, 'SCOPE_REQUIRED');
    host.dispose();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('bound writing sessions get hidden workspace context, a restricted toolset and reviewed proposals', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-host-'));
  try {
    const host = fixture(root);
    const project = await host.rpc('createProject', { name: 'Harness paper', template: 'blank' });
    const writing = host.agent('writing-session'), unrelated = host.agent('other-session');
    await host.rpc('updateProject', { projectId: project.id, sessionId: writing.id });
    const params = { projectId: project.id, path: 'main.tex' };
    const before = await host.rpc('readFile', params);
    const selected = 'Study result.';
    const manuscript = '\\documentclass{article}\n\\begin{document}\n' + selected + '\nPrivate paragraph.\n\\end{document}\n';
    await host.rpc('writeFile', { ...params, content: manuscript, expectedHash: before.hash });
    const saved = await host.rpc('readFile', params);
    await host.rpc('writeFile', { projectId: project.id, path: 'refs.bib', content: '% related-source', expectedHash: null });
    await host.rpc('writeFile', { projectId: project.id, path: 'secret.tex', content: 'Private content.', expectedHash: null });
    const call = async (args, target = writing) => JSON.parse(await host.tool.execute(args, { agent: target }));
    await host.step(writing);
    assert.equal((await call({ action: 'listFiles' })).code, 'SCOPE_REQUIRED');
    const start = manuscript.indexOf(selected);
    await host.rpc('focus', { ...params, sessionId: writing.id, hash: saved.hash, range: { start, end: start + selected.length }, related: ['refs.bib'] });

    assert.equal(await host.active(unrelated), false, 'ordinary chats do not advertise the Folio tool');
    assert.equal(await host.active(writing), true, 'bound chats activate the Folio tool');

    const plain = await host.step(unrelated);
    assert.equal(plain.messages.length, 1, 'other sessions are untouched');
    assert.deepEqual(host.restrictedTo, ['thesis_project'], 'other sessions do not alter the thesis restriction');

    const decision = await host.step(writing);
    const context = decision.messages.at(-1);
    assert.equal(context.source.kind, 'thesis-context', 'non-user source keeps the context out of the visible chat');
    assert.match(context.content[0].text, /Project: "Harness paper"/);
    assert.match(context.content[0].text, /Current selection: main\.tex, lines 3–3/);
    assert.doesNotMatch(context.content[0].text, /Study result|Private paragraph|secret\.tex/);
    assert.equal((await host.step(writing, 2)).messages.length, 1, 'context is added once per turn');
    assert.deepEqual(host.restrictedTo, ['thesis_project']);
    assert.equal(host.guard({ name: 'thesis_project' }), undefined);
    assert.match(host.guard({ name: 'bash' }), /thesis_project/);

    assert.match((await call({ action: 'readFile', path: 'main.tex' }, unrelated)).error, /not a Folio writing session/);
    const file = await call({ action: 'readFile', path: 'main.tex' });
    assert.equal(file.content, selected);
    assert.deepEqual((await call({ action: 'listFiles' })).files.map(item => item.path), ['main.tex', 'refs.bib']);
    assert.equal((await call({ action: 'readFile', path: 'secret.tex' })).code, 'SCOPE_DENIED');
    assert.equal((await call({ action: 'readFile', path: 'refs.bib' })).content, '% related-source');
    const edit = (find, replace) => ({ action: 'propose_patch', path: 'main.tex', expectedHash: file.hash, edits: [{ find, replace }], summary: 'Emphasize the selected result' });
    assert.match((await call(edit('Private paragraph.', 'Other text.'))).error, /not found/);
    const diagnostic = await call({ action: 'compile', engine: 'outside the project configuration' });
    assert.equal(typeof diagnostic.ok, 'boolean', 'the host ignores unrecognized compile overrides');
    assert.equal(diagnostic.log, undefined, 'raw logs may contain data outside scope');
    assert.match((await call({ action: 'compile' })).error, /One diagnostic compile/);
    const proposal = await call(edit(selected, '\\textbf{' + selected + '}'));
    assert.equal(proposal.status, 'pending');
    assert.equal((await host.rpc('readFile', params)).content, manuscript, 'the model cannot apply');
    await assert.rejects(call({ action: 'writeFile', path: 'main.tex', content: 'x' }), e => e.code === 'INVALID_ARGS', 'the tool schema has no write action');
    const [pending] = (await host.rpc('listProposals', { projectId: project.id })).proposals;
    assert.equal(pending.summary, 'Emphasize the selected result');
    await host.rpc('rejectProposal', { projectId: project.id, id: pending.id });

    const protectedPatch = await call(edit(selected, 'Updated result.'));
    assert.equal(protectedPatch.risk, 'protected');
    await assert.rejects(host.rpc('applyProposal', { projectId: project.id, id: protectedPatch.id }), e => e.code === 'PROTECTED_CONTENT');
    await assert.rejects(call({ action: 'applyProposal', path: 'main.tex' }), e => e.code === 'INVALID_ARGS');
    assert.equal((await host.rpc('rejectProposal', { projectId: project.id, id: protectedPatch.id })).status, 'rejected');

    const diagnosticMessage = 'LaTeX Error: Unicode character 中 (U+4E2D)';
    const problem = { level: 'error', code: 'TEX_ERROR' };
    const stateDir = path.join(root, project.id, '.folio');
    await fs.writeFile(path.join(stateDir, 'build.json'), JSON.stringify({
      ok: false, log: 'Unfiltered compiler log',
      problems: [
        { ...problem, file: 'main.tex', line: 3, message: diagnosticMessage },
        { ...problem, file: 'main.tex', line: 4, message: 'Outside the selected lines' },
        { ...problem, file: 'secret.tex', line: 1, message: 'Outside the authorized files' },
        { ...problem, file: '', line: 0, message: 'Unlocated message' }
      ]
    }));
    const { build } = await call({ action: 'lastBuild' });
    assert.equal(build.log, undefined);
    assert.deepEqual(build.problems, [
      { ...problem, file: 'main.tex', line: 3, message: diagnosticMessage },
      { ...problem, file: '', line: 0 }
    ]);

    await host.rpc('focus', { ...params, sessionId: writing.id, clear: true });
    assert.equal((await call({ action: 'listFiles' })).code, 'SCOPE_REQUIRED');

    await host.rpc('updateProject', { projectId: project.id, sessionId: 'fresh-chat' });
    assert.deepEqual(host.restrictedTo, ['thesis_project'], 'previous thesis chats remain restricted');
    assert.equal(await host.active(writing), true, 'previous thesis chats can still be reopened');
    assert.equal((await call({ action: 'readFile', path: 'main.tex' })).code, 'SCOPE_REQUIRED');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

