import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EditorState } from '@codemirror/state';
import { indentService, indentUnit } from '@codemirror/language';
import { insertNewlineAndIndent } from '@codemirror/commands';
import { figureSource, graphicxPlan, insertionPosition, normalizeFormula, parsePastedTable, planProjectContents, tableSource, templateFragment, validImage, validLabel } from '../format-tools.js';
import { compileProject, latexmkCommand } from '../compiler.js';
import { parseCsv } from '../table-import.js';
import { latexIndentAt, latexIndentChanges } from '../latex-indent.js';
import { latexOutline } from '../latex-outline.js';

test('the table of contents goes after the abstract and stays unique across included sources', async () => {
  const main = [
    '\\documentclass{article}',
    '\\newcommand{\\tocExample}{\\tableofcontents}',
    '\\begin{document}',
    '\\maketitle',
    '% \\tableofcontents',
    '\\input{front/abstract} % Keep this note',
    '\\section{Introduction}',
    'Text.',
    '\\end{document}'
  ].join('\n');
  const files = {
    'main.tex': main,
    'front/abstract.tex': '\\begin{abstract}\nAn abstract.\n\\end{abstract}\n',
    'front/toc.tex': '\\tableofcontents\n'
  };
  const plan = () => planProjectContents('main.tex', Object.keys(files), async path => ({ content: files[path], hash: path }));
  const result = await plan();
  assert.equal(result.path, 'main.tex');
  const updated = main.slice(0, result.at) + result.text + main.slice(result.at);
  assert.match(updated, /\\input\{front\/abstract\} % Keep this note\n\\tableofcontents\n\n\\section\{Introduction\}/);
  files['main.tex'] = updated;
  assert.deepEqual(await plan(), { path: 'main.tex', hash: 'main.tex', at: updated.indexOf('\\tableofcontents\n\n') });

  files['main.tex'] = main.replace('\\section{Introduction}', '\\input{front/toc}\n\\section{Introduction}');
  assert.deepEqual(await plan(), { path: 'front/toc.tex', hash: 'front/toc.tex', at: 0 });
  files['main.tex'] = '% \\begin{document}\n\\documentclass{article}\n';
  assert.equal(await plan(), null);
});

test('the inserted directory compiles before the first section', {
  skip: spawnSync('pdflatex', ['--version'], { stdio: 'ignore' }).status !== 0
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'folio-contents-'));
  try {
    const source = '\\documentclass{article}\n\\begin{document}\\section{Introduction}\nAn example.\n\\end{document}\n';
    const result = await planProjectContents('main.tex', ['main.tex'], async () => ({ content: source, hash: 'saved' }));
    const updated = source.slice(0, result.at) + result.text + source.slice(result.at);
    assert.ok(updated.indexOf('\\tableofcontents') < updated.indexOf('\\section'));
    await writeFile(path.join(root, 'main.tex'), updated);
    const build = await compileProject({ root, mainFile: 'main.tex', engine: 'pdflatex' });
    assert.ok(build.ok, build.log);
    assert.match(build.log, /main\.toc/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the compiled contents includes three heading levels, abstract, references and appendix', {
  skip: ['pdflatex', 'bibtex', 'pdftotext', 'kpsewhich'].some(tool => spawnSync(tool, ['--version'], { stdio: 'ignore' }).error) ||
    spawnSync('kpsewhich', ['tocbibind.sty'], { stdio: 'ignore' }).status !== 0
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'folio-toc-levels-'));
  try {
    const source = [
      '\\documentclass{article}', '\\usepackage{hyperref}', '\\setcounter{tocdepth}{1}',
      '\\begin{document}', '\\begin{abstract}', 'Abstract text.', '\\end{abstract}',
      '\\tableofcontents', '\\clearpage', '\\section{Introduction}', '\\subsection{Method}',
      '\\subsubsection{Third Level}', '\\paragraph{Fourth Level Hidden}', 'Reference \\cite{one}.',
      '\\bibliographystyle{plain}', '\\bibliography{refs}', '\\appendix', '\\section{Supplementary Data}', '\\end{document}'
    ].join('\n');
    const plan = text => planProjectContents('main.tex', ['main.tex'], async () => ({ content: text, hash: 'source' }), true);
    const { setup } = await plan(source);
    const change = setup.change;
    const body = source.slice(0, change.from) + change.insert + source.slice(change.to);
    assert.equal((await plan(body)).setup, undefined, 'the settings are idempotent');
    await writeFile(path.join(root, 'main.tex'), body);
    await writeFile(path.join(root, 'refs.bib'), '@book{one,title={Example},author={Doe, Jane},publisher={Sample},year={2024}}');
    const build = await compileProject({ root, engine: 'pdflatex', mainFile: 'main.tex' });
    assert.ok(build.ok, build.log);
    const pdfText = spawnSync('pdftotext', ['-f', '1', '-l', '1', '-', '-'], { input: build.pdf, encoding: 'utf8' });
    assert.equal(pdfText.status, 0, pdfText.stderr);
    for (const title of ['Abstract', 'Third Level', 'References', 'Appendix', 'Supplementary Data']) {
      assert.match(pdfText.stdout, new RegExp(title));
    }
    assert.doesNotMatch(pdfText.stdout, /Fourth Level Hidden/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('folds TeX blocks, preamble and sections and supplies Chinese explanations', () => {
  const doc = EditorState.create({ doc: [
    '\\documentclass{article}',
    '\\ctexset{',
    '  section/aftername={.\\quad},',
    '}',
    '\\begin{document}',
    '\\section{First}',
    '\\begin{equation}',
    '  x+y=z',
    '\\end{equation}',
    '% \\begin{mismatch}',
    '\\section{Second}',
    '\\begin{verbatim}',
    '\\section{Literal}',
    '\\end{verbatim}',
    '\\end{document}'
  ].join('\n') }).doc;
  const { folds, hints } = latexOutline(doc);
  const range = line => folds.get(doc.line(line).from);
  const hint = line => hints.get(doc.line(line).from);
  assert.deepEqual(range(1), { from: doc.line(1).to, to: doc.line(4).to });
  assert.deepEqual(range(2), { from: doc.line(2).to, to: doc.line(3).to });
  assert.deepEqual(range(6), { from: doc.line(6).to, to: doc.line(10).to });
  assert.deepEqual(range(7), { from: doc.line(7).to, to: doc.line(8).to });
  assert.deepEqual(range(12), { from: doc.line(12).to, to: doc.line(13).to });
  assert.equal(hint(2), '设置中文排版与章节格式');
  assert.equal(hint(7), '编排独立公式');
  assert.equal(hint(10), undefined);
  assert.equal(hint(13), undefined);
});

test('LaTeX indentation formats selected lines using surrounding context and preserves literal contents', () => {
  const source = [
    '\\ctexset{',
    'section/format=\\Large\\bfseries\\raggedright,',
    'section/aftername={.\\quad},',
    'subsection/aftername={.\\quad},',
    '}',
    '\\begin{document}',
    '\\begin{itemize}',
    '\\item \\verb|{| is a brace. % }',
    '\\begin{verbatim}',
    '  preserve {',
    '\\end{verbatim}',
    '\\end{itemize}',
    '\\end{document}'
  ].join('\n');
  const state = EditorState.create({ doc: source });
  const selected = state.update({ changes: latexIndentChanges(state.doc, { from: state.doc.line(2).from, to: state.doc.line(5).from }) }).state;
  assert.equal(selected.doc.line(2).text, '  section/format=\\Large\\bfseries\\raggedright,');
  assert.equal(selected.doc.line(3).text, '  section/aftername={.\\quad},');
  assert.equal(selected.doc.line(8).text, state.doc.line(8).text);

  const formatted = selected.update({ changes: latexIndentChanges(selected.doc, { from: 0, to: selected.doc.length }) }).state;
  assert.equal(formatted.doc.line(7).text, '\\begin{itemize}');
  assert.equal(formatted.doc.line(8).text, '  \\item \\verb|{| is a brace. % }');
  assert.equal(formatted.doc.line(9).text, '  \\begin{verbatim}');
  assert.equal(formatted.doc.line(10).text, '  preserve {');
  assert.equal(formatted.doc.line(11).text, '\\end{verbatim}');
  assert.equal(formatted.doc.line(12).text, '\\end{itemize}');
  assert.deepEqual(latexIndentChanges(formatted.doc, { from: 0, to: formatted.doc.length }), []);
});

test('Enter indents a LaTeX argument and dedents before its closing brace', () => {
  const extensions = [indentUnit.of('  '), indentService.of(latexIndentAt)];
  const source = '\\ctexset{';
  let state = EditorState.create({ doc: source, selection: { anchor: source.length }, extensions });
  assert.ok(insertNewlineAndIndent({ state, dispatch: transaction => { state = transaction.state; } }));
  assert.equal(state.doc.toString(), source + '\n  ');

  const withClosingBrace = source + '\n  option=value,}';
  state = EditorState.create({ doc: withClosingBrace, selection: { anchor: withClosingBrace.length - 1 }, extensions });
  assert.ok(insertNewlineAndIndent({ state, dispatch: transaction => { state = transaction.state; } }));
  assert.equal(state.doc.toString(), source + '\n  option=value,\n}');
});

const main = [
  '\\documentclass{article}',
  '% \\begin{document}',
  '\\author{Your name}',
  '\\begin{document}',
  'The results are $x + 2$.',
  '% a body comment',
  '\\section{A heading}',
  '\\begin{verbatim}',
  '\\end{document} is just text here.',
  '\\end{verbatim}',
  '\\begin{figure} Existing float. \\end{figure}',
  'A normal paragraph.',
  '\\end{document}',
  'Ignored note.'
].join('\n');

test('insertion guard protects actual document boundaries, comments, groups and math', () => {
  const cursor = (text, offset = 2) => {
    const from = main.indexOf(text) + offset;
    return { from, to: from };
  };
  const check = (text, action = 'equation') => insertionPosition(main, cursor(text), { main: true, action });
  assert.equal(check('Your name').reason, 'insertPreamble');
  assert.equal(check('Ignored note.').reason, 'insertAfterBody');
  assert.equal(check('a body comment').reason, 'insertComment');
  assert.equal(check('A heading').reason, 'insertGroup');
  assert.equal(check('x + 2').reason, 'insertMath');
  assert.equal(check('just text here').reason, 'insertLiteral');
  assert.equal(check('Existing float', 'figure').reason, 'insertFloat');
  assert.equal(check('A normal paragraph.').reason, undefined);
  for (const text of ['Your name', 'Ignored note.', 'A heading']) {
    const { jump } = check(text);
    assert.equal(insertionPosition(main, { from: jump, to: jump }, { main: true, action: 'equation' }).reason, undefined);
  }
  assert.equal(insertionPosition('Included chapter.', { from: 4, to: 4 }, { main: false, action: 'table' }).reason, undefined);
  assert.equal(insertionPosition('Incomplete main file.', { from: 4, to: 4 }, { main: true, action: 'table' }).reason, 'insertNoBody');
  const pair = '\\verb|example with space| and $x$.';
  assert.equal(insertionPosition(pair, { from: 14, to: 14 }, { main: false, action: 'bold' }).reason, 'insertLiteral');
});

test('sheet paste preserves empty cells and produces a rectangular grid', () => {
  assert.deepEqual(parsePastedTable('Variable\tUnit\t\r\nSpeed\tm/s\r\n'), [['Variable', 'Unit', ''], ['Speed', 'm/s', '']]);
  assert.equal(parsePastedTable('only one row'), null);
  assert.equal(parsePastedTable('a\t'.repeat(12) + '\nvalue'), null);
  assert.equal(validImage('images/chart 01.png'), true);
  assert.equal(validImage('images/chart%01.png'), false);
  assert.equal(validLabel('tab:sample-1'), true);
  assert.equal(validLabel('tab:bad label'), false);
});

test('graphicx planning uses the active preamble and honors grouped imports', () => {
  assert.deepEqual(graphicxPlan(main), { loaded: false, at: main.indexOf('\\begin{document}', main.indexOf('\\author')) });
  assert.deepEqual(graphicxPlan('\\usepackage [demo] {xcolor, graphicx}\n\\begin{document}'), { loaded: true, at: null });
  const commented = '% \\usepackage{graphicx}\n\\begin{document}';
  assert.deepEqual(graphicxPlan(commented), { loaded: false, at: commented.indexOf('\\begin{document}') });
});

const pdflatex = spawnSync('pdflatex', ['--version']).status === 0;
test('formula source strips wrappers and refuses file commands or nested document roots', () => {
  assert.equal(normalizeFormula('\\[x_1+\\frac{1}{2}\\]'), 'x_1+\\frac{1}{2}');
  assert.equal(normalizeFormula('\\begin{equation} a_1^2 \\end{equation}'), 'a_1^2');
  assert.equal(normalizeFormula('\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}'), '\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}');
  for (const source of ['\\input{x}', '\\begin{document}X\\end{document}', '\\gdef\\foo{Y}', 'a\n\nb']) {
    assert.equal(normalizeFormula(source), '');
  }
});

test('CSV import keeps quotes and leading zeroes, while templates only add absent sections and packages', () => {
  assert.deepEqual(parseCsv('\uFEFFCategory,Value\r\n"A,B","001"\r\n"Quote ""here""","12"\r\n'), [
    ['Category', 'Value'], ['A,B', '001'], ['Quote "here"', '12']
  ]);
  assert.throws(() => parseCsv('Name,Value\n"unclosed,abc'), /TABLE_FORMAT/);
  const source = '\\documentclass{article}\n\\usepackage{graphicx,amsmath}\n\\begin{document}\n\\section{Introduction}\n\\end{document}';
  const preamble = templateFragment(source, 'preamble', 'en', true);
  assert.equal(preamble.text, '\\usepackage{booktabs}');
  assert.equal(preamble.at, source.indexOf('\\begin{document}'));
  assert.equal(templateFragment(source, 'preamble', 'en', false), null);
  assert.doesNotMatch(templateFragment(source, 'sections', 'en', true).text, /Introduction|documentclass/);
  assert.equal(templateFragment('\\begin{abstract}Existing\\end{abstract}', 'abstract', 'en'), null);
});

const latexmk = spawnSync('latexmk', ['-v']).status === 0;
test('latexmk uses a constrained command and unchanged automatic builds reuse the PDF', { skip: !pdflatex || !latexmk }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-latexmk-test-'));
  try {
    const recipe = latexmkCommand('xelatex', 'main.tex');
    assert.ok(['-norc', '-pdfxe', '-no-shell-escape'].every(flag => recipe.args.includes(flag)));
    assert.equal(latexmkCommand('pdflatex', 'file&other.tex'), null);
    const opts = { root, preferLatexmk: true };
    const prefix = '\\documentclass{article}\n\\begin{document}\n';
    await writeFile(path.join(root, 'main.tex'), prefix + 'First build.\\end{document}');
    const first = await compileProject(opts);
    assert.equal(first.ok, true, first.log);
    assert.equal(first.runner, 'latexmk');
    const cached = await compileProject({ ...opts, cache: true });
    assert.equal(cached.reused, true);
    assert.equal(cached.pdfVersion, first.pdfVersion);
    await writeFile(path.join(root, 'main.tex'), prefix + 'Updated build.\\end{document}');
    const next = await compileProject({ ...opts, cache: true });
    assert.equal(next.ok, true, next.log);
    assert.equal(next.reused, undefined);
    assert.notEqual(next.pdfVersion, first.pdfVersion);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the generated three-rule table and a figure with spaces in its path compile', { skip: !pdflatex }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-format-test-'));
  try {
    await mkdir(path.join(root, 'images'));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGOQs4o6ceIEA4QCACUwBhVnnw1uAAAAAElFTkSuQmCC', 'base64');
    await writeFile(path.join(root, 'images', 'chart 01.png'), png);
    const table = tableSource({ cells: [['Condition', 'Value'], ['A & B', '25%']], align: ['l', 'r'], caption: 'Results #1', label: 'tab:results' });
    assert.equal([...table.matchAll(/\\hrule/g)].length, 3);
    assert.match(table, /\\begin\{tabular\}\{lr\}/);
    assert.match(table, /A \\& B & 25\\%/);
    const figure = figureSource({ image: 'images/chart 01.png', caption: 'A & B', label: 'fig:chart', width: '53', placement: '!h' });
    assert.match(figure, /width=0\.53\\linewidth/);
    await writeFile(path.join(root, 'main.tex'), '\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n' + table + figure + 'See Table~\\ref{tab:results} and Figure~\\ref{fig:chart}.\n\\end{document}\n');
    const result = await compileProject({ root });
    assert.equal(result.ok, true, result.log);
    assert.equal(result.pdf.subarray(0, 4).toString(), '%PDF');
  } finally { await rm(root, { recursive: true, force: true }); }
});
