import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { inspectStructure } from './diagnostics.js';

export const ENGINES = ['pdflatex', 'xelatex', 'lualatex', 'tectonic'];
const MAX_SOURCE = 20 * 1024 * 1024;
const MAX_PDF = 20 * 1024 * 1024;
const MAX_LOG = 64 * 1024;
// Biber unpacks itself on first run; a persistent folder keeps later runs at ~3 s instead of ~25 s.
export const BIBER_CACHE = path.join(os.tmpdir(), 'dsh-folio-biber');
let tail = Promise.resolve();
let waiting = 0;
let cachedBuild = null;
export function buildCommand(engine, mainFile) {
  if (!ENGINES.includes(engine)) throw new Error('Unsupported TeX engine');
  if (typeof mainFile !== 'string' || !mainFile.endsWith('.tex') || path.isAbsolute(mainFile) || mainFile.includes('\\') || mainFile.split('/').some(part => !part || part.startsWith('.'))) throw new Error('Invalid main TeX path');
  mainFile = `./${mainFile}`;
  return engine === 'tectonic'
    ? { command: 'tectonic', args: ['--only-cached', '--untrusted', '--synctex', '--outdir', 'output', mainFile] }
    : { command: engine, args: ['-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-synctex=1', '-output-directory=output', mainFile] };
}
export function latexmkCommand(engine, mainFile) {
  const mode = { pdflatex: '-pdf', xelatex: '-pdfxe', lualatex: '-pdflua' }[engine];
  if (!mode || !/^[\p{L}\p{N}_. /-]+\.tex$/u.test(mainFile)) return null;
  const { args } = buildCommand(engine, mainFile);
  return { command: 'latexmk', args: ['-norc', mode, ...args.slice(0, 5), '-outdir=output', args.at(-1)] };
}

async function findLatexmk(searchPath) {
  const executable = process.platform === 'win32' ? 'latexmk.exe' : 'latexmk';
  for (const directory of (searchPath || process.env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const target = path.join(directory, executable);
    if (await fs.stat(target).then(stat => stat.isFile(), () => false)) return target;
  }
  return '';
}
export async function snapshotSources(root, target) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  let count = 0;
  async function walk(rel = '') {
    const entries = (await fs.readdir(path.join(root, rel), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'project.json' || entry.name === 'node_modules' || entry.name === 'output') continue;
      const name = path.posix.join(rel, entry.name);
      const source = path.join(root, name);
      const stat = await fs.lstat(source);
      if (stat.isSymbolicLink()) throw new Error('Symlink source is not allowed');
      if (stat.isDirectory()) {
        if (target) await fs.mkdir(path.join(target, name), { recursive: true });
        await walk(name);
      }
      else if (stat.isFile()) {
        if (++count > 500 || (bytes += stat.size) > MAX_SOURCE) throw new Error('Project snapshot limit exceeded');
        const content = await fs.readFile(source);
        hash.update(name).update('\0').update(content).update('\0');
        if (target) {
          await fs.mkdir(path.dirname(path.join(target, name)), { recursive: true });
          await fs.writeFile(path.join(target, name), content);
        }
      }
    }
  }
  await walk();
  return hash.digest('hex');
}
function run(command, args, cwd, timeoutMs, searchPath, signal, engine) {
  return new Promise(resolve => {
    let log = '';
    let timeout = false;
    let settled = false;
    // Do not pass provider keys, shell configuration, or the full host environment to TeX.
    // max_print_line stops TeX wrapping its log at 79 columns, which would split file:line errors.
    // LuaTeX's font loader reads support files by absolute path, which paranoid mode refuses;
    // restricted mode still refuses dotfiles.
    const env = { PATH: searchPath || process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: cwd, TMPDIR: cwd, PAR_GLOBAL_TMPDIR: BIBER_CACHE, max_print_line: '10000', error_line: '254', half_error_line: '238', openin_any: engine === 'lualatex' ? 'r' : 'p', openout_any: 'p', shell_escape: 'f', TEXMFOUTPUT: path.join(cwd, 'output'), BIBINPUTS: `${cwd}${path.delimiter}${path.join(cwd, 'output')}${path.delimiter}`, BSTINPUTS: `${cwd}${path.delimiter}`, XDG_CACHE_HOME: process.env.DSH_FOLIO_TEX_CACHE || process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache') };
    if (process.platform === 'win32') {
      env.SystemRoot = process.env.SystemRoot || 'C:\\Windows';
      env.WINDIR = env.SystemRoot;
      env.TEMP = env.TMP = cwd;
    }
    const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const append = value => { if (log.length < MAX_LOG) log += value.toString().slice(0, MAX_LOG - log.length); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const terminate = () => {
      if (!child.pid) return;
      try {
        if (process.platform !== 'win32') { process.kill(-child.pid, 'SIGKILL'); return; }
        const kill = spawn(path.join(env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        kill.on('error', () => child.kill('SIGKILL'));
        kill.on('exit', code => { if (code) child.kill('SIGKILL'); });
      } catch { child.kill('SIGKILL'); }
    };
    const timer = setTimeout(() => { timeout = true; terminate(); }, timeoutMs);
    const finish = (ok, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', terminate);
      resolve({ ok, log: log.slice(0, MAX_LOG - extra.length) + extra });
    };
    signal?.addEventListener('abort', terminate, { once: true });
    if (signal?.aborted) terminate();
    child.on('error', error => finish(false, error.code === 'ENOENT' ? `TeX engine not installed: ${command}` : 'TeX process failed'));
    child.on('close', code => finish(code === 0 && !timeout && !signal?.aborted, signal?.aborted ? '\nCompilation cancelled' : timeout ? '\nCompilation timed out' : ''));
  });
}
// `path` is the PATH to find TeX on, from the TeX environment; it defaults to Harness's own.
export function compileProject({ root, mainFile = 'main.tex', engine = 'pdflatex', timeoutMs = 60_000, path: searchPath, candidate, signal, preferLatexmk = false, cache = false }) {
  if (waiting >= 4) return Promise.resolve({ ok: false, pdf: null, log: 'Compile queue is full', version: '' });
  waiting += 1;
  const operation = tail.then(async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-folio-'));
    let version = '';
    let baselineVersion = '';
    let structural = [];
    try {
      if (signal?.aborted) return { ok: false, pdf: null, log: 'Compilation cancelled', cancelled: true };
      await fs.chmod(temp, 0o700);
      await fs.mkdir(BIBER_CACHE, { recursive: true, mode: 0o700 });
      baselineVersion = await snapshotSources(root, temp);
      version = baselineVersion;
      const cacheKey = JSON.stringify([root, mainFile, engine, searchPath || process.env.PATH, version, preferLatexmk]);
      if (!candidate && cache && !signal?.aborted && cachedBuild?.key === cacheKey && cachedBuild.until > Date.now()) {
        return { ...cachedBuild.result, reused: true };
      }
      if (candidate) {
        buildCommand(engine, candidate.path);
        const file = path.join(temp, candidate.path);
        const original = await fs.readFile(file, 'utf8');
        if (crypto.createHash('sha256').update(original).digest('hex') !== candidate.expectedHash) throw new Error('Source changed before validation');
        await fs.writeFile(file, candidate.content);
        version = await snapshotSources(temp);
      }
      structural = await inspectStructure(temp, mainFile);
      await fs.mkdir(path.join(temp, 'output'), { recursive: true });
      const { command, args } = buildCommand(engine, mainFile);
      const deadline = Date.now() + Math.min(60_000, Math.max(1, timeoutMs));
      let log = '';
      let bibliographyLog = '';
      let runner = engine;
      // `diagnostics` holds only the latest TeX pass (plus the bibliography tool), so warnings
      // already resolved by a rerun do not resurface; `log` keeps every pass for the raw view.
      async function pass(executable, parameters) {
        if (signal?.aborted) return { ok: false, log, diagnostics: 'Compilation cancelled', cancelled: true };
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { ok: false, log: `${log}\nCompilation timed out`, diagnostics: 'Compilation timed out' };
        const result = await run(executable, parameters, temp, remaining, searchPath, signal, engine);
        log = `${log}${result.log}\n`.slice(0, MAX_LOG);
        if (executable === 'bibtex' || executable === 'biber') bibliographyLog = result.log;
        return { ok: result.ok, log, diagnostics: `${bibliographyLog}\n${result.log}`, cancelled: signal?.aborted === true };
      }
      const job = path.basename(mainFile, '.tex');
      const mk = preferLatexmk ? latexmkCommand(engine, mainFile) : null;
      const executable = mk && await findLatexmk(searchPath);
      let result;
      if (executable) {
        runner = 'latexmk';
        result = await pass(executable, mk.args);
        const fallback = !result.ok && !result.cancelled && /I found no \\citation commands|(?:failed|not found|could not).{0,55}perl|could not find script engine|TeX engine not installed:/i.test(result.diagnostics || '');
        if (fallback) {
          runner = engine;
          await fs.rm(path.join(temp, 'output'), { recursive: true, force: true });
          await fs.mkdir(path.join(temp, 'output'));
          result = await pass(command, args);
        } else if (result.ok) {
          const finalLog = await fs.open(path.join(temp, 'output', job + '.log'), 'r').then(async handle => {
            try {
              const bytes = Buffer.alloc(MAX_LOG);
              const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
              return bytes.subarray(0, bytesRead).toString('utf8');
            } finally { await handle.close(); }
          }).catch(() => '');
          if (finalLog) result.diagnostics = finalLog + '\n' + result.log.split('\n').filter(line => /^(I found no |I couldn't open |Warning--|ERROR - |WARN - )/.test(line)).join('\n');
        }
      } else result = await pass(command, args);
      if (!result.ok) return { ...result, pdf: null, version, baselineVersion, structural };
      if (engine !== 'tectonic' && runner !== 'latexmk') {
        const bcf = path.join(temp, 'output', `${job}.bcf`);
        let bibliography = false;
        try { bibliography = (await fs.stat(bcf)).isFile(); } catch {}
        // A bibliography tool complaint (e.g. no \\cite yet) is reported in the log, not a failed build.
        if (bibliography) await pass('biber', ['--input-directory', 'output', '--output-directory', 'output', job]);
        else {
          let aux = '';
          try { aux = await fs.readFile(path.join(temp, 'output', `${job}.aux`), 'utf8'); } catch {}
          if (aux.includes('\\bibdata{')) await pass('bibtex', [`output/${job}`]);
        }
        // Resolve bibliography, citations, cross-references and table-of-contents page numbers.
        for (let iteration = 0; iteration < 2; iteration += 1) {
          result = await pass(command, args);
          if (!result.ok) return { ...result, pdf: null, version, baselineVersion, structural };
        }
      }
      const pdfPath = path.join(temp, 'output', `${path.basename(mainFile, '.tex')}.pdf`);
      const stat = await fs.lstat(pdfPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PDF) throw new Error('PDF output size or type limit');
      // SyncTeX maps PDF positions to source lines; it records paths inside this temporary snapshot.
      const synctex = await fs.readFile(path.join(temp, 'output', `${path.basename(mainFile, '.tex')}.synctex.gz`)).catch(() => null);
      const pdf = await fs.readFile(pdfPath);
      const compiled = { ok: true, pdf, pdfVersion: crypto.createHash('sha256').update(pdf).digest('hex'), synctex,
        synctexRoot: synctex ? await fs.realpath(temp) : '', log: result.log, diagnostics: result.diagnostics, version, baselineVersion, structural, runner };
      if (!candidate && !signal?.aborted && (pdf.length + (synctex?.length || 0)) <= MAX_PDF) cachedBuild = { key: cacheKey, result: compiled, until: Date.now() + 120_000 };
      return compiled;
    } catch (error) { return { ok: false, pdf: null, log: error.message, version, baselineVersion, structural, cancelled: signal?.aborted === true }; }
    finally { await fs.rm(temp, { recursive: true, force: true }); }
  });
  tail = operation.catch(() => {}).finally(() => { waiting -= 1; });
  return operation;
}

const SOURCE_FILE = /^\((?:"([^"]+)"|(\.{0,2}[\\/][^\s()]+|[A-Za-z]:[\\/][^\s()]+|[^\s()]+\.(?:tex|ltx|sty|cls|bib|bbl|aux|toc|out|def|cfg|clo|fd|tikz|pgf)))(?=[\s()]|$)/;
const LOCATED_ERROR = /^(?:error:\s+)?("?[^"]+?\.(?:tex|sty|cls|bib|bbl)"?):(\d+):\s*(.+)$/i;
const ERROR_CONTEXT = /^l\.(\d+)(?:\s|$)/;
// A project source as the client names it, or '' for TeX's own files and build output.
function projectFile(name) {
  if (!name) return '';
  const relative = path.posix.normalize(name.replace(/\\/g, '/').replace(/^"(.*)"$/, '$1'));
  return /^(?:\/|[A-Za-z]:|\.\.(?:\/|$)|output\/)/.test(relative) ? '' : relative;
}
// Turn a -file-line-error TeX log into jumpable problems; the raw log stays available.
// TeX prints "(file" when it starts reading a file and ")" when it finishes, so the open
// parentheses tell which file a warning's "input line N" belongs to.
export function parseLog(log = '') {
  const problems = [];
  const seen = new Set();
  const push = item => { const key = `${item.level}|${item.file}|${item.line}|${item.message}`; if (!seen.has(key) && problems.length < 100) { seen.add(key); problems.push(item); } };
  const lines = log.split(/\r?\n/);
  let stack = [];
  const located = line => {
    // Lines count within the file being read; one inside a package cannot be jumped to.
    const reading = stack.findLast(Boolean);
    if (reading === undefined) return { file: '', line };
    const file = projectFile(reading);
    return { file, line: file ? line : 0 };
  };
  const track = text => {
    for (let at = 0; at < text.length; at += 1) {
      if (text[at] === '(') { const opened = text.slice(at).match(SOURCE_FILE); stack.push(opened ? opened[1] ?? opened[2] : null); if (opened) at += opened[0].length - 1; }
      else if (text[at] === ')') stack.pop();
    }
  };
  for (let i = 0; i < lines.length; i += 1) {
    if (/^This is \S*TeX/.test(lines[i])) stack = [];
    const error = lines[i].match(LOCATED_ERROR);
    // The closing "==> Fatal error occurred" line repeats the position of the real error above it.
    if (error) {
      const file = projectFile(error[1]);
      const message = error[3].trim();
      if (!/^==> Fatal error/.test(message)) push({ level: 'error', file, line: file ? Number(error[2]) : 0, message });
      continue;
    }
    const missing = lines[i].match(/^TeX engine not installed: (.+)$/);
    if (missing) { push({ level: 'error', file: '', line: 0, message: `${missing[1]} was not found. Open TeX environment to locate your TeX installation.`, setup: true }); continue; }
    if (/^!\s/.test(lines[i])) {
      const message = lines[i].slice(1).trim();
      if (/^==> Fatal error/.test(message) && problems.some(item => item.level === 'error')) continue;
      let line = 0;
      for (let j = i + 1; j < Math.min(lines.length, i + 16); j += 1) {
        if (/^!\s/.test(lines[j]) || LOCATED_ERROR.test(lines[j]) || SOURCE_FILE.test(lines[j]) || /^\)/.test(lines[j])) break;
        const context = lines[j].match(ERROR_CONTEXT);
        if (context) { line = Number(context[1]); break; }
      }
      push({ level: 'error', ...located(line), message });
      continue;
    }
    // Error context ("l.12 \foo)") quotes the source, whose parentheses are not file markers.
    if (ERROR_CONTEXT.test(lines[i])) continue;
    const warning = lines[i].match(/^(?:LaTeX|Package [\w-]+) Warning: (.+)$/);
    if (warning) {
      let text = warning[1];
      if (/^Shell escape feature is not enabled/.test(text)) continue; // expected: TeX runs without shell escape
      while (!/\.$/.test(text) && i + 1 < lines.length) {
        const next = lines[i + 1];
        if (!next.trim() || /Warning:|^!\s/.test(next) || LOCATED_ERROR.test(next)) break;
        text += ' ' + lines[++i].replace(/^\([\w-]+\)\s*/, '').trim();
      }
      const line = text.match(/on input line (\d+)/);
      push({ level: 'warning', ...located(line ? Number(line[1]) : 0), message: text.trim() });
      continue;
    }
    const bib = lines[i].match(/^(I found no .+|I couldn't open .+|Warning--.+|ERROR - .+|WARN - .+)$/);
    if (bib) { push({ level: 'warning', file: '', line: 0, message: bib[1].replace(/---while reading file .*/, '').trim() }); continue; }
    const box = lines[i].match(/^(Overfull|Underfull) \\[hv]box .* at lines? (\d+)/);
    if (box) push({ level: 'typesetting', ...located(Number(box[2])), message: lines[i].trim() });
    track(lines[i]);
  }
  return problems;
}
