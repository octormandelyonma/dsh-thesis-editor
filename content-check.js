// Only a small set of known LaTeX formatting changes can pass this check.
const wrappers = new Set(['textbf', 'textmd', 'textit', 'textsl', 'textsc', 'textnormal', 'textrm', 'textsf', 'texttt', 'emph', 'underline']);
const formatting = new Set(['centering', 'raggedleft', 'raggedright', 'noindent', 'hline', 'toprule', 'midrule', 'bottomrule', 'hfill']);
const environments = new Set(['table', 'table*', 'figure', 'figure*', 'center', 'flushleft', 'flushright']);
const guardedCommand = /\\(?:cite\w*|[A-Za-z]*ref|label|input|include|bibliography|addbibresource|includegraphics|caption|title|author|section|subsection|subsubsection|chapter|part|paragraph|footnote)\*?(?![A-Za-z@])/gi;
const mathPattern = /\\begin\s*\{(math|displaymath|equation\*?|align\*?|alignat\*?|gather\*?|multline\*?|flalign\*?|eqnarray\*?|matrix|pmatrix|cases)\}[\s\S]*?\\end\s*\{\1\}|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|(?<!\\)\$\$[\s\S]*?(?<!\\)\$\$|(?<![\\$])\$(?!\$)(?:\\.|[^$\\])*\$/g;

export function maskComments(source) {
  return source.replace(/\\.|%[^\r\n]*/g, part => part[0] === '%' ? ' '.repeat(part.length) : part);
}

function closing(text, start, open, close) {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue; }
    if (text[index] === open) depth++;
    if (text[index] === close && --depth === 0) return index + 1;
  }
  return start;
}

function graphicsOptions(options) {
  return options.split(',').filter(option => !/^\s*width\s*=\s*(?:\d+(?:\.\d+)?|\.\d+)?\s*(?:\\(?:line|text|column)width|px|pt|cm|mm|in)\s*$/.test(option)).join(',');
}

function protectedText(source) {
  const records = [];
  const text = maskComments(source).replace(mathPattern, value => {
    records.push(['math', value]);
    return ' THESIS_PROTECTED_MATH ';
  });
  for (const match of text.matchAll(guardedCommand)) {
    const command = match[0];
    let cursor = match.index + command.length;
    const options = [];
    while (/\s/.test(text[cursor] || '')) cursor++;
    while (text[cursor] === '[') {
      const end = closing(text, cursor, '[', ']');
      if (end === cursor) break;
      options.push(text.slice(cursor + 1, end - 1));
      cursor = end;
      while (/\s/.test(text[cursor] || '')) cursor++;
    }
    const end = text[cursor] === '{' ? closing(text, cursor, '{', '}') : cursor;
    records.push([command, /^\\includegraphics/.test(command) ? options.map(graphicsOptions).filter(Boolean) : options, text.slice(cursor, end)]);
  }
  return { text, records };
}

function normalized(text) {
  const source = text
    .replace(/\\(?:begin|end)\s*\{([^}]+)\}(?:\[[!htbpH]+\])?/g, (whole, name) => environments.has(name) ? '' : whole)
    .replace(/\\([a-zA-Z@]+)(?![a-zA-Z@])[ \t]*/g, (whole, name) => formatting.has(name) ? '' : whole)
    .replace(/\\includegraphics(\*?)\s*\[([^\]]+)\]/g, (_, star, options) => {
      const rest = graphicsOptions(options);
      return '\\includegraphics' + star + (rest ? '[' + rest + ']' : '');
    });
  const ignored = new Set();
  const groups = [];
  for (const token of source.matchAll(/\\([a-zA-Z@]+)[ \t]*(\{)?|\\[^\r\n]|[{}]/g)) {
    if (token[2] || token[0] === '{') {
      groups.push(token[2] && wrappers.has(token[1]) ? token : null);
    } else if (token[0] === '}') {
      const open = groups.pop();
      if (!open) continue;
      for (let index = open.index; index < open.index + open[0].length; index++) ignored.add(index);
      ignored.add(token.index);
    }
  }
  if (groups.some(Boolean)) return null;
  return source.replace(/[\s\S]/g, (value, index) => ignored.has(index) ? '' : value)
    .replace(/\r?\n[ \t]*(?:\r?\n[ \t]*)+/g, '\n\n').split('\n\n').map(part => part.replace(/\s+/g, ' ').trim()).join('\n\n');
}

export function classifyChange(before, after) {
  const old = protectedText(before), next = protectedText(after);
  if (JSON.stringify(old.records) !== JSON.stringify(next.records)) return 'protected';
  const unsafe = /(?<!\\)\$|\\(?:[\[\]()\]]|begin\s*\{(?:math|displaymath|equation|align|gather|multline|flalign|eqnarray|verbatim|lstlisting|minted)|verb\b|(?:re)?new(?:command|environment)\b|(?:g|x|e)?def\b|catcode\b)/i;
  if (unsafe.test(old.text) || unsafe.test(next.text)) return 'uncertain';
  const comments = value => (value.match(/\\.|%[^\r\n]*/g) || []).filter(part => part.startsWith('%'));
  if (JSON.stringify(comments(before)) !== JSON.stringify(comments(after))) return 'uncertain';
  const original = normalized(old.text), candidate = normalized(next.text);
  if (original == null || candidate == null) {
    // A closing brace can repair a known formatting wrapper. Keep every other token fixed.
    if (original == null && candidate != null && next.text.length === old.text.length + 1) {
      let index = 0;
      while (index < old.text.length && old.text[index] === next.text[index]) index++;
      if (next.text[index] === '}' && old.text.slice(index) === next.text.slice(index + 1)) return 'formatting';
    }
    return 'uncertain';
  }
  return original === candidate ? 'formatting' : 'protected';
}
