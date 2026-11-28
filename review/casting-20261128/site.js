'use strict';
(() => {
  const C = window.WTCasting, $ = id => document.getElementById(id);
  let manifest = null, feedback = new Map(), page = 0, filter = 'all';
  const visibleImages = new Set();
  function node(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function tell(text) { $('feedback-status').textContent = text; }
  function payload() { return {schema_version:1,dataset_id:C.DATASET,filter,page,feedback:[...feedback.values()]}; }
  function save() {
    try { localStorage.setItem(C.STORE,JSON.stringify(payload())); return true; }
    catch { tell('当前浏览器无法保存，请复制反馈链接或导出 JSON。'); return false; }
  }
  function updateSummary() {
    const likes = [...feedback.values()].filter(v => v.rating === 'like').length;
    const revisions = [...feedback.values()].filter(v => v.rating === 'revise').length;
    $('selection-summary').textContent = '已选喜欢 ' + likes + ' 张 · 待改 ' + revisions + ' 张 · 备注与选择跨页保存';
  }
  function applyChecked(checked) {
    for (const [id,value] of checked.entries) {
      if (value.rating || value.tags.length || value.note) feedback.set(id,value);
      else feedback.delete(id);
    }
    page = checked.page; filter = checked.filter;
  }
  function importPayload(data) {
    const checked = C.validateFeedback(data,manifest); // All-or-nothing validation before mutation.
    applyChecked(checked);
    return {count:checked.entries.size,persisted:save()};
  }
  function load() {
    try {
      const raw = localStorage.getItem(C.STORE);
      if (!raw) return;
      if (raw.length > C.MAX_PAYLOAD) throw Error('Stored payload too large');
      applyChecked(C.validateFeedback(JSON.parse(raw),manifest));
    } catch { tell('已忽略不属于本轮图片版本的本地反馈。'); }
  }
  function importHash() {
    const encoded = new URLSearchParams(location.hash.slice(1)).get('feedback');
    if (!encoded) return false;
    try {
      const result = importPayload(C.decodeFeedback(encoded));
      if (result.persisted) {
        const url = new URL(location.href), parts = new URLSearchParams(url.hash.slice(1));
        parts.delete('feedback'); url.hash = parts.toString();
        history.replaceState(history.state,'',url.href);
      }
      tell(result.persisted ? '已导入并保存 ' + result.count + ' 条角色反馈。' :
        '已导入，但当前浏览器无法保存。请立即复制反馈链接或导出 JSON。');
      return true;
    } catch { tell('反馈未导入：图片版本、数据集或内容不匹配。'); return false; }
  }
  function makeFeedback(item) {
    const section = node('section','item-feedback');
    section.dataset.feedbackId = item.id;
    section.setAttribute('aria-label',item.title + ' · 反馈');
    const stored = feedback.get(item.id);
    const value = stored ? {...stored,tags:[...stored.tags]} :
      {id:item.id,image_sha256:item.image_sha256,rating:'',tags:[],note:''};
    const status = node('span','saved-status'); status.setAttribute('role','status');
    const changed = () => {
      if (value.rating || value.tags.length || value.note) feedback.set(item.id,{...value,tags:[...value.tags]});
      else feedback.delete(item.id);
      status.textContent = save() ? '已保存' : '尚未保存';
      updateSummary();
    };
    const ratings = node('fieldset','rating-field'); ratings.append(node('legend','','这个角色怎么样？'));
    const buttons = [];
    for (const [key,label] of C.RATINGS) {
      const b = node('button','rating-button',label); b.type = 'button'; b.dataset.rating = key;
      b.setAttribute('aria-pressed',String(value.rating === key));
      b.addEventListener('click',() => {
        value.rating = value.rating === key ? '' : key;
        buttons.forEach(other => other.setAttribute('aria-pressed',String(other.dataset.rating === value.rating)));
        changed();
      });
      buttons.push(b); ratings.append(b);
    }
    const tags = node('fieldset','tag-field'); tags.append(node('legend','','标记关注点 · 可多选'));
    for (const [key,label] of C.TAGS) {
      const wrap = node('label','issue-tag'), input = node('input');
      input.type = 'checkbox'; input.dataset.issue = key; input.checked = value.tags.includes(key);
      input.addEventListener('change',() => {
        const selected = new Set(value.tags);
        if (input.checked) selected.add(key); else selected.delete(key);
        value.tags = C.TAGS.map(t => t[0]).filter(t => selected.has(t)); changed();
      });
      wrap.append(input,node('span','',label)); tags.append(wrap);
    }
    const label = node('label','note-label','备注'), count = node('span','note-count');
    const note = node('textarea','feedback-note'); note.id = 'note-' + item.id; label.htmlFor = note.id;
    note.rows = 2; note.maxLength = C.NOTE_LIMIT; note.value = value.note;
    note.placeholder = '例如：喜欢脸和衣服，希望腿部比例更自然';
    count.textContent = value.note.length + '/' + C.NOTE_LIMIT; label.append(count);
    note.addEventListener('input',() => {
      value.note = note.value; count.textContent = value.note.length + '/' + C.NOTE_LIMIT; changed();
    });
    section.append(ratings,tags,label,note,status);
    return section;
  }
  function releaseImages() {
    for (const image of visibleImages) {
      image.onload = null; image.onerror = null;
      image.removeAttribute('srcset'); image.removeAttribute('src');
    }
    visibleImages.clear();
  }
  function makeCard(item) {
    const card = node('article','cast-card'); card.dataset.id = item.id;
    const top = node('div','card-top'), title = node('h3','',item.title);
    title.id = 'title-' + item.id; card.setAttribute('aria-labelledby',title.id);
    top.append(title,node('span','kind',item.kind === 'photo' ? 'PHOTO / 写实' : 'ANIME / 动漫'));
    const shell = node('a','image-shell');
    shell.href = item.image; shell.target = '_blank'; shell.rel = 'noopener';
    shell.setAttribute('aria-label','查看 ' + item.title + ' 完整原图');
    shell.style.setProperty('--ratio',item.width + ' / ' + item.height);
    const image = node('img','cast-image');
    image.alt = item.title + ' · 完整角色原图'; image.width = item.width; image.height = item.height;
    image.decoding = 'async'; image.loading = 'eager';
    const error = node('span','image-error','这张原图未能加载。请刷新，或使用下方原图链接。'); error.hidden = true;
    image.onerror = () => { if (visibleImages.has(image)) error.hidden = false; };
    image.onload = () => { if (visibleImages.has(image)) error.hidden = true; };
    visibleImages.add(image); image.src = item.image;
    shell.append(image,error);
    const body = node('div','card-body');
    if (item.description) body.append(node('p','description',item.description));
    const actions = node('div','asset-actions'), download = node('a','download','下载原始 PNG ↓');
    download.href = item.image; download.download = item.id + '.png'; download.dataset.testid = 'download-original';
    actions.append(download,node('span','original-meta',item.width + ' × ' + item.height + (item.bytes ? ' · ' + (item.bytes/1048576).toFixed(1) + ' MB' : '')));
    body.append(actions,makeFeedback(item));
    card.append(top,shell,body); return card;
  }
  function render(scrollToTop = false) {
    if (!manifest) return;
    releaseImages(); $('cast-grid').replaceChildren();
    const selected = C.filterItems(manifest,filter), pages = Math.ceil(selected.length/C.PAGE_SIZE);
    page = Math.min(page,pages-1);
    for (const item of selected.slice(page*C.PAGE_SIZE,(page+1)*C.PAGE_SIZE)) $('cast-grid').append(makeCard(item));
    document.querySelectorAll('[data-filter]').forEach(b => b.setAttribute('aria-pressed',String(b.dataset.filter === filter)));
    document.querySelectorAll('[data-count]').forEach(s => { s.textContent = C.filterItems(manifest,s.dataset.count).length; });
    $('previous-page').disabled = page === 0; $('next-page').disabled = page+1 >= pages;
    $('page-label').textContent = '第 ' + (page+1) + ' / ' + pages + ' 页 · ' + selected.length + ' 张';
    updateSummary();
    if (scrollToTop) $('gallery-heading').scrollIntoView({block:'start',behavior:'auto'});
  }
  document.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click',() => {
    if (!manifest || filter === b.dataset.filter) return;
    filter = b.dataset.filter; page = 0; save(); render(true);
  }));
  $('previous-page').addEventListener('click',() => {
    if (!manifest || page === 0) return; page--; save(); render(true);
  });
  $('next-page').addEventListener('click',() => {
    if (!manifest || (page+1)*C.PAGE_SIZE >= C.filterItems(manifest,filter).length) return;
    page++; save(); render(true);
  });
  $('share-feedback').addEventListener('click',async () => {
    if (!manifest) return;
    const url = new URL(location.href); url.hash = 'feedback=' + C.encodeFeedback(payload());
    $('feedback-url').value = url.href; $('share-result').hidden = false;
    try { await navigator.clipboard.writeText(url.href); tell('反馈链接已复制，包含所有页的选择和备注。'); }
    catch { $('feedback-url').focus(); $('feedback-url').select(); tell('请复制下方已选中的反馈链接。'); }
  });
  $('export-feedback').addEventListener('click',() => {
    if (!manifest) return;
    const blob = new Blob([JSON.stringify(payload(),null,2)+'\n'],{type:'application/json;charset=utf-8'});
    const url = URL.createObjectURL(blob), a = node('a'); a.href = url; a.download = C.DATASET + '-feedback.json';
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url),1000);
    tell('已导出所有页的角色反馈 JSON。');
  });
  $('choose-import').addEventListener('click',() => $('import-feedback').click());
  $('import-feedback').addEventListener('change',async event => {
    const file = event.target.files[0]; if (!file || !manifest) return;
    try {
      if (file.size > C.MAX_PAYLOAD) throw Error('Too large');
      const result = importPayload(JSON.parse(await file.text())); render();
      tell(result.persisted ? '已导入并保存 ' + result.count + ' 条角色反馈。' :
        '已导入，但当前浏览器无法保存。请立即复制反馈链接或导出 JSON。');
    } catch { tell('JSON 未导入：图片版本、数据集或内容不匹配。'); }
    finally { event.target.value = ''; }
  });
  window.addEventListener('hashchange',() => { if (manifest && importHash()) render(); });
  window.addEventListener('pagehide',releaseImages);
  window.addEventListener('pageshow',event => { if (event.persisted && manifest) render(); });
  fetch('data.json',{cache:'no-cache'}).then(r => { if (!r.ok) throw Error('Missing manifest'); return r.json(); })
    .then(data => {
      manifest = C.validateManifest(data); load(); importHash(); render();
      $('page-status').hidden = true; $('content').hidden = false;
    }).catch(() => {
      $('page-status').textContent = '本轮角色清单暂时无法读取，请稍后刷新。'; $('page-status').classList.add('error');
    });
})();
