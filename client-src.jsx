import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { basicSetup } from 'codemirror';
import { EditorState, EditorSelection, Prec, Compartment } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { StreamLanguage, HighlightStyle, syntaxHighlighting, indentService, indentUnit, getIndentUnit, foldedRanges, unfoldEffect } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { snippetCompletion, startCompletion } from '@codemirror/autocomplete';
import { toggleComment, indentWithTab, isolateHistory } from '@codemirror/commands';
import * as pdfjs from 'pdfjs-dist';
import { diffLines } from 'diff';
import { zipSync } from 'fflate';
import { FormatDialog, insertThesisFormat } from './formatting.jsx';
import { FormulaDialog, TemplateDialog } from './manuscript-tools.jsx';
import { graphicxPlan, insertionPosition, packagePlan, planProjectContents, templateFragment } from './format-tools.js';
import { maskComments } from './content-check.js';
import { latexIndentAt, latexIndentChanges } from './latex-indent.js';
import { latexSourceDecorations } from './source-decorations.js';
import { analyzeTex, outlineTree, projectOutline, readProjectAnalysis, referenceIssues } from './project-analysis.js';
import english from './locale/en.json';
import chinese from './locale/zh.json';
import { readZip, planImport, toBase64, isSkipped } from './import.js';

const NS = 'dsh-thesis-editor';
const PANEL = 'thesis-editor';
const PRESET = 'thesis-writing';
const PROJECT_KEY = 'thesis-project-v1';
const LAYOUT_KEY = 'thesis-layout-v2';
const AUTO_KEY = 'thesis-autocompile-v1';
const EDIT_STATE_KEY = 'thesis-source-v1:';
const ARCHIVED_KEY = 'thesis-archived-chats-v1';
const ENGINES = [['pdflatex', 'pdfLaTeX'], ['xelatex', 'XeLaTeX'], ['lualatex', 'LuaLaTeX'], ['tectonic', 'Tectonic']];
const ENGINE_LABEL = Object.fromEntries(ENGINES);
const TOPBAR = 48;
const FLOAT_MIN = { w: 280, h: 200 };
const CHAT_DOCK_MIN = 232;
const FLOAT_EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const DOCKS = ['workspace', 'right', 'left', 'bottom', 'float'];
const DEFAULT_LAYOUT = { files: 180, chat: 304, split: 0.59, sourceShare: 0.54, show: { files: true, editor: true, pdf: true, chat: true } };

// A stored layout may come from an older or edited build, or be hand-edited, so never trust its
// shape: docks, sizes and the visible panes are all clamped to values the workspace can render.
function normalizeLayout(stored) {
  const saved = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const number = (value, fallback, min, max) => {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
  };
  const dock = DOCKS.includes(saved.dock) ? saved.dock : 'workspace';
  const show = { ...DEFAULT_LAYOUT.show };
  for (const pane of Object.keys(show)) if (typeof saved.show?.[pane] === 'boolean') show[pane] = saved.show[pane];
  // The workspace always needs something to show: source, PDF and the assistant cannot all be off.
  if (!show.editor && !show.pdf && !show.chat) show.editor = true;
  const float = { w: number(saved.float?.w, 420, FLOAT_MIN.w, 10000), h: number(saved.float?.h, 560, FLOAT_MIN.h, 10000) };
  // Only keep a position the user actually chose; otherwise the window places itself as before.
  if (Number.isFinite(Number(saved.float?.x))) float.x = Number(saved.float.x);
  if (Number.isFinite(Number(saved.float?.y))) float.y = Number(saved.float.y);
  return {
    ...DEFAULT_LAYOUT,
    ...saved,
    dock,
    show,
    files: number(saved.files, DEFAULT_LAYOUT.files, 150, 420),
    chat: number(saved.chat, DEFAULT_LAYOUT.chat, FLOAT_MIN.w, 1200),
    chatHeight: number(saved.chatHeight, 320, 140, 2000),
    split: number(saved.split, DEFAULT_LAYOUT.split, 0.2, 0.8),
    sourceShare: number(saved.sourceShare, DEFAULT_LAYOUT.sourceShare, 0.37, 0.72),
    float,
    lastDock: DOCKS.includes(saved.lastDock) ? saved.lastDock : undefined
  };
}

/* ───────────── small utilities ───────────── */

const messageOf = error => error?.message || String(error);
function readStored(key, fallback) { try { const value = localStorage.getItem(key); return value == null ? fallback : JSON.parse(value); } catch { return fallback; } }
function store(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
const endpoint = file => new URL(file, document.baseURI).toString();
// `keepalive` lets a small request finish after the page is closed (browsers cap such bodies at 64 KiB).
async function rpc(action, args = {}, { keepalive = false } = {}) {
  const payload = JSON.stringify({ action, args });
  const response = await fetch(endpoint('api/dsh-thesis'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: keepalive && payload.length < 60000 });
  let body;
  try { body = await response.json(); } catch { throw new Error(`Folio service unavailable (HTTP ${response.status}). Restart DSH after installing the plugin.`); }
  if (!body.ok) throw Object.assign(new Error(body.error || 'Request failed'), { code: body.code });
  return body.value;
}
function unwrap(result) { if (!result?.ok) throw new Error(result?.error?.message || result?.error?.code || 'Harness request failed'); return result.value; }
function relativeTime(iso, locale) {
  const time = Date.parse(iso);
  if (!time) return '';
  const seconds = Math.round((time - Date.now()) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  return format.format(0, 'second');
}
const fileToBase64 = file => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
const isTextPath = file => /\.(tex|bib|sty|cls|bst|bbx|cbx|def|cfg|clo|dtx|ins|txt|md|csv|tsv|dat|json|ya?ml|lua|py|r|m|gp|tikz|pgf)$/i.test(file);

// In-flight session bindings per project, shared across remounts of the workspace.
const bindings = new Map();
// Resolve 'found' once the Session list knows `id`, 'missing' when the loaded list still lacks it
// after a grace period (deleted chat), or 'timeout'.
function waitForSession(sessions, id, timeoutMs = 10000) {
  return new Promise(resolve => {
    const started = Date.now();
    let loadedAt = 0, done = false, unsubscribe = () => {}, timer = 0;
    const finish = value => { if (done) return; done = true; clearInterval(timer); unsubscribe(); resolve(value); };
    const check = () => {
      const snapshot = sessions.list.getSnapshot();
      if (snapshot.byId?.[id]) return finish('found');
      if (snapshot.phase && snapshot.phase !== 'pending' && !loadedAt) loadedAt = Date.now();
      if (loadedAt && Date.now() - loadedAt > 2500) return finish('missing');
      if (Date.now() - started > timeoutMs) finish('timeout');
    };
    timer = setInterval(check, 250);
    try { const stop = sessions.list.subscribe(check); if (typeof stop === 'function') { if (done) stop(); else unsubscribe = stop; } } catch {}
    check();
  });
}

/* ───────────── icons ───────────── */

const ICONS = {
  files: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h9A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z',
  source: 'M8.5 7 4 12l4.5 5M15.5 7 20 12l-4.5 5M13.5 5l-3 14',
  pdf: 'M6 3h9l4 4v14H6zM15 3v4h4M9 12h6M9 15.5h6M9 9h3',
  chat: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z',
  play: 'M8 5.5v13l10.5-6.5z',
  chevron: 'm7 10 5 5 5-5',
  right: 'm10 7 5 5-5 5',
  plus: 'M12 5v14M5 12h14',
  upload: 'M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15',
  download: 'M12 4v12m0 0-4.5-4.5M12 16l4.5-4.5M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15',
  export: 'M12 15V4m0 0L8 8m4-4 4 4M5 13v7h14v-7',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 4v5l3 2',
  more: 'M5.5 12h.01M12 12h.01M18.5 12h.01',
  close: 'M6 6l12 12M18 6 6 18',
  star: 'm12 4 2.4 5 5.4.6-4 3.7 1.1 5.3L12 16l-4.9 2.6 1.1-5.3-4-3.7 5.4-.6z',
  tex: 'M7 4h7l4 4v12H7zM14 4v4h4',
  image: 'M4 5h16v14H4zM4 15.5l4.5-4.5 4 4 2.5-2.5 5 5M15 9.5h.01',
  folder: 'M3.5 7A1.5 1.5 0 0 1 5 5.5h4l1.8 2H19A1.5 1.5 0 0 1 20.5 9v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z',
  spark: 'M12 3.5c.6 3.9 2.2 5.6 6 6.3-3.8.7-5.4 2.4-6 6.2-.6-3.8-2.2-5.5-6-6.2 3.8-.7 5.4-2.4 6-6.3zM18.5 15c.3 1.6.9 2.3 2.5 2.6-1.6.3-2.2 1-2.5 2.5-.3-1.5-.9-2.2-2.5-2.5 1.6-.3 2.2-1 2.5-2.6z',
  alert: 'M12 4 21 19.5H3zM12 10v4.5M12 17h.01',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  back: 'm14 7-5 5 5 5',
  refresh: 'M19 8a7.5 7.5 0 1 0 1 6M19 4v4h-4',
  archive: 'M4 5h16v4H4zM5.5 9v10h13V9M10 13h4',
  'dock-right': 'M4 5h16v14H4zM14 5v14',
  'dock-left': 'M4 5h16v14H4zM10 5v14',
  'dock-bottom': 'M4 5h16v14H4zM4 14h16',
  'dock-float': 'M4 5h16v14H4zM11 11h7v6h-7z',
  import: 'M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M4.5 14v4A1.5 1.5 0 0 0 6 19.5h12a1.5 1.5 0 0 0 1.5-1.5v-4',
  list: 'M9.5 6.5h10M9.5 12h10M9.5 17.5h10M5 6.5h.01M5 12h.01M5 17.5h.01',
  'list-ol': 'M10 6.5h10M10 12h10M10 17.5h10M4 5l1.5-1v4.5M3.8 13.2c.4-.8 2.4-.9 2.4.3 0 .9-2.4 1.6-2.4 3h2.5',
  table: 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14',
  quote: 'M6 7h4v4c0 2.8-1.2 4.6-4 5.5M14 7h4v4c0 2.8-1.2 4.6-4 5.5',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  tag: 'M4 4h7l9 9-7 7-9-9zM8.5 8.5h.01',
  locate: 'M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  'zoom-in': 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.8-4.8M10.5 7.5v6M7.5 10.5h6',
  'zoom-out': 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.8-4.8M7.5 10.5h6',
  'fit-width': 'M4 12h16M7.5 8.5 4 12l3.5 3.5M16.5 8.5 20 12l-3.5 3.5',
  'fit-page': 'M6.5 4h11v16h-11zM9.5 9 12 6.5 14.5 9M9.5 15l2.5 2.5 2.5-2.5',
  minus: 'M5.5 12h13',
  copy: 'M8.5 8.5h10v10h-10zM5.5 15.5v-10h10',
  cut: 'M6.5 8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM6.5 20.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM8.6 7.4 19 18M8.6 16.6 19 6',
  paste: 'M8.5 5H6v15.5h12V5h-2.5M9 3.5h6v3H9z',
  heading: 'M6.5 5v14M17.5 5v14M6.5 12h11',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5.5H4.5V6H10',
  layout: 'M4 5h16v14H4zM9.5 5v14M15 5v14',
  gear: 'M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2.1-1.2L14 3.2h-4l-.5 2.4a7 7 0 0 0-2.1 1.2l-2.3-.9-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2.1 1.2l.5 2.4h4l.5-2.4a7 7 0 0 0 2.1-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z'
};
function Icon({ name, size = 16, fill = false }) {
  return <svg className="fo-icon" width={size} height={size} viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICONS[name]} /></svg>;
}
function FolioMark({ size = 22 }) {
  return <svg className="fo-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="16" fill="var(--fo-accent)" /><path d="M19 13h19l9 9v29H19z" fill="#fff" /><path d="M38 13v9h9z" fill="#fff" opacity=".55" /><path d="M36.5 27c-.9-1.2-2.1-1.7-3.4-1.4-1.9.5-2.6 2.3-3 4.8l-3 15c-.5 2.3-1.5 3.4-3.1 3.4M27.2 32.6h7.6" fill="none" stroke="var(--fo-accent)" strokeWidth="3" strokeLinecap="round" /></svg>;
}


/* ───────────── \ command completion ───────────── */

// [name, snippet body after the command (${} = tab stops), detail]
const COMMANDS = [
  ['section', '{${title}}', 'heading'], ['section*', '{${title}}', 'unnumbered'], ['subsection', '{${title}}', 'heading'], ['subsubsection', '{${title}}', 'heading'], ['paragraph', '{${title}}', 'heading'], ['chapter', '{${title}}', 'heading'], ['part', '{${title}}', 'heading'],
  ['title', '{${}}', 'preamble'], ['author', '{${}}', 'preamble'], ['date', '{${\\today}}', 'preamble'], ['maketitle', '', 'title block'], ['tableofcontents', '', 'contents'], ['appendix', '', ''], ['bibliography', '{${references}}', 'BibTeX file'], ['bibliographystyle', '{${plain}}', 'style'], ['printbibliography', '', 'biblatex'], ['addbibresource', '{${references.bib}}', 'biblatex'],
  ['textbf', '{${}}', 'bold'], ['textit', '{${}}', 'italic'], ['emph', '{${}}', 'emphasis'], ['underline', '{${}}', ''], ['texttt', '{${}}', 'monospace'], ['textsc', '{${}}', 'small caps'], ['textsf', '{${}}', 'sans'], ['textrm', '{${}}', 'roman'], ['textcolor', '{${red}}{${}}', 'xcolor'], ['footnote', '{${}}', ''], ['url', '{${}}', 'hyperref'], ['href', '{${url}}{${text}}', 'hyperref'],
  ['cite', '{${}}', 'citation'], ['citep', '{${}}', 'natbib'], ['citet', '{${}}', 'natbib'], ['parencite', '{${}}', 'biblatex'], ['textcite', '{${}}', 'biblatex'], ['nocite', '{${*}}', ''],
  ['label', '{${}}', ''], ['ref', '{${}}', 'reference'], ['eqref', '{${}}', 'equation ref'], ['cref', '{${}}', 'cleveref'], ['Cref', '{${}}', 'cleveref'], ['autoref', '{${}}', 'hyperref'], ['pageref', '{${}}', ''],
  ['input', '{${}}', 'file'], ['include', '{${}}', 'file'], ['includegraphics', '[width=${\\linewidth}]{${}}', 'graphicx'], ['caption', '{${}}', ''], ['centering', '', ''],
  ['usepackage', '{${}}', 'package'], ['documentclass', '{${article}}', 'class'], ['newcommand', '{\\${name}}[${1}]{${}}', 'macro'], ['renewcommand', '{\\${name}}{${}}', 'macro'], ['DeclareMathOperator', '{\\${name}}{${}}', 'amsmath'],
  ['item', ' ', 'list item'], ['newpage', '', ''], ['clearpage', '', ''], ['noindent', '', ''], ['vspace', '{${1em}}', ''], ['hspace', '{${1em}}', ''], ['linewidth', '', 'length'], ['textwidth', '', 'length'], ['today', '', ''],
  ['hline', '', 'table rule'], ['toprule', '', 'booktabs'], ['midrule', '', 'booktabs'], ['bottomrule', '', 'booktabs'], ['multicolumn', '{${2}}{${c}}{${}}', 'table'],
  ['frac', '{${num}}{${den}}', 'math'], ['dfrac', '{${num}}{${den}}', 'math'], ['sqrt', '{${}}', 'math'], ['sum', '_{${i=1}}^{${n}}', 'math'], ['prod', '_{${i=1}}^{${n}}', 'math'], ['int', '_{${a}}^{${b}}', 'math'], ['lim', '_{${n \\to \\infty}}', 'math'], ['partial', '', 'math'], ['nabla', '', 'math'], ['infty', '', 'math'],
  ['mathbb', '{${R}}', 'math font'], ['mathcal', '{${}}', 'math font'], ['mathbf', '{${}}', 'math font'], ['mathrm', '{${}}', 'math font'], ['boldsymbol', '{${}}', 'math font'], ['operatorname', '{${}}', 'math'], ['text', '{${}}', 'text in math'],
  ['left(', '${} \\right)', 'delimiters'], ['left[', '${} \\right]', 'delimiters'], ['hat', '{${}}', 'accent'], ['bar', '{${}}', 'accent'], ['tilde', '{${}}', 'accent'], ['vec', '{${}}', 'accent'], ['dot', '{${}}', 'accent'], ['overline', '{${}}', ''], ['underbrace', '{${}}_{${}}', ''],
  ...['alpha', 'beta', 'gamma', 'Gamma', 'delta', 'Delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'Theta', 'kappa', 'lambda', 'Lambda', 'mu', 'nu', 'xi', 'pi', 'Pi', 'rho', 'sigma', 'Sigma', 'tau', 'phi', 'varphi', 'Phi', 'chi', 'psi', 'Psi', 'omega', 'Omega'].map(name => [name, '', 'greek']),
  ...['cdot', 'cdots', 'ldots', 'times', 'div', 'pm', 'leq', 'geq', 'neq', 'approx', 'equiv', 'sim', 'propto', 'in', 'notin', 'subset', 'subseteq', 'cup', 'cap', 'forall', 'exists', 'to', 'rightarrow', 'Rightarrow', 'leftrightarrow', 'iff', 'mapsto', 'langle', 'rangle', 'top', 'quad', 'qquad'].map(name => [name, '', 'symbol'])
];
const ENVIRONMENTS = ['equation', 'equation*', 'align', 'align*', 'gather', 'multline', 'cases', 'matrix', 'pmatrix', 'bmatrix', 'figure', 'figure*', 'table', 'table*', 'tabular', 'itemize', 'enumerate', 'description', 'abstract', 'theorem', 'lemma', 'proposition', 'corollary', 'definition', 'remark', 'proof', 'center', 'minipage', 'quote', 'verbatim', 'lstlisting', 'tikzpicture', 'frame', 'thebibliography'];
const ENV_BODY = { figure: '\\centering\n\t\\includegraphics[width=\\linewidth]{${}}\n\t\\caption{${}}\n\t\\label{fig:${}}', table: '\\centering\n\t\\caption{${}}\n\t\\label{tab:${}}\n\t\\begin{tabular}{${lc}}\n\t\t${}\n\t\\end{tabular}', tabular: '${}', itemize: '\\item ${}', enumerate: '\\item ${}', description: '\\item[${}] ${}', frame: '\\frametitle{${}}\n\t${}' };
const ENV_ARGS = { tabular: '{${lc}}', minipage: '{${0.5\\linewidth}}', frame: '', figure: '[${htbp}]', table: '[${htbp}]' };
const PACKAGES = ['amsmath', 'amssymb', 'amsthm', 'mathtools', 'graphicx', 'hyperref', 'cleveref', 'geometry', 'booktabs', 'tabularx', 'xcolor', 'tikz', 'pgfplots', 'natbib', 'biblatex', 'listings', 'algorithm2e', 'algorithmicx', 'subcaption', 'caption', 'float', 'enumitem', 'microtype', 'siunitx', 'multirow', 'url', 'fontspec', 'ctex', 'xeCJK', 'babel', 'csquotes', 'fancyhdr', 'setspace', 'lipsum'];
const CLASSES = ['article', 'report', 'book', 'beamer', 'ctexart', 'ctexrep', 'ctexbook', 'IEEEtran', 'acmart', 'llncs', 'revtex4-2', 'elsarticle', 'memoir'];

const commandOptions = [
  ...COMMANDS.map(([name, body, detail]) => body ? snippetCompletion(`\\${name}${body}` + '${}', { label: `\\${name}`, detail, type: detail === 'math' || detail === 'greek' || detail === 'symbol' ? 'constant' : 'keyword', boost: name.startsWith('sub') || name === 'section' ? 2 : 0 }) : { label: `\\${name}`, detail, type: detail === 'greek' || detail === 'symbol' ? 'constant' : 'keyword' }),
  ...ENVIRONMENTS.map(env => snippetCompletion(`\\begin{${env}}${ENV_ARGS[env] || ''}\n\t${ENV_BODY[env] || '${}'}\n\\end{${env}}` + '${}', { label: `\\begin{${env}}`, detail: 'environment', type: 'type' }))
];
// Labels, bibliography keys and files of the open project, refreshed by the workspace.
const projectIndex = { labels: [], cites: [], files: [] };
function latexCompletions(context) {
  const argument = context.matchBefore(/\\([a-zA-Z]+\*?)(?:\[[^\]\n]*\])?\{[^{}\n]*$/);
  if (argument) {
    const match = argument.text.match(/^\\([a-zA-Z]+\*?)(?:\[[^\]\n]*\])?\{([^{}\n]*)$/);
    const command = match[1], typed = match[2];
    const from = argument.to - (typed.length - typed.lastIndexOf(',') - 1);
    const doc = context.state.doc.toString();
    let options = [];
    if (/^(ref|eqref|cref|Cref|autoref|pageref|vref|nameref)$/.test(command)) options = [...new Set([...projectIndex.labels, ...[...doc.matchAll(/\\label\{([^}]+)\}/g)].map(m => m[1])])].map(label => ({ label, type: 'variable', detail: label.split(':')[0] }));
    else if (/cite|^nocite$/i.test(command)) options = [...new Set([...projectIndex.cites, ...[...doc.matchAll(/\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}/g)].map(m => m[1])])].map(label => ({ label, type: 'text', detail: 'bib' }));
    else if (command === 'includegraphics') options = projectIndex.files.filter(file => /\.(png|jpe?g|pdf|eps|svg)$/i.test(file)).map(label => ({ label, type: 'text' }));
    else if (command === 'input' || command === 'include') options = projectIndex.files.filter(file => file.endsWith('.tex')).map(file => ({ label: command === 'include' ? file.replace(/\.tex$/, '') : file, type: 'text' }));
    else if (command === 'bibliography' || command === 'addbibresource') options = projectIndex.files.filter(file => file.endsWith('.bib')).map(file => ({ label: command === 'bibliography' ? file.replace(/\.bib$/, '') : file, type: 'text' }));
    else if (command === 'begin' || command === 'end') options = ENVIRONMENTS.map(label => ({ label, type: 'type' }));
    else if (command === 'usepackage') options = PACKAGES.map(label => ({ label, type: 'namespace' }));
    else if (command === 'documentclass') options = CLASSES.map(label => ({ label, type: 'class' }));
    else return null;
    return options.length ? { from, options, validFor: /^[^,{}\s]*$/ } : null;
  }
  const word = context.matchBefore(/\\[a-zA-Z@]*\*?/);
  if (!word) return null;
  return { from: word.from, options: commandOptions, validFor: /^\\[a-zA-Z@]*\*?$/ };
}

/* ───────────── LaTeX language ───────────── */

const MATH_ENVS = /^(equation|align|alignat|gather|multline|flalign|eqnarray|math|displaymath)\*?$/;
const latexLanguage = StreamLanguage.define({
  name: 'latex',
  startState: () => ({ math: null, arg: null, env: null }),
  copyState: state => ({ ...state }),
  token(stream, state) {
    if (state.arg) {
      if (stream.eat('}')) { const kind = state.arg; state.arg = null; if (kind === 'begin' && MATH_ENVS.test(state.env || '')) state.math = 'env'; return 'bracket'; }
      if (stream.match(/^[^}%\n]+/)) { if (state.arg === 'begin' || state.arg === 'end') { state.env = stream.current().trim(); return 'typeName'; } return state.arg === 'ref' ? 'labelName' : 'string'; }
      stream.next(); return null;
    }
    if (stream.match(/^%.*/)) return 'comment';
    if (state.math) {
      if ((state.math === '$$' && stream.match('$$')) || (state.math === '$' && stream.eat('$')) || (state.math === '\\]' && stream.match('\\]')) || (state.math === '\\)' && stream.match('\\)'))) { state.math = null; return 'meta'; }
      if (state.math === 'env' && stream.match(/^\\end(?=\{)/)) { state.math = null; stream.eat('{'); state.arg = 'end'; return 'keyword'; }
      if (stream.match(/^\\[a-zA-Z@]+/)) return 'variableName';
      // \% and \$ are escaped characters, not a comment or the end of the formula.
      if (stream.match(/^\\./)) return 'atom';
      if (stream.match(/^[0-9.]+/)) return 'number';
      if (stream.match(/^[{}[\]]/)) return 'bracket';
      stream.next(); return 'atom';
    }
    if (stream.match('$$')) { state.math = '$$'; return 'meta'; }
    if (stream.eat('$')) { state.math = '$'; return 'meta'; }
    if (stream.match('\\[')) { state.math = '\\]'; return 'meta'; }
    if (stream.match('\\(')) { state.math = '\\)'; return 'meta'; }
    const command = stream.match(/^\\([a-zA-Z@]+\*?|.)/);
    if (command) {
      const name = command[1];
      if ((name === 'begin' || name === 'end') && stream.eat('{')) { state.arg = name; return 'keyword'; }
      if (/^(cite[a-z]*|ref|eqref|autoref|cref|Cref|label|pageref|input|include|includegraphics|bibliography|usepackage|documentclass)$/.test(name)) {
        const before = stream.pos;
        stream.match(/^\s*\[[^\]]*\]/);
        if (stream.eat('{')) { state.arg = /ref|label/.test(name) ? 'ref' : 'path'; return name.startsWith('use') || name === 'documentclass' ? 'meta' : 'keyword'; }
        stream.pos = before;
      }
      if (/^(part|chapter|section|subsection|subsubsection|paragraph|title|caption)\*?$/.test(name)) return 'heading';
      return 'keyword';
    }
    if (stream.match(/^[{}]/)) return 'bracket';
    if (stream.match(/^[&~]/)) return 'operator';
    if (stream.match(/^[^\\%${}&~]+/)) return null;
    stream.next(); return null;
  },
  languageData: {
    commentTokens: { line: '%' },
    indentOnInput: /^\s*(?:\}|\\\]|\\end\{[^}]+\})$/,
    autocomplete: latexCompletions
  }
});
const latexHighlight = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--fo-syn-comment)', fontStyle: 'italic' },
  { tag: tags.keyword, color: 'var(--fo-syn-command)' },
  { tag: tags.heading, color: 'var(--fo-syn-heading)', fontWeight: '600' },
  { tag: tags.typeName, color: 'var(--fo-syn-env)', fontWeight: '500' },
  { tag: [tags.meta, tags.operator], color: 'var(--fo-syn-meta)' },
  { tag: [tags.variableName, tags.atom, tags.number], color: 'var(--fo-syn-math)' },
  { tag: tags.labelName, color: 'var(--fo-syn-ref)' },
  { tag: tags.string, color: 'var(--fo-syn-arg)' },
  { tag: tags.bracket, color: 'var(--fo-syn-bracket)' }
]);
const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--fo-ed-size, 13.5px)', color: 'var(--fo-ed-fg, var(--fo-ink))', backgroundColor: 'var(--fo-ed-bg, var(--fo-surface))' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--fo-ed-font, var(--fo-mono))', lineHeight: '1.75' },
  '.cm-content': { padding: '18px 0 40vh', caretColor: 'var(--fo-accent)' },
  '.cm-line': { padding: '0 22px 0 14px' },
  '.cm-gutters': { backgroundColor: 'var(--fo-ed-bg, var(--fo-surface))', border: 'none', color: 'var(--fo-ed-gutter, var(--fo-faint))', paddingLeft: '8px' },
  '.cm-activeLine': { backgroundColor: 'var(--fo-active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fo-ed-fg, var(--fo-ink))' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'var(--fo-selection) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--fo-ed-caret, var(--fo-accent))', borderLeftWidth: '2px' },
  '.cm-matchingBracket': { backgroundColor: 'var(--fo-accent-soft)', outline: 'none' },
  '.cm-searchMatch': { backgroundColor: 'var(--fo-accent-soft)' },
  '.cm-tooltip': { border: '1px solid var(--fo-line)', backgroundColor: 'var(--fo-raised)', borderRadius: '8px', overflow: 'hidden', boxShadow: 'var(--fo-shadow)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--fo-accent)', color: '#fff' },
  '.cm-panels': { backgroundColor: 'var(--fo-raised)', color: 'var(--fo-ink)', borderColor: 'var(--fo-line)' },
  '.cm-flash-line': { backgroundColor: 'var(--fo-accent-soft)', transition: 'background-color 1.2s ease' },
  '&.cm-focused': { outline: 'none' }
});

/* ───────────── editor settings and LaTeX actions ───────────── */

const EDITOR_KEY = 'thesis-editor-v1';
const EDITOR_DEFAULTS = { size: 13.5, font: 'default', theme: 'harness', wrap: true, toolbar: true };
const EDITOR_FONTS = [['default', 'System mono', 'var(--fo-mono)'], ['menlo', 'Menlo', 'Menlo, var(--fo-mono)'], ['sf', 'SF Mono', '"SF Mono", var(--fo-mono)'], ['jetbrains', 'JetBrains Mono', '"JetBrains Mono", var(--fo-mono)'], ['fira', 'Fira Code', '"Fira Code", var(--fo-mono)'], ['courier', 'Courier New', '"Courier New", monospace']];
// Each palette sets the editor surface and syntax colors; Harness follows the host's light or dark theme.
const EDITOR_THEMES = [
  ['harness', 'Harness', null],
  ['github', 'GitHub', { bg: '#ffffff', fg: '#1f2328', gutter: '#8c959f', active: '#f6f8fa', selection: '#cfe3ff', caret: '#0969da', comment: '#6e7781', command: '#cf222e', heading: '#0550ae', env: '#8250df', meta: '#953800', math: '#0a3069', ref: '#116329', arg: '#0a3069', bracket: '#8c959f' }],
  ['solarized', 'Solarized', { bg: '#fdf6e3', fg: '#586e75', gutter: '#93a1a1', active: '#f5efdc', selection: '#eee8d5', caret: '#268bd2', comment: '#93a1a1', command: '#268bd2', heading: '#cb4b16', env: '#6c71c4', meta: '#d33682', math: '#2aa198', ref: '#859900', arg: '#b58900', bracket: '#93a1a1' }],
  ['paper', 'Paper', { bg: '#f8f5ee', fg: '#2f2b26', gutter: '#a39d92', active: '#f1ece1', selection: '#e3dccb', caret: '#9a3412', comment: '#9b958a', command: '#9a3412', heading: '#1e3a8a', env: '#6d28d9', meta: '#b45309', math: '#0f766e', ref: '#3f6212', arg: '#7c2d12', bracket: '#a39d92' }],
  ['onedark', 'One Dark', { dark: true, bg: '#282c34', fg: '#abb2bf', gutter: '#5c6370', active: '#2c313c', selection: '#3e4451', caret: '#528bff', comment: '#7f848e', command: '#c678dd', heading: '#e5c07b', env: '#61afef', meta: '#d19a66', math: '#56b6c2', ref: '#98c379', arg: '#e06c75', bracket: '#7f848e' }],
  ['dracula', 'Dracula', { dark: true, bg: '#282a36', fg: '#f8f8f2', gutter: '#6272a4', active: '#323444', selection: '#44475a', caret: '#f8f8f0', comment: '#6272a4', command: '#ff79c6', heading: '#bd93f9', env: '#8be9fd', meta: '#ffb86c', math: '#50fa7b', ref: '#f1fa8c', arg: '#f1fa8c', bracket: '#6272a4' }],
  ['nord', 'Nord', { dark: true, bg: '#2e3440', fg: '#d8dee9', gutter: '#4c566a', active: '#343b48', selection: '#434c5e', caret: '#88c0d0', comment: '#616e88', command: '#81a1c1', heading: '#88c0d0', env: '#b48ead', meta: '#d08770', math: '#a3be8c', ref: '#8fbcbb', arg: '#ebcb8b', bracket: '#616e88' }]
];
const clampSize = size => Math.max(9, Math.min(28, Math.round(size * 2) / 2));
function editorStyle(settings) {
  const palette = EDITOR_THEMES.find(([id]) => id === settings.theme)?.[2];
  const style = { '--fo-ed-size': `${settings.size}px`, '--fo-ed-font': (EDITOR_FONTS.find(([id]) => id === settings.font) || EDITOR_FONTS[0])[2] };
  if (!palette) return style;
  return { ...style, colorScheme: palette.dark ? 'dark' : 'light', '--fo-ed-bg': palette.bg, '--fo-ed-fg': palette.fg, '--fo-ed-gutter': palette.gutter, '--fo-ed-caret': palette.caret, '--fo-active-line': palette.active, '--fo-selection': palette.selection,
    ...Object.fromEntries(['comment', 'command', 'heading', 'env', 'meta', 'math', 'ref', 'arg', 'bracket'].map(key => [`--fo-syn-${key}`, palette[key]])) };
}

// Wrap each selection in `before`/`after`, or unwrap it when it is already wrapped.
function wrapWith(view, before, after) {
  const { state } = view;
  view.dispatch(state.changeByRange(range => {
    const text = state.sliceDoc(range.from, range.to);
    if (range.from >= before.length && state.sliceDoc(range.from - before.length, range.from) === before && state.sliceDoc(range.to, range.to + after.length) === after)
      return { changes: [{ from: range.from - before.length, to: range.from }, { from: range.to, to: range.to + after.length }], range: EditorSelection.range(range.from - before.length, range.to - before.length) };
    return { changes: { from: range.from, to: range.to, insert: before + text + after }, range: EditorSelection.range(range.from + before.length, range.from + before.length + text.length) };
  }), { scrollIntoView: true, userEvent: 'input' });
  view.focus();
}
// Put `before` + selection + `after` on lines of their own, indented like the current line.
function insertBlock(view, before, after) {
  const { state } = view;
  const range = state.selection.main;
  const line = state.doc.lineAt(range.from);
  const indent = /^\s*/.exec(line.text)[0];
  const indented = text => text.replace(/\n/g, `\n${indent}`);
  const head = (state.sliceDoc(line.from, range.from).trim() ? `\n${indent}` : '') + indented(before);
  const body = indented(state.sliceDoc(range.from, range.to));
  const tail = indented(after) + (state.sliceDoc(range.to, state.doc.lineAt(range.to).to).trim() ? `\n${indent}` : '');
  view.dispatch({ changes: { from: range.from, to: range.to, insert: head + body + tail }, selection: EditorSelection.cursor(range.from + head.length + body.length), scrollIntoView: true, userEvent: 'input' });
  view.focus();
}
const thenComplete = run => view => { run(view); if (view.state.selection.main.empty) startCompletion(view); };
// Formatting and insertion commands shared by the toolbar, the right-click menu and shortcuts.
function latexActions(t) {
  return {
    bold: { title: t('fmtBold'), glyph: 'B', glyphClass: 'is-bold', hint: `${MOD}B`, run: view => wrapWith(view, '\\textbf{', '}') },
    italic: { title: t('fmtItalic'), glyph: 'I', glyphClass: 'is-italic', hint: `${MOD}I`, run: view => wrapWith(view, '\\textit{', '}') },
    underline: { title: t('fmtUnderline'), glyph: 'U', glyphClass: 'is-underline', run: view => wrapWith(view, '\\underline{', '}') },
    mono: { title: t('fmtMono'), glyph: 'T', glyphClass: 'is-mono', run: view => wrapWith(view, '\\texttt{', '}') },
    chapter: { title: t('hChapter'), glyph: 'Ch', run: view => wrapWith(view, '\\chapter{', '}') },
    section: { title: t('hSection'), glyph: 'H1', run: view => wrapWith(view, '\\section{', '}') },
    subsection: { title: t('hSubsection'), glyph: 'H2', run: view => wrapWith(view, '\\subsection{', '}') },
    subsubsection: { title: t('hSubsubsection'), glyph: 'H3', run: view => wrapWith(view, '\\subsubsection{', '}') },
    paragraph: { title: t('hParagraph'), glyph: '¶', run: view => wrapWith(view, '\\paragraph{', '}') },
    math: { title: t('fmtMath'), glyph: '$x$', glyphClass: 'is-math', run: view => wrapWith(view, '$', '$') },
    equation: { title: t('fmtEquation'), glyph: 'Σ', run: view => insertBlock(view, '\\begin{equation}\n  ', '\n\\end{equation}') },
    align: { title: t('fmtAlign'), glyph: '≡', run: view => insertBlock(view, '\\begin{align}\n  ', '\n\\end{align}') },
    itemize: { title: t('fmtItemize'), icon: 'list', run: view => insertBlock(view, '\\begin{itemize}\n  \\item ', '\n\\end{itemize}') },
    enumerate: { title: t('fmtEnumerate'), icon: 'list-ol', run: view => insertBlock(view, '\\begin{enumerate}\n  \\item ', '\n\\end{enumerate}') },
    figure: { title: t('fmtFigure'), icon: 'image', run: thenComplete(view => insertBlock(view, '\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{', '}\n  \\caption{}\n  \\label{fig:}\n\\end{figure}')) },
    table: { title: t('fmtTable'), icon: 'table', run: view => insertBlock(view, '\\begin{table}[htbp]\n  \\centering\n  \\caption{', '}\n  \\label{tab:}\n  \\begin{tabular}{lll}\n    \\hline\n    A & B & C \\\\\n    \\hline\n     &  &  \\\\\n    \\hline\n  \\end{tabular}\n\\end{table}') },
    cite: { title: t('fmtCite'), icon: 'quote', run: thenComplete(view => wrapWith(view, '\\cite{', '}')) },
    ref: { title: t('fmtRef'), icon: 'link', run: thenComplete(view => wrapWith(view, '\\ref{', '}')) },
    label: { title: t('fmtLabel'), icon: 'tag', run: view => wrapWith(view, '\\label{', '}') },
    footnote: { title: t('fmtFootnote'), glyph: 'ⁿ', run: view => wrapWith(view, '\\footnote{', '}') },
    comment: { title: t('fmtComment'), glyph: '%', glyphClass: 'is-mono', hint: `${MOD}/`, run: view => { toggleComment(view); view.focus(); } }
  };
}
function EditorSettings({ t, settings, onChange, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const listener = event => { if (!ref.current?.contains(event.target) && !event.target.closest?.('[data-editor-settings]')) onClose(); };
    const key = event => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', listener); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', listener); window.removeEventListener('keydown', key); };
  }, []);
  return <div className="fo-popover fo-ed-settings" ref={ref} role="dialog" aria-label={t('editorSettings')}>
    <div className="fo-ed-line"><span>{t('fontSize')}</span><div className="fo-stepper">
      <button aria-label={t('zoomOut')} onClick={() => onChange({ size: clampSize(settings.size - 1) })}><Icon name="minus" size={14} /></button>
      <output>{settings.size}</output>
      <button aria-label={t('zoomIn')} onClick={() => onChange({ size: clampSize(settings.size + 1) })}><Icon name="plus" size={14} /></button>
    </div></div>
    <label className="fo-field"><span>{t('font')}</span><select value={settings.font} onChange={event => onChange({ font: event.target.value })}>{EDITOR_FONTS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    <div className="fo-ed-themes"><span>{t('colorTheme')}</span><div>{EDITOR_THEMES.map(([id, label, palette]) => <button key={id} className={settings.theme === id ? 'is-selected' : ''} aria-pressed={settings.theme === id} onClick={() => onChange({ theme: id })}>
      <span className="fo-swatch" style={{ background: palette?.bg || 'var(--fo-surface)', color: palette?.fg || 'var(--fo-ink)' }}>{['command', 'env', 'math'].map(key => <i key={key} style={{ background: palette?.[key] || `var(--fo-syn-${key})` }} />)}</span>{label}
    </button>)}</div></div>
    <label className="fo-switch"><input type="checkbox" checked={settings.wrap} onChange={event => onChange({ wrap: event.target.checked })} /><span />{t('wrapLines')}</label>
    <small className="fo-muted">{t('editorZoomHint')}</small>
  </div>;
}

function SourceEditor({ docKey, content, initialLine, latex, onChange, onCursor, onSave, onCompile, onFormat, apiRef, settings, style, onZoom, onContextMenu, t }) {
  const host = useRef(null);
  const wrapping = useRef(new Compartment());
  const handlers = useRef({}); handlers.current = { onChange, onCursor, onSave, onCompile, onFormat, onZoom, onContextMenu };
  const viewRef = useRef(null);
  useEffect(() => {
    if (!host.current) return;
    const initialDoc = EditorState.create({ doc: content }).doc;
    const position = initialDoc.line(Math.max(1, Math.min(initialDoc.lines, initialLine || 1))).from;
    const view = new EditorView({ parent: host.current, state: EditorState.create({ doc: initialDoc, selection: EditorSelection.cursor(position), extensions: [
      Prec.high(keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => { handlers.current.onSave(); return true; } },
        { key: 'Mod-Enter', preventDefault: true, run: () => { handlers.current.onCompile(); return true; } },
        { key: 'Mod-b', preventDefault: true, run: target => { handlers.current.onFormat('bold', target); return true; } },
        { key: 'Mod-i', preventDefault: true, run: target => { handlers.current.onFormat('italic', target); return true; } },
        { key: 'Mod-=', preventDefault: true, run: () => { handlers.current.onZoom(1); return true; } },
        { key: 'Mod--', preventDefault: true, run: () => { handlers.current.onZoom(-1); return true; } },
        { key: 'Mod-0', preventDefault: true, run: () => { handlers.current.onZoom(0); return true; } }
      ])),
      ...(latex ? [indentUnit.of('  '), indentService.of(latexIndentAt), keymap.of([indentWithTab]), latexSourceDecorations,
        EditorState.phrases.of({ 'Fold line': t('foldSource'), 'Unfold line': t('unfoldSource'),
          'folded code': t('foldedSource'), unfold: t('unfoldSource') })] : []),
      basicSetup, latexLanguage, syntaxHighlighting(latexHighlight), editorTheme, wrapping.current.of(settings.wrap ? EditorView.lineWrapping : []),
      EditorView.updateListener.of(update => {
        if (update.docChanged) handlers.current.onChange(update.state.doc.toString());
        if (update.docChanged || update.selectionSet) {
          const { main } = update.state.selection;
          const doc = update.state.doc;
          handlers.current.onCursor({ line: doc.lineAt(main.head).number, from: doc.lineAt(main.from).number, to: doc.lineAt(main.to).number, start: main.from, end: main.to, text: main.empty ? '' : doc.sliceString(main.from, main.to) });
        }
      })
    ] }) });
    viewRef.current = view;
    if (position) view.dispatch({ effects: EditorView.scrollIntoView(position, { y: 'center' }) });
    // Pinch or Ctrl/⌘ + scroll over the source changes the font size.
    let pending = 0;
    const wheel = event => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      pending -= event.deltaY;
      if (Math.abs(pending) >= 24) { handlers.current.onZoom(pending > 0 ? 0.5 : -0.5); pending = 0; }
    };
    host.current.addEventListener('wheel', wheel, { passive: false });
    // The whole editor, gutter and blank space included, gets the LaTeX menu.
    const menu = event => handlers.current.onContextMenu?.(event, view);
    host.current.addEventListener('contextmenu', menu);
    apiRef.current = {
      view,
      jumpTo(line) {
        const target = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
        const effects = [EditorView.scrollIntoView(target.from, { y: 'center' })];
        foldedRanges(view.state).between(target.from, target.from, (from, to) => {
          if (from < target.from && target.from < to) effects.push(unfoldEffect.of({ from, to }));
        });
        view.dispatch({ selection: EditorSelection.cursor(target.from), effects });
        view.focus();
      },
      focus: () => view.focus()
    };
    const element = host.current;
    return () => { element.removeEventListener('wheel', wheel); element.removeEventListener('contextmenu', menu); apiRef.current = null; viewRef.current = null; view.destroy(); };
  }, [docKey, latex]);
  useEffect(() => { viewRef.current?.dispatch({ effects: wrapping.current.reconfigure(settings.wrap ? EditorView.lineWrapping : []) }); }, [settings.wrap]);
  useEffect(() => { viewRef.current?.requestMeasure(); }, [settings.size, settings.font]);
  return <div className="fo-editor" data-testid="folio-editor" ref={host} style={style} />;
}

/* ───────────── PDF preview ───────────── */

const PDF_VIEW_KEY = 'thesis-pdf-view-v2';
const PDF_PAD = 16, PDF_GAP = 12, CSS_UNITS = 96 / 72;
const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const clampZoom = zoom => Math.max(0.25, Math.min(5, zoom));
let pdfWorkerUrl = null;
// One worker per load, passed explicitly to getDocument. Sharing a single port through
// GlobalWorkerOptions breaks as soon as a document is destroyed (switching dock, closing the
// preview, rebuilding): pdf.js marks the shared PDFWorker `_pendingDestroy`, and the next
// getDocument on that port throws "PDFWorker.fromPort - the worker is being destroyed". Passing
// the worker explicitly keeps `task._worker` unset, so destroying one document can never mark
// the worker of another as pending and poison the next load.
function createPdfWorker() {
  // The PDF.js worker ships inside client.js; one Blob URL runs it on the Harness origin.
  pdfWorkerUrl ||= URL.createObjectURL(new Blob([__PDF_WORKER__], { type: 'text/javascript' }));
  const port = new Worker(pdfWorkerUrl, { type: 'module' });
  return { port, worker: new pdfjs.PDFWorker({ port }) };
}
function releasePdfWorker(handle) {
  try { handle?.worker?.destroy(); } catch {}
  try { handle?.port?.terminate(); } catch {}
}

function PdfPage({ pdf, number, size, scale, near, marks, follow }) {
  const [links, setLinks] = useState([]);
  const host = useRef(null); const text = useRef(null);
  const drawn = useRef(0); const layerRef = useRef(null); const scaleRef = useRef(scale); scaleRef.current = scale;
  // Text positions are relative to the page and font sizes follow --scale-factor, so the text
  // layer tracks zoom immediately, before the canvas is redrawn.
  useLayoutEffect(() => { text.current?.style.setProperty('--scale-factor', String(scale)); }, [scale]);
  // Transparent text over the canvas, so the PDF's text can be selected and copied.
  useEffect(() => {
    if (!near || !pdf) return;
    let cancelled = false, layer = null;
    (async () => {
      try {
        const page = await pdf.getPage(number);
        if (cancelled) return;
        text.current.replaceChildren();
        layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text.current, viewport: page.getViewport({ scale: scaleRef.current }) });
        await layer.render();
        if (!cancelled) layerRef.current = { layer, page };
      } catch (error) { if (!cancelled) console.warn('Folio: PDF text', number, error); }
    })();
    return () => { cancelled = true; layer?.cancel(); layerRef.current = null; };
  }, [pdf, number, near]);
  useEffect(() => {
    setLinks([]);
    if (!near || !pdf) return;
    let cancelled = false;
    (async () => {
      try {
        const page = await pdf.getPage(number);
        const viewport = page.getViewport({ scale: 1 });
        const annotations = await page.getAnnotations({ intent: 'display' });
        if (cancelled) return;
        setLinks(annotations.flatMap(({ subtype, rect, dest, url }) => {
          const external = /^(?:https?:|mailto:)/i.test(url || '') ? url : '';
          if (subtype !== 'Link' || (!dest && !external) || !rect) return [];
          const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(rect);
          return [{ dest, url: external, style: { left: Math.min(x1, x2) / viewport.width * 100 + '%',
            top: Math.min(y1, y2) / viewport.height * 100 + '%', width: Math.abs(x2 - x1) / viewport.width * 100 + '%',
            height: Math.abs(y2 - y1) / viewport.height * 100 + '%' } }];
        }));
      } catch { /* The canvas and text remain usable when annotations cannot be read. */ }
    })();
    return () => { cancelled = true; };
  }, [pdf, number, near]);
  useEffect(() => {
    if (!near || !pdf) return;
    let cancelled = false, task = null;
    // Redraw after a zoom settles; meanwhile the previous canvas is stretched to the new size.
    const timer = setTimeout(async () => {
      try {
        const page = await pdf.getPage(number);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        // Keep each canvas under ~16 megapixels so deep zooms stay within browser limits.
        const pixel = Math.min(scale * Math.min(window.devicePixelRatio || 1, 2), Math.sqrt(16e6 / (base.width * base.height)));
        const viewport = page.getViewport({ scale: pixel });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width); canvas.height = Math.floor(viewport.height);
        task = page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport });
        await task.promise;
        if (cancelled || !host.current) return;
        host.current.querySelector('canvas')?.remove();
        host.current.prepend(canvas);
        drawn.current = scale;
        layerRef.current?.layer.update({ viewport: layerRef.current.page.getViewport({ scale }) });
      } catch (error) { if (error?.name !== 'RenderingCancelledException' && !cancelled) console.warn('Folio: PDF page', number, error); }
    }, drawn.current ? 140 : 0);
    return () => { cancelled = true; clearTimeout(timer); task?.cancel(); };
  }, [pdf, number, scale, near]);
  // Pages far from view give their canvas back.
  useEffect(() => { if (!near && host.current) { host.current.querySelector('canvas')?.remove(); text.current?.replaceChildren(); drawn.current = 0; } }, [near]);
  return <div className="fo-pdf-page" data-page={number} ref={host} style={{ width: size.w * scale, height: size.h * scale }}>
    <div className="textLayer" ref={text} />
    {links.map(({ dest, url, style }, index) => <a key={index} className="fo-pdf-link" style={style}
      href={url || '#'} title={url || follow.label} aria-label={url || follow.label}
      target={url ? '_blank' : undefined} rel={url ? 'noopener noreferrer' : undefined}
      onClick={url ? undefined : event => { event.preventDefault(); follow.open(dest); }} />)}
    {marks.map((mark, i) => <span key={`${mark.key}-${i}`} className="fo-pdf-mark" style={mark.width < 2
      ? { left: 0, width: '100%', top: mark.y * scale, height: Math.max(mark.height, 8) * scale }
      : { left: mark.x * scale - 3, width: mark.width * scale + 6, top: mark.y * scale - 2, height: Math.max(mark.height, 8) * scale + 4 }} />)}
  </div>;
}

// Continuous-scroll PDF viewer: pinch or Ctrl/⌘ + scroll zooms around the pointer, the place is kept
// across rebuilds, double-click jumps to the source, and right-click is handled by `onMenu`.
function PdfViewer({ t, url, apiRef, onInverse, onMenu, downloadName }) {
  const [locating, setLocating] = useState(false);
  const scroller = useRef(null);
  const [doc, setDoc] = useState({ pdf: null, sizes: [] });
  const [error, setError] = useState('');
  const [view, setView] = useState(() => ({ mode: 'width', zoom: 1, ...readStored(PDF_VIEW_KEY, {}) }));
  const [near, setNear] = useState(() => new Set([1, 2]));
  const [current, setCurrent] = useState(1);
  const [pageInput, setPageInput] = useState('');
  const [marks, setMarks] = useState(null);
  const [zoomMenu, setZoomMenu] = useState(null);
  const pending = useRef(null); const docRef = useRef(null); const liveScale = useRef(0);
  // The worker that belongs to the document currently on screen, released together with it.
  const workerRef = useRef(null);
  const { width, height } = useElementSize(scroller);
  useEffect(() => { store(PDF_VIEW_KEY, view); }, [view]);

  const sizes = doc.sizes;
  const widest = Math.max(1, ...sizes.map(size => size.w)), first = sizes[0] || { w: 612, h: 792 };
  const fitWidth = Math.max(0.1, (width - PDF_PAD * 2) / widest);
  const fitPage = Math.max(0.1, Math.min(fitWidth, (height - PDF_PAD * 2) / first.h));
  const scale = view.mode === 'width' ? fitWidth : view.mode === 'page' ? fitPage : view.zoom * CSS_UNITS;
  const percent = Math.round(scale / CSS_UNITS * 100);
  const tops = useMemo(() => { let y = PDF_PAD; return sizes.map(size => { const top = y; y += size.h * scale + PDF_GAP; return top; }); }, [sizes, scale]);
  const layoutRef = useRef({}); layoutRef.current = { tops, sizes, scale };
  liveScale.current = liveScale.current || scale;

  // Load each new build; keep showing the previous one until the new one is ready.
  useEffect(() => {
    if (!url) return;
    const handle = createPdfWorker();
    let cancelled = false, loaded = false;
    const task = pdfjs.getDocument({ url, worker: handle.worker, isEvalSupported: false, enableXfa: false });
    task.promise.then(async pdf => {
      loaded = true;
      const list = [];
      for (let i = 1; i <= pdf.numPages; i += 1) { const viewport = (await pdf.getPage(i)).getViewport({ scale: 1 }); list.push({ w: viewport.width, h: viewport.height }); }
      if (cancelled) { pdf.destroy(); releasePdfWorker(handle); return; }
      const element = scroller.current, { tops: oldTops, sizes: oldSizes, scale: oldScale } = layoutRef.current;
      if (element && docRef.current && oldTops.length) {
        // Same page, same spot within it, as before the rebuild.
        let index = 0;
        while (index + 1 < oldTops.length && oldTops[index + 1] <= element.scrollTop) index += 1;
        pending.current = { page: index, within: (element.scrollTop - oldTops[index]) / (oldSizes[index].h * oldScale), left: element.scrollLeft };
      }
      const previous = docRef.current, previousWorker = workerRef.current;
      docRef.current = pdf; workerRef.current = handle;
      setDoc({ pdf, sizes: list }); setError('');
      // The old document stays on screen until the new one is ready; it owns its own worker.
      if (previous) setTimeout(() => { previous.destroy(); releasePdfWorker(previousWorker); }, 1500);
    }).catch(failure => { if (!cancelled) setError(messageOf(failure)); if (!loaded) releasePdfWorker(handle); });
    return () => { cancelled = true; if (!loaded) { task.destroy(); releasePdfWorker(handle); } };
  }, [url]);
  useEffect(() => () => { docRef.current?.destroy(); releasePdfWorker(workerRef.current); docRef.current = null; workerRef.current = null; }, []);

  // Apply a pending scroll once the new layout is in place.
  useLayoutEffect(() => {
    const element = scroller.current, target = pending.current;
    liveScale.current = scale;
    if (!element || !target) return;
    if (target.zoomFrom) {
      const ratio = scale / target.zoomFrom;
      element.scrollLeft = target.contentX * ratio - target.x;
      element.scrollTop = target.contentY * ratio - target.y;
    } else if (target.page !== undefined && tops[target.page] !== undefined) {
      element.scrollTop = tops[target.page] + target.within * sizes[target.page].h * scale;
      element.scrollLeft = target.left;
    }
    pending.current = null;
  }, [scale, tops]);

  function zoomTo(next, clientX, clientY) {
    const element = scroller.current;
    if (element && !pending.current?.zoomFrom) {
      const rect = element.getBoundingClientRect();
      const x = (clientX ?? rect.left + rect.width / 2) - rect.left, y = (clientY ?? rect.top + rect.height / 2) - rect.top;
      pending.current = { zoomFrom: scale, x, y, contentX: element.scrollLeft + x, contentY: element.scrollTop + y };
    }
    liveScale.current = next.mode === 'custom' ? next.zoom * CSS_UNITS : liveScale.current;
    setView(next);
  }
  const zoomRef = useRef(zoomTo); zoomRef.current = zoomTo;
  const step = direction => {
    const now = liveScale.current / CSS_UNITS;
    const level = direction > 0 ? ZOOM_LEVELS.find(value => value > now + 0.001) : [...ZOOM_LEVELS].reverse().find(value => value < now - 0.001);
    zoomTo({ mode: 'custom', zoom: level ?? clampZoom(now) });
  };
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    // Trackpad pinch arrives as Ctrl + wheel; Safari also sends gesture events.
    const wheel = event => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomRef.current({ mode: 'custom', zoom: clampZoom(liveScale.current / CSS_UNITS * Math.exp(-event.deltaY * 0.01)) }, event.clientX, event.clientY);
    };
    let base = 1;
    const start = event => { event.preventDefault(); base = liveScale.current / CSS_UNITS; };
    const change = event => { event.preventDefault(); zoomRef.current({ mode: 'custom', zoom: clampZoom(base * event.scale) }, event.clientX, event.clientY); };
    element.addEventListener('wheel', wheel, { passive: false });
    element.addEventListener('gesturestart', start); element.addEventListener('gesturechange', change);
    return () => { element.removeEventListener('wheel', wheel); element.removeEventListener('gesturestart', start); element.removeEventListener('gesturechange', change); };
  }, []);

  const track = useCallback(() => {
    const element = scroller.current;
    if (!element || !sizes.length) return;
    const top = element.scrollTop, span = element.clientHeight;
    const next = new Set(); let page = 1;
    sizes.forEach((size, i) => {
      const a = tops[i], b = a + size.h * scale;
      if (b >= top - span && a <= top + span * 2) next.add(i + 1);
      if (a <= top + span * 0.4) page = i + 1;
    });
    setNear(previous => previous.size === next.size && [...next].every(value => previous.has(value)) ? previous : next);
    setCurrent(page);
  }, [sizes, tops, scale]);
  useEffect(() => { track(); }, [track, height]);

  const goTo = number => { const element = scroller.current; const index = Math.max(1, Math.min(sizes.length, number)) - 1; if (element && tops[index] !== undefined) element.scrollTo({ top: tops[index] - PDF_PAD / 2, behavior: 'smooth' }); };
  async function followDestination(value) {
    try {
      const destination = typeof value === 'string' ? await doc.pdf.getDestination(value) : value;
      if (!Array.isArray(destination)) return;
      const [reference, mode, x, y] = destination;
      const index = Number.isInteger(reference) ? reference : await doc.pdf.getPageIndex(reference);
      if (tops[index] === undefined) return;
      const yCoordinate = mode?.name === 'XYZ' ? y : ['FitH', 'FitBH'].includes(mode?.name) ? x : null;
      if (!Number.isFinite(yCoordinate)) { goTo(index + 1); return; }
      const page = await doc.pdf.getPage(index + 1);
      const [, top] = page.getViewport({ scale }).convertToViewportPoint(0, yCoordinate);
      scroller.current?.scrollTo({ top: tops[index] + top - PDF_PAD, behavior: 'smooth' });
    } catch { /* A stale or unresolved PDF destination is left alone. */ }
  }
  const pointOf = event => {
    const page = event.target.closest?.('.fo-pdf-page');
    if (!page) return null;
    const box = page.getBoundingClientRect();
    return { page: Number(page.dataset.page), x: (event.clientX - box.left) / scale, y: (event.clientY - box.top) / scale };
  };
  apiRef.current = {
    zoomIn: () => step(1), zoomOut: () => step(-1),
    fit: mode => setView(previous => ({ ...previous, mode })),
    actual: () => zoomTo({ mode: 'custom', zoom: 1 }),
    percent,
    selection: () => { const selected = window.getSelection(); return selected && scroller.current?.contains(selected.anchorNode) ? selected.toString() : ''; },
    reveal(boxes) {
      const element = scroller.current, box = boxes[0];
      if (!element || !box || tops[box.page - 1] === undefined) return;
      element.scrollTop = tops[box.page - 1] + box.y * scale - element.clientHeight / 3;
      element.scrollLeft = Math.max(0, PDF_PAD + box.x * scale - element.clientWidth / 4);
      const key = Date.now();
      setMarks({ key, boxes: boxes.slice(0, 8) });
      setTimeout(() => setMarks(previous => previous?.key === key ? null : previous), 2400);
    }
  };

  if (error && !doc.pdf) return <div className="fo-empty"><p className="fo-form-error">{t('pdfFailed')}: {error}</p><a className="fo-btn" href={url} target="_blank" rel="noreferrer"><Icon name="external" size={14} /> {t('openPdfTab')}</a></div>;
  return <div className="fo-pdf-viewer">
    <div className={'fo-pdf-scroll' + (locating ? ' is-locating' : '')} ref={scroller} tabIndex={0} onScroll={track}
      onClick={event => {
        if (!locating || event.detail !== 1 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.target.closest?.('a, button')) return;
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed && scroller.current?.contains(selection.anchorNode)) return;
        const point = pointOf(event);
        if (point) onInverse?.(point);
      }}
      onDoubleClick={event => { const point = pointOf(event); if (!locating && point && !event.target.closest?.('a, button')) { window.getSelection()?.removeAllRanges(); onInverse?.(point); } }}
      onContextMenu={event => onMenu?.(event, pointOf(event))}
      onKeyDown={event => {
        if (!(event.ctrlKey || event.metaKey)) return;
        if (event.key === '=' || event.key === '+') { event.preventDefault(); step(1); }
        else if (event.key === '-') { event.preventDefault(); step(-1); }
        else if (event.key === '0') { event.preventDefault(); setView(previous => ({ ...previous, mode: 'width' })); }
      }}>
      {!doc.pdf ? <div className="fo-empty"><span className="fo-spinner" /><p>{t('loadingPdf')}</p></div>
        : <div className="fo-pdf-pages" style={{ padding: PDF_PAD, gap: PDF_GAP }}>{sizes.map((size, i) => <PdfPage key={i} pdf={doc.pdf} number={i + 1} size={size} scale={scale} near={near.has(i + 1)} follow={{ label: t('pdfInternalLink'), open: followDestination }} marks={marks ? marks.boxes.filter(box => box.page === i + 1).map(box => ({ ...box, key: marks.key })) : []} />)}</div>}
    </div>
    {doc.pdf && <div className="fo-pdf-bar" onDoubleClick={event => event.stopPropagation()}>
      <button className="fo-icon-btn" title={t('prevPage')} aria-label={t('prevPage')} disabled={current <= 1} onClick={() => goTo(current - 1)}><Icon name="back" size={14} /></button>
      <input className="fo-pdf-page-input" aria-label={t('page')} value={pageInput || String(current)} onFocus={event => { setPageInput(String(current)); event.target.select(); }} onChange={event => setPageInput(event.target.value.replace(/\D/g, ''))} onBlur={() => setPageInput('')} onKeyDown={event => { if (event.key === 'Enter') { goTo(Number(pageInput) || current); event.currentTarget.blur(); } }} />
      <span className="fo-pdf-count">/ {sizes.length}</span>
      <button className="fo-icon-btn" title={t('nextPage')} aria-label={t('nextPage')} disabled={current >= sizes.length} onClick={() => goTo(current + 1)}><Icon name="right" size={14} /></button>
      <i className="fo-pdf-sep" />
      {onInverse && <button type="button" className="fo-icon-btn fo-pdf-locate" title={t('pdfLocateMode')} aria-label={t('pdfLocateMode')}
        aria-pressed={locating} onClick={() => setLocating(value => !value)}><Icon name="locate" size={15} /></button>}
      <button className="fo-icon-btn" title={`${t('zoomOut')} (${MOD}−)`} aria-label={t('zoomOut')} onClick={() => step(-1)}><Icon name="minus" size={14} /></button>
      <button className="fo-pdf-zoom" title={t('zoom')} onClick={event => { const box = event.currentTarget.getBoundingClientRect(); setZoomMenu({ position: 'fixed', left: box.left - 40, top: box.top - 4, flip: 8 }); }}>{view.mode === 'width' ? t('fitWidth') : view.mode === 'page' ? t('fitPage') : `${percent}%`}</button>
      <button className="fo-icon-btn" title={`${t('zoomIn')} (${MOD}+)`} aria-label={t('zoomIn')} onClick={() => step(1)}><Icon name="plus" size={14} /></button>
    </div>}
    {zoomMenu && <Menu anchor={zoomMenu} onClose={() => setZoomMenu(null)} items={[
      { label: t('fitWidth'), icon: 'fit-width', checked: view.mode === 'width' || undefined, run: () => setView(previous => ({ ...previous, mode: 'width' })) },
      { label: t('fitPage'), icon: 'fit-page', checked: view.mode === 'page' || undefined, run: () => setView(previous => ({ ...previous, mode: 'page' })) },
      '-',
      ...[0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map(zoom => ({ label: `${zoom * 100}%`, checked: (view.mode === 'custom' && Math.abs(view.zoom - zoom) < 0.001) || undefined, run: () => zoomTo({ mode: 'custom', zoom }) }))
    ]} />}
  </div>;
}

/* ───────────── diff review ───────────── */

function DiffView({ proposal }) {
  const rows = useMemo(() => {
    const parts = diffLines(proposal.original || '', proposal.content || '');
    const output = [];
    let oldLine = 1, newLine = 1;
    parts.forEach((part, index) => {
      const lines = part.value.replace(/\n$/, '').split('\n');
      if (!part.added && !part.removed) {
        const keepHead = index === 0 ? 0 : 3, keepTail = index === parts.length - 1 ? 0 : 3;
        if (lines.length > keepHead + keepTail + 2) {
          lines.slice(0, keepHead).forEach(text => output.push({ type: 'same', text, a: oldLine++, b: newLine++ }));
          const hidden = lines.length - keepHead - keepTail;
          output.push({ type: 'gap', count: hidden });
          oldLine += hidden; newLine += hidden;
          lines.slice(lines.length - keepTail).forEach(text => output.push({ type: 'same', text, a: oldLine++, b: newLine++ }));
        } else lines.forEach(text => output.push({ type: 'same', text, a: oldLine++, b: newLine++ }));
      } else if (part.removed) lines.forEach(text => output.push({ type: 'del', text, a: oldLine++ }));
      else lines.forEach(text => output.push({ type: 'add', text, b: newLine++ }));
    });
    return output;
  }, [proposal.id]);
  return <div className="fo-diff" role="table">{rows.map((row, i) => row.type === 'gap'
    ? <div key={i} className="fo-diff-gap">⋯ {row.count}</div>
    : <div key={i} className={`fo-diff-row is-${row.type}`}><span className="fo-diff-n">{row.a ?? ''}</span><span className="fo-diff-n">{row.b ?? ''}</span><span className="fo-diff-sign">{row.type === 'add' ? '+' : row.type === 'del' ? '−' : ''}</span><code>{row.text || ' '}</code></div>)}</div>;
}

/* ───────────── chrome pieces ───────────── */

function SourceCheck({ t, result, stale, onClose, onApply }) {
  const message = stale ? t('checkChanged') : result.loading ? t('checkRunning')
    : result.error || (!result.problems.length ? t('checkClear') : '');
  return <section className="thesis-check" aria-label={t('checkSource')} aria-busy={result.loading && !stale}>
    <header><strong>{t('checkSource')}</strong><button type="button" className="fo-icon-btn" aria-label={t('close')} onClick={onClose}><Icon name="close" size={14} /></button></header>
    {message ? <p role={result.error && !stale ? 'alert' : 'status'}>{message}</p> : <>
      <ul>{result.problems.map(issue => <li key={issue.kind + ':' + issue.from}>
        <div><span className="fo-muted">{t('line')} {result.doc.lineAt(issue.from).number}</span> · {t(issue.kind)}
          {issue.detail && <> <code>{issue.detail}</code></>}</div>
        <div className="thesis-check-fixes"><code>{issue.text}</code>
          {issue.replacements.map(replacement => <button className="fo-btn is-small" type="button" key={replacement}
            onClick={() => onApply(issue, replacement)}>
            {replacement ? <>{t('checkApply')} <code>{replacement}</code></> : t('checkRemove')}
          </button>)}
        </div>
      </li>)}</ul>
      {result.limited && <p className="fo-muted">{t('checkLimited')}</p>}
    </>}
  </section>;
}

function Dialog({ title, children, onClose, busy, className = '' }) {
  useEffect(() => { const listener = event => { if (event.key === 'Escape' && !busy) onClose(); }; window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener); }, [busy, onClose]);
  return <div className="fo-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className={`fo-dialog ${className}`} role="dialog" aria-modal="true" aria-label={title}><h2>{title}</h2>{children}</section>
  </div>;
}
function PromptForm({ t, label, initial = '', placeholder, submitLabel, onSubmit, onCancel, danger, message }) {
  const [value, setValue] = useState(initial); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  return <form onSubmit={async event => { event.preventDefault(); if (!message && !value.trim()) { setError(t('required')); return; } setBusy(true); setError(''); try { await onSubmit(value.trim()); } catch (failure) { setError(messageOf(failure)); setBusy(false); } }}>
    {message ? <p className="fo-dialog-copy">{message}</p> : <label className="fo-field"><span>{label}</span><input autoFocus value={value} placeholder={placeholder} disabled={busy} onChange={event => { setValue(event.target.value); setError(''); }} onFocus={event => { const dot = event.target.value.lastIndexOf('.'); if (dot > 0) event.target.setSelectionRange(event.target.value.lastIndexOf('/') + 1, dot); }} /></label>}
    {error && <p className="fo-form-error" role="alert">{error}</p>}
    <footer><button type="button" className="fo-btn" onClick={onCancel} disabled={busy}>{t('cancel')}</button><button className={danger ? 'fo-btn is-danger' : 'fo-btn is-primary'} disabled={busy}>{submitLabel}</button></footer>
  </form>;
}
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? '⌘' : 'Ctrl+';
// Menu items: { label, run, icon, hint, checked, disabled, danger }, '-' separators, or
// { row: [{ title, icon | glyph, run }] } for a strip of tool buttons.
function Menu({ items, onClose, anchor }) {
  const ref = useRef(null);
  const [position, setPosition] = useState(anchor);
  useLayoutEffect(() => {
    // Keep the menu on screen: shift left from the right edge, open upward near the bottom.
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - box.width - 8));
    const top = anchor.top + box.height > window.innerHeight - 8 ? Math.max(8, anchor.top - box.height - (anchor.flip || 0)) : anchor.top;
    setPosition({ ...anchor, left, top });
  }, [anchor]);
  useEffect(() => {
    const listener = event => { if (!ref.current?.contains(event.target)) onClose(); };
    const key = event => { if (event.key === 'Escape') onClose(); };
    const blur = () => onClose();
    setTimeout(() => window.addEventListener('pointerdown', listener));
    window.addEventListener('keydown', key); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('pointerdown', listener); window.removeEventListener('keydown', key); window.removeEventListener('blur', blur); };
  }, []);
  const list = items.filter(Boolean).filter((item, i, all) => item !== '-' || (i > 0 && i < all.length - 1 && all[i - 1] !== '-'));
  const hasMarks = list.some(item => item.icon || item.checked !== undefined);
  return <div className="fo-menu" ref={ref} role="menu" style={{ ...position, flip: undefined }} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>{list.map((item, i) => item === '-' ? <hr key={i} />
    : item.row ? <div key={i} className="fo-menu-row" role="group">{item.row.map(tool => <button key={tool.title} role="menuitem" title={tool.hint ? `${tool.title} (${tool.hint})` : tool.title} aria-label={tool.title} onClick={() => { onClose(); tool.run(); }}>{tool.icon ? <Icon name={tool.icon} size={15} /> : <span className={`fo-glyph ${tool.glyphClass || ''}`}>{tool.glyph}</span>}</button>)}</div>
    : <button key={i} role="menuitem" disabled={item.disabled} className={item.danger ? 'is-danger' : ''} onClick={() => { onClose(); item.run(); }}>
      {hasMarks && <span className="fo-menu-mark">{item.checked ? <Icon name="check" size={14} /> : item.icon ? <Icon name={item.icon} size={14} /> : null}</span>}
      <span className="fo-menu-label">{item.label}</span>{item.hint && <kbd>{item.hint}</kbd>}
    </button>)}</div>;
}
// Open a menu at the pointer for a right-click, instead of the browser's own menu.
function menuAt(event) { event.preventDefault(); event.stopPropagation(); return { position: 'fixed', left: event.clientX, top: event.clientY }; }
function useToasts() {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((text, tone = 'info') => { const id = Math.random(); setToasts(list => [...list.slice(-2), { id, text, tone }]); setTimeout(() => setToasts(list => list.filter(item => item.id !== id)), tone === 'error' ? 7000 : 3200); }, []);
  const view = <div className="fo-toasts" aria-live="polite">{toasts.map(item => <div key={item.id} className={`fo-toast is-${item.tone}`} role={item.tone === 'error' ? 'alert' : 'status'}><span>{item.text}</span><button aria-label="×" onClick={() => setToasts(list => list.filter(other => other.id !== item.id))}><Icon name="close" size={13} /></button></div>)}</div>;
  return [push, view];
}

/* ───────────── library ───────────── */

/* ───────────── import ───────────── */

// Files from a folder picker or drop as {path, data}; skipped paths carry no data and are never read.
async function readFiles(list) {
  return Promise.all(list.map(async ({ path, file }) => ({ path, data: isSkipped(path) ? null : new Uint8Array(await file.arrayBuffer()) })));
}
async function walkEntry(entry, prefix = '') {
  if (entry.isFile) return [{ path: prefix + entry.name, file: await new Promise((resolve, reject) => entry.file(resolve, reject)) }];
  if (isSkipped(prefix + entry.name)) return [{ path: `${prefix}${entry.name}/`, file: null }];
  const reader = entry.createReader(), children = [];
  for (;;) { const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject)); if (!batch.length) break; children.push(...batch); }
  return (await Promise.all(children.map(child => walkEntry(child, `${prefix}${entry.name}/`)))).flat();
}
// What a drop or picker holds: one .zip, or a folder. Resolves to {name, entries}.
async function importSource({ zip, folder, entry }) {
  if (zip) return { name: zip.name.replace(/\.zip$/i, ''), entries: await readZip(await zip.arrayBuffer()) };
  if (entry) return { name: entry.name, entries: await readFiles(await walkEntry(entry)) };
  const list = [...folder].map(file => ({ path: file.webkitRelativePath || file.name, file }));
  return { name: list[0]?.path.split('/')[0] || 'Imported', entries: await readFiles(list) };
}

/* ───────────── TeX environment ───────────── */

const TEX_TOOLS = [['pdflatex', 'pdfLaTeX'], ['xelatex', 'XeLaTeX'], ['lualatex', 'LuaLaTeX'], ['bibtex', 'BibTeX'], ['biber', 'Biber'], ['tectonic', 'Tectonic'], ['kpsewhich', 'kpsewhich']];
const TEX_TESTS = { pdflatex: 'pdfLaTeX', bibtex: 'pdfLaTeX + BibTeX', biber: 'biblatex + Biber', xelatex: 'XeLaTeX + fontspec', ctex: 'XeLaTeX + ctex 中文', lualatex: 'LuaLaTeX', tectonic: 'Tectonic' };
const TEX_INSTALL = {
  darwin: [['MacTeX', 'https://www.tug.org/mactex/', 'brew install --cask mactex-no-gui'], ['TinyTeX', 'https://yihui.org/tinytex/', '']],
  linux: [['TeX Live', 'https://www.tug.org/texlive/', 'sudo apt install texlive-latex-extra texlive-xetex texlive-luatex texlive-lang-chinese biber']],
  win32: [['MiKTeX', 'https://miktex.org/download', ''], ['TeX Live', 'https://www.tug.org/texlive/windows.html', '']]
};
function TexDialog({ t, onClose }) {
  const [status, setStatus] = useState(null); const [bin, setBin] = useState(''); const [error, setError] = useState('');
  const [saving, setSaving] = useState(false); const [testing, setTesting] = useState(false); const [results, setResults] = useState(null);
  const load = useCallback(() => { setError(''); return rpc('texStatus', { refresh: true }).then(value => { setStatus(value); setBin(value.texBin || ''); }).catch(failure => setError(messageOf(failure))); }, []);
  useEffect(() => { load(); }, [load]);
  async function saveBin(value) {
    setSaving(true); setError('');
    try { const next = await rpc('setTexBin', { bin: value }); setStatus(next); setBin(next.texBin || ''); setResults(null); }
    catch (failure) { setError(messageOf(failure)); } finally { setSaving(false); }
  }
  async function runTest() {
    setTesting(true); setResults(null); setError('');
    try { setResults((await rpc('testTex')).results); } catch (failure) { setError(messageOf(failure)); } finally { setTesting(false); }
  }
  const none = status && !status.engines.length;
  return <Dialog title={t('texEnv')} onClose={onClose} busy={testing} className="fo-tex">
    <p className="fo-dialog-copy">{t('texEnvLead')}</p>
    {!status ? <p className="fo-muted fo-tex-wait">{error ? <span className="fo-form-error">{error}</span> : <><span className="fo-spinner" /> {t('texChecking')}</>}</p> : <>
      <ul className="fo-tex-tools">{TEX_TOOLS.map(([tool, label]) => { const item = status.tools[tool]; return <li key={tool} className={item ? 'is-ok' : 'is-missing'}>
        <span className="fo-tex-dot" aria-hidden="true" /><strong>{label}</strong><span className="fo-tex-detail" title={item?.path || ''}>{item ? item.version || item.path : t('texNotFound')}</span>
      </li>; })}</ul>
      {status.missingPackages && <p className="fo-tex-note">{status.missingPackages.length ? <>{t('texMissingPackages')} <code>{status.missingPackages.join(', ')}</code></> : t('texPackagesOk')}</p>}
      {none && <div className="fo-tex-install"><strong>{t('texInstall')}</strong>{(TEX_INSTALL[status.platform] || TEX_INSTALL.linux).map(([name, url, command]) => <p key={name}><a href={url} target="_blank" rel="noreferrer">{name}</a>{command && <code>{command}</code>}</p>)}<p className="fo-muted">{t('texInstallAfter')}</p></div>}
      <form className="fo-tex-bin" onSubmit={event => { event.preventDefault(); saveBin(bin); }}>
        <label className="fo-field"><span>{t('texFolder')}</span><input value={bin} disabled={saving} placeholder={t('texFolderAuto')} spellCheck={false} onChange={event => { setBin(event.target.value); setError(''); }} /></label>
        <button className="fo-btn" disabled={saving || bin.trim() === (status.texBin || '')}>{t('save')}</button>
        {status.texBin && <button type="button" className="fo-btn" disabled={saving} onClick={() => saveBin('')}>{t('texAuto')}</button>}
      </form>
      <p className="fo-tex-note fo-muted">{t('texFolderHint')}</p>
      {(testing || results) && <ul className="fo-tex-results">{testing ? <li className="is-running"><span className="fo-spinner" /> {t('texTesting')}</li> : results.length ? results.map(item => <li key={item.id} className={item.ok ? 'is-ok' : 'is-failed'}>
        <Icon name={item.ok ? 'check' : 'alert'} size={14} /><strong>{TEX_TESTS[item.id] || item.id}</strong><small>{(item.durationMs / 1000).toFixed(1)}s</small>
        {!item.ok && item.error && <pre>{item.error}</pre>}
      </li>) : <li className="is-failed"><Icon name="alert" size={14} /> {t('texNothingToTest')}</li>}</ul>}
      {error && <p className="fo-form-error" role="alert">{error}</p>}
    </>}
    <footer>
      <button className="fo-btn" onClick={() => { setStatus(null); setResults(null); load(); }} disabled={testing || saving}><Icon name="refresh" size={14} /> {t('texRedetect')}</button>
      <span className="fo-spacer" />
      <button className="fo-btn" onClick={onClose} disabled={testing}>{t('close')}</button>
      <button className="fo-btn is-primary" onClick={runTest} disabled={!status || none || testing || saving}>{testing ? <span className="fo-spinner" /> : <Icon name="play" fill size={12} />} {t('texTest')}</button>
    </footer>
  </Dialog>;
}

function Library({ t, locale, projects, loading, onOpen, onCreate, onRename, onDelete, onImport }) {
  const [name, setName] = useState(''); const [template, setTemplate] = useState(locale.startsWith('zh') ? 'ctex' : 'article');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [dialog, setDialog] = useState(null); const [menu, setMenu] = useState(null);
  const templates = [['article', t('tplArticle'), t('tplArticleHint')], ['ctex', t('tplCtex'), t('tplCtexHint')], ['blank', t('tplBlank'), t('tplBlankHint')]];
  const [importing, setImporting] = useState(null); const [importError, setImportError] = useState(''); const [dragging, setDragging] = useState(false);
  const [tex, setTex] = useState(null); const [texOpen, setTexOpen] = useState(false);
  const zipRef = useRef(null); const folderRef = useRef(null); const nameRef = useRef(null);
  const checkTex = useCallback(() => rpc('texStatus', { quick: true, refresh: true }).then(setTex).catch(() => setTex({ engines: [] })), []);
  useEffect(() => { checkTex(); }, [checkTex]);
  async function runImport(source) {
    if (importing) return;
    setImporting({ done: 0, total: 0 }); setImportError('');
    try { const { name, entries } = await importSource(source); await onImport(name, entries, (done, total) => setImporting({ name, done, total })); }
    catch (failure) { setImportError(messageOf(failure)); } finally { setImporting(null); }
  }
  function drop(event) {
    event.preventDefault(); setDragging(false);
    const item = [...event.dataTransfer.items].find(entry => entry.kind === 'file');
    const entry = item?.webkitGetAsEntry?.();
    const file = item?.getAsFile();
    if (entry?.isDirectory) runImport({ entry });
    else if (file && /\.zip$/i.test(file.name)) runImport({ zip: file });
    else setImportError(t('importDropHint'));
  }
  return <div className="fo-library" onContextMenu={event => { if (event.target.closest('input, textarea, select, a[href], .fo-menu, .fo-dialog')) return; setMenu({ project: null, anchor: menuAt(event) }); }}><div className="fo-library-inner">
    <header className="fo-library-head"><div className="fo-wordmark"><FolioMark size={36} /><div><h1>{t('panel')}</h1><p className="fo-lead">{t('libraryLead')}</p></div></div>
      <button className={`fo-tex-pill ${tex ? (tex.engines.length ? 'is-ok' : 'is-missing') : ''}`} onClick={() => setTexOpen(true)} title={t('texEnv')}>
        <span className="fo-tex-dot" aria-hidden="true" />{!tex ? t('texChecking') : tex.engines.length ? `TeX · ${tex.engines.map(engine => ENGINE_LABEL[engine]).join(', ')}` : t('texMissing')}
      </button>
    </header>
    <form className="fo-create" onSubmit={async event => { event.preventDefault(); if (!name.trim()) { setError(t('required')); return; } setBusy(true); setError(''); try { await onCreate(name.trim(), template); setName(''); } catch (failure) { setError(messageOf(failure)); } finally { setBusy(false); } }}>
      <label className="fo-field"><span>{t('newProject')}</span><input ref={nameRef} data-testid="folio-name-input" value={name} disabled={busy} placeholder={t('projectPlaceholder')} onChange={event => { setName(event.target.value); setError(''); }} /></label>
      <button className="fo-btn is-primary fo-create-submit" disabled={busy}>{busy ? t('creating') : t('create')}</button>
      <fieldset className="fo-templates"><legend>{t('template')}</legend>{templates.map(([id, label, hint]) => <label key={id} className={template === id ? 'is-selected' : ''}><input type="radio" name="template" value={id} checked={template === id} onChange={() => setTemplate(id)} /><strong>{label}</strong><small>{hint}</small></label>)}</fieldset>
      {error && <p className="fo-form-error" role="alert">{error}</p>}
    </form>
    <section className={`fo-import ${dragging ? 'is-drop' : ''}`} onDragOver={event => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); setDragging(true); } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }} onDrop={drop}>
      <Icon name="import" size={18} />
      <div className="fo-import-copy"><strong>{importing ? (importing.total ? `${t('importing')} ${importing.done}/${importing.total}` : t('importReading')) : t('importTitle')}</strong><small>{t('importHint')}</small></div>
      <div className="fo-import-actions">
        <button className="fo-btn" disabled={Boolean(importing)} onClick={() => zipRef.current?.click()}>{t('importZip')}</button>
        <button className="fo-btn" disabled={Boolean(importing)} onClick={() => folderRef.current?.click()}>{t('importFolder')}</button>
      </div>
      <input ref={zipRef} type="file" accept=".zip,application/zip" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) runImport({ zip: file }); }} />
      <input ref={folderRef} type="file" webkitdirectory="" directory="" multiple hidden onChange={event => { const files = [...(event.target.files || [])]; event.target.value = ''; if (files.length) runImport({ folder: files }); }} />
      {importError && <p className="fo-form-error" role="alert">{importError}</p>}
    </section>
    <section className="fo-shelf">
      <header><h2>{t('library')}</h2><span className="fo-count">{projects.length}</span></header>
      {!projects.length && !loading ? <p className="fo-shelf-empty">{t('noProjects')}</p> : <div className="fo-pages">{projects.map((project, index) => <article key={project.id} className="fo-page" style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}>
        <button className="fo-page-open" onClick={() => onOpen(project.id)} onContextMenu={event => setMenu({ project, anchor: menuAt(event) })} aria-label={`${t('open')} ${project.name}`}>
          <span className="fo-page-icon" aria-hidden="true"><Icon name="tex" size={18} /></span>
          <strong>{project.name}</strong>
          <small>{ENGINE_LABEL[project.engine] || 'pdfLaTeX'} · {t('edited')} {relativeTime(project.updatedAt, locale)}</small>
        </button>
        <button className="fo-page-more" aria-label="…" onClick={event => { const box = event.currentTarget.getBoundingClientRect(); setMenu({ project, anchor: { position: 'fixed', top: box.bottom + 4, left: Math.max(8, box.right - 160) } }); }}><Icon name="more" /></button>
      </article>)}</div>}
    </section>
  </div>
    {texOpen && <TexDialog t={t} onClose={() => { setTexOpen(false); checkTex(); }} />}
    {menu && <Menu anchor={menu.anchor} onClose={() => setMenu(null)} items={menu.project ? [{ label: t('open'), icon: 'tex', run: () => onOpen(menu.project.id) }, { label: t('rename'), run: () => setDialog({ kind: 'rename', project: menu.project }) }, '-', { label: t('delete'), danger: true, run: () => setDialog({ kind: 'delete', project: menu.project }) }]
      : [{ label: t('newProjectShort'), icon: 'plus', run: () => nameRef.current?.focus() }, { label: t('importZip'), icon: 'import', run: () => zipRef.current?.click() }, { label: t('importFolder'), icon: 'folder', run: () => folderRef.current?.click() }, '-', { label: t('texEnv'), icon: 'gear', run: () => setTexOpen(true) }]} />}
    {dialog && <Dialog title={dialog.kind === 'rename' ? t('rename') : t('delete')} onClose={() => setDialog(null)}>
      <PromptForm t={t} label={t('projectName')} initial={dialog.project.name} danger={dialog.kind === 'delete'} message={dialog.kind === 'delete' ? `${t('deleteProjectConfirm')} — ${dialog.project.name}` : ''} submitLabel={dialog.kind === 'delete' ? t('delete') : t('save')} onCancel={() => setDialog(null)} onSubmit={async value => { if (dialog.kind === 'delete') await onDelete(dialog.project.id); else await onRename(dialog.project.id, value); setDialog(null); }} />
    </Dialog>}
  </div>;
}

/* ───────────── file tree ───────────── */

function FileTree({ t, files, activePath, mainFile, onOpen, onAction, onUpload }) {
  const [collapsed, setCollapsed] = useState(() => new Set()); const [dragging, setDragging] = useState(false); const [menu, setMenu] = useState(null);
  const rows = useMemo(() => {
    const entries = new Map();
    for (const file of files) {
      const parts = file.path.split('/');
      parts.slice(0, -1).forEach((_, i) => { const path = parts.slice(0, i + 1).join('/'); if (!entries.has(path)) entries.set(path, { path, name: parts[i], depth: i, directory: true }); });
      entries.set(file.path, { ...file, name: parts[parts.length - 1], depth: parts.length - 1 });
    }
    return [...entries.values()].sort((a, b) => {
      const pa = a.path.split('/'), pb = b.path.split('/');
      for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
        if (pa[i] !== pb[i]) { const aDir = i < pa.length - 1 || a.directory, bDir = i < pb.length - 1 || b.directory; if (aDir !== bDir) return aDir ? -1 : 1; return pa[i].localeCompare(pb[i]); }
      }
      return pa.length - pb.length;
    });
  }, [files]);
  const hidden = path => { const parts = path.split('/'); return parts.slice(0, -1).some((_, i) => collapsed.has(parts.slice(0, i + 1).join('/'))); };
  const toggleFolder = path => setCollapsed(previous => { const next = new Set(previous); next.has(path) ? next.delete(path) : next.add(path); return next; });
  const copyPath = path => navigator.clipboard?.writeText(path).catch(() => {});
  // Right-click: a file, a folder, or the empty space below the tree.
  const treeMenu = row => !row ? [
    { label: t('newFile'), icon: 'plus', run: () => onAction('new', '') },
    { label: t('uploadFiles'), icon: 'upload', run: () => onAction('upload') },
    '-',
    { label: t('collapseAll'), run: () => setCollapsed(new Set(rows.filter(item => item.directory).map(item => item.path))) },
    { label: t('expandAll'), run: () => setCollapsed(new Set()) }
  ] : row.directory ? [
    { label: collapsed.has(row.path) ? t('expand') : t('collapse'), icon: 'folder', run: () => toggleFolder(row.path) },
    { label: t('newFileHere'), icon: 'plus', run: () => onAction('new', `${row.path}/`) },
    '-',
    { label: t('copyPath'), icon: 'copy', run: () => copyPath(row.path) }
  ] : [
    { label: t('open'), icon: row.kind === 'image' ? 'image' : 'tex', run: () => onOpen(row.path) },
    row.path.endsWith('.tex') && row.path !== mainFile && { label: t('setMain'), icon: 'star', run: () => onAction('main', row.path) },
    '-',
    { label: t('rename'), run: () => onAction('rename', row.path) },
    { label: t('copyPath'), icon: 'copy', run: () => copyPath(row.path) },
    '-',
    { label: t('delete'), danger: true, run: () => onAction('delete', row.path) }
  ];
  return <div className={`fo-tree ${dragging ? 'is-drop' : ''}`} onContextMenu={event => setMenu({ row: null, anchor: menuAt(event) })} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }} onDrop={event => { event.preventDefault(); setDragging(false); if (event.dataTransfer.files.length) onUpload([...event.dataTransfer.files]); }}>
    <nav aria-label={t('files')}>{rows.map(row => hidden(row.path) ? null : <div key={row.path} className={`fo-tree-row ${row.path === activePath ? 'is-active' : ''} ${menu?.row?.path === row.path ? 'is-menu' : ''}`} style={{ '--depth': row.depth }} onContextMenu={event => setMenu({ row, anchor: menuAt(event) })}>
      <button className="fo-tree-item" title={row.path} onClick={() => row.directory ? toggleFolder(row.path) : onOpen(row.path)}>
        {row.directory ? <span className={`fo-tree-caret ${collapsed.has(row.path) ? '' : 'is-open'}`}><Icon name="right" size={12} /></span> : <span className="fo-tree-caret" />}
        <span className={`fo-tree-icon kind-${row.directory ? 'folder' : row.kind}`}><Icon name={row.directory ? 'folder' : row.kind === 'image' ? 'image' : 'tex'} size={14} /></span>
        <span className="fo-tree-name">{row.name}</span>
        {row.path === mainFile && <span className="fo-tree-main" title={t('mainFile')}><Icon name="star" size={11} fill /></span>}
      </button>
      {!row.directory && <button className="fo-tree-more" aria-label="…" onClick={event => { const box = event.currentTarget.getBoundingClientRect(); setMenu({ row, anchor: { position: 'fixed', top: box.bottom + 2, left: box.left - 120 } }); }}><Icon name="more" size={14} /></button>}
    </div>)}</nav>
    {dragging && <div className="fo-drop-hint">{t('dropHere')}</div>}
    {menu && <Menu anchor={menu.anchor} onClose={() => setMenu(null)} items={treeMenu(menu.row)} />}
  </div>;
}

/* ───────────── the embedded Harness conversation ───────────── */

function FixedChatView(props) { return <>{props.renderSlot('conversation.session', { view: 'chat' })}</>; }
// Mirrors DSH's own embedded Conversation (subagent tab): native composer, model picker,
// Markdown, reasoning and tool rows all come from the Harness chat itself.
function FolioChat({ sessionId, onRunning, useSession, useSessions, renderFactorySlot }) {
  const openState = useSession(value => value.openState);
  const running = useSession(value => Boolean(value.running));
  const summaryBlank = useSessions(state => state.byId[sessionId]?.blank);
  const phase = openState === 'loading' && summaryBlank !== true ? 'settling' : 'active';
  useEffect(() => { onRunning?.(running); }, [running]);
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero: false }, { slots: { views: FixedChatView } });
}

/* ───────────── resizable workbench ───────────── */

function useElementSize(ref) {
  const [size, setSize] = useState({ width: 1200, height: 800 });
  useEffect(() => { if (!ref.current) return; const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height })); observer.observe(ref.current); return () => observer.disconnect(); }, []);
  return size;
}
function Handle({ onDrag, onDone, label, axis = 'x' }) {
  return <div className={`fo-handle is-${axis}`} role="separator" aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'} aria-label={label} tabIndex={0} onKeyDown={event => {
    const amount = event.shiftKey ? 32 : 12;
    const delta = { ArrowLeft: [-amount, 0], ArrowRight: [amount, 0], ArrowUp: [0, -amount], ArrowDown: [0, amount] }[event.key];
    if (!delta || (axis === 'x' ? delta[0] === 0 : delta[1] === 0)) return;
    event.preventDefault();
    onDrag(...delta);
    onDone?.();
  }} onPointerDown={event => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget; handle.setPointerCapture(event.pointerId);
    const root = handle.closest('.fo-root'); root?.classList.add('is-resizing');
    let lastX = event.clientX, lastY = event.clientY;
    const move = moveEvent => { onDrag(moveEvent.clientX - lastX, moveEvent.clientY - lastY); lastX = moveEvent.clientX; lastY = moveEvent.clientY; };
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); root?.classList.remove('is-resizing'); onDone?.(); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  }}><span /></div>;
}

/* ───────────── chats of this manuscript ───────────── */

const EMPTY_LIST = { ids: [], byId: {} };
function useSessionList(sessions) {
  return useSyncExternalStore(
    useCallback(listener => sessions?.list?.subscribe?.(listener) || (() => {}), [sessions]),
    () => sessions?.list?.getSnapshot?.() || EMPTY_LIST
  );
}
// Chats are the Harness Sessions whose directory is this manuscript's folder.
function ChatSwitcher({ t, locale, services, directory, currentId, running, onSwitch, onNew, onArchive, archived, separateHeading }) {
  const list = useSessionList(services.sessions);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const listener = event => { if (!ref.current?.contains(event.target)) setOpen(false); };
    const key = event => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', listener); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', listener); window.removeEventListener('keydown', key); };
  }, [open]);
  // Session list rows are keyed by `id`; DSH titles a chat after its first exchange.
  // The Session list still carries archived chats; hide the ones archived here.
  const rows = Object.values(list.byId || {}).filter(item => item && directory && item.cwd === directory && !item.parentSessionId && (!archived.has(item.id) || item.id === currentId));
  const chats = rows.filter(item => !item.blank || item.id === currentId).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const empty = rows.filter(item => item.blank && item.id !== currentId && !item.running).map(item => item.id);
  const titleOf = item => item?.title?.trim() || (item?.blank ? '' : item?.displayTitle?.trim()) || t('untitledChat');
  return <div className="fo-chat-switch" ref={ref}>
    <button className="fo-chat-switch-btn" aria-expanded={open} onClick={() => setOpen(!open)} title={t('chats')}>
      {!separateHeading && <Icon name="spark" size={13} />}<span>{currentId ? titleOf(list.byId?.[currentId]) : t(separateHeading ? 'currentChat' : 'assistant')}</span><Icon name="chevron" size={13} />
    </button>
    {open && <div className="fo-popover fo-chat-list" role="menu">
      <header><span className="fo-caps">{t('chats')}</span><button className="fo-btn is-small" disabled={running} onClick={() => { setOpen(false); onNew(); }}><Icon name="plus" size={13} /> {t('newChat')}</button></header>
      {chats.length ? <ul>{chats.map(item => <li key={item.id} className={item.id === currentId ? 'is-current' : ''}>
        <button className="fo-chat-row" role="menuitem" disabled={running && item.id !== currentId} onClick={() => { setOpen(false); if (item.id !== currentId) onSwitch(item.id); }}>
          <span className="fo-chat-title">{item.running && <i className="fo-live-dot" />}{titleOf(item)}</span>
          <small>{relativeTime(new Date(item.updatedAt || Date.now()).toISOString(), locale)}</small>
        </button>
        {!item.running && <button className="fo-icon-btn" title={t('archive')} aria-label={`${t('archive')} ${titleOf(item)}`} onClick={() => onArchive([item.id])}><Icon name="archive" size={14} /></button>}
      </li>)}</ul> : <p className="fo-muted fo-chat-none">{t('noChats')}</p>}
      {empty.length > 0 && <footer><button className="fo-btn is-small" onClick={() => onArchive(empty)}><Icon name="archive" size={13} /> {t('archiveEmpty')} ({empty.length})</button></footer>}
    </div>}
  </div>;
}
function DockMenu({ t, dock, onDock }) {
  const [anchor, setAnchor] = useState(null);
  const options = [['workspace', t('dockWorkspace')], ['right', t('dockRight')], ['left', t('dockLeft')], ['bottom', t('dockBottom')], ['float', t('dockFloat')]];
  return <>
    <button className="fo-icon-btn" title={t('dock')} aria-label={t('dock')} onClick={event => { const box = event.currentTarget.getBoundingClientRect(); setAnchor({ position: 'fixed', top: box.bottom + 4, left: Math.max(8, box.right - 180) }); }}><Icon name={dock === 'workspace' ? 'dock-bottom' : 'dock-' + dock} /></button>
    {anchor && <Menu anchor={anchor} onClose={() => setAnchor(null)} items={options.map(([value, label]) => ({ label: `${value === dock ? '✓ ' : '\u2003'}${label}`, run: () => onDock(value) }))} />}
  </>;
}

/* ───────────── workspace ───────────── */

function useCaptionSeat(workspace) {
  const [seat, setSeat] = useState(null);
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!root.hasAttribute('data-windows-titlebar')) return;
    const frame = workspace.current;
    let menu = null;
    const observer = new ResizeObserver(measure);
    function measure() {
      const next = document.querySelector('[data-windows-menu]');
      if (next !== menu) {
        if (menu) observer.unobserve(menu);
        menu = next;
        if (menu) observer.observe(menu);
      }
      const box = menu?.getBoundingClientRect();
      const overlay = navigator.windowControlsOverlay;
      const native = overlay?.visible ? overlay.getTitlebarAreaRect() : null;
      const right = native?.width > 0 ? native.right : root.clientWidth - 155;
      const left = Math.ceil((box?.right || 0) + 10);
      const width = Math.min(490, Math.floor(right - left - 12));
      const height = Math.round(box?.height || 0);
      setSeat(current => {
        if (!box?.width || !height || width < 135 || !frame?.offsetWidth) return null;
        return current?.left === left && current.width === width && current.height === height ? current : { left, width, height };
      });
    }
    const mount = new MutationObserver(measure);
    mount.observe(document.body, { childList: true });
    if (frame) observer.observe(frame);
    window.addEventListener('resize', measure);
    navigator.windowControlsOverlay?.addEventListener('geometrychange', measure);
    measure();
    return () => {
      mount.disconnect();
      observer.disconnect();
      window.removeEventListener('resize', measure);
      navigator.windowControlsOverlay?.removeEventListener('geometrychange', measure);
    };
  }, [workspace]);
  return seat;
}

function Workspace({ t, locale, services, projectId, onExit, onImport, onCreate, renderSlot, SessionProvider, toast }) {
  const [project, setProject] = useState(null);
  const [files, setFiles] = useState([]);
  const [file, setFile] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState('saved');
  const [conflict, setConflict] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, from: 1, to: 1, text: '' });
  const [build, setBuild] = useState(null);
  const [compiling, setCompiling] = useState(false);
  const activeBuild = useRef(false);
  const repeatBuild = useRef(false);
  const [showIssues, setShowIssues] = useState(false);
  const [issueFilter, setIssueFilter] = useState('all');
  const [activeIssue, setActiveIssue] = useState(null);
  const [issueJump, setIssueJump] = useState(null);
  const jumpingIssue = useRef(false);
  const [historyBuild, setHistoryBuild] = useState(null);
  const [proposals, setProposals] = useState([]);
  const [reviewing, setReviewing] = useState(null);
  const [writeApproval, setWriteApproval] = useState(null);
  const [proposalHistory, setProposalHistory] = useState([]);
  const [proposalBusy, setProposalBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const historyRef = useRef(null);
  const [grant, setGrant] = useState(null);
  const [scopeDialog, setScopeDialog] = useState(null);
  const [scopeBusy, setScopeBusy] = useState(false);
  const [session, setSession] = useState({ id: '', reference: null, error: '', opening: false });
  const [running, setRunning] = useState(false);
  const [layout, setLayout] = useState(() => normalizeLayout(readStored(LAYOUT_KEY, {})));
  const [mobilePane, setMobilePane] = useState('editor');
  const [lowerPane, setLowerPane] = useState('files');
  const [autoCompile, setAutoCompile] = useState(() => readStored(AUTO_KEY, false));
  const [archived, setArchived] = useState(() => { const saved = readStored(ARCHIVED_KEY, []); return new Set(Array.isArray(saved) ? saved.filter(id => typeof id === 'string') : []); });
  const [dialog, setDialog] = useState(null);
  const [formatDialog, setFormatDialog] = useState(null);
  const [formulaDraft, setFormulaDraft] = useState('');
  const [formatIssue, setFormatIssue] = useState(null);
  const [contentsBusy, setContentsBusy] = useState(false);
  const [contentsRequest, setContentsRequest] = useState(null);
  const [projectAnalysis, setProjectAnalysis] = useState(null);
  const [referenceReport, setReferenceReport] = useState(null);
  const syncPending = useRef(false);
  const openRequest = useRef(0);
  const [checkResult, setCheckResult] = useState(null);
  const [mainHasGraphics, setMainHasGraphics] = useState(null);
  const [mainHasBooktabs, setMainHasBooktabs] = useState(null);
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef(null);
  const [exporting, setExporting] = useState(false);
  const [importingTemplate, setImportingTemplate] = useState(false);
  const templateRef = useRef(null);
  const [compileMenu, setCompileMenu] = useState(false);
  const [drop, setDrop] = useState(null);
  const [texOpen, setTexOpen] = useState(false);
  const [editorSettings, setEditorSettings] = useState(() => ({ ...EDITOR_DEFAULTS, ...readStored(EDITOR_KEY, {}) }));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menu, setMenu] = useState(null);
  const pdfApi = useRef(null);
  const rootRef = useRef(null); const editorApi = useRef(null); const uploadRef = useRef(null); const mounted = useRef(true);
  const captionSeat = useCaptionSeat(rootRef);
  const live = useRef({}); live.current = { project, file, dirty, autoCompile, session, cursor };
  const saving = useRef(null); const saveTimer = useRef(0); const generation = useRef(0);
  const { width, height } = useElementSize(rootRef);
  const narrow = width < 735;
  const compact = width < 1070;
  const [compactChat, setCompactChat] = useState(false);
  const [showChatTools, setShowChatTools] = useState(false);
  useEffect(() => {
    if (!showHistory) return;
    const pointer = event => { if (!historyRef.current?.contains(event.target)) setShowHistory(false); };
    const key = event => { if (event.key === 'Escape') setShowHistory(false); };
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', pointer);
      document.removeEventListener('keydown', key);
    };
  }, [showHistory]);
  useEffect(() => {
    if (!exportOpen) return;
    const pointer = event => { if (!exportRef.current?.contains(event.target)) setExportOpen(false); };
    const key = event => { if (event.key === 'Escape') setExportOpen(false); };
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', pointer);
      document.removeEventListener('keydown', key);
    };
  }, [exportOpen]);

  const updateLayout = patch => setLayout(previous => { const next = typeof patch === 'function' ? patch(previous) : { ...previous, ...patch }; return next; });
  useEffect(() => { store(LAYOUT_KEY, layout); }, [layout]);
  useEffect(() => { store(EDITOR_KEY, editorSettings); }, [editorSettings]);
  const updateEditor = patch => setEditorSettings(previous => ({ ...previous, ...patch }));
  const zoomEditor = delta => setEditorSettings(previous => ({ ...previous, size: delta === 0 ? EDITOR_DEFAULTS.size : clampSize(previous.size + delta) }));
  const openMenu = (event, items) => setMenu({ anchor: menuAt(event), items });
  useEffect(() => { store(AUTO_KEY, autoCompile); }, [autoCompile]);

  const loadFiles = useCallback(async () => { const { files: list } = await rpc('listFiles', { projectId }); setFiles(list); return list; }, [projectId]);
  const loadProposals = useCallback(async () => { const { proposals: list, history } = await rpc('listProposals', { projectId }); setProposals(list); setProposalHistory(history || []); setReviewing(current => current && !list.some(item => item.id === current) ? null : current); return list; }, [projectId]);
  const replaceFile = value => { generation.current += 1; const next = { ...value, key: `${value.path}#${generation.current}` }; live.current = { ...live.current, file: next, dirty: false }; setFile(next); setCursor({ line: next.initialLine || 1, from: next.initialLine || 1, to: next.initialLine || 1, text: '' }); if (next.kind === 'text') store(EDIT_STATE_KEY + projectId, { path: next.path, line: next.initialLine || 1 }); setDirty(false); setSaveState('saved'); setConflict(false); };

  async function save({ urgent = false } = {}) {
    clearTimeout(saveTimer.current);
    if (saving.current) { await saving.current; if (!live.current.dirty) return; }
    const run = (async () => {
      while (live.current.file && live.current.dirty && live.current.file.kind === 'text') {
        const current = live.current.file;
        setSaveState('saving');
        try {
          const result = await rpc('writeFile', { projectId, path: current.path, content: current.content, expectedHash: current.hash }, { keepalive: urgent });
          const latest = live.current.file;
          if (!latest || latest.key !== current.key) return;
          const stillDirty = latest.content !== current.content;
          const nextFile = { ...latest, hash: result.hash };
          live.current = { ...live.current, file: nextFile, dirty: stillDirty };
          setFile(nextFile); setDirty(stillDirty); setSaveState(stillDirty ? 'dirty' : 'saved');
        } catch (error) {
          if (error.code === 'CONFLICT') { setConflict(true); setSaveState('dirty'); return; }
          setSaveState('dirty'); throw error;
        }
      }
    })();
    saving.current = run;
    try { await run; } finally { if (saving.current === run) saving.current = null; }
  }
  const saveQuietly = () => save().catch(error => toast(messageOf(error), 'error'));
  // Save before replacing or leaving the open file. Edits that could not be written (the file
  // changed on disk, or the request failed) stay in the editor instead of being dropped.
  async function flushEdits() {
    await save();
    if (live.current.dirty) throw new Error(t('unsavedBlocked'));
  }
  const leave = async () => { try { await flushEdits(); onExit(); } catch (error) { toast(messageOf(error), 'error'); } };
  const saveRef = useRef(save); saveRef.current = save;
  useEffect(() => {
    // Typing is saved after a short pause; closing or hiding the page must not lose that pause.
    const hidden = () => { if (document.visibilityState === 'hidden' && live.current.dirty) saveRef.current({ urgent: true }).catch(() => {}); };
    const closing = event => { if (live.current.dirty) { saveRef.current({ urgent: true }).catch(() => {}); event.preventDefault(); event.returnValue = ''; } };
    document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', hidden); window.addEventListener('beforeunload', closing);
    return () => {
      document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', hidden); window.removeEventListener('beforeunload', closing);
      // Leaving Folio for another Harness page unmounts the workspace: write what is pending.
      if (live.current.dirty) saveRef.current({ urgent: true }).catch(() => {});
    };
  }, []);

  // Resolves true once `path` is the open file.
  async function openFile(path, entries = files, line) {
    const request = ++openRequest.current;
    try {
      await flushEdits();
      if (request !== openRequest.current) return false;
      const entry = entries.find(item => item.path === path) || { path, kind: isTextPath(path) ? 'text' : 'binary' };
      const result = entry.kind === 'text' ? await rpc('readFile', { projectId, path }) : { path, content: '', hash: null };
      if (request !== openRequest.current) return false;
      setReviewing(null);
      replaceFile({ ...result, kind: entry.kind, initialLine: line });
      if (narrow) setMobilePane('editor');
      return true;
    } catch (error) { toast(messageOf(error), 'error'); return false; }
  }

  async function compile({ automatic = false } = {}) {
    if (activeBuild.current) { if (automatic) repeatBuild.current = true; return; }
    activeBuild.current = true;
    setCompiling(true);
    try {
      await flushEdits();
      const result = await rpc('compile', { projectId, automatic });
      setBuild(result);
      setHistoryBuild(null);
      setShowIssues(!result.ok || result.problems?.some(item => item.code === 'IGNORED_TAIL'));
    } catch (error) { toast(messageOf(error), 'error'); }
    finally {
      activeBuild.current = false;
      setCompiling(false);
      if (repeatBuild.current) {
        repeatBuild.current = false;
        if (mounted.current && live.current.autoCompile) queueMicrotask(() => compileRef.current({ automatic: true }));
      }
    }
  }
  const compileRef = useRef(compile); compileRef.current = compile;
  const saveAndMaybeCompile = async () => { try { await save(); compileRef.current(); } catch (error) { toast(messageOf(error), 'error'); } };

  // Initial load: project, files, last build, proposals and the project's writing session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await rpc('getProject', { projectId });
        if (cancelled) return;
        setProject(info);
        const list = await loadFiles();
        const remembered = readStored(EDIT_STATE_KEY + projectId, {});
        const first = list.find(item => item.path === remembered.path && item.kind === 'text') || list.find(item => item.path === info.mainFile) || list.find(item => item.path.endsWith('.tex')) || list.find(item => item.kind === 'text');
        if (first && !cancelled) { const result = await rpc('readFile', { projectId, path: first.path }); if (!cancelled) replaceFile({ ...result, kind: 'text', initialLine: first.path === remembered.path ? remembered.line : 1 }); }
        const { build: last } = await rpc('lastBuild', { projectId });
        if (!cancelled) setBuild(last || null);
        await loadProposals();
      } catch (error) { if (!cancelled) toast(messageOf(error), 'error'); }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  async function workspaceOf(info) {
    // Each manuscript folder is its own Harness Workspace, so its chats group under the title in DSH.
    const { workspace, created } = unwrap(await services.remote.workspace.create({ path: info.directory }));
    if (created || workspace.title !== info.name) await services.remote.workspace.rename({ workspaceId: workspace.workspaceId, title: info.name }).catch(() => {});
    return workspace;
  }
  async function createSession(info) {
    const workspace = await workspaceOf(info);
    const created = unwrap(await services.remote.session.create({ workspaceId: workspace.workspaceId, agentPreset: PRESET }));
    const updated = await rpc('updateProject', { projectId, sessionId: created.sessionId });
    setProject(updated);
    return created.sessionId;
  }
  async function bindSession(info, { fresh = false, target = '' } = {}) {
    // One binding at a time per project: a remount or repeated click must never mint extra chats.
    if (bindings.has(projectId)) return bindings.get(projectId);
    const run = (async () => {
      setSession(previous => { previous.reference?.release(); return { id: '', reference: null, error: '', opening: true }; });
      try {
        let id = fresh ? '' : target || info.sessionId;
        if (target && target !== info.sessionId) setProject(await rpc('updateProject', { projectId, sessionId: target }));
        // The browser's Session list loads asynchronously; retain() rejects ids it has not seen yet.
        if (id && await waitForSession(services.sessions, id) === 'missing') id = '';
        if (!id) {
          id = await createSession(info);
          if (await waitForSession(services.sessions, id, 20000) !== 'found') throw new Error(t('chatUnavailable'));
        } else {
          // Chats created before workspaces (or moved in DSH) are adopted into the manuscript's workspace.
          const workspace = await workspaceOf(info).catch(() => null);
          if (workspace && !workspace.sessionIds.includes(id)) await services.remote.workspace.insertSessionBefore({ workspaceId: workspace.workspaceId, sessionId: id }).catch(() => {});
        }
        await rpc('focus', { projectId, sessionId: id, clear: true });
        setGrant(null);
        const reference = services.sessions.retain(id, { source: 'folio' });
        if (!mounted.current) { reference.release(); return; }
        setSession({ id, reference, error: '', opening: false });
      } catch (error) { if (mounted.current) setSession({ id: '', reference: null, error: messageOf(error), opening: false }); }
    })();
    bindings.set(projectId, run);
    try { await run; } finally { bindings.delete(projectId); }
  }
  async function archiveChats(ids) {
    for (const id of ids) {
      try { unwrap(await services.remote.workspace.archiveSession({ sessionId: id })); }
      catch (error) { toast(messageOf(error), 'error'); return; }
      setArchived(previous => { const next = new Set(previous).add(id); store(ARCHIVED_KEY, [...next].slice(-500)); return next; });
    }
    if (ids.includes(live.current.session?.id)) bindSession(live.current.project, { fresh: true });
  }
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; live.current.session?.reference?.release(); }; }, []);

  // The same source scan powers completion, navigation and the citation preflight.
  useEffect(() => {
    if (!project?.mainFile) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const parsed = await readProjectAnalysis(files, project.mainFile, path => rpc('readFile', { projectId, path }));
        if (cancelled) return;
        setProjectAnalysis(parsed);
        Object.assign(projectIndex, {
          labels: [...new Set([...parsed.sources.values()].flatMap(item => item.labels.map(entry => entry.key)))],
          cites: [...new Set([...parsed.bibliographies.values()].flat().map(entry => entry.key))],
          files: files.map(item => item.path)
        });
      } catch {}
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [files, project?.mainFile, saveState === 'saved']);

  useEffect(() => {
    if (!session.id) return;
    const sessionId = session.id;
    return () => { rpc('focus', { projectId, sessionId, clear: true }).catch(() => {}); };
  }, [session.id, projectId]);

  function showScope() {
    if (!file || !session.id) return;
    setScopeDialog({ path: file.path, key: file.key, range: cursor.text ? { start: cursor.start, end: cursor.end } : null, selected: Boolean(cursor.text), related: [] });
  }
  async function saveScope(event) {
    event.preventDefault();
    setScopeBusy(true);
    try {
      await flushEdits();
      const current = live.current.file;
      if (!current || current.key !== scopeDialog.key || live.current.session.id !== session.id) throw new Error(t('scopeChanged'));
      if (scopeDialog.selected && (live.current.cursor.start !== scopeDialog.range.start || live.current.cursor.end !== scopeDialog.range.end)) throw new Error(t('scopeChanged'));
      await rpc('focus', { projectId, sessionId: session.id, path: current.path, hash: current.hash, range: scopeDialog.selected ? scopeDialog.range : null, related: scopeDialog.related });
      setGrant({ ...scopeDialog, hash: current.hash });
      setScopeDialog(null);
    } catch (error) { toast(messageOf(error), 'error'); }
    finally { setScopeBusy(false); }
  }
  async function clearScope() {
    try {
      await rpc('focus', { projectId, sessionId: session.id, clear: true });
      setGrant(null);
    } catch (error) { toast(messageOf(error), 'error'); }
  }

  // While the assistant works, its proposals and builds appear without a manual refresh.
  useEffect(() => {
    if (!running) {
      loadProposals().catch(() => {});
      rpc('lastBuild', { projectId }).then(({ build: last }) => { if (last) setBuild(previous => previous && (previous.builtAt === last.builtAt || previous.builtAt > last.builtAt) ? previous : last); }).catch(() => {});
      return;
    }
    const timer = setInterval(() => { loadProposals().catch(() => {}); }, 2500);
    return () => clearInterval(timer);
  }, [running]);

  async function settle(proposal, accept) {
    if (proposalBusy) return;
    setProposalBusy(true);
    try {
      await flushEdits();
      const args = { projectId, id: proposal.id };
      if (accept && writeApproval === proposal.id) args.allowRisky = true;
      const result = await rpc(accept ? 'applyProposal' : 'rejectProposal', args);
      await loadProposals();
      setReviewing(null);
      if (!accept) { toast(t('discarded')); return; }
      if (result.validation) {
        setHistoryBuild(null);
        setBuild(result.validation);
        setShowIssues(result.status !== 'applied');
      }
      if (result.status !== 'applied') {
        toast(t(result.status === 'cancelled' ? 'validationCancelled' : 'validationFailed'), 'error');
        return;
      }
      const open = live.current.file;
      if (open?.path === result.path && !live.current.dirty) {
        const saved = await rpc('readFile', { projectId, path: result.path });
        if (live.current.file?.key === open.key && !live.current.dirty) replaceFile({ ...saved, kind: 'text', initialLine: live.current.cursor.line });
      }
      toast(t(result.previewError ? 'previewPublishFailed' : 'verifiedApplied'), result.previewError ? 'error' : 'success');
    } catch (error) { toast(error.code === 'CONFLICT' ? t('conflict') : messageOf(error), 'error'); }
    finally { setProposalBusy(false); }
  }

  async function undoProposal(id) {
    if (proposalBusy) return;
    setProposalBusy(true);
    try {
      await flushEdits();
      const { path } = await rpc('undoProposal', { projectId, id });
      const open = live.current.file;
      if (open?.path === path && !live.current.dirty) {
        const saved = await rpc('readFile', { projectId, path });
        if (live.current.file?.key === open.key && !live.current.dirty) replaceFile({ ...saved, kind: 'text', initialLine: live.current.cursor.line });
      }
      await loadProposals();
      toast(t('proposalUndone'), 'success');
      await compileRef.current();
    } catch (error) { toast(error.code === 'CONFLICT' ? t('undoConflict') : messageOf(error), 'error'); }
    finally { setProposalBusy(false); }
  }

  async function cancelBuild() {
    repeatBuild.current = false;
    try { await rpc('cancelCompile', { projectId }); }
    catch (error) { toast(messageOf(error), 'error'); }
  }

  async function uploadNow(list, overwrite) {
    for (const item of list) {
      try { await rpc('uploadFile', { projectId, path: item.name, base64: await fileToBase64(item), overwrite }); }
      catch (error) { toast(`${item.name}: ${messageOf(error)}`, 'error'); }
    }
    await loadFiles().catch(() => {});
    // The open file was replaced on disk: show the new content rather than the stale buffer.
    const open = live.current.file;
    if (overwrite && open?.kind === 'text' && list.some(item => item.name === open.path)) await rpc('readFile', { projectId, path: open.path }).then(result => replaceFile({ ...result, kind: 'text' })).catch(() => {});
  }
  // New files upload at once; files that would replace existing ones wait for a confirmation.
  async function upload(list) {
    const existing = list.filter(item => files.some(entry => entry.path === item.name));
    await uploadNow(list.filter(item => !existing.includes(item)), false);
    if (existing.length) setDialog({ kind: 'overwrite', items: existing });
  }
  async function fileAction(kind, path) {
    if (kind === 'main') { try { setProject(await rpc('updateProject', { projectId, mainFile: path })); } catch (error) { toast(messageOf(error), 'error'); } return; }
    if (kind === 'upload') { uploadRef.current?.click(); return; }
    setDialog({ kind, path });
  }
  async function submitDialog(value) {
    const { kind, path } = dialog;
    if (kind === 'new') {
      await flushEdits();
      await rpc('writeFile', { projectId, path: value, content: '', expectedHash: null });
      await loadFiles();
      replaceFile({ ...(await rpc('readFile', { projectId, path: value })), kind: 'text' });
    } else if (kind === 'rename') {
      await flushEdits();
      try { await rpc('renameFile', { projectId, from: path, to: value }); }
      catch (error) {
        if (error.code === 'MAIN_FILE_EXTENSION') throw new Error(t('renameMainExtension'));
        if (error.code === 'PENDING_PROPOSAL_EXTENSION') throw new Error(t('renamePendingExtension'));
        throw error;
      }
      setGrant(current => current?.path === path || current?.related.includes(path) ? null : current);
      const list = await loadFiles();
      setProject(await rpc('getProject', { projectId }));
      await loadProposals();
      if (live.current.file?.path === path) await openFile(value, list, live.current.cursor.line);
    } else if (kind === 'delete') {
      const entry = files.find(item => item.path === path);
      let hash = null;
      if (entry?.kind === 'text') hash = live.current.file?.path === path ? (await save(), live.current.file.hash) : (await rpc('readFile', { projectId, path })).hash;
      await rpc('deleteFile', { projectId, path, expectedHash: hash });
      const list = await loadFiles();
      if (live.current.file?.path === path) { setFile(null); live.current = { ...live.current, file: null, dirty: false }; const next = list.find(item => item.kind === 'text'); if (next) openFile(next.path); }
    } else if (kind === 'overwrite') {
      await uploadNow(dialog.items, true);
    } else if (kind === 'templateNew') {
      await flushEdits();
      await onCreate(value, dialog.template);
    } else if (kind === 'title') {
      setProject(await rpc('updateProject', { projectId, name: value }));
    }
    setDialog(null);
  }
  async function resolveConflict(keepMine) {
    const current = live.current.file;
    const fresh = await rpc('readFile', { projectId, path: current.path });
    if (keepMine) { const next = { ...current, hash: fresh.hash }; live.current = { ...live.current, file: next, dirty: true }; setFile(next); setConflict(false); await save(); }
    else replaceFile({ ...fresh, kind: 'text' });
  }
  async function setEngine(engine) { try { setProject(await rpc('updateProject', { projectId, engine })); } catch (error) { toast(messageOf(error), 'error'); } }
  async function setMain(mainFile) { try { setProject(await rpc('updateProject', { projectId, mainFile })); } catch (error) { toast(messageOf(error), 'error'); } }

  const onChange = value => {
    const next = { ...live.current.file, content: value };
    live.current = { ...live.current, file: next, dirty: true };
    setFile(next); setDirty(true); setSaveState('dirty');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { save().then(() => { if (live.current.autoCompile && !live.current.dirty) compileRef.current({ automatic: true }); }).catch(error => toast(messageOf(error), 'error')); }, 900);
  };

  const problems = build?.problems || [];
  const issueBuild = historyBuild || build;
  const shownProblems = (issueBuild?.problems || []).map((problem, index) => ({ problem, index }))
    .filter(({ problem }) => issueFilter === 'all' || problem.level === issueFilter);
  const issuePath = problem => problem.file || issueBuild?.mainFile || project?.mainFile;
  const jumpable = ({ problem }) => Boolean(problem.line > 0 && files.some(item => item.path === issuePath(problem) && item.kind === 'text'));
  const jumpableIssues = shownProblems.filter(jumpable);
  const issueIndex = activeIssue && activeIssue.build === issueBuild ? activeIssue.index : -1;
  const errorCount = problems.filter(item => item.level === 'error').length;
  const warningCount = problems.length - errorCount;
  const texFiles = files.filter(item => item.path.endsWith('.tex'));
  const reviewIndex = proposals.findIndex(item => item.id === reviewing);
  const reviewProposal = proposals[reviewIndex];
  function chooseProposal(id) {
    setWriteApproval(null);
    setReviewing(id);
  }
  const canApplyProposal = reviewProposal && (reviewProposal.risk === 'formatting' || writeApproval === reviewProposal.id);
  const formatAvailable = Boolean(file?.kind === 'text' && /[.]tex$/i.test(file.path) && !reviewProposal);
  const activeCheck = !reviewProposal && checkResult?.key === file?.key ? checkResult : null;
  const actionItems = (ids, actions) => ids.map(id => ({
    ...actions[id], label: actions[id].title, disabled: !formatAvailable, run: () => runFormat(id)
  }));
  const toolItem = (action, label, icon) => ({
    label: t(label), icon, disabled: action === 'template' ? !project || importingTemplate : !formatAvailable,
    run: () => runFormat(action)
  });
  const fontItems = actions => actionItems(['bold', 'italic', 'underline', 'mono'], actions);
  function openToolMenu(event, items) {
    const box = event.currentTarget.getBoundingClientRect();
    setMenu({ anchor: { position: 'fixed', top: box.bottom + 4, left: box.left, flip: 12 }, items });
  }
  const formattingPane = <div className="thesis-format" role="group" aria-label={t('typesetting')}>
    {[
      ['heading', 'shortHeading'], ['abstract', 'shortAbstract'], ['contents', 'shortContents'],
      ['table', 'threeLineTable'], ['equation', 'shortEquation'], ['figure', 'shortFigure'],
      ['cite', 'shortCite'], ['font', 'font'], ['check', 'checkSource']
    ].map(([action, label]) => <button key={action} type="button"
      disabled={!formatAvailable || (action === 'check' && activeCheck?.loading) || (action === 'contents' && contentsBusy)} title={t(label)} aria-label={t(label)}
      aria-haspopup={action === 'font' ? 'menu' : undefined}
      onMouseDown={event => event.preventDefault()} onClick={event => {
        if (action === 'font') openToolMenu(event, fontItems(latexActions(t)));
        else runFormat(action);
      }}>
      {t(label)}
    </button>)}
    <button type="button" title={t('moreFormatting')} aria-label={t('moreFormatting')} aria-haspopup="menu" onMouseDown={event => event.preventDefault()} onClick={event => {
      const actions = latexActions(t);
      openToolMenu(event, [
        toolItem('indent', 'formatIndentation'),
        { label: t('checkReferences'), icon: 'quote', disabled: !project || referenceReport?.loading, run: checkProjectReferences },
        toolItem('bodyStart', 'goToBody', 'locate'),
        toolItem('sections', 'templateSections', 'heading'),
        { ...actions.equation, label: t('formulaEmptyEnvironment'), disabled: !formatAvailable, run: () => {
          const view = editorApi.current?.view;
          if (view && formatAllowed('equation', view)) actions.equation.run(view);
        } },
        ...actionItems(['itemize', 'enumerate', 'ref', 'footnote'], actions),
        toolItem('template', 'template', 'import'),
        ...(fixedWorkspace ? ['-', { label: t('lowerTogether'), checked: layout.lowerTogether === true, run: () => updateLayout(previous => ({ ...previous, lowerTogether: !previous.lowerTogether, show: { ...previous.show, files: true, chat: true } })) }] : [])
      ]);
    }}>
      {t('more')}
    </button>
    <input ref={templateRef} hidden type="file" accept=".zip,application/zip" onChange={importTemplate} />
  </div>;

  function formatAllowed(action, view) {
    if (action === 'comment') return true;
    const current = live.current;
    const options = { main: current.file?.path === current.project?.mainFile, action };
    const doc = view.state.doc;
    const ranges = ['bold', 'italic', 'underline', 'mono', 'math', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'ref', 'label', 'footnote'].includes(action)
      ? view.state.selection.ranges : [view.state.selection.main];
    for (const range of ranges) {
      const issue = insertionPosition(doc.toString(), range, options);
      if (issue.reason) {
        setFormatIssue({ ...issue, doc, view });
        return false;
      }
    }
    setFormatIssue(null);
    return true;
  }
  useEffect(() => {
    if (!['figure', 'table'].includes(formatDialog?.action) || !project?.mainFile || file?.path === project.mainFile) return;
    let active = true;
    setMainHasGraphics(null);
    setMainHasBooktabs(null);
    rpc('readFile', { projectId, path: project.mainFile })
      .then(({ content }) => { if (active) { setMainHasGraphics(graphicxPlan(content).loaded); setMainHasBooktabs(packagePlan(content, 'booktabs').loaded); } })
      .catch(() => { if (active) { setMainHasGraphics(false); setMainHasBooktabs(false); } });
    return () => { active = false; };
  }, [formatDialog, project?.mainFile, file?.path]);
  function runFormat(action, view = editorApi.current?.view) {
    const target = { action, view, doc: view?.state.doc, selection: view?.state.selection };
    if (action === 'template' && project) { setFormatDialog(target); return; }
    if (!view || view !== editorApi.current?.view || !formatAvailable) return;
    if (action === 'check') { checkSelection(view, view.state.selection.main); return; }
    if (action === 'contents') { findOrInsertContents(); return; }
    if (action === 'indent') {
      const { state } = view;
      const selection = state.selection.main;
      const range = selection.empty ? { from: 0, to: state.doc.length } : selection;
      const changes = latexIndentChanges(state.doc, range, getIndentUnit(state));
      if (changes.length) view.dispatch({ changes, annotations: isolateHistory.of('full'), userEvent: 'input.format' });
      toast(t(changes.length ? 'indentationApplied' : 'indentationCurrent'));
      view.focus();
      return;
    }
    if (['abstract', 'sections', 'bodyStart'].includes(action)) { manuscriptAction(action, view); return; }
    if (!formatAllowed(action, view)) return;
    if (['heading', 'figure', 'table', 'cite', 'equation'].includes(action)) {
      setFormatDialog(target);
      return;
    }
    latexActions(t)[action].run(view);
  }
  async function findOrInsertContents() {
    const key = live.current.file?.key, mainFile = live.current.project?.mainFile;
    if (contentsBusy || !mainFile) return;
    setContentsBusy(true);
    try {
      await flushEdits();
      const origin = live.current.file;
      if (origin?.key !== key) return;
      const entries = await loadFiles();
      const result = await planProjectContents(mainFile, entries.filter(entry => entry.kind === 'text').map(entry => entry.path),
        path => rpc('readFile', { projectId, path }), true);
      if (live.current.file?.key !== key || live.current.file.hash !== origin.hash || live.current.dirty ||
          live.current.project?.mainFile !== mainFile) throw new Error(t('formatAnchorChanged'));
      if (!result) { toast(t('insertNoBody')); return; }
      const target = result.setup || result;
      if (target.path !== origin.path && !await openFile(target.path, entries)) return;
      setContentsRequest({ result, key: live.current.file.key });
    } catch (error) { toast(messageOf(error), 'error'); }
    finally { setContentsBusy(false); }
  }
  useEffect(() => {
    if (!contentsRequest) return;
    const { result, key } = contentsRequest;
    const { path, hash } = result.setup || result;
    const current = live.current.file;
    const editor = editorApi.current;
    if (current?.key !== key || current.path !== path || current.hash !== hash || live.current.dirty) {
      setContentsRequest(null);
      toast(t('formatAnchorChanged'), 'error');
      return;
    }
    if (!editor) return;
    const { view } = editor;
    setContentsRequest(null);
    const edits = result.setup ? [result.setup.change] : [];
    if (result.text) edits.push({ from: result.at, insert: result.text });
    const changes = view.state.changes(edits);
    if (result.path !== path) {
      view.dispatch({ changes, annotations: isolateHistory.of('full'), userEvent: 'input.format' });
      openFile(result.path).then(opened => {
        if (opened) setContentsRequest({ result: { path: result.path, hash: result.hash, at: result.at }, key: live.current.file.key });
      });
      return;
    }
    editor.jumpTo(view.state.doc.lineAt(result.at).number);
    const at = changes.mapPos(result.at, -1) + (result.text ? result.text.indexOf('\\tableofcontents') : 0);
    view.dispatch({ changes, selection: EditorSelection.cursor(at), annotations: isolateHistory.of('full'),
      userEvent: 'input.format', scrollIntoView: true });
    toast(t(result.text ? 'contentsInserted' : result.setup ? 'contentsUpdated' : 'contentsFound'));
  }, [contentsRequest, file?.key, reviewing]);
  function manuscriptAction(action, view) {
    const source = view.state.doc.toString();
    const clean = maskComments(source);
    const opening = action === 'bodyStart' ? /\\begin\s*\{document\}/.exec(clean)
      : action === 'abstract' ? /\\begin\s*\{abstract\}/.exec(clean) : null;
    if (opening) {
      const line = view.state.doc.lineAt(opening.index + opening[0].length);
      view.dispatch({ selection: EditorSelection.cursor(line.to), scrollIntoView: true });
      view.focus();
      return;
    }
    if (action === 'bodyStart') { toast(t('insertNoBody')); return; }
    if (!formatAllowed('template', view)) return;
    const fragment = templateFragment(source, action, locale.startsWith('zh') ? 'zh' : 'en', file.path === project?.mainFile);
    if (!fragment) { toast(t('templateAlreadyPresent')); return; }
    insertThesisFormat(view, 'template', fragment, latexActions(t));
    view.focus();
  }
  async function checkSelection(view, { from, to }) {
    if (from === to) { setCheckResult(null); toast(t('checkNeedSelection')); return; }
    const key = live.current.file?.key;
    const pending = { key, view, doc: view.state.doc, from, to, loading: true };
    setCheckResult(pending);
    try {
      await flushEdits();
      const current = live.current.file;
      if (current?.key !== key || view !== editorApi.current?.view || view.state.doc !== pending.doc) throw new Error(t('checkChanged'));
      const result = await rpc('checkSelection', { projectId, path: current.path, expectedHash: current.hash, from, to });
      setCheckResult(previous => previous === pending ? { ...pending, ...result, loading: false } : previous);
    } catch (error) {
      const message = error.code === 'CONFLICT' ? t('conflict') : error.code === 'CHECK_LIMIT' ? t('checkTooLong') : messageOf(error);
      setCheckResult(previous => previous === pending ? { ...pending, error: message, loading: false } : previous);
    }
  }
  async function checkProjectReferences() {
    if (referenceReport?.loading || !live.current.project?.mainFile) return;
    const pending = { loading: true };
    setReferenceReport(pending);
    try {
      await flushEdits();
      const mainFile = live.current.project.mainFile;
      const entries = await loadFiles();
      const parsed = await readProjectAnalysis(entries, mainFile, path => rpc('readFile', { projectId, path }));
      if (!parsed.sources.has(mainFile)) throw new Error(t('referenceNoMain'));
      setReferenceReport(previous => previous === pending ? { issues: referenceIssues(parsed.sources, parsed.bibliographies, mainFile) } : previous);
    } catch (error) { setReferenceReport(previous => previous === pending ? { error: messageOf(error) } : previous); }
  }
  function applyCheck(issue, replacement) {
    const view = editorApi.current?.view;
    if (!view || view !== activeCheck?.view || view.state.doc !== activeCheck.doc ||
        view.state.sliceDoc(issue.from, issue.to) !== issue.text) {
      toast(t('checkChanged'), 'error');
      return;
    }
    const changes = view.state.changes({ from: issue.from, to: issue.to, insert: replacement });
    const from = changes.mapPos(activeCheck.from, -1), to = changes.mapPos(activeCheck.to, 1);
    view.dispatch({ changes, selection: EditorSelection.range(from, to), scrollIntoView: true, userEvent: 'input.format' });
    if (from === to) setCheckResult(null);
    else checkSelection(view, { from, to });
  }
  function submitFormat(action, data) {
    const view = editorApi.current?.view;
    if (!view || view !== formatDialog?.view || view.state.doc !== formatDialog.doc || !view.state.selection.eq(formatDialog.selection)) {
      toast(t('formatAnchorChanged'), 'error');
      closeFormat();
      return;
    }
    if (!formatAllowed(action === 'heading' ? data.command : action, view)) { setFormatDialog(null); return; }
    if (action === 'figure' && data.addPackage && live.current.file?.path === live.current.project?.mainFile) {
      data = { ...data, packageAt: graphicxPlan(view.state.doc.toString()).at, packageName: 'graphicx' };
    }
    if (action === 'table') {
      const isMain = live.current.file?.path === live.current.project?.mainFile;
      const plan = isMain ? packagePlan(view.state.doc.toString(), 'booktabs') : { loaded: mainHasBooktabs, at: null };
      data = { ...data, booktabs: plan.loaded || plan.at != null, packageAt: plan.at, packageName: 'booktabs' };
    }
    if (action === 'equation' && /\\begin\s*\{(?:aligned|gathered|[A-Za-z]*matrix|cases)\}/.test(data.formula)
      && live.current.file?.path === live.current.project?.mainFile) {
      data = { ...data, packageAt: packagePlan(view.state.doc.toString(), 'amsmath').at, packageName: 'amsmath' };
    }
    insertThesisFormat(view, action, data, latexActions(t));
    if (action === 'equation') setFormulaDraft('');
    setFormatDialog(null);
    requestAnimationFrame(() => { if (editorApi.current?.view === view) view.focus(); });
  }
  function closeFormat() {
    setFormatDialog(null);
    editorApi.current?.focus();
  }
  function insertTemplate(kind) {
    const view = editorApi.current?.view;
    if (!formatAvailable || !view || view !== formatDialog?.view ||
      view.state.doc !== formatDialog.doc || !view.state.selection.eq(formatDialog.selection)) return false;
    const fragment = templateFragment(view.state.doc.toString(), kind, locale.startsWith('zh') ? 'zh' : 'en', file.path === project?.mainFile);
    if (!fragment || (fragment.at == null && !formatAllowed('template', view))) return false;
    insertThesisFormat(view, 'template', fragment, latexActions(t));
    closeFormat();
    return true;
  }
  async function recognizeFormula(image) {
    const current = live.current.session;
    if (!current.reference || running || typeof services.remote.session.prompt !== 'function') {
      if (narrow) setMobilePane('chat');
      else { setLowerPane('chat'); setCompactChat(true); updateLayout(previous => ({ ...previous, show: { ...previous.show, chat: true } })); }
      throw new Error(t(running ? 'formulaBusy' : 'formulaNeedChat'));
    }
    const data = await fileToBase64(image);
    if (live.current.session.id !== current.id) throw new Error(t('formulaNeedChat'));
    await rpc('focus', { projectId, sessionId: current.id, clear: true });
    setGrant(null);
    const text = 'Transcribe only the mathematical formula in the image into LaTeX. Do not use tools or edit files. Return the LaTeX in one fenced latex code block, without equation delimiters. If any symbol is unreadable, say so rather than guessing.';
    unwrap(await services.remote.session.prompt({ sessionId: current.id, requestId: crypto.randomUUID(), mode: 'queue', content: [
      { type: 'text', text }, { type: 'image', mediaType: image.type, data, name: image.name || 'formula.png' }
    ] }));
    setFormatDialog(null);
    if (narrow) setMobilePane('chat');
    else { setLowerPane('chat'); setCompactChat(true); updateLayout(previous => ({ ...previous, show: { ...previous.show, chat: true } })); }
    toast(t('formulaSent'));
  }
  function jumpToBody() {
    const view = editorApi.current?.view;
    if (view && formatIssue?.view === view && formatIssue.doc === view.state.doc && formatIssue.jump != null) {
      view.dispatch({ selection: EditorSelection.cursor(formatIssue.jump), effects: EditorView.scrollIntoView(formatIssue.jump, { y: 'center' }) });
      view.focus();
    }
    setFormatIssue(null);
  }
  async function uploadFormatImage(file) {
    const path = 'images/' + file.name;
    await rpc('uploadFile', { projectId, path, base64: await fileToBase64(file), overwrite: false });
    await loadFiles();
    return path;
  }
  async function importTemplate(event) {
    const zip = event.target.files?.[0];
    event.target.value = '';
    if (!zip || importingTemplate) return;
    setImportingTemplate(true);
    try {
      await flushEdits();
      const { name, entries } = await importSource({ zip });
      await onImport(name, entries);
    } catch (error) { toast(messageOf(error), 'error'); }
    finally { setImportingTemplate(false); }
  }
  async function exportSource() {
    setExportOpen(false);
    setExporting(true);
    try {
      await flushEdits();
      const current = await rpc('listFiles', { projectId });
      const entries = Object.create(null);
      for (const item of current.files) {
        const query = new URLSearchParams({ projectId, path: item.path });
        const response = await fetch(endpoint('api/dsh-thesis/raw?' + query));
        if (!response.ok) throw new Error(t('exportFailed') + ' · ' + item.path);
        entries[item.path] = new Uint8Array(await response.arrayBuffer());
      }
      const url = URL.createObjectURL(new Blob([zipSync(entries)], { type: 'application/zip' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = project.name + '.zip';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (error) { toast(messageOf(error), 'error'); }
    finally { setExporting(false); }
  }
  const pdfUrl = build?.hasPdf ? endpoint(`api/dsh-thesis/pdf?projectId=${encodeURIComponent(projectId)}&v=${encodeURIComponent(build.pdfVersion || build.builtAt || '')}`) : '';
  const show = layout.show;
  const dock = narrow ? 'right' : layout.dock;
  const fixedWorkspace = !narrow && dock === 'workspace';
  const switchLower = fixedWorkspace && (width < 1040 || layout.lowerTogether !== true);
  const singleLowerPane = switchLower && show.chat && show.files;
  const visible = narrow ? { files: mobilePane === 'files', editor: mobilePane === 'editor', pdf: mobilePane === 'pdf', chat: mobilePane === 'chat' }
    : fixedWorkspace ? { editor: true, pdf: true, files: show.files && (!singleLowerPane || lowerPane === 'files'), chat: show.chat && (!singleLowerPane || lowerPane === 'chat') }
    : { ...show, chat: show.chat && (!compact || compactChat) };
  const toggle = pane => {
    if (switchLower && (pane === 'files' || pane === 'chat')) {
      setLowerPane(pane);
      const open = !visible[pane];
      updateLayout(previous => ({ ...previous, show: { ...previous.show, files: open, chat: open } }));
      return;
    }
    if (fixedWorkspace) {
      updateLayout(previous => ({ ...previous, show: { ...previous.show, [pane]: !previous.show[pane] } }));
      return;
    }
    if (pane === 'chat' && compact) { setCompactChat(!visible.chat); if (!show.chat) updateLayout(previous => ({ ...previous, show: { ...previous.show, chat: true } })); return; }
    updateLayout(previous => { const next = { ...previous.show, [pane]: !previous.show[pane] }; if (!next.editor && !next.pdf && !next.chat) return previous; return { ...previous, show: next }; });
  };
  // Where the assistant lives: a docked column (right/left), a bottom panel, or a floating window.
  // With source and PDF both hidden the assistant becomes the main pane and takes the free width.
  const chatFills = !visible.editor && !visible.pdf;
  const chatInRow = visible.chat && !chatFills && (dock === 'left' || dock === 'right');
  const floating = visible.chat && !narrow && !chatFills && dock === 'float';
  const maxChatWidth = Math.min(560, Math.max(CHAT_DOCK_MIN, Math.round(width * 0.36)));
  const defaultChatWidth = Math.max(CHAT_DOCK_MIN, Math.round(width * 0.25));
  const chatWidth = Math.min(layout.chat, layout.chatResized ? maxChatWidth : defaultChatWidth);
  const centerWidth = Math.max(0, width - (visible.files ? layout.files : 0) - (chatInRow ? chatWidth : 0));
  const float = { w: 420, h: 560, ...(layout.float || {}) };
  float.w = Math.max(FLOAT_MIN.w, Math.min(float.w, width)); float.h = Math.max(FLOAT_MIN.h, Math.min(float.h, height - TOPBAR));
  float.x = Math.max(0, Math.min(float.x ?? width - float.w - 16, width - float.w)); float.y = Math.max(TOPBAR, Math.min(float.y ?? 64, height - float.h));
  // Follow one pointer gesture on the window, with the given cursor shown everywhere until it ends.
  function track(cursor, onMove, onUp) {
    const root = rootRef.current?.closest('.fo-root');
    root?.classList.add('is-resizing'); if (root) root.style.cursor = cursor;
    const up = upEvent => {
      window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      root?.classList.remove('is-resizing'); if (root) root.style.cursor = '';
      onUp?.(upEvent);
    };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  }
  // Resize the floating window from any edge or corner; `edge` lists the sides that move.
  function resizeFloat(event, edge) {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const start = { px: event.clientX, py: event.clientY, ...float };
    const right = start.x + start.w, bottom = start.y + start.h;
    track(getComputedStyle(event.currentTarget).cursor, next => {
      const dx = next.clientX - start.px, dy = next.clientY - start.py;
      let { x, y, w, h } = start;
      if (edge.includes('e')) w = Math.min(width - x, Math.max(FLOAT_MIN.w, start.w + dx));
      if (edge.includes('s')) h = Math.min(height - y, Math.max(FLOAT_MIN.h, start.h + dy));
      if (edge.includes('w')) { x = Math.max(0, Math.min(right - FLOAT_MIN.w, start.x + dx)); w = right - x; }
      if (edge.includes('n')) { y = Math.max(TOPBAR, Math.min(bottom - FLOAT_MIN.h, start.y + dy)); h = bottom - y; }
      updateLayout(previous => ({ ...previous, float: { x, y, w, h } }));
    });
  }
  // The dock an assistant dragged to (clientX, clientY) would land in, with its outline in workspace coordinates.
  function dropAt(clientX, clientY) {
    const root = rootRef.current?.getBoundingClientRect(), bench = rootRef.current?.querySelector('.fo-bench')?.getBoundingClientRect();
    if (!root || !bench) return null;
    const reach = 64, top = bench.top - root.top, left = bench.left - root.left + (show.files ? layout.files + 1 : 0);
    const columnWidth = Math.min(layout.chat, bench.width / 2), panelHeight = Math.min(layout.chatHeight || 320, bench.height - 120);
    if (clientX < bench.left + reach) return { zone: 'left', left, top, width: columnWidth, height: bench.height };
    if (clientX > bench.right - reach) return { zone: 'right', left: bench.right - root.left - columnWidth, top, width: columnWidth, height: bench.height };
    if (clientY > bench.bottom - reach) return { zone: 'bottom', left, top: top + bench.height - panelHeight, width: bench.right - root.left - left, height: panelHeight };
    return null;
  }
  // Drag the assistant by its header. A docked panel tears off into a window after a few pixels;
  // releasing near the left, right or bottom edge docks it there, anywhere else leaves it floating.
  function dragChat(event) {
    if (event.button !== 0 || narrow || fixedWorkspace || chatFills || event.target.closest('button, a, input, select, [role=menu], .fo-popover')) return;
    event.preventDefault();
    const root = rootRef.current.getBoundingClientRect(), pane = event.currentTarget.closest('.fo-pane-chat').getBoundingClientRect();
    const start = { px: event.clientX, py: event.clientY }, before = layout.float, from = dock;
    const grab = { x: Math.min(event.clientX - pane.left, float.w - 48), y: Math.min(event.clientY - pane.top, 32) };
    let torn = floating, target = null;
    track('grabbing', next => {
      if (!torn && Math.hypot(next.clientX - start.px, next.clientY - start.py) < 6) return;
      const x = Math.max(0, Math.min(width - float.w, next.clientX - root.left - grab.x));
      const y = Math.max(TOPBAR, Math.min(height - float.h, next.clientY - root.top - grab.y));
      updateLayout(previous => ({ ...previous, dock: 'float', lastDock: torn ? previous.lastDock : from, float: { ...float, x, y } }));
      torn = true;
      const zone = dropAt(next.clientX, next.clientY);
      if (zone?.zone !== target?.zone) setDrop(zone);
      target = zone;
    }, () => {
      setDrop(null);
      // Docking keeps the window's last free position for the next time it floats.
      if (target) updateLayout(previous => ({ ...previous, dock: target.zone, float: before ?? previous.float }));
    });
  }
  // Double-clicking the header switches between the window and the dock it came from.
  function toggleFloat(event) {
    if (narrow || fixedWorkspace || chatFills || event.target.closest('button, a, input, select, [role=menu], .fo-popover')) return;
    updateLayout(previous => floating
      ? { ...previous, dock: previous.lastDock && previous.lastDock !== 'float' ? previous.lastDock : 'right' }
      : { ...previous, dock: 'float', lastDock: dock });
  }
  // SyncTeX: double-click in the PDF opens the source line; "Show in PDF" goes the other way.
  async function syncToSource({ page, x, y }) {
    if (syncPending.current) return;
    syncPending.current = true;
    try {
      const result = await rpc('synctex', { projectId, direction: 'toSource', page, x, y });
      if (!result.available) { toast(t('syncUnavailable')); return; }
      if (!result.file || !await revealSource(result.file, result.line)) toast(t('syncNoMatch'));
    } catch (error) { toast(messageOf(error), 'error'); }
    finally { syncPending.current = false; }
  }
  async function syncToPdf() {
    const current = live.current.file;
    if (!current || current.kind !== 'text') return;
    try {
      const result = await rpc('synctex', { projectId, direction: 'toPdf', file: current.path, line: live.current.cursor.line });
      if (!result.available) { toast(t('syncUnavailable')); return; }
      if (!result.boxes?.length) { toast(t('syncNoMatch')); return; }
      setShowIssues(false);
      if (narrow) setMobilePane('pdf'); else if (!layout.show.pdf) updateLayout(previous => ({ ...previous, show: { ...previous.show, pdf: true } }));
      setTimeout(() => pdfApi.current?.reveal(result.boxes), 80);
    } catch (error) { toast(messageOf(error), 'error'); }
  }
  async function clipboard(view, kind) {
    try {
      if (kind === 'paste') view.dispatch({ ...view.state.replaceSelection(await navigator.clipboard.readText()), scrollIntoView: true, userEvent: 'input.paste' });
      else {
        const { state } = view;
        await navigator.clipboard.writeText(state.selection.ranges.map(range => state.sliceDoc(range.from, range.to)).join('\n'));
        if (kind === 'cut') view.dispatch({ ...view.state.replaceSelection(''), userEvent: 'delete.cut' });
      }
    } catch { toast(kind === 'paste' ? t('pasteBlocked') : t('clipboardBlocked'), 'error'); }
    view.focus();
  }
  // Right-click menus. Text fields, links and the chat transcript keep the browser's menu.
  const paneItems = () => [
    ...(narrow ? [] : [['files', t('files')], ['editor', t('editor')], ['pdf', t('pdf')], ['chat', t('assistant')]]
      .filter(([pane]) => !fixedWorkspace || pane === 'files' || pane === 'chat')
      .map(([pane, label]) => ({ label, checked: visible[pane], run: () => toggle(pane) }))),
    '-',
    ...(narrow ? [] : [['workspace', t('dockWorkspace')], ['right', t('dockRight')], ['left', t('dockLeft')], ['bottom', t('dockBottom')], ['float', t('dockFloat')]].map(([value, label]) => ({ label, checked: dock === value, run: () => updateLayout(previous => ({ ...previous, dock: value, show: { ...previous.show, chat: true } })) }))),
    '-',
    { label: t('compile'), icon: 'play', hint: `${MOD}↵`, disabled: compiling, run: () => compileRef.current() },
    { label: t('texEnv'), icon: 'gear', run: () => setTexOpen(true) },
    { label: t('backToLibrary'), icon: 'back', run: leave }
  ];
  function editorMenu(event, view) {
    // Right-clicking outside the selection moves the cursor there first, as native editors do.
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
    const selection = view.state.selection.main;
    if (position != null && (position < selection.from || position > selection.to)) view.dispatch({ selection: EditorSelection.cursor(position) });
    const actions = latexActions(t);
    const bind = id => ({ ...actions[id], run: () => runFormat(id, view) });
    const selected = !view.state.selection.main.empty;
    openMenu(event, [
      { row: ['bold', 'italic', 'underline', 'mono', 'math', 'equation', 'itemize', 'enumerate'].map(bind) },
      { row: ['section', 'subsection', 'figure', 'table', 'cite', 'ref', 'label', 'comment'].map(bind) },
      '-',
      { label: t('cut'), icon: 'cut', hint: `${MOD}X`, disabled: !selected, run: () => clipboard(view, 'cut') },
      { label: t('copy'), icon: 'copy', hint: `${MOD}C`, disabled: !selected, run: () => clipboard(view, 'copy') },
      { label: t('paste'), icon: 'paste', hint: `${MOD}V`, run: () => clipboard(view, 'paste') },
      { label: t('selectAll'), hint: `${MOD}A`, run: () => { view.dispatch({ selection: EditorSelection.range(0, view.state.doc.length) }); view.focus(); } },
      '-',
      { label: t('showInPdf'), icon: 'locate', disabled: !build?.hasPdf, run: syncToPdf },
      { label: t('compile'), icon: 'play', hint: `${MOD}↵`, disabled: compiling, run: () => compileRef.current() },
      { label: t('editorSettings'), icon: 'gear', run: () => setSettingsOpen(true) }
    ]);
  }
  function pdfMenu(event, point) {
    const api = pdfApi.current;
    const selected = api?.selection() || '';
    openMenu(event, [
      point && { label: t('showInSource'), icon: 'locate', run: () => syncToSource(point) },
      selected && { label: t('copyText'), icon: 'copy', run: () => navigator.clipboard.writeText(selected).catch(() => toast(t('clipboardBlocked'), 'error')) },
      '-',
      { label: t('zoomIn'), icon: 'zoom-in', hint: `${MOD}+`, run: () => api?.zoomIn() },
      { label: t('zoomOut'), icon: 'zoom-out', hint: `${MOD}−`, run: () => api?.zoomOut() },
      { label: t('fitWidth'), icon: 'fit-width', hint: `${MOD}0`, run: () => api?.fit('width') },
      { label: t('fitPage'), icon: 'fit-page', run: () => api?.fit('page') },
      { label: t('actualSize'), run: () => api?.actual() }
    ]);
  }
  useEffect(() => {
    if (!issueJump || file?.path !== issueJump.path || !editorApi.current) return;
    editorApi.current.jumpTo(issueJump.line);
    setIssueJump(null);
  }, [issueJump, file?.key, visible.editor]);

  async function revealSource(path, line) {
    if (!(line > 0) || !files.some(item => item.path === path && item.kind === 'text')) return false;
    if (path === live.current.file?.path) openRequest.current++;
    else if (!await openFile(path, files, line)) return false;
    setReviewing(null);
    setIssueJump({ path, line });
    if (narrow) setMobilePane('editor');
    else if (!visible.editor) updateLayout(previous => ({ ...previous, show: { ...previous.show, editor: true } }));
    return true;
  }

  async function jumpToIssue(entry) {
    if (!jumpable(entry) || jumpingIssue.current) return;
    jumpingIssue.current = true;
    try {
      const { problem, index } = entry;
      if (await revealSource(issuePath(problem), problem.line)) setActiveIssue({ build: issueBuild, index });
    } finally { jumpingIssue.current = false; }
  }
  function stepIssue(direction) {
    if (!jumpableIssues.length) return;
    const current = jumpableIssues.findIndex(entry => entry.index === issueIndex);
    const next = current < 0 ? (direction > 0 ? 0 : jumpableIssues.length - 1)
      : (current + direction + jumpableIssues.length) % jumpableIssues.length;
    jumpToIssue(jumpableIssues[next]);
  }

  const filesPane = visible.files && (<section key="files" className="fo-pane fo-pane-files" style={narrow || fixedWorkspace ? undefined : { width: layout.files }}>
    <header className="fo-pane-head"><span className="fo-caps">{t('files')}</span><div className="fo-pane-actions"><button className="fo-icon-btn" title={t('newFile')} aria-label={t('newFile')} onClick={() => setDialog({ kind: 'new' })}><Icon name="plus" /></button><button className="fo-icon-btn" title={t('upload')} aria-label={t('upload')} onClick={() => uploadRef.current?.click()}><Icon name="upload" /></button><input ref={uploadRef} type="file" multiple hidden onChange={event => { upload([...event.target.files]); event.target.value = ''; }} /></div></header>
    <FileTree t={t} files={files} activePath={file?.path} mainFile={project?.mainFile} onOpen={openFile} onAction={fileAction} onUpload={upload} />
    <SourceOutline t={t} sources={projectAnalysis?.sources} mainFile={project?.mainFile} current={file} reveal={revealSource} />
  </section>);
  const editorPane = visible.editor && (<section key="editor" className="fo-pane fo-pane-editor" style={narrow || fixedWorkspace ? undefined : { flex: visible.pdf ? `${layout.split} 1 0` : '1 1 0' }}>
    <header className="fo-pane-head thesis-sourcebar">
      <div className="thesis-file-tabs" aria-label={t('files')}>
        {[project?.mainFile, file?.path, ...files.filter(item => /[.]bib$/i.test(item.path)).map(item => item.path)].filter((path, i, all) => path && all.indexOf(path) === i).map(path =>
          <button type="button" key={path} aria-pressed={path === file?.path} title={path} onClick={() => { if (path !== file?.path) openFile(path); }}>{path.split('/').at(-1)}</button>
        )}
      </div>
      {formattingPane}
      <div className="fo-pane-actions thesis-source-actions">
        <div className="thesis-history" ref={historyRef}>
          <button type="button" className="fo-btn is-small" aria-expanded={showHistory} aria-label={t('reviewHistory')} title={t('reviewHistory')} onClick={() => setShowHistory(value => !value)}>
            <Icon name="clock" size={14} /><span>{t('reviewHistory')}</span>
          </button>
          {showHistory && <div className="fo-popover thesis-review-history">
            {proposalHistory.length ? <ul>{proposalHistory.map(entry => <li key={entry.id}>
              <span title={entry.summary}>{entry.path} · {t('review_' + entry.status)}</span>
              {entry.validation && <button type="button" className="fo-btn is-small" onClick={() => {
                setShowHistory(false);
                setHistoryBuild(entry.validation);
                setShowIssues(true);
                if (narrow) setMobilePane('pdf');
                else if (!visible.pdf) updateLayout(previous => ({ ...previous, show: { ...previous.show, pdf: true } }));
              }}>{t('viewValidation')}</button>}
              {entry.status === 'applied' && entry.contentHash && <button type="button" className="fo-btn is-small" disabled={proposalBusy} onClick={() => undoProposal(entry.id)}>{t('undoProposal')}</button>}
            </li>)}</ul> : <span className="fo-muted">{t('emptyHistory')}</span>}
          </div>}
        </div>
        <button className="fo-icon-btn" data-editor-settings title={t('editorSettings')} aria-label={t('editorSettings')} onClick={() => setSettingsOpen(!settingsOpen)}><Icon name="gear" size={15} /></button>
      </div>
    </header>
    
    {settingsOpen && <EditorSettings t={t} settings={editorSettings} onChange={updateEditor} onClose={() => setSettingsOpen(false)} />}
    {proposals.length > 0 && !reviewProposal && <button className="fo-proposal-bar" onClick={() => chooseProposal(proposals[0].id)}><Icon name="spark" /><span><strong>{proposals.length > 1 ? `${proposals.length} ${t('proposals')}` : t('proposal')}</strong> · {proposals[0].summary || proposals[0].path}</span><em>{t('review')} →</em></button>}
    {conflict && <div className="fo-conflict" role="alert"><Icon name="alert" /><span>{t('diskChanged')}</span><button className="fo-btn is-small" onClick={() => resolveConflict(false).catch(error => toast(messageOf(error), 'error'))}>{t('reload')}</button><button className="fo-btn is-small" onClick={() => resolveConflict(true).catch(error => toast(messageOf(error), 'error'))}>{t('overwrite')}</button></div>}
    {formatIssue && formatIssue.view === editorApi.current?.view && <div className="fo-conflict thesis-insert-issue" role="alert">
      <Icon name="alert" /><span>{t(formatIssue.reason)}</span>
      {formatIssue.jump != null && <button type="button" className="fo-btn is-small" onClick={jumpToBody}>{t('jumpToBody')}</button>}
      <button type="button" className="fo-icon-btn" aria-label={t('close')} onClick={() => setFormatIssue(null)}><Icon name="close" size={14} /></button>
    </div>}
    {activeCheck && <SourceCheck t={t} result={activeCheck}
      stale={activeCheck.view !== editorApi.current?.view || activeCheck.doc !== activeCheck.view.state.doc}
      onClose={() => setCheckResult(null)} onApply={applyCheck} />}
    {referenceReport && !reviewProposal && <ReferenceReport t={t} report={referenceReport} onClose={() => setReferenceReport(null)} reveal={revealSource} />}
    <div className="fo-pane-body">
      {reviewProposal ? <div className="fo-review">
        <header><div><span className="fo-caps"><Icon name="spark" size={13} /> {t('proposal')} · {reviewIndex + 1}/{proposals.length}</span><h3>{reviewProposal.summary || reviewProposal.path}</h3><code>{reviewProposal.path}</code></div>
          <div className="fo-review-actions">
            <button className="fo-btn" disabled={proposalBusy} onClick={() => setReviewing(null)}>{t('close')}</button>
            <button className="fo-btn" disabled={proposalBusy} onClick={() => settle(reviewProposal, false)}>{t('discard')}</button>
            <button className="fo-btn is-primary" disabled={proposalBusy || !canApplyProposal} aria-describedby="thesis-review-note" onClick={() => settle(reviewProposal, true)}><Icon name="check" /> {t(proposalBusy ? 'validatingPatch' : 'verifyPatch')}</button>
          </div>
        </header>
        {proposals.length > 1 && <label className="thesis-review-switch">
          {t('chooseProposal')}
          <select value={reviewProposal.id} disabled={proposalBusy} onChange={event => chooseProposal(event.target.value)}>
            {proposals.map(item => <option key={item.id} value={item.id}>{item.path}{item.summary ? ' · ' + item.summary : ''}</option>)}
          </select>
        </label>}
        <p id="thesis-review-note" className="thesis-review-note">{t(reviewProposal.risk === 'formatting' ? 'formattingReview' : reviewProposal.risk === 'protected' ? 'protectedReview' : 'uncertainReview')}</p>
        {reviewProposal.risk !== 'formatting' && <label className="thesis-review-approval">
          <input type="checkbox" checked={writeApproval === reviewProposal.id} disabled={proposalBusy}
            onChange={event => setWriteApproval(event.target.checked ? reviewProposal.id : null)} />
          {t('authorizePatchWrite')}
        </label>}
        <DiffView proposal={reviewProposal} />
      </div>
      : !file ? <div className="fo-empty"><p>{t('selectFile')}</p></div>
      : file.kind === 'image' ? <div className="fo-image-preview"><img alt={file.path} src={endpoint(`api/dsh-thesis/raw?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(file.path)}`)} /></div>
      : file.kind !== 'text' ? <div className="fo-empty"><p>{t('binaryFile')}</p></div>
      : <SourceEditor t={t} docKey={file.key} initialLine={file.initialLine} content={file.content} latex={/\.(tex|sty|cls)$/i.test(file.path)} apiRef={editorApi} settings={editorSettings} style={editorStyle(editorSettings)} onZoom={zoomEditor} onContextMenu={editorMenu} onChange={onChange} onCursor={value => { setFormatIssue(null); setCursor(value); store(EDIT_STATE_KEY + projectId, { path: file.path, line: value.line }); }} onFormat={runFormat} onSave={saveAndMaybeCompile} onCompile={() => compileRef.current()} />}
    </div>
  </section>);
  const workspaceActions = <div className="thesis-work-actions">
    <nav className="fo-seg thesis-panes" aria-label={t('layout')}>
      {([['files', 'files'], ['editor', 'source'], ['pdf', 'pdf'], ['chat', 'chat']])
        .filter(([pane]) => !fixedWorkspace || pane === 'files' || pane === 'chat')
        .map(([pane, icon]) => {
          const label = t(pane === 'chat' ? 'assistant' : pane);
          return <button key={pane} type="button" aria-label={label} aria-pressed={visible[pane]} onClick={() => narrow ? setMobilePane(pane) : toggle(pane)}
            title={label}><Icon name={icon} /><span>{label}</span></button>;
        })}
    </nav>
    <div className="fo-compile">
      <button className="fo-btn is-primary fo-compile-main" onClick={() => compileRef.current()} disabled={compiling || !project} title="⌘/Ctrl + Enter">
        {compiling ? <span className="fo-spinner" /> : <Icon name="play" fill size={13} />}{compiling ? t('compiling') : t('compile')}
      </button>
      <button className="fo-btn is-primary fo-compile-more" aria-label={t('engine')} aria-expanded={compileMenu} onClick={() => setCompileMenu(!compileMenu)}><Icon name="chevron" size={14} /></button>
      {compileMenu && <CompileMenu t={t} project={project} texFiles={texFiles} autoCompile={autoCompile} setAutoCompile={setAutoCompile} setEngine={setEngine} setMain={setMain}
        onCheck={() => { setCompileMenu(false); if (narrow) setMobilePane('editor'); else if (!visible.editor) updateLayout(previous => ({ ...previous, show: { ...previous.show, editor: true } })); checkProjectReferences(); }}
        onTex={() => { setCompileMenu(false); setTexOpen(true); }} onClose={() => setCompileMenu(false)} />}
    </div>
    {(compiling || proposalBusy) && <button className="fo-icon-btn" type="button" title={t('cancelBuild')} aria-label={t('cancelBuild')} onClick={cancelBuild}><Icon name="close" size={14} /></button>}
    <div className="thesis-export" ref={exportRef}>
      <button type="button" className="fo-btn thesis-export-trigger" disabled={!project || exporting} aria-label={t('exportMenu')} title={t('exportMenu')} aria-expanded={exportOpen} onClick={() => setExportOpen(!exportOpen)}>
        <Icon name="export" size={15} /><span>{t('exportMenu')}</span>
      </button>
      {exportOpen && <div className="fo-popover thesis-export-menu">
        {pdfUrl ? <a href={pdfUrl} download={project.name + '.pdf'} onClick={() => setExportOpen(false)}>{t('download')}</a>
          : <button type="button" disabled>{t('download')}</button>}
        {pdfUrl && <button type="button" onClick={() => { setExportOpen(false); window.open(pdfUrl, '_blank', 'noopener'); }}>{t('openPdfTab')}</button>}
        <button type="button" onClick={exportSource}>{t('exportSource')}</button>
      </div>}
    </div>
  </div>;
  const buildStatus = compiling ? t('compiling') : !build ? t('noPdf') : build.ok ? t('buildOk') : t('buildFailed');
  const pdfPane = visible.pdf && (<section key="pdf" className="fo-pane fo-pane-pdf" style={narrow || fixedWorkspace ? undefined : { flex: visible.editor ? `${1 - layout.split} 1 0` : '1 1 0' }}>
    <header className="fo-pane-head thesis-pdfbar">
      <div className="thesis-pdf-status">
        <span className="thesis-pdf-title">{t('pdfPreview')}</span>
      <button className={`fo-build is-${compiling ? 'busy' : !build ? 'none' : build.ok ? 'ok' : 'failed'}`} onClick={() => { setHistoryBuild(null); setShowIssues(!showIssues || Boolean(historyBuild)); }} disabled={!build}>
        <i /><span aria-live="polite">{buildStatus}</span>
        {errorCount > 0 && <b className="is-error">{errorCount}</b>}{warningCount > 0 && <b className="is-warning">{warningCount}</b>}
      </button>
      </div>
      {fixedWorkspace && workspaceActions}
    </header>
    <div className="fo-pane-body fo-desk">
      {pdfUrl ? <PdfViewer t={t} url={pdfUrl} apiRef={pdfApi} onInverse={syncToSource} onMenu={pdfMenu} />
        : <div className="fo-empty fo-empty-pdf"><div className="fo-sheet" aria-hidden="true"><span /><span /><span /><span /></div><p>{t('noPdfHint')}</p></div>}
      {showIssues && issueBuild && <div className="fo-issues is-over">
        <button className="fo-btn is-small thesis-close-issues" onClick={() => { setHistoryBuild(null); setShowIssues(false); }}>{t('hideIssues')}</button>
        <h3 className="fo-caps">{t(historyBuild ? 'viewValidation' : 'issues')} {historyBuild && historyBuild.builtAt ? <span>{relativeTime(historyBuild.builtAt, locale)}</span> : <>{errorCount > 0 && <span className="is-error">{errorCount} {t('errors')}</span>} {warningCount > 0 && <span className="is-warning">{warningCount} {t('warnings')}</span>}</>}</h3>
        {(issueBuild.problems?.length ?? 0) > 0 && <div className="thesis-issue-controls">
          <select aria-label={t('filterIssues')} value={issueFilter} onChange={event => setIssueFilter(event.target.value)}>
            <option value="all">{t('allIssues')}</option><option value="error">{t('errorIssues')}</option>
            <option value="warning">{t('warningIssues')}</option><option value="typesetting">{t('typesettingIssues')}</option>
          </select>
          <button className="fo-btn is-small" disabled={!jumpableIssues.length} aria-keyshortcuts="Shift+F8" title="Shift+F8" onClick={() => stepIssue(-1)}>{t('previousIssue')}</button>
          <button className="fo-btn is-small" disabled={!jumpableIssues.length} aria-keyshortcuts="F8" title="F8" onClick={() => stepIssue(1)}>{t('nextIssue')}</button>
        </div>}
        {shownProblems.length ? <ul>{shownProblems.map(entry => {
          const { problem, index } = entry;
          return <li key={index} className={'is-' + problem.level}><button aria-current={index === issueIndex || undefined}
            onClick={() => problem.setup ? setTexOpen(true) : jumpToIssue(entry)} disabled={!problem.setup && !jumpable(entry)}>
            <span className="fo-issue-dot" /><span className="fo-issue-text">{problem.message}</span>
            {problem.line > 0 && <code>{(issuePath(problem) ? issuePath(problem) + ':' : t('line') + ' ') + problem.line}</code>}
          </button></li>;
        })}</ul> : <p className="fo-muted">{t(issueBuild.problems?.length ? 'noFilteredIssues' : 'noIssues')}</p>}
        {issueBuild.log && <details><summary>{t('rawLog')}</summary><pre>{issueBuild.log}</pre></details>}
      </div>}
    </div>
  </section>);
  const chatStyle = narrow || fixedWorkspace ? undefined : chatFills ? { flex: '1 1 0' } : dock === 'bottom' ? { height: layout.chatHeight || 320 } : floating ? { left: float.x, top: float.y, width: float.w, height: float.h } : { width: chatWidth };
  const chatPane = visible.chat && (<section key="chat" className={`fo-pane fo-pane-chat is-${chatFills ? 'main' : dock}${drop ? ' is-dropping' : ''}`} style={chatStyle} data-thesis-chat-controls={showChatTools ? 'full' : 'compact'} aria-label={t('assistant')}>
    <header className="fo-pane-head" onContextMenu={event => openMenu(event, [{ label: t('newChat'), icon: 'plus', disabled: !project || running, run: () => project && bindSession(project, { fresh: true }) }, '-', ...paneItems()])} onPointerDown={dragChat} onDoubleClick={toggleFloat} title={narrow || fixedWorkspace || chatFills ? undefined : t('dragHint')}>
      {fixedWorkspace && <span className="thesis-chat-heading">{t('assistant')}</span>}
      <ChatSwitcher t={t} locale={locale} services={services} directory={project?.directory} currentId={session.id} running={running} onSwitch={id => project && bindSession(project, { target: id })} onNew={() => project && bindSession(project, { fresh: true })} onArchive={archiveChats} archived={archived} separateHeading={fixedWorkspace} />
      <div className="fo-pane-actions">
        <button className="fo-icon-btn" onClick={() => project && bindSession(project, { fresh: true })} disabled={!project || running || session.opening} title={t('newChat')} aria-label={t('newChat')}><Icon name="plus" /></button>
        {session.reference && <button type="button" className="fo-icon-btn thesis-extra-chat-tools" title={t('moreChatTools')} aria-label={t('moreChatTools')} aria-pressed={showChatTools} onClick={() => setShowChatTools(value => !value)}><Icon name="more" /></button>}
        {!narrow && <DockMenu t={t} dock={dock} onDock={value => updateLayout(previous => ({ ...previous, dock: value, show: { ...previous.show, chat: true } }))} />}
        {!narrow && !fixedWorkspace && <button className="fo-icon-btn" onClick={() => toggle('chat')} title={t('close')} aria-label={t('close')}><Icon name="close" /></button>}
      </div>
    </header>
    {session.reference && <div className="thesis-scope-bar">
      <button type="button" className="fo-btn is-small" disabled={running || !file || !/[.](tex|bib|sty|cls)$/i.test(file.path)} onClick={showScope}>{t('authorizeScope')}</button>
      {grant && <><span title={grant.path}>{grant.path}{grant.selected ? ' · ' + t('scopeSelection') : ''}{grant.related.length ? ' +' + grant.related.length : ''}</span>
        <button type="button" className="fo-icon-btn" aria-label={t('clearScope')} title={t('clearScope')} onClick={clearScope}><Icon name="close" size={13} /></button></>}
    </div>}
    <div className="fo-pane-body fo-chat-body">
      {session.reference ? <SessionProvider session={session.reference}>{renderSlot('thesis.editor.chat', { sessionId: session.id, onRunning: setRunning })}</SessionProvider>
        : <div className="fo-empty">{session.error ? <><p className="fo-form-error">{session.error}</p><button className="fo-btn" onClick={() => bindSession(live.current.project)}><Icon name="refresh" /> {t('reload')}</button></> : session.opening ? <p className="fo-muted">{t('chatStarting')}</p> : <><p className="fo-muted">{t('aiIdle')}</p><button className="fo-btn" disabled={!project} onClick={() => bindSession(live.current.project)}>{t(project?.sessionId ? 'resumeChat' : 'openAssistant')}</button></>}</div>}
    </div>
    {floating && FLOAT_EDGES.map(edge => <div key={edge} className={`fo-float-edge is-${edge}`} onPointerDown={event => resizeFloat(event, edge)} aria-hidden="true" />)}
  </section>);
  const center = [editorPane, visible.editor && visible.pdf && !narrow && <Handle key="h-split" label={t('pdf')} onDrag={dx => updateLayout(previous => ({ ...previous, split: Math.max(0.2, Math.min(0.8, previous.split + dx / Math.max(1, centerWidth))) }))} />, pdfPane].filter(Boolean);
  const chatHandle = <Handle key="h-chat" label={t('assistant')} onDrag={dx => updateLayout(previous => {
    const currentWidth = Math.min(previous.chat, previous.chatResized ? maxChatWidth : defaultChatWidth);
    return { ...previous, chatResized: true, chat: Math.min(maxChatWidth, Math.max(CHAT_DOCK_MIN, currentWidth + (dock === 'left' ? dx : -dx))) };
  })} />;
  const bench = fixedWorkspace ? [
    <div key="fixed-left" className={`thesis-work-left${filesPane || chatPane ? ' has-lower' : ''}`} style={{ '--thesis-source-share': layout.sourceShare + 'fr', '--thesis-lower-share': (1 - layout.sourceShare) + 'fr' }}>
      {editorPane}
      {(filesPane || chatPane) && <>
        <Handle axis="y" label={t('resizeSource')} onDrag={(_, dy) => updateLayout(previous => ({
          ...previous, sourceShare: Math.max(0.37, Math.min(0.72, previous.sourceShare + dy / Math.max(1, height - 76)))
        }))} />
        <div className={`thesis-work-lower${filesPane && chatPane ? ' has-both' : ''}`}>{filesPane}{chatPane}</div>
      </>}
    </div>, pdfPane
  ] : narrow ? [filesPane, editorPane, pdfPane, chatPane].filter(Boolean) : [
    filesPane, filesPane && <Handle key="h-files" label={t('files')} onDrag={dx => updateLayout(previous => ({ ...previous, files: Math.max(150, Math.min(420, previous.files + dx)) }))} />,
    chatInRow && dock === 'left' && chatPane, chatInRow && dock === 'left' && chatHandle,
    ...(visible.chat && !chatFills && dock === 'bottom'
      ? [<div key="center" className="fo-center"><div className="fo-center-row">{center}</div><Handle key="h-bottom" axis="y" label={t('assistant')} onDrag={(_, dy) => updateLayout(previous => ({ ...previous, chatHeight: Math.max(140, Math.min(height - TOPBAR - 120, (previous.chatHeight || 320) - dy)) }))} />{chatPane}</div>]
      : center),
    chatInRow && dock === 'right' && chatHandle, chatInRow && dock === 'right' && chatPane,
    visible.chat && chatFills && chatPane
  ].filter(Boolean);

  const documentTitle = <div className="fo-topbar-left">
    <button className="fo-home" onClick={leave} title={t('back')} aria-label={t('back')}><FolioMark /><span>{t('panel')}</span><Icon name="chevron" size={13} /></button>
    <span className="fo-slash" aria-hidden="true">/</span>
    <button className="fo-title" onClick={() => project && setDialog({ kind: 'title' })} title={project ? t('rename') + ' · ' + project.name : t('rename')}>{project?.name || '…'}</button>
  </div>;
  return <div className="fo-workspace" ref={rootRef} onKeyDown={event => {
    if (event.key === 'F8' && !event.altKey && !event.ctrlKey && !event.metaKey &&
        event.target.closest('.fo-editor, .fo-issues') && jumpableIssues.length) {
      event.preventDefault();
      stepIssue(event.shiftKey ? -1 : 1);
    }
  }} onContextMenu={event => { if (event.target.closest('input, textarea, select, a[href], .fo-chat-body, .fo-menu, .fo-popover, .fo-dialog, .thesis-native-caption')) return; openMenu(event, paneItems()); }}>
    {captionSeat && createPortal(<div className="thesis-native-caption" style={captionSeat}>{documentTitle}</div>, document.body)}
    {(!captionSeat || !fixedWorkspace) && <header className="fo-topbar">
      {!captionSeat && documentTitle}
      {!fixedWorkspace && workspaceActions}
    </header>}
    <div className={`fo-bench${narrow ? ' is-narrow' : ''}${fixedWorkspace ? ' is-fixed-workspace' : ''}${width < 1240 ? ' is-compact-tools' : ''}${width < 900 ? ' is-tight-tools' : ''}`}>{bench}</div>
    {floating && chatPane}
    <footer className="thesis-status">
      <span className={'fo-save is-' + saveState}>{t(saveState === 'saving' ? 'saving' : saveState === 'dirty' ? 'unsaved' : 'saved')}</span>
      <span>{ENGINE_LABEL[project?.engine] || '—'}</span>
    </footer>
    {scopeDialog && <Dialog title={t('authorizeScope')} onClose={() => setScopeDialog(null)} busy={scopeBusy}>
      <form onSubmit={saveScope}>
        <p className="fo-dialog-copy">{scopeDialog.path}</p>
        <label className="fo-field">{t('scopeKind')}<select value={scopeDialog.selected ? 'selected' : 'file'}
          onChange={event => setScopeDialog({ ...scopeDialog, selected: event.target.value === 'selected' })}>
          {scopeDialog.range && <option value="selected">{t('scopeSelection')}</option>}
          <option value="file">{t('scopeFile')}</option>
        </select></label>
        <fieldset className="thesis-related-files"><legend>{t('scopeRelated')}</legend>
          {files.filter(item => item.kind === 'text' && /[.](tex|bib|sty|cls)$/i.test(item.path) && item.path !== scopeDialog.path).map(item =>
            <label key={item.path}><input type="checkbox" checked={scopeDialog.related.includes(item.path)} onChange={event => setScopeDialog({
              ...scopeDialog, related: event.target.checked ? [...scopeDialog.related, item.path] : scopeDialog.related.filter(path => path !== item.path)
            })} disabled={scopeBusy || (!scopeDialog.related.includes(item.path) && scopeDialog.related.length >= 12)} /> {item.path}</label>)}
        </fieldset>
        <p className="fo-dialog-copy">{t('scopeHelp')}</p>
        <button type="submit" className="fo-btn is-primary" disabled={scopeBusy}>{t('authorizeScope')}</button>
      </form>
    </Dialog>}
    {formatDialog?.action === 'equation' && <FormulaDialog t={t} value={formulaDraft} onChange={setFormulaDraft}
      onRecognize={recognizeFormula} onInsert={data => submitFormat('equation', data)} onClose={closeFormat} Dialog={Dialog} />}
    {formatDialog?.action === 'template' && <TemplateDialog t={t} source={file?.content || ''} main={file?.path === project?.mainFile}
      lang={project?.engine === 'xelatex' && locale.startsWith('zh') ? 'zh' : 'en'} canInsert={formatAvailable}
      onInsert={insertTemplate} onZip={() => templateRef.current?.click()} onClose={closeFormat} Dialog={Dialog}
      onCreate={template => { setFormatDialog(null); setDialog({ kind: 'templateNew', template }); }} />}
    {formatDialog && !['equation', 'template'].includes(formatDialog.action) && <FormatDialog kind={formatDialog.action} t={t} files={files} readBib={path => rpc('readFile', { projectId, path })}
      graphicx={file?.path === project?.mainFile ? graphicxPlan(file?.content || '') : { loaded: mainHasGraphics, at: null }}
      booktabs={file?.path === project?.mainFile ? packagePlan(file?.content || '', 'booktabs') : { loaded: mainHasBooktabs, at: null }}
      imageUrl={path => endpoint('api/dsh-thesis/raw?projectId=' + encodeURIComponent(projectId) + '&path=' + encodeURIComponent(path))}
      uploadImage={uploadFormatImage} Dialog={Dialog} onClose={closeFormat} onInsert={submitFormat} />}
    {texOpen && <TexDialog t={t} onClose={() => setTexOpen(false)} />}
    {menu && <Menu anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} />}
    {drop && <div className={`fo-drop is-${drop.zone}`} style={{ left: drop.left, top: drop.top, width: drop.width, height: drop.height }} aria-hidden="true" />}
    {dialog?.kind === 'templateNew' && <Dialog title={t(dialog.template === 'ctex' ? 'templateNewZh' : 'templateNewEn')} onClose={() => setDialog(null)}>
      <PromptForm t={t} label={t('projectName')} submitLabel={t('create')} onCancel={() => setDialog(null)} onSubmit={submitDialog} />
    </Dialog>}
    {dialog && dialog.kind !== 'templateNew' && <Dialog title={{ new: t('newFile'), rename: t('renameFile'), delete: t('deleteFile'), title: t('rename'), overwrite: t('replaceFiles') }[dialog.kind]} onClose={() => setDialog(null)}>
      <PromptForm t={t} label={dialog.kind === 'title' ? t('projectName') : t('filePath')} placeholder={t('filePlaceholder')} initial={dialog.kind === 'title' ? project?.name : dialog.kind === 'new' ? dialog.path || '' : dialog.path} danger={dialog.kind === 'delete' || dialog.kind === 'overwrite'} message={dialog.kind === 'delete' ? `${t('deleteFileConfirm')} — ${dialog.path}` : dialog.kind === 'overwrite' ? `${t('replaceFilesConfirm')} — ${dialog.items.map(item => item.name).join(', ')}` : ''} submitLabel={dialog.kind === 'delete' ? t('delete') : dialog.kind === 'overwrite' ? t('replace') : dialog.kind === 'new' ? t('create') : t('save')} onCancel={() => setDialog(null)} onSubmit={submitDialog} />
    </Dialog>}
  </div>;
}

function SourceOutline({ t, sources, mainFile, current, reveal }) {
  const groups = useMemo(() => {
    const entries = new Map(sources);
    if (current?.kind === 'text' && /\.tex$/i.test(current.path)) entries.set(current.path, analyzeTex(current.path, current.content));
    return projectOutline(entries, mainFile);
  }, [sources, mainFile, current?.path, current?.content]);
  if (!groups.length) return null;
  return <section className="thesis-outline" aria-label={t('outline')}>
    <strong>{t('outline')}</strong>
    {groups.map(({ path, headings }) =>
      <details key={path} open={path === current?.path || path === mainFile}>
        <summary title={path}>{path}</summary>
        <OutlineItems nodes={outlineTree(headings)} reveal={reveal} />
      </details>)}
  </section>;
}

function OutlineItems({ nodes, reveal }) {
  return <ul>{nodes.map(({ path, line, label, children }, index) => <li key={index}>
    <button type="button" title={label} onClick={() => reveal(path, line)}>{label}</button>
    {children.length > 0 && <OutlineItems nodes={children} reveal={reveal} />}
  </li>)}</ul>;
}

function ReferenceReport({ t, report, onClose, reveal }) {
  const status = report.loading ? t('checkingReferences') : report.error || (!report.issues.length ? t('referencesClear') : '');
  return <section className="thesis-check" aria-label={t('checkReferences')} aria-busy={Boolean(report.loading)}>
    <header><strong>{t('checkReferences')}</strong><button type="button" className="fo-icon-btn" aria-label={t('close')} onClick={onClose}><Icon name="close" size={14} /></button></header>
    {status ? <p role={report.error ? 'alert' : 'status'}>{status}</p> : <ul>
      {report.issues.map(({ path, line, key, kind }, index) => <li key={index}>
        <button className="fo-btn is-small" type="button" onClick={() => reveal(path, line)}>{path}:{line}</button>
        {' '}{t(kind)} <code>{key}</code>
      </li>)}
    </ul>}
  </section>;
}

function CompileMenu({ t, project, texFiles, autoCompile, setAutoCompile, setEngine, setMain, onCheck, onTex, onClose }) {
  const ref = useRef(null);
  useEffect(() => { const listener = event => { if (!ref.current?.contains(event.target) && !event.target.closest?.('.fo-compile-more')) onClose(); }; window.addEventListener('pointerdown', listener); return () => window.removeEventListener('pointerdown', listener); }, []);
  return <div className="fo-popover" ref={ref}>
    <label className="fo-field"><span>{t('engine')}</span><select value={project?.engine || 'pdflatex'} onChange={event => setEngine(event.target.value)}>{ENGINES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    <label className="fo-field"><span>{t('mainFile')}</span><select value={project?.mainFile || 'main.tex'} onChange={event => setMain(event.target.value)}>{texFiles.map(item => <option key={item.path} value={item.path}>{item.path}</option>)}</select></label>
    <label className="fo-switch"><input type="checkbox" checked={autoCompile} onChange={event => setAutoCompile(event.target.checked)} /><span />{t('autoCompile')}</label>
    <button className="fo-btn is-small" type="button" disabled={!project} onClick={onCheck}>{t('checkReferences')}</button>
    <button className="fo-btn is-small fo-tex-link" onClick={onTex}><Icon name="gear" size={14} /> {t('texEnv')}…</button>
  </div>;
}

/* ───────────── root ───────────── */

// A render error inside the workspace would otherwise leave the whole Folio panel blank, with no
// hint and no way out. Show what failed, and offer to drop the stored layout and start again.
class WorkspaceBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { try { console.error('Folio workspace failed to render', error, info); } catch {} }
  reset = () => {
    try { localStorage.removeItem(LAYOUT_KEY); } catch {}
    this.setState({ error: null });
    this.props.onReset?.();
  };
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="fo-empty" role="alert">
      <h3>{this.props.t('renderFailed')}</h3>
      <p className="fo-form-error">{messageOf(this.state.error)}</p>
      <div className="fo-review-actions">
        <button className="fo-btn is-primary" onClick={this.reset}>{this.props.t('resetLayout')}</button>
      </div>
    </div>;
  }
}

function FolioApp({ services, t, renderSlot, SessionProvider }) {
  const locale = (typeof navigator !== 'undefined' && document.documentElement.lang) || navigator.language || 'en';
  const [projects, setProjects] = useState([]); const [loading, setLoading] = useState(true);
  const [projectId, setProjectId] = useState(() => readStored(PROJECT_KEY, ''));
  const [toast, toasts] = useToasts();
  const loadProjects = useCallback(async () => { try { const { projects: list } = await rpc('listProjects'); setProjects(list); return list; } catch (error) { toast(messageOf(error), 'error'); return []; } finally { setLoading(false); } }, []);
  useEffect(() => { loadProjects().then(list => { if (projectId && !list.some(item => item.id === projectId)) open(''); }); }, []);
  const open = id => { setProjectId(id); store(PROJECT_KEY, id); if (!id) loadProjects(); };
  async function importThesis(name, entries, progress = () => {}) {
    const plan = planImport(entries);
    if (!plan.mainFile) throw new Error(t('importNoMain'));
    const project = await rpc('createProject', { name, template: 'empty' });
    try {
      for (const [index, file] of plan.files.entries()) {
        progress(index, plan.files.length);
        await rpc('uploadFile', { projectId: project.id, path: file.path, base64: toBase64(file.data), overwrite: true });
      }
      await rpc('updateProject', { projectId: project.id, mainFile: plan.mainFile, engine: plan.engine });
    } catch (error) { await rpc('deleteProject', { projectId: project.id }).catch(() => {}); throw error; }
    toast([t('imported'), plan.files.length, t('importedFiles'), '·', plan.mainFile, '·', ENGINE_LABEL[plan.engine]].join(' '));
    await loadProjects();
    open(project.id);
  }
  async function createThesis(name, template) {
    const project = await rpc('createProject', { name, template });
    await loadProjects();
    open(project.id);
  }
  return <div className="fo-root thesis-root">
    <style>{__FOLIO_CSS__}</style>
    {projectId ? <WorkspaceBoundary t={t} onReset={() => open('')}><Workspace key={projectId} t={t} locale={locale} services={services} projectId={projectId} onExit={() => open('')} onImport={importThesis} onCreate={createThesis} renderSlot={renderSlot} SessionProvider={SessionProvider} toast={toast} /></WorkspaceBoundary>
      : <Library t={t} locale={locale} projects={projects} loading={loading} onOpen={open}
        onCreate={createThesis}
        onRename={async (id, name) => { await rpc('updateProject', { projectId: id, name }); await loadProjects(); }}
        onDelete={async id => { await rpc('deleteProject', { projectId: id }); await loadProjects(); }}
        onImport={importThesis} />}
    {toasts}
  </div>;
}

export const inject = ['slots', 'layout', 'remote', 'remote.session', 'remote.workspace', 'sessions', 'locale'];
export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, 'en', english.folio));
  ctx.effect(() => ctx.locale.register(NS, 'zh', chinese.folio));
  const services = { remote: ctx.remote, sessions: ctx.sessions };
  const openedFromMode = new Set();
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: PANEL, locale: NS
  }, function ThesisModeEntry({ sessionId, useSessions }) {
    const preset = useSessions(state => state.byId[sessionId]?.projectionValues?.agentPreset);
    useEffect(() => {
      if (!sessionId || preset == null || ctx.layout.panelInfo?.getSnapshot().activePanelId === PANEL) return;
      if (preset !== PRESET) { openedFromMode.delete(sessionId); return; }
      if (openedFromMode.has(sessionId)) return;
      openedFromMode.add(sessionId);
      ctx.layout.selectPanel(PANEL);
    }, [sessionId, preset]);
    return null;
  }));
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL, locale: NS, children: { 'thesis.editor.chat': { kind: 'single', scope: 'session' } }, inject: () => ({ services }) }, FolioApp));
  ctx.slots.inject('thesis.editor.chat', () => ctx.slots.register({ name: 'thesis.editor.chat' }, FolioChat));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, label: () => ctx.locale.bind(NS)('panel'), locale: NS, order: 5 }, function FolioIcon({ size = 20 }) {
    return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true"><path d="M5.5 3.5h9l4 4v13h-13z" /><path d="M14.5 3.5v4h4" /><path d="M13.6 9.6c-.4-.5-.9-.7-1.5-.6-.8.2-1.1 1-1.3 2.1l-1.3 6.4c-.2 1-.7 1.5-1.4 1.5M10 12h3.4" /></svg>;
  }));
}
