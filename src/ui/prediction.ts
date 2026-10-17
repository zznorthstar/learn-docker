import type { App } from '../app/app';
import { esc } from './h';

/** The prediction card: commit to an answer BEFORE the experiment runs, then see the truth and its cause. */
export function renderPrediction(app: App): string {
  const p = app.engine.activePrediction;
  if (!p) return '';
  // keep a revealed card around until dismissed
  const opts = p.options
    .map((o) => {
      const chosen = p.chosenId === o.id;
      const cls = p.status === 'revealed' ? (o.id === p.answerId ? 'right' : chosen ? 'wrong' : '') : '';
      return `<button class="opt ${cls}" aria-pressed="${chosen}" data-act="predict-pick" data-arg="${esc(o.id)}" data-pid="${esc(p.id)}" ${p.status === 'revealed' ? 'disabled' : ''}><b>${esc(o.id.toUpperCase())}</b><span>${esc(o.label)}</span></button>`;
    })
    .join('');
  // once revealed the card collapses to a slim bar so it never blocks the world underneath
  if (p.status === 'revealed' && !app.ui.predExpanded) {
    const v = p.correct === undefined ? 'Here is what happened.' : p.correct ? 'You called it.' : 'Not quite.';
    return `<div class="predict compact" role="group" aria-label="Prediction result"><span class="v ${p.correct ? 'right' : p.correct === false ? 'wrong' : ''}">${esc(v)}</span><button class="btn small" data-act="pred-expand">Why?</button><button class="btn small ghost" data-act="predict-dismiss" aria-label="Dismiss">✕</button></div>`;
  }
  let foot = '';
  if (p.status === 'open' || p.status === 'answered') {
    foot = `<div class="row"><button class="btn primary" data-act="predict-run" data-arg="${esc(p.id)}" ${p.chosenId ? '' : 'disabled'}>${p.chosenId ? 'Lock in &amp; run it' : 'Pick an answer first'}</button><button class="btn ghost" data-act="predict-run" data-arg="${esc(p.id)}">Just show me</button><button class="btn ghost" data-act="predict-dismiss">Dismiss</button></div>`;
  } else {
    const right = p.correct;
    foot = `<div class="verdict">${right === undefined ? '<strong>Here is what happened.</strong>' : right ? '<strong class="right">You called it.</strong>' : '<strong class="wrong">Not quite.</strong>'} ${esc(p.explanation)}</div>
      <div class="row"><button class="btn small" data-act="pred-expand">Collapse</button><button class="btn small" data-act="dock" data-arg="events">See the causes</button><button class="btn small" data-act="predict-rewind" data-arg="${esc(p.id)}">Rewind to before</button><button class="btn small ghost" data-act="predict-dismiss">Dismiss</button></div>`;
  }
  return `<div class="predict" role="group" aria-label="Prediction"><h3>Predict before it happens</h3><p class="q">${esc(p.question)}</p><div class="opts">${opts}</div>${foot}</div>`;
}
