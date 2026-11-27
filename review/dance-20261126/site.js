'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const PAGE_SIZE = 2;
  let manifest, page = 0, active = null, token = 0;
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
    image.loading = 'lazy'; image.decoding = 'async';
    image.width = item.width; image.height = item.height;
    const video = node('video', 'media-video');
    video.preload = 'none'; video.playsInline = true;
    video.muted = !isFilm; video.hidden = true;
    video.setAttribute('aria-label', item.title);
    const play = node('button', 'play-overlay');
    play.type = 'button'; play.dataset.testid = 'play';
    play.setAttribute('aria-label', `播放${item.title}`);
    const icon = node('span', 'play-circle', '▶'); icon.setAttribute('aria-hidden', 'true');
    play.append(icon, node('span', '', isFilm ? '播放成片 · 开启声音' : '播放镜头'));
    shell.append(image, video, play);
    const toolbar = node('div', 'player-toolbar');
    toolbar.append(node('span', '', `${duration(item.duration_seconds)} · ${item.width} × ${item.height}`));
    const stop = node('button', 'release-button', '停止并释放');
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
      article.append(assetLink(item, `下载原始视频 · ${size(item.bytes)}`, 'shot-download'));
      grid.append(article);
    }
    const pages = Math.ceil(manifest.shots.length / PAGE_SIZE);
    $('previous-page').disabled = page === 0;
    $('next-page').disabled = page + 1 === pages;
    $('page-label').textContent = `第 ${page + 1} / ${pages} 页 · ${manifest.shots.length} 个镜头`;
  }
  function validate(data) {
    if (!data || data.schema_version !== 1 || typeof data.title !== 'string' ||
        !Array.isArray(data.shots) || data.shots.length !== 4 || !data.film) throw Error('Invalid manifest');
    const ids = new Set();
    for (const item of [data.film, ...data.shots]) {
      if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) ||
          ids.has(item.id) || typeof item.title !== 'string' || !item.title ||
          typeof item.video !== 'string' || !mediaPath.test(item.video) || !item.video.endsWith('.mp4') ||
          typeof item.poster !== 'string' || !mediaPath.test(item.poster) || item.poster.endsWith('.mp4') ||
          !Number.isInteger(item.width) || item.width < 1 || !Number.isInteger(item.height) || item.height < 1 ||
          !Number.isFinite(item.duration_seconds) || item.duration_seconds <= 0 ||
          !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.visual_approved !== true ||
          (item.description !== undefined && typeof item.description !== 'string')) throw Error('Invalid media item');
      ids.add(item.id);
    }
    return data;
  }
  $('previous-page').addEventListener('click', () => { if (page > 0) { page -= 1; renderShots(); } });
  $('next-page').addEventListener('click', () => {
    if (manifest && (page + 1) * PAGE_SIZE < manifest.shots.length) { page += 1; renderShots(); }
  });
  window.addEventListener('pagehide', releaseAll);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && active) active.video.pause();
  });
  fetch('manifest.json', {cache: 'no-cache'})
    .then(response => { if (!response.ok) throw Error('Manifest unavailable'); return response.json(); })
    .then(data => {
      manifest = validate(data);
      document.title = `${manifest.title.replace(/\n/g, ' ')} — World Tracing`;
      $('film-heading').textContent = manifest.title;
      $('film-subtitle').textContent = manifest.subtitle || '';
      $('film-player').append(makePlayer(manifest.film, true).container);
      $('film-download').append(
        assetLink(manifest.film, '下载高清成片 ↓', 'download-button'),
        node('span', 'download-meta', `${manifest.film.width} × ${manifest.film.height} · ${size(manifest.film.bytes)} · 原始文件`)
      );
      renderShots();
      $('page-status').hidden = true;
      $('content').hidden = false;
    })
    .catch(() => {
      $('page-status').textContent = '短片清单暂时无法读取。请稍后刷新，或通过上方链接查看对照页。';
      $('page-status').classList.add('error');
    });
})();
