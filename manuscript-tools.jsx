import React, { useEffect, useMemo, useState } from 'react';
import katex from 'katex';
import { normalizeFormula, templateFragment } from './format-tools.js';

export function FormulaDialog({ t, value, onChange, onRecognize, onInsert, onClose, Dialog }) {
  const [image, setImage] = useState(null);
  const [imageUrl, setImageUrl] = useState('');
  const [numbered, setNumbered] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!image) { setImageUrl(''); return; }
    const url = URL.createObjectURL(image);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);
  const preview = useMemo(() => {
    const formula = normalizeFormula(value);
    if (!formula) return null;
    try {
      const markup = katex.renderToString(formula, { output: 'mathml', displayMode: true, throwOnError: true, trust: false, maxExpand: 250, maxSize: 15 });
      return /<m(?:error|text[^>]+mathcolor=["']#cc0000)/.test(markup) ? null : { formula, markup };
    } catch { return null; }
  }, [value]);
  function select(file) {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setError(t('formulaImageInvalid'));
      return;
    }
    setImage(file);
    setError('');
  }
  async function recognize() {
    if (!image || busy) return;
    setError('');
    setBusy(true);
    try { await onRecognize(image); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <Dialog title={t('shortEquation')} className="thesis-rich-format thesis-math-dialog" busy={busy} onClose={onClose}>
    <form onSubmit={event => {
      event.preventDefault();
      if (preview && !busy) onInsert({ formula: preview.formula, numbered });
    }} onPaste={event => {
      const file = [...event.clipboardData.files].find(item => item.type.startsWith('image/'));
      if (file) { event.preventDefault(); select(file); }
    }}>
      <label className="fo-field">{t('formulaSource')}
        <textarea autoFocus rows={3} value={value} maxLength={6000} placeholder={'E = mc^2'} onChange={event => { onChange(event.target.value); setError(''); }} />
      </label>
      <div className="thesis-formula-preview" aria-label={t('formulaPreview')}>
        {preview ? <div dangerouslySetInnerHTML={{ __html: preview.markup }} />
          : <span className={value.trim() ? 'fo-form-error' : 'fo-muted'}>{t(value.trim() ? 'formulaInvalid' : 'formulaPreviewEmpty')}</span>}
      </div>
      <label className="thesis-package-option"><input type="checkbox" checked={numbered} onChange={event => setNumbered(event.target.checked)} />{t('formulaNumbered')}</label>
      <details className="thesis-recognize" open={image ? true : undefined}>
        <summary>{t('formulaFromImage')}</summary>
        <p className="fo-dialog-copy">{t('formulaVisionHelp')}</p>
        <input type="file" aria-label={t('formulaFromImage')} accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={event => { select(event.target.files?.[0]); event.target.value = ''; }} />
        {imageUrl && <img src={imageUrl} alt={image.name || t('formulaFromImage')} />}
        <button className="fo-btn" type="button" disabled={!image || busy} onClick={recognize}>{t(busy ? 'loading' : 'formulaSend')}</button>
      </details>
      {error && <p className="fo-form-error" role="alert">{error}</p>}
      <footer><button type="button" className="fo-btn" disabled={busy} onClick={onClose}>{t('close')}</button><button className="fo-btn is-primary" disabled={busy || !preview}>{t('insertFormat')}</button></footer>
    </form>
  </Dialog>;
}

export function TemplateDialog({ t, source, main, lang, canInsert, onInsert, onCreate, onZip, onClose, Dialog }) {
  const [kind, setKind] = useState('sections');
  const [error, setError] = useState('');
  const fragment = canInsert && templateFragment(source, kind, lang, main);
  return <Dialog title={t('template')} className="thesis-rich-format" onClose={onClose}>
    <form onSubmit={event => {
      event.preventDefault();
      if (!fragment) return;
      if (!onInsert(kind)) setError(t('templatePlacement'));
    }}>
      <div className="thesis-template-buttons">
        <button type="button" className="fo-btn" onClick={() => onCreate('ctex')}>{t('templateNewZh')}</button>
        <button type="button" className="fo-btn" onClick={() => onCreate('article')}>{t('templateNewEn')}</button>
        <button type="button" className="fo-btn" onClick={onZip}>{t('templateZip')}</button>
      </div>
      <label className="fo-field">{t('templateInsert')}
        <select autoFocus value={kind} onChange={event => { setKind(event.target.value); setError(''); }}>
          <option value="sections">{t('templateSections')}</option>
          <option value="abstract">{t('templateAbstract')}</option>
          <option value="preamble" disabled={!main}>{t('templatePreamble')}</option>
        </select>
      </label>
      {fragment ? <pre className="thesis-template-source">{fragment.text}</pre> : <p className="fo-muted">{t('templateAlreadyPresent')}</p>}
      <p className="fo-dialog-copy">{t(kind === 'preamble' ? 'templatePreambleHint' : 'templateBodyHint')}</p>
      {error && <p className="fo-form-error" role="alert">{error}</p>}
      <footer><button type="button" className="fo-btn" onClick={onClose}>{t('close')}</button><button className="fo-btn is-primary" disabled={!fragment}>{t('insertFormat')}</button></footer>
    </form>
  </Dialog>;
}
