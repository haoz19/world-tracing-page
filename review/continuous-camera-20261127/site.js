'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const PAGE_SIZE = 2;
  const DATASET = 'wt-continuous-camera-20261127-v1';
  const STORE = `wt-release:${DATASET}:feedback:v1`;
  const RATINGS = [['good', '好'], ['okay', '一般'], ['bad', '不好']];
  const TAGS = [['face', '脸'], ['identity', '身份'], ['motion', '动作'], ['geometry', '3D'], ['camera', '运镜'], ['transition', '过渡']];
  const NOTE_LIMIT = 240;
  const MAX_PAYLOAD = 20000;
  let manifest, page = 0, active = null, token = 0;
  let feedback = new Map();
  const players = new Set();
  const mediaPath = /^media\/[a-f0-9]{64}\.(mp4|jpg|png|webp)$/;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function duration(seconds) {
    const rounded = Math.round(seconds);
    return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
  }
  function size(bytes) { return `${(bytes / 1048576).toFixed(1)} MB`; }
  function tell(text) { $('feedback-status').textContent = text; }
  function emptyFeedback(item) {
    return {id: item.id, video_sha256: item.video_sha256, rating: '', tags: [], note: ''};
  }
  function payload() {
    return {schema_version: 1, dataset_id: DATASET, page, feedback: [...feedback.values()]};
  }
  function keysExactly(value, allowed) {
    return value && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).length === allowed.length && allowed.every(k => Object.hasOwn(value, k));
  }
  function validateFeedback(data) {
    if (!keysExactly(data, ['schema_version', 'dataset_id', 'page', 'feedback']) ||
        data.schema_version !== 1 || data.dataset_id !== DATASET ||
        !Number.isInteger(data.page) || data.page < 0 || data.page >= Math.ceil(manifest.shots.length / PAGE_SIZE) ||
        !Array.isArray(data.feedback) || data.feedback.length > manifest.shots.length + 1) throw Error('Wrong feedback envelope');
    const items = new Map([manifest.film, ...manifest.shots].map(item => [item.id, item]));
    const checked = new Map();
    for (const value of data.feedback) {
      if (!keysExactly(value, ['id', 'video_sha256', 'rating', 'tags', 'note']) ||
          !items.has(value.id) || checked.has(value.id) ||
          value.video_sha256 !== items.get(value.id).video_sha256 ||
          !['', ...RATINGS.map(x => x[0])].includes(value.rating) ||
          !Array.isArray(value.tags) || value.tags.length > TAGS.length ||
          new Set(value.tags).size !== value.tags.length ||
          !value.tags.every(tag => TAGS.some(x => x[0] === tag)) ||
          typeof value.note !== 'string' || value.note.length > NOTE_LIMIT ||
          /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value.note)) throw Error('Wrong item, hash or feedback');
      checked.set(value.id, {id: value.id, video_sha256: value.video_sha256,
        rating: value.rating, tags: [...value.tags], note: value.note});
    }
    return {entries: checked, page: data.page};
  }
  function saveFeedback() {
    try { localStorage.setItem(STORE, JSON.stringify(payload())); return true; }
    catch { tell('当前浏览器无法保存，请复制反馈链接或导出 JSON。'); return false; }
  }
  function loadFeedback() {
    try {
      const raw = localStorage.getItem(STORE);
      if (!raw) return;
      if (raw.length > MAX_PAYLOAD) throw Error('Storage too large');
      const checked = validateFeedback(JSON.parse(raw));
      feedback = checked.entries; page = checked.page;
    } catch { tell('已忽略不属于当前视频版本的本地反馈。'); }
  }
  function encodeFeedback(data) {
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  function decodeFeedback(encoded) {
    if (!encoded || encoded.length > MAX_PAYLOAD || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw Error('Invalid share encoding');
    const standard = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(standard + '='.repeat((4 - standard.length % 4) % 4));
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Uint8Array.from(raw, x => x.charCodeAt(0))));
  }
  function importPayload(data) {
    // Validate the complete payload before any state/storage change.
    const checked = validateFeedback(data);
    for (const [id, value] of checked.entries) feedback.set(id, value);
    page = checked.page;
    return {count: checked.entries.size, persisted: saveFeedback()};
  }
  function importHash() {
    const shared = new URLSearchParams(location.hash.slice(1)).get('feedback');
    if (!shared) return false;
    try {
      const result = importPayload(decodeFeedback(shared));
      if (result.persisted) {
        const url = new URL(location.href); const parts = new URLSearchParams(url.hash.slice(1));
        parts.delete('feedback'); url.hash = parts.toString();
        history.replaceState(history.state, '', url.href);
      }
      tell(result.persisted ? `已导入并保存 ${result.count} 条本轮反馈。` :
        `已导入 ${result.count} 条反馈，但当前浏览器未能保存。请立即复制反馈链接或导出 JSON；刷新会丢失后续修改。`);
      return true;
    } catch { tell('反馈链接未导入：数据集、视频版本或内容不匹配。'); return false; }
  }
  function makeFeedback(item, isFilm = false) {
    const section = node('section', 'item-feedback'); section.dataset.feedbackId = item.id;
    section.setAttribute('aria-label', `${item.title} · 反馈`);
    const value = feedback.get(item.id) || emptyFeedback(item);
    const ratings = node('fieldset', 'rating-field');
    ratings.append(node('legend', '', isFilm ? '这支成片感觉如何？' : '这个镜头感觉如何？'));
    const buttons = [];
    const status = node('span', 'saved-status'); status.setAttribute('role', 'status');
    function changed() {
      if (value.rating || value.tags.length || value.note) feedback.set(item.id, value);
      else feedback.delete(item.id);
      status.textContent = saveFeedback() ? '已保存' : '尚未保存';
    }
    for (const [key, label] of RATINGS) {
      const button = node('button', 'rating-button', label); button.type = 'button';
      button.dataset.rating = key; button.setAttribute('aria-pressed', String(value.rating === key));
      button.addEventListener('click', () => {
        value.rating = value.rating === key ? '' : key;
        for (const other of buttons) other.setAttribute('aria-pressed', String(other.dataset.rating === value.rating));
        changed();
      });
      buttons.push(button); ratings.append(button);
    }
    const tags = node('fieldset', 'tag-field'); tags.append(node('legend', '', '哪里需要改？可多选'));
    for (const [key, label] of TAGS) {
      const wrap = node('label', 'issue-tag'); const input = node('input');
      input.type = 'checkbox'; input.dataset.issue = key; input.checked = value.tags.includes(key);
      input.addEventListener('change', () => {
        const selected = new Set(value.tags);
        if (input.checked) selected.add(key); else selected.delete(key);
        value.tags = TAGS.map(x => x[0]).filter(x => selected.has(x)); changed();
      });
      wrap.append(input, node('span', '', label)); tags.append(wrap);
    }
    const label = node('label', 'note-label', '简短备注');
    const note = node('textarea', 'feedback-note'); note.rows = 3; note.maxLength = NOTE_LIMIT;
    note.dataset.note = ''; note.value = value.note; note.placeholder = '例如：转身时脸变了，过渡有点突然';
    note.id = `note-${item.id}`; label.htmlFor = note.id;
    note.addEventListener('input', () => { value.note = note.value; changed(); });
    section.append(ratings, tags, label, note, status);
    return section;
  }
  function refreshFeedback() {
    $('film-feedback').replaceChildren(makeFeedback(manifest.film, true)); renderShots();
  }
  function assetLink(item, label, className) {
    const a = node('a', className, label);
    a.href = item.video;
    a.download = `World-Tracing-${item.id}.mp4`;
    return a;
  }
  function release(player) {
    if (!player) return;
    if (active === player) { active = null; token += 1; }
    player.video.pause();
    if (player.video.hasAttribute('src')) {
      player.video.removeAttribute('src');
      player.video.load();
    }
    player.video.controls = false;
    player.video.hidden = true;
    player.image.hidden = false;
    player.play.hidden = false;
    player.stop.hidden = true;
    player.message.textContent = '';
  }
  function releaseAll() { for (const player of players) release(player); }
  async function activate(player) {
    if (active !== player) {
      releaseAll();
      active = player;
      token += 1;
      player.video.src = player.item.video;
      player.video.preload = 'auto';
    }
    const operation = token;
    player.video.hidden = false;
    player.video.controls = true;
    player.image.hidden = true;
    player.play.hidden = true;
    player.stop.hidden = false;
    player.message.textContent = '正在加载…';
    try {
      await player.video.play();
      if (operation !== token || active !== player) {
        // A delayed play promise must never reactivate a released card.
        if (active !== player) release(player);
        return;
      }
      player.message.textContent = '';
    } catch (error) {
      if (operation !== token || active !== player) return;
      player.message.textContent = '未能开始播放，请使用播放器按钮重试，或下载原文件。';
    }
  }
  function makePlayer(item, isFilm = false) {
    const container = node('div', 'player');
    container.dataset.testid = isFilm ? 'film-player' : 'shot-player';
    container.dataset.id = item.id;
    const shell = node('div', 'media-shell');
    shell.style.aspectRatio = `${item.width} / ${item.height}`;
    const image = node('img', 'poster');
    image.src = item.poster; image.alt = `${item.title} · 视频封面`;
    image.loading = isFilm ? 'eager' : 'lazy'; image.decoding = 'async';
    if (isFilm) image.fetchPriority = 'high';
    image.width = item.width; image.height = item.height;
    const video = node('video', 'media-video');
    video.preload = 'none'; video.playsInline = true;
    video.muted = !isFilm; video.hidden = true;
    video.setAttribute('aria-label', item.title);
    const play = node('button', 'play-overlay');
    play.type = 'button'; play.dataset.testid = 'play';
    play.setAttribute('aria-label', `播放${item.title}`);
    const icon = node('span', 'play-circle', '▶'); icon.setAttribute('aria-hidden', 'true');
    play.append(icon, node('span', '', isFilm ? '播放连续运镜' : '播放镜头'));
    shell.append(image, video, play);
    const toolbar = node('div', 'player-toolbar');
    toolbar.append(node('span', '', `${duration(item.duration_seconds)} · ${item.width} × ${item.height}`));
    const stop = node('button', 'release-button', '停止播放');
    stop.type = 'button'; stop.hidden = true; stop.dataset.testid = 'release';
    toolbar.append(stop);
    const message = node('p', 'player-message'); message.setAttribute('role', 'status');
    container.append(shell, toolbar, message);
    const player = {item, container, video, image, play, stop, message};
    players.add(player);
    play.addEventListener('click', () => activate(player));
    stop.addEventListener('click', () => release(player));
    video.addEventListener('play', () => {
      if (active !== player) release(player);
    });
    video.addEventListener('error', () => {
      if (active === player) message.textContent = '视频加载失败，请重试或下载原文件。';
    });
    video.addEventListener('playing', () => {
      if (active === player) message.textContent = '';
    });
    return player;
  }
  function renderShots() {
    releaseAll();
    for (const player of players) {
      if (player.container.dataset.testid === 'shot-player') players.delete(player);
    }
    const grid = $('shot-grid'); grid.replaceChildren();
    const start = page * PAGE_SIZE;
    for (const [offset, item] of manifest.shots.slice(start, start + PAGE_SIZE).entries()) {
      const article = node('article', 'shot-card'); article.dataset.testid = 'shot-card';
      article.dataset.id = item.id;
      article.append(makePlayer(item).container);
      const heading = node('div', 'shot-heading');
      heading.append(node('h3', '', item.title), node('span', 'shot-index', String(start + offset + 1).padStart(2, '0')));
      article.append(heading, node('p', 'shot-description', item.description || ''));
      article.append(assetLink(item, `下载这个镜头 · ${size(item.bytes)}`, 'shot-download'));
      article.append(makeFeedback(item));
      grid.append(article);
    }
    const pages = Math.ceil(manifest.shots.length / PAGE_SIZE);
    $('previous-page').disabled = page === 0;
    $('next-page').disabled = page + 1 === pages;
    $('page-label').textContent = `第 ${page + 1} / ${pages} 页 · ${manifest.shots.length} 个镜头`;
  }
  function validate(data) {
    if (!data || data.schema_version !== 1 || data.dataset_id !== DATASET || typeof data.title !== 'string' ||
        !Array.isArray(data.shots) || data.shots.length < 1 || data.shots.length > 10 || !data.film) throw Error('Invalid manifest');
    const ids = new Set();
    for (const item of [data.film, ...data.shots]) {
      if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) ||
          ids.has(item.id) || typeof item.title !== 'string' || !item.title ||
          typeof item.video !== 'string' || !mediaPath.test(item.video) || !item.video.endsWith('.mp4') ||
          typeof item.video_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.video_sha256) ||
          item.video !== `media/${item.video_sha256}.mp4` ||
          typeof item.poster !== 'string' || !mediaPath.test(item.poster) || item.poster.endsWith('.mp4') ||
          !Number.isInteger(item.width) || item.width < 1 || !Number.isInteger(item.height) || item.height < 1 ||
          !Number.isFinite(item.duration_seconds) || item.duration_seconds <= 0 ||
          !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.visual_approved !== true ||
          (item.description !== undefined && typeof item.description !== 'string')) throw Error('Invalid media item');
      ids.add(item.id);
    }
    return data;
  }
  $('previous-page').addEventListener('click', () => { if (page > 0) { page -= 1; saveFeedback(); renderShots(); } });
  $('next-page').addEventListener('click', () => {
    if (manifest && (page + 1) * PAGE_SIZE < manifest.shots.length) { page += 1; saveFeedback(); renderShots(); }
  });
  $('share-feedback').addEventListener('click', async () => {
    if (!manifest) return;
    const url = new URL(location.href); url.hash = `feedback=${encodeFeedback(payload())}`;
    $('feedback-url').value = url.href; $('share-result').hidden = false;
    try { await navigator.clipboard.writeText(url.href); tell('反馈链接已复制，包含当前视频版本和中文备注。'); }
    catch { $('feedback-url').focus(); $('feedback-url').select(); tell('请复制下方已选中的反馈链接。'); }
  });
  $('export-feedback').addEventListener('click', () => {
    if (!manifest) return;
    const blob = new Blob([JSON.stringify(payload(), null, 2) + '\n'], {type: 'application/json;charset=utf-8'});
    const url = URL.createObjectURL(blob); const link = node('a');
    link.href = url; link.download = `${DATASET}-feedback.json`; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000); tell('已导出本轮反馈 JSON。');
  });
  $('import-feedback').addEventListener('change', async event => {
    const file = event.target.files[0]; if (!file || !manifest) return;
    try {
      if (file.size > MAX_PAYLOAD) throw Error('Too large');
      const result = importPayload(JSON.parse(await file.text())); refreshFeedback();
      tell(result.persisted ? `已导入并保存 ${result.count} 条本轮反馈。` :
        `已导入 ${result.count} 条反馈，但当前浏览器未能保存。请立即复制反馈链接或导出 JSON；刷新会丢失后续修改。`);
    } catch { tell('JSON 未导入：数据集、视频版本或内容不匹配。'); }
    finally { event.target.value = ''; }
  });
  window.addEventListener('hashchange', () => { if (manifest && importHash()) refreshFeedback(); });
  window.addEventListener('pagehide', releaseAll);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && active) active.video.pause();
  });
  fetch('manifest.json', {cache: 'no-cache'})
    .then(response => { if (!response.ok) throw Error('Manifest unavailable'); return response.json(); })
    .then(data => {
      manifest = validate(data);
      loadFeedback(); importHash();
      document.title = `${manifest.title.replace(/\n/g, ' ')} — World Tracing`;
      $('film-heading').textContent = manifest.title;
      $('film-subtitle').textContent = manifest.subtitle || '';
      $('film-player').append(makePlayer(manifest.film, true).container);
      const filmFeedback = node('div'); filmFeedback.id = 'film-feedback';
      filmFeedback.append(makeFeedback(manifest.film, true)); $('film-player').append(filmFeedback);
      $('film-download').append(
        assetLink(manifest.film, '下载原始视频 ↓', 'download-button'),
        node('span', 'download-meta', `${manifest.film.width} × ${manifest.film.height} · ${size(manifest.film.bytes)} · 原始文件`)
      );
      renderShots();
      $('page-status').hidden = true;
      $('content').hidden = false;
    })
    .catch(() => {
      $('page-status').textContent = '本轮短片清单暂时无法读取，请稍后刷新。';
      $('page-status').classList.add('error');
    });
})();
