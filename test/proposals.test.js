import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FolioDomain } from '../domain.js';
import { ProposalStore, applyEdits } from '../proposals.js';
import { classifyChange } from '../content-check.js';

const hasTeX = spawnSync('pdflatex', ['--version']).status === 0;
const text = 'Study result $x=2$.';
const body = '\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n\\input{chapters/results}\n\\end{document}\n';

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-proposals-'));
  const domain = new FolioDomain({ root }), store = new ProposalStore(domain);
  const project = await domain.dispatch('createProject', { name: 'Research', template: 'blank' });
  const dispatch = (action, args) => domain.dispatch(action, { projectId: project.id, ...args });
  const read = (path = 'chapters/results.tex') => dispatch('readFile', { path });
  const write = (path, content, expectedHash) => dispatch('writeFile', { path, content, expectedHash });
  await write('main.tex', body, (await read('main.tex')).hash);
  await write('chapters/results.tex', text + '\n', null);
  return { root, domain, store, project, read, write, dispatch };
}

test('a reviewed patch builds a multi-file manuscript and has a hash-guarded undo', { skip: !hasTeX }, async () => {
  const { root, domain, store, project, read, write, dispatch } = await setup();
  try {
    const before = await read();
    const patch = (source, find, replace) => store.propose(project.id, source.path, { edits: [{ find, replace }], expectedHash: source.hash, summary: 'Emphasize text' });
    await assert.rejects(store.propose(project.id, before.path, { content: 'unversioned paper' }), /source hash/);
    const proposal = await patch(before, 'Study result', '\\textbf{Study result}');
    assert.equal((await read()).content, before.content, 'proposing never writes');
    const manual = 'A ' + before.content;
    await write(before.path, manual, before.hash);
    await assert.rejects(store.settle(project.id, proposal.id, true), e => e.code === 'CONFLICT');
    assert.equal((await read()).content, manual);
    await store.settle(project.id, proposal.id, false);
    const next = await patch(await read(), 'Study result', '\\textbf{Study result}');
    const result = await store.settle(project.id, next.id, true);
    assert.equal(result.status, 'applied', result.validation?.log);
    assert.equal((await read()).content, manual.replace('Study result', '\\textbf{Study result}'));
    assert.equal((await read('main.tex')).content, body);
    assert.equal((await store.review(project.id)).history[0].id, next.id);
    const published = (await dispatch('lastBuild')).build;
    assert.equal((await dispatch('checkCompile')).ok, true);
    assert.deepEqual((await dispatch('lastBuild')).build, published, 'diagnostic-only compile never publishes');
    assert.match((await domain.readPdf(project.id)).subarray(0, 4).toString(), /%PDF/);
    const undo = await store.undo(project.id, next.id);
    assert.equal(undo.status, 'undone');
    assert.equal((await read()).content, manual);
    const another = await patch(await read(), 'Study result', '\\textit{Study result}');
    assert.equal((await store.settle(project.id, another.id, true)).status, 'applied');
    await write(before.path, manual + 'Manual edit.', (await read()).hash);
    await assert.rejects(store.undo(project.id, another.id), e => e.code === 'CONFLICT');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a pending proposal can be applied and undone after its source is renamed', { skip: !hasTeX }, async () => {
  const { root, store, project, read, dispatch, write } = await setup();
  try {
    const file = await read();
    const draft = await store.propose(project.id, file.path, { expectedHash: file.hash, summary: 'Emphasize the result',
      edits: [{ find: 'Study result', replace: '\\textbf{Study result}' }] });
    await assert.rejects(store.renameFile(project.id, file.path, 'chapters/results.txt'), e => e.code === 'PENDING_PROPOSAL_EXTENSION');
    assert.equal((await read()).hash, file.hash);
    assert.equal((await store.pending(project.id))[0].path, file.path);

    const to = 'chapters/renamed.tex';
    await store.renameFile(project.id, file.path, to);
    const main = await read('main.tex');
    await write(main.path, main.content.replace('chapters/results', 'chapters/renamed'), main.hash);
    const applied = await store.settle(project.id, draft.id, true);
    assert.equal(applied.status, 'applied', applied.validation?.log);
    assert.equal(applied.path, to);
    assert.equal((await read(to)).content, file.content.replace('Study result', '\\textbf{Study result}'));
    assert.ok((await dispatch('lastBuild')).build?.ok);
    assert.equal((await store.undo(project.id, draft.id)).status, 'undone');
    assert.equal((await read(to)).hash, file.hash);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('find/replace edits apply exactly once and newer proposals supersede older ones for the same file', async () => {
  const { root, store, project, read } = await setup();
  try {
    const current = await read();
    const patch = (find, replace) => store.propose(project.id, current.path, { edits: [{ find, replace }], expectedHash: current.hash, summary: 'Format results' });
    await assert.rejects(patch('missing', 'x'), /not found/);
    await assert.rejects(patch('t', 'x'), /ambiguous/);
    const first = await patch('Study result', '\\textbf{Study result}');
    const second = await patch('$x=2$', '$x=3$');
    const pending = await store.pending(project.id);
    assert.deepEqual(pending.map(item => item.id), [second.id]);
    assert.notEqual(first.id, second.id);
    assert.equal(pending[0].risk, 'protected');
    await assert.rejects(store.settle(project.id, second.id, true), e => e.code === 'PROTECTED_CONTENT');
    await assert.rejects(store.propose(project.id, 'sections/new.tex', { content: '\\section{New}' }), e => e.code === 'NOT_FOUND');
    assert.equal(applyEdits('a b c', [{ find: 'b', replace: 'B' }, { find: 'c', replace: 'C' }]), 'a B C');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('failed validation preserves source and PDF and bounds evidence-based retries', { skip: !hasTeX }, async () => {
  const { root, domain, store, project, read, write, dispatch } = await setup();
  try {
    assert.equal((await dispatch('compile')).ok, true);
    const pdf = await domain.readPdf(project.id);
    const main = await read('main.tex');
    await write(main.path, main.content + 'Ignored text.\n', main.hash);
    const source = await read();
    const patch = (name, evidenceId) => store.propose(project.id, source.path, {
      edits: [{ find: 'Study result', replace: '\\' + name + '{Study result}' }],
      expectedHash: source.hash, summary: 'Test ' + name, evidenceId, sessionId: 'thesis-session'
    });
    const first = await patch('textbf');
    const failed = await store.settle(project.id, first.id, true);
    assert.equal(failed.status, 'validation_failed');
    assert.ok(failed.validation.log.includes('pdfTeX'));
    assert.ok(failed.validation.problems.some(item => item.code === 'IGNORED_TAIL' && item.file === 'main.tex' && item.line === 6));
    assert.equal((await read()).content, source.content);
    assert.deepEqual(await domain.readPdf(project.id), pdf);
    assert.equal((await store.lastFailure(project.id, 'thesis-session', source.path)).id, first.id);
    await assert.rejects(patch('textit'), /evidenceId/);
    const retry = await patch('textit', first.id);
    assert.equal((await store.settle(project.id, retry.id, true)).status, 'validation_failed');
    await assert.rejects(patch('texttt', retry.id), /repeated validation failure/);
    assert.deepEqual(await domain.readPdf(project.id), pdf);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('the author can authorize saved protected and uncertain proposals, with validation and undo', { skip: !hasTeX }, async () => {
  const { root, domain, store, project, read } = await setup();
  try {
    const source = await read();
    const proposal = await store.propose(project.id, source.path, {
      expectedHash: source.hash, summary: 'Update the reported value',
      edits: [{ find: '$x=2$', replace: '$x=3$' }]
    });
    assert.equal(proposal.risk, 'protected');
    const reopened = new ProposalStore(domain);
    await assert.rejects(reopened.settle(project.id, proposal.id, true, 'true'), e => e.code === 'PROTECTED_CONTENT');
    assert.equal((await reopened.review(project.id)).proposals[0].id, proposal.id);
    assert.equal((await read()).hash, source.hash);

    const applied = await reopened.settle(project.id, proposal.id, true, true);
    assert.equal(applied.status, 'applied', applied.validation?.log);
    assert.equal((await read()).content, source.content.replace('$x=2$', '$x=3$'));
    assert.equal((await reopened.review(project.id)).history[0].status, 'applied');
    assert.equal((await reopened.undo(project.id, proposal.id)).status, 'undone');
    assert.equal((await read()).hash, source.hash);

    const main = await read('main.tex');
    const firstLine = main.content.split('\n')[0];
    const commented = firstLine + '\n% 补丁流程测试标记，验证后可删除';
    const uncertain = await store.propose(project.id, main.path, {
      expectedHash: main.hash, summary: 'Insert a comment after the first line',
      edits: [{ find: firstLine, replace: commented }]
    });
    assert.equal(uncertain.risk, 'uncertain');
    await assert.rejects(reopened.settle(project.id, uncertain.id, true), e => e.code === 'PROTECTED_CONTENT');
    assert.equal((await reopened.review(project.id)).proposals[0].id, uncertain.id);
    const result = await reopened.settle(project.id, uncertain.id, true, true);
    assert.equal(result.status, 'applied', result.validation?.log);
    assert.equal((await read('main.tex')).content, main.content.replace(firstLine, commented));
    assert.equal((await reopened.undo(project.id, uncertain.id)).status, 'undone');
    assert.equal((await read('main.tex')).hash, main.hash);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('real TeX diagnostics cover structural and dependency failures', { skip: !hasTeX }, async () => {
  const { root, read, write, dispatch, store, project } = await setup();
  try {
    const cases = [
      ['\\textbf{Study result', 'UNBALANCED_GROUP'],
      ['\\begin{center}Study result\\end{flushleft}', 'ENVIRONMENT'],
      ['See \\ref{missing}.', 'UNDEFINED_REFERENCE'],
      ['See \\cite{missing}.', 'UNDEFINED_CITATION'],
      ['\\includegraphics{never-exists.png}', 'MISSING_RESOURCE'],
      ['\\input{never-exists}', 'MISSING_SOURCE']
    ];
    for (const [content, code] of cases) {
      const current = await read();
      await write(current.path, content + '\n', current.hash);
      const result = await dispatch('checkCompile');
      assert.ok(result.problems.some(item => item.code === code), code + '\n' + JSON.stringify(result.problems));
    }
    const current = await read();
    const broken = await write(current.path, '\\textbf{Study result\n', current.hash);
    const repair = await store.propose(project.id, current.path, {
      expectedHash: broken.hash, summary: 'Close the bold command', edits: [{ find: 'Study result', replace: 'Study result}' }]
    });
    assert.equal(repair.risk, 'formatting');
    assert.equal((await store.settle(project.id, repair.id, true)).status, 'applied');
    const controller = new AbortController();
    controller.abort();
    assert.equal((await dispatch('checkCompile', { signal: controller.signal })).cancelled, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('content guard rejects changes to prose, table values, grouping and citation keys', () => {
  for (const [before, after] of [
    ['Data & 2', 'Data & 3'],
    ['\\custom{A}B', '\\custom{AB}'],
    ['See \\cite{source}', 'See \\cite{other}'],
    ['\\caption{Result 1}', '\\caption{Result 2}'],
    ['\\input{chapters/a}', '\\input{chapters/b}'],
    ['x \\[y=2\\]', 'x \\[y=3\\]'],
    ['A\n\nB', 'A B']
  ]) assert.equal(classifyChange(before, after), 'protected', before);
  assert.equal(classifyChange('\\newcommand{\\x}{X}Text', '\\newcommand{\\x}{X}\\textbf{Text}'), 'uncertain');
  assert.equal(classifyChange('\\hline\nData & 2', '\\toprule\nData & 2'), 'formatting');
  assert.equal(classifyChange('\\includegraphics[width=5cm]{chart}', '\\includegraphics[width=0.8\\linewidth]{chart}'), 'formatting');
});

test('oversized proposal stores leave the previous store readable', async () => {
  const { root, store, project } = await setup();
  try {
    await store.save(project.id, []);
    await assert.rejects(store.save(project.id, [{ content: 'x'.repeat(8 * 1024 * 1024) }]), /storage limit/);
    assert.deepEqual(await store.read(project.id), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

