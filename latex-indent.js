export const literalEnvironments = new Set(['verbatim', 'verbatim*', 'Verbatim', 'BVerbatim', 'LVerbatim', 'lstlisting', 'minted', 'comment']);
const leadingSpace = /^[ \t]*/;
export const latexStructureTokens = /%.*|\\verb\*?([^\s*]).*?(?:\1|$)|\\(begin|end)\s*\{([^}\s]+)\}|\\[\[\]]|\\(?:[a-zA-Z@]+|.)|[{}]/g;

// Track structure across lines, ignoring escaped delimiters and comments.
function createIndenter(unit) {
  let groups = 0;
  let display = 0;
  let literal = '';
  const environments = [];
  const depth = () => groups + display + environments.length;

  return line => {
    if (literal) {
      if (line.trimStart().startsWith('\\end{' + literal + '}')) literal = '';
      return null;
    }
    let indentation = depth();
    let leading = true;
    let offset = 0;
    for (const match of line.matchAll(latexStructureTokens)) {
      const [token, verb, direction, name] = match;
      if (token.startsWith('%')) break;
      if (/\S/.test(line.slice(offset, match.index))) leading = false;
      offset = match.index + token.length;
      if (token === '}' || token === '\\]' || direction === 'end') {
        if (token === '}') groups = Math.max(0, groups - 1);
        else if (token === '\\]') display = Math.max(0, display - 1);
        else if (environments.at(-1) === name) environments.pop();
        if (leading) indentation = depth();
        continue;
      }
      leading = false;
      if (verb) continue;
      if (token === '{') groups++;
      else if (token === '\\[') display++;
      else if (direction === 'begin' && name !== 'document') {
        if (literalEnvironments.has(name)) {
          if (!line.includes('\\end{' + name + '}', offset)) literal = name;
          break;
        }
        environments.push(name);
      }
    }
    return Math.min(indentation, 40) * unit;
  };
}

export function latexIndentAt(context, position) {
  const { doc } = context.state;
  const line = doc.lineAt(position);
  const current = context.lineAt(position);
  const indent = createIndenter(context.unit);
  for (const text of doc.iterLines(1, line.number)) indent(text);
  // When Enter splits a line, account for its prefix before indenting the new line.
  if (current.from === position && position > line.from) indent(doc.sliceString(line.from, position));
  return indent(current.text);
}

export function latexIndentChanges(doc, { from, to }, unit = 2) {
  const start = doc.lineAt(from).number;
  const end = doc.lineAt(to > from ? to - 1 : to).number;
  const indent = createIndenter(unit);
  const changes = [];
  let lineNumber = 1;
  let position = 0;
  for (const text of doc.iterLines(1, end + 1)) {
    const width = indent(text);
    if (lineNumber >= start && width !== null && text.trim()) {
      const before = leadingSpace.exec(text)[0];
      const after = ' '.repeat(width);
      if (before !== after) changes.push({ from: position, to: position + before.length, insert: after });
    }
    lineNumber++;
    position += text.length + 1;
  }
  return changes;
}
