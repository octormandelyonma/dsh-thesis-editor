import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTex, analyzeBib, outlineTree, projectOutline, referenceIssues } from '../project-analysis.js';

test('cross-file headings preserve order and nesting and skip commented and literal examples', () => {
  const entries = new Map([
    ['chapters/results.tex', analyzeTex('chapters/results.tex', '\\section{Results}\n\\subsection[Short]{A {nested} heading}\n\\subsubsection{Details}')],
    ['main.tex', analyzeTex('main.tex', '\\begin{document}\n% \\section{Comment}\n\\begin{verbatim}\n\\section{Literal}\n\\end{verbatim}\n\\section{Intro}\n\\include{chapters/results}\n\\end{document}\n\\section{Tail}')]
  ]);
  const [main, results] = projectOutline(entries, 'main.tex');
  assert.deepEqual(main.headings.map(item => item.label), ['Intro']);
  assert.equal(results.path, 'chapters/results.tex');
  const [root] = outlineTree(results.headings);
  assert.equal(root.children[0].label, 'A nested heading');
  assert.equal(root.children[0].children[0].line, 3);
});

test('citation preflight checks cited keys and labels across the main document graph', () => {
  const tex = (path, source) => [path, analyzeTex(path, source)];
  const sources = new Map([
    tex('main.tex', '\\begin{document}\r\n\\input{chapters/body}\r\n\\bibliography{refs,missing-file}\r\n\\label{fig:ok}\r\n\\end{document}'),
    tex('chapters/body.tex', '\\cites[see]{accepted}{unknown}\n\\ref{fig:ok,fig:missing}\n\\label{fig:ok}\n% \\cite{comment}\n\\begin{verbatim}\n\\cite{fake}\n\\end{verbatim}'),
    tex('unused.tex', '\\cite{outside-document}')
  ]);
  const entries = analyzeBib('refs.bib', '@article{accepted,title={Literal @article{fake,}}}\n@book{accepted,title="Another"}\n@comment{ @article{ignored,} }');
  assert.deepEqual(entries.map(item => item.key), ['accepted', 'accepted']);
  const issues = referenceIssues(sources, new Map([['refs.bib', entries]]), 'main.tex');
  assert.deepEqual(issues.map(item => [item.kind, item.key, item.path, item.line]), [
    ['missingBibliography', 'missing-file', 'main.tex', 3],
    ['duplicateCitationKey', 'accepted', 'refs.bib', 1],
    ['duplicateCitationKey', 'accepted', 'refs.bib', 2],
    ['missingCitationKey', 'unknown', 'chapters/body.tex', 1],
    ['duplicateLabelKey', 'fig:ok', 'main.tex', 4],
    ['duplicateLabelKey', 'fig:ok', 'chapters/body.tex', 3],
    ['missingLabelKey', 'fig:missing', 'chapters/body.tex', 2]
  ]);
});
