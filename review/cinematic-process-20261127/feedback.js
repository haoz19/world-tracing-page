(() => {
  'use strict';
  const dataset = 'wt-cinematic-process-20261127-v1';
  const storageKey = `feedback:${dataset}`;
  const cases = [
    ['process_dynamic_v1', 'Process preview', document.querySelector('main > section')],
    ['process_freeze_v1', 'Frozen camera study', document.querySelector('.freeze-copy')],
    ...['seoul', 'noir', 'anime'].map((id, i) => [`reference_g12_${id}`, ['Seoul reference', 'Noir reference', 'Anime reference'][i], document.querySelectorAll('.wt-casting-card')[i]])
  ];
  const ids = new Set(cases.map(c => c[0]));
  const ratings = [['good', 'Keep'], ['revise', 'Improve'], ['bad', 'Reject']];
  const allowed = new Set(['', ...ratings.map(r => r[0])]);
  let records = new Map();
  let initialMessage = '';
  function validate(value) {
    if (!value || value.v !== 1 || value.d !== dataset || !Array.isArray(value.r) || value.r.length > ids.size) throw Error('This feedback belongs to a different review.');
    const result = new Map();
    for (const row of value.r) {
      if (!Array.isArray(row) || row.length !== 3 || !ids.has(row[0]) || result.has(row[0]) || !allowed.has(row[1]) || typeof row[2] !== 'string' || row[2].length > 2000) throw Error('Invalid feedback data.');
      result.set(row[0], {rating: row[1], note: row[2]});
    }
    return result;
  }
  function payload() {
    return {v: 1, d: dataset, r: [...records].filter(([, r]) => r.rating || r.note).map(([id, r]) => [id, r.rating, r.note])};
  }
  function encode(value) {
    return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  }
  function decode(value) {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 120000) throw Error('Invalid feedback link.');
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0))));
  }
  try { const saved = localStorage.getItem(storageKey); if (saved) records = validate(JSON.parse(saved)); }
  catch { initialMessage = 'Browser storage is unavailable or contains an older review. You can still export feedback.'; }
  try {
    const shared = new URLSearchParams(location.hash.slice(1)).get('feedback');
    if (shared) {
      const incoming = validate(decode(shared));
      for (const [id, row] of incoming) records.set(id, row);
      initialMessage = `Loaded ${incoming.size} shared review item(s).`;
      try {
        localStorage.setItem(storageKey, JSON.stringify(payload()));
        // Consume a successful import so a reload cannot overwrite newer local edits.
        const url = new URL(location.href);
        const fragment = new URLSearchParams(url.hash.slice(1));
        fragment.delete('feedback'); url.hash = fragment.toString();
        history.replaceState(history.state, '', url.href);
      } catch {
        initialMessage += ' Browser storage is unavailable. Export any changes before closing.';
      }
    }
  } catch { initialMessage = 'Could not read the shared feedback. Your existing local marks are unchanged.'; }
  const element = (tag, text, cls) => { const el = document.createElement(tag); if (text) el.textContent = text; if (cls) el.className = cls; return el; };
  const panel = element('section', '', 'wt-feedback-transfer');
  panel.setAttribute('aria-label', 'Share review feedback');
  panel.append(element('p', 'Mark a preview or reference above. Marks stay in this browser; copy the feedback link and send it back, or download the JSON. Nothing is uploaded automatically.'));
  const actions = element('div', '', 'actions');
  const copy = element('button', 'Copy feedback link'); copy.type = 'button';
  const download = element('button', 'Download feedback'); download.type = 'button';
  const link = element('textarea'); link.readOnly = true; link.hidden = true; link.setAttribute('aria-label', 'Feedback link to copy');
  const status = element('p', initialMessage, 'status'); status.setAttribute('role', 'status');
  actions.append(copy, download); panel.append(actions, link, status);
  document.querySelector('footer').before(panel);
  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify(payload())); status.textContent = 'Saved in this browser.'; }
    catch { status.textContent = 'Browser storage is unavailable. Copy or download your feedback before closing.'; }
    link.hidden = true;
  }
  for (const [id, label, target] of cases) {
    if (!target) continue;
    const record = records.get(id) || {rating: '', note: ''}; records.set(id, record);
    const field = element('fieldset', '', 'wt-review'); field.dataset.caseId = id;
    field.append(element('legend', `Review · ${label}`));
    const choices = element('div', '', 'wt-review-ratings');
    for (const [value, title] of ratings) {
      const button = element('button', title); button.type = 'button'; button.dataset.rating = value;
      button.setAttribute('aria-pressed', String(record.rating === value));
      button.addEventListener('click', () => {
        record.rating = record.rating === value ? '' : value;
        for (const b of choices.children) b.setAttribute('aria-pressed', String(b.dataset.rating === record.rating));
        save();
      });
      choices.append(button);
    }
    const noteLabel = element('label', 'What should change?'); noteLabel.htmlFor = `note-${id}`;
    const note = element('textarea'); note.id = noteLabel.htmlFor; note.maxLength = 2000; note.value = record.note;
    note.placeholder = 'Faces, clothing, point cloud, transitions, camera…';
    note.addEventListener('input', () => {record.note = note.value; save();});
    field.append(choices, noteLabel, note); target.append(field);
  }
  copy.addEventListener('click', async () => {
    const url = new URL(location.href); url.search = ''; url.hash = `feedback=${encode(payload())}`;
    link.value = url.href; link.hidden = false;
    try { await navigator.clipboard.writeText(url.href); status.textContent = 'Copied. Send this link back with your feedback.'; }
    catch { link.focus(); link.select(); status.textContent = 'Select and copy the link below, then send it back.'; }
  });
  download.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload(), null, 2) + '\n'], {type:'application/json'}));
    const a = element('a'); a.href = url; a.download = 'world-tracing-cinematic-feedback.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); status.textContent = 'Feedback downloaded. Send the JSON file back.';
  });
  // Opening a new shared fragment in this tab must import it, too.
  window.addEventListener('hashchange', () => {
    if (new URLSearchParams(location.hash.slice(1)).has('feedback')) location.reload();
  });
})();
