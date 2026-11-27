'use strict';
(() => {
  const D = window.STAGE_PICKS_DATA;
  const DATASET = 'wt-stage-picks-20261127-v1';
  if (!D || D.dataset_id !== DATASET || !Array.isArray(D.clips)) throw new Error('Wrong stage-picks dataset');
  const STORE = DATASET + ':feedback';
  const SIZE = 4;
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const validIds = new Set(D.clips.map(c=>c.id));
  const safeAsset = s => /^media\/[a-zA-Z0-9_-]+\.(mp4|jpg|jpeg|png|webp)$/.test(s || '') ? s : '';
  const safeLink = s => {try {const u=new URL(s);return u.protocol==='https:'?u.href:'#';} catch (_) {return '#';}};
  const state = {filter:'all', page:0, feedback:{}};
  function sanitize(input) {
    const result = {};
    if (!input || typeof input!=='object' || Array.isArray(input)) return result;
    if (Object.keys(input).length>100) throw new Error('Too many feedback entries');
    for (const [id,v] of Object.entries(input)) {
      if (!validIds.has(id) || !v || typeof v!=='object') continue;
      const vote=['want','skip'].includes(v.vote)?v.vote:null;
      const note=typeof v.note==='string'?v.note.slice(0,600):'';
      if(vote || note) result[id]={vote,note};
    }
    return result;
  }
  const encode = obj => {const bytes=new TextEncoder().encode(JSON.stringify(obj));let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');};
  const decode = s => JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))));
  function restoreHash() {
    if(!location.hash.startsWith('#picks='))return false;
    try {
      const raw=location.hash.slice(7);if(raw.length>150000)throw new Error('Oversize');
      const p=decode(raw);
      if(p.schema_version!==1 || p.dataset_id!==DATASET)throw new Error('Different dataset');
      state.feedback={...state.feedback,...sanitize(p.feedback)};
      if(['all','kpop','western'].includes(p.filter))state.filter=p.filter;
      if(Number.isInteger(p.page)&&p.page>=0)state.page=p.page;
      save();$('#status').textContent='已恢复本轮选择与备注。';return true;
    } catch (_) {$('#status').textContent='此链接不属于本轮，或内容无法读取；本机选择已保留。';return false;}
  }
  function save() {
    state.feedback=sanitize(state.feedback);
    try{localStorage.setItem(STORE,JSON.stringify({schema_version:1,dataset_id:DATASET,feedback:state.feedback}));}catch(_){}
    const entries=Object.values(state.feedback),n=entries.filter(x=>x.vote==='want').length,k=entries.filter(x=>x.vote==='skip').length;
    $('#selection-count').textContent=n||k?`${n} 条想看 · ${k} 条跳过`:'尚未选择';
  }
  try{const p=JSON.parse(localStorage.getItem(STORE)||'null');if(p?.dataset_id===DATASET&&p.schema_version===1)state.feedback=sanitize(p.feedback);}catch(_){}
  function releaseVideos(except=null) {
    document.querySelectorAll('.media video').forEach(v=>{
      if(v===except)return;const media=v.parentElement;v.pause();v.removeAttribute('src');v.load();v.remove();
      const b=media.querySelector('[data-play]');if(b)b.hidden=false;
    });
  }
  function card(c) {
    const f=state.feedback[c.id]||{vote:null,note:''};
    return `<article class="card" data-id="${esc(c.id)}"><div class="card-top"><div class="kicker"><span>${c.category==='kpop'?'K-POP':'欧美 POP'} · ${esc(c.artist)}</span><span>原片节选</span></div><h2>${esc(c.title)}</h2><p class="style">${esc(c.style_zh)}</p></div><div class="media" style="--source-aspect:${c.preview.width}/${c.preview.height}"><button class="poster-play" data-play="${esc(safeAsset(c.clip_asset))}" aria-label="播放${esc(c.title)}原片节选"><img loading="lazy" src="${esc(safeAsset(c.poster_asset))}" width="${c.poster.width}" height="${c.poster.height}" alt="${esc(c.title)}实际原片画面"><span>▶ 看动作与运镜 · ${Number(c.preview.duration_seconds).toFixed(1)}秒</span></button></div><div class="clip-modes" aria-label="选择预览长度"><button data-play="${esc(safeAsset(c.clip_asset))}" data-mode="context" aria-pressed="true">动作与运镜 · ${Number(c.preview.duration_seconds).toFixed(1)}秒</button><button data-play="${esc(safeAsset(c.core.clip_asset))}" data-mode="core" aria-pressed="false">重建候选短窗 · ${Number(c.core.preview.duration_seconds).toFixed(1)}秒</button></div><div class="card-body"><p class="dimensions"><span>原速长预览</span><span>原片 ${c.source.width}×${c.source.height}</span><span>预览 ${c.preview.width}×${c.preview.height}</span><span>${esc(c.source_interval_label)}</span></p><p class="clarity"><span class="label">动作与运镜</span>${esc(c.context_note_zh)}</p><p class="clarity"><span class="label">重建候选短窗 · ${esc(c.core.source_interval_label)}</span>${esc(c.clarity_zh)}</p><p class="wt"><span class="label">可以怎样重拍</span>${esc(c.wt_idea_zh)}</p><p class="heat">发布 ${esc(c.published_date)} · ${esc(c.heat_evidence.label_zh)}<br>${esc(c.heat_evidence.as_of_label_zh)} · <a href="${esc(safeLink(c.heat_evidence.url))}" target="_blank" rel="noopener noreferrer">热度出处 ↗</a></p><div class="links"><a href="${esc(safeLink(c.official_url))}" target="_blank" rel="noopener noreferrer">官方完整原片 ↗</a><a href="${esc(safeAsset(c.clip_asset))}" download>下载长预览 ↓</a><a href="${esc(safeAsset(c.core.clip_asset))}" download>下载短窗 ↓</a></div></div><div class="feedback" data-feedback-id="${esc(c.id)}"><div class="votes"><button data-vote="want" aria-pressed="${f.vote==='want'}">想看这个</button><button data-vote="skip" aria-pressed="${f.vote==='skip'}">先跳过</button><button data-clear>取消选择</button></div><label for="note-${esc(c.id)}">备注 · 喜欢的动作、造型或想看的镜头</label><textarea id="note-${esc(c.id)}" data-note maxlength="600" placeholder="例如：这段有感觉，想看同动作换两位主角"></textarea></div></article>`;
  }
  function render() {
    releaseVideos();const rows=D.clips.filter(c=>state.filter==='all'||c.category===state.filter);
    const pages=Math.max(1,Math.ceil(rows.length/SIZE));state.page=Math.min(state.page,pages-1);
    document.querySelectorAll('[data-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.filter===state.filter)));
    $('#cards').innerHTML=rows.slice(state.page*SIZE,(state.page+1)*SIZE).map(card).join('')||'<p>这个分类还没有已选短片。</p>';
    $('#cards').querySelectorAll('[data-note]').forEach(t=>{t.value=state.feedback[t.closest('[data-feedback-id]').dataset.feedbackId]?.note||'';});
    $('#page-info').textContent=`第 ${state.page+1} / ${pages} 页 · ${rows.length} 条`;
    $('#prev').disabled=state.page===0;$('#next').disabled=state.page===pages-1;save();
  }
  document.addEventListener('click',e=>{
    const filter=e.target.closest('[data-filter]');if(filter){state.filter=filter.dataset.filter;state.page=0;render();return;}
    const play=e.target.closest('[data-play]');if(play){
      const src=safeAsset(play.dataset.play);if(!src)return;releaseVideos();
      const card=play.closest('.card'),media=card.querySelector('.media');const mode=play.dataset.mode||'context';
      card.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===mode)));
      const v=document.createElement('video');v.controls=true;v.playsInline=true;v.loop=mode==='core';v.preload='metadata';v.src=src;v.setAttribute('aria-label',play.getAttribute('aria-label')||card.querySelector('h2').textContent);
      v.addEventListener('error',()=>{$('#status').textContent='这段暂时无法播放，可打开官方原片或下载预览。';},{once:true});
      media.appendChild(v);media.querySelector('.poster-play').hidden=true;v.play().catch(()=>{$('#status').textContent='视频已加载，请点击播放器播放。';});return;
    }
    const vote=e.target.closest('[data-vote]'),clear=e.target.closest('[data-clear]');
    if(vote||clear){const box=(vote||clear).closest('[data-feedback-id]'),id=box.dataset.feedbackId,f=state.feedback[id]||{vote:null,note:''};f.vote=clear?null:(f.vote===vote.dataset.vote?null:vote.dataset.vote);state.feedback[id]=f;box.querySelectorAll('[data-vote]').forEach(b=>b.setAttribute('aria-pressed',String(f.vote===b.dataset.vote)));save();}
  });
  document.addEventListener('input',e=>{if(!e.target.matches('[data-note]'))return;const id=e.target.closest('[data-feedback-id]').dataset.feedbackId;state.feedback[id]={...(state.feedback[id]||{vote:null}),note:e.target.value.slice(0,600)};save();});
  function turn(delta){state.page+=delta;render();$('.toolbar').scrollIntoView({behavior:'smooth',block:'start'});}
  $('#prev').addEventListener('click',()=>turn(-1));$('#next').addEventListener('click',()=>turn(1));
  $('#share').addEventListener('click',async()=>{
    const hash='#picks='+encode({schema_version:1,dataset_id:DATASET,filter:state.filter,page:state.page,feedback:state.feedback});
    history.replaceState(null,'',hash);$('#share-box').hidden=false;$('#share-url').value=location.href;
    try{await navigator.clipboard.writeText(location.href);$('#status').textContent='分享链接已复制。';}catch(_){$('#share-url').focus();$('#share-url').select();$('#status').textContent='分享链接已生成，请复制。';}
  });
  window.addEventListener('hashchange',()=>{if(restoreHash())render();});
  document.addEventListener('play',e=>{if(e.target instanceof HTMLVideoElement)releaseVideos(e.target);},true);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)document.querySelectorAll('video').forEach(v=>v.pause());});
  window.addEventListener('pagehide',()=>releaseVideos());
  for(const type of ['all','kpop','western'])$('#count-'+type).textContent=D.clips.filter(c=>type==='all'||c.category===type).length;
  restoreHash();render();
})();
