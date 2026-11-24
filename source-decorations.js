import { countColumn } from '@codemirror/state';
import { foldService, getIndentUnit } from '@codemirror/language';
import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import { latexOutline } from './latex-outline.js';

class LatexHint extends WidgetType {
  constructor(text) { super(); this.text = text; }
  eq(other) { return this.text === other.text; }
  toDOM(view) {
    const el = view.dom.ownerDocument.createElement('span');
    el.className = 'thesis-code-hint';
    el.textContent = '% ' + this.text;
    return el;
  }
}

function visibleDecorations(view) {
  const { doc, tabSize } = view.state;
  const { hints } = latexOutline(doc);
  const unit = getIndentUnit(view.state);
  const guides = Decoration.mark({ class: 'thesis-indent-guide', attributes: { style: '--thesis-indent-unit: ' + unit + 'ch' } });
  const ranges = [];
  const seen = new Set();
  for (const { from, to } of view.visibleRanges) {
    for (let line = doc.lineAt(from); line.from <= to; line = doc.lineAt(line.to + 1)) {
      if (!seen.has(line.from)) {
        seen.add(line.from);
        const whitespace = /^[ \t]*/.exec(line.text)[0];
        if (countColumn(whitespace, tabSize) >= unit) ranges.push(guides.range(line.from, line.from + whitespace.length));
        const hint = hints.get(line.from);
        if (hint) ranges.push(Decoration.widget({ widget: new LatexHint(hint), side: 1 }).range(line.to));
      }
      if (line.to === doc.length) break;
    }
  }
  return Decoration.set(ranges, true);
}

export const latexSourceDecorations = [
  foldService.of((state, lineStart) => latexOutline(state.doc).folds.get(lineStart)),
  ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = visibleDecorations(view); }
    update(update) {
      if (update.docChanged || update.viewportChanged) this.decorations = visibleDecorations(update.view);
    }
  }, { decorations: plugin => plugin.decorations })
];
