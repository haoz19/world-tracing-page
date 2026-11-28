'use strict';
const video = document.getElementById('preview');
const download = document.getElementById('download');
const buttons = [...document.querySelectorAll('[data-variant]')];
const variants = {
  white: {src: 'white.mp4', poster: 'white-poster.jpg', label: '冷白荧光'},
  blue: {src: 'blue.mp4', poster: 'blue-poster.jpg', label: '蓝色荧光'}
};
let active = 'white';
let generation = 0;
let pendingSwitch = null;
for (const button of buttons) {
  button.addEventListener('click', () => {
    const key = button.dataset.variant;
    if (key === active) return;
    const state = variants[key];
    const stamp = ++generation;
    const intent = pendingSwitch || {
      time: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      resume: !video.paused
    };
    pendingSwitch = intent;
    video.pause();
    active = key;
    for (const b of buttons) b.setAttribute('aria-pressed', String(b === button));
    video.poster = state.poster;
    video.setAttribute('aria-label', state.label + '点云动态预览');
    video.src = state.src;
    download.href = state.src;
    download.download = `world-tracing-${key}-glow-1080x1920.mp4`;
    video.addEventListener('loadedmetadata', () => {
      if (stamp !== generation) return;
      video.currentTime = Math.min(intent.time, Math.max(0, video.duration - 1 / 24));
      if (intent.resume) video.play().catch(() => {});
      pendingSwitch = null;
    }, {once: true});
    video.load();
  });
}
