'use strict';
(() => {
  const D = window.CANDIDATE_DATA;
  const STORE = 'wt-candidate-round-20261127-v1';
  const SIZE = 4;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const url = (s) => /^https?:\/\//i.test(s || '') ? s : '#';
  const group = {same_motion_new_protagonists:'同动作 · 换主角',freeze_or_reverse_with_new_camera:'时间 · 新镜头',spatial_duplication_and_placement:'空间 · 复制与位置',scene_and_scale_editing:'场景 · 尺度'};
  const state = {tab:'sources',pages:{sources:0,briefs:0,casting:0},feedback:{}};
  const allowedKeys = new Set(['sources','briefs','casting'].flatMap(tab => D[tab].map(x => tab + ':' + x.id)));
  function sanitizeFeedback(input) {
    const clean = {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) return clean;
    const entries = Object.entries(input);
    if (entries.length > 64) throw new Error('too many feedback entries');
    for (const [key,value] of entries) {
      if (!allowedKeys.has(key) || !value || typeof value !== 'object') continue;
      const vote = ['want','skip'].includes(value.vote) ? value.vote : null;
      const note = typeof value.note === 'string' ? value.note.slice(0,1000) : '';
      clean[key] = {vote,note};
    }
    return clean;
  }
  try { state.feedback = sanitizeFeedback(JSON.parse(localStorage.getItem(STORE) || '{}')); } catch (_) {}
  const encode = (obj) => {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    let binary = ''; for (const n of bytes) binary += String.fromCharCode(n);
    return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  };
  const decode = (str) => JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(str.replace(/-/g,'+').replace(/_/g,'/')), c=>c.charCodeAt(0))));
  function restoreHash() {
    if (!location.hash.startsWith('#feedback=')) return false;
    try {
      const raw = location.hash.slice(10);
      if (raw.length > 200000) throw new Error('too large');
      const data = decode(raw);
      if (data.version !== 1 || data.round !== '20261127') throw new Error('wrong version');
      state.feedback = {...state.feedback,...sanitizeFeedback(data.feedback)};
      if (['sources','briefs','casting'].includes(data.tab)) state.tab = data.tab;
      if (Number.isInteger(data.page) && data.page >= 0) state.pages[state.tab] = data.page;
      save();
      $('#status').textContent = '已从分享链接恢复选择与备注。';
      return true;
    } catch (_) { $('#status').textContent = '分享内容无法读取，保留本机已有选择。'; return false; }
  }
  function save() {
    try { localStorage.setItem(STORE,JSON.stringify(state.feedback)); } catch (_) {}
    const values = Object.values(state.feedback);
    const want = values.filter(v=>v.vote==='want').length, skip = values.filter(v=>v.vote==='skip').length;
    $('#selection-count').textContent = want || skip ? `${want} 项想看 · ${skip} 项跳过` : '尚未选择';
  }
  function releaseVideos() {
    document.querySelectorAll('video').forEach(v=>{v.pause();v.removeAttribute('src');v.querySelectorAll('source').forEach(s=>s.remove());v.load();});
  }
  function feedback(c) {
    const key = state.tab+':'+c.id, f = state.feedback[key] || {vote:null,note:''};
    return `<div class="feedback" data-key="${esc(key)}"><div class="vote-buttons"><button class="want" data-vote="want" aria-pressed="${f.vote==='want'}">想看这个</button><button class="skip" data-vote="skip" aria-pressed="${f.vote==='skip'}">先跳过</button><button class="clear" data-clear>取消选择</button></div><label for="note-${esc(key)}">备注 · 想看的主角、动作或镜头（可选）</label><textarea id="note-${esc(key)}" data-note maxlength="1000" placeholder="例如：保留这个动作，想看冻结后推近脸部"></textarea></div>`;
  }
  function source(c) {
    const dimensions = c.source_native_width && c.source_native_height ? `原片 ${c.source_native_width}×${c.source_native_height}` : c.width && c.height ? `已取片段 ${c.width}×${c.height}` : '尺寸待核';
    const previewDimensions=c.actualpreview_w && c.actualpreview_h ? `预览 ${c.actualpreview_w}×${c.actualpreview_h}` : '';
    const duration = Number.isFinite(c.actualpreview_duration) ? `${c.actualpreview_duration.toFixed(2)}秒预览` : '片段待选';
    const media = c.clip_asset ? `<div class="media"><video playsinline controls preload="none" ${c.poster_asset ? `poster="${esc(c.poster_asset)}"` : ''} aria-label="${esc(c.title)}原片预览"></video><span class="media-label">原片 · 不是模型结果</span><button class="play" data-play="${esc(c.clip_asset)}">▶ 点击加载原片</button></div>` : `<div class="empty-media"><b>暂无短视频预览</b><span>可查看原始来源与下方选源说明。</span><a href="${esc(url(c.original_url))}" target="_blank" rel="noopener noreferrer">打开原始来源 ↗</a></div>`;
    const assessment = c.assessment || {};
    return `<article class="card" data-id="${esc(c.id)}"><div class="card-top"><div class="kicker"><span>${esc(c.category || '原片候选')}</span><span class="pending">${c.clip_asset?'原片可预览 · 小样待做':'参考源 · 暂无推荐短片'}</span></div><h2>${esc(c.title)}</h2><p class="hook">${esc(c.hook_zh || '')}</p></div>${media}<div class="card-body"><div class="meta"><span>${esc(dimensions)}</span>${previewDimensions ? `<span>${esc(previewDimensions)}</span>` : ''}<span>${esc(duration)}</span>${c.fps?`<span>${esc(c.fps)} fps</span>`:''}</div><p class="operation"><span class="label">想做的 WT 编辑</span>${esc(c.wt_operation_zh || '')}</p><p class="risk"><span class="label">选源时要注意</span>${esc(c.risks_zh || '')}</p><details><summary>来源与当前进度</summary><p>${esc(c.availability || '')}</p><p>${esc(assessment.cut_status || '尚未逐帧审核')}</p><p>模型视频：尚未为此候选完成测试。</p>${c.local_upload_differs ? '<p>本地预览来自另一已记录上传；它与上方原始来源页的时间区间不能混用。</p>' : ''}${c.contact_asset?`<a href="${esc(c.contact_asset)}" target="_blank" rel="noopener">查看实际原片联系图 ↗</a>`:''}</details><a class="source-link" href="${esc(url(c.original_url))}" target="_blank" rel="noopener noreferrer">原始来源 ↗</a></div>${feedback(c)}</article>`;
  }
  function brief(c) {
    return `<article class="card" data-id="${esc(c.id)}"><div class="brief-hero"><div class="kicker"><span>${esc(group[c.ability_group])}</span>${c.first_round_rank?`<span class="rank">首轮推荐 ${c.first_round_rank}</span>`:''}</div><h2>${esc(c.title_zh)}</h2><p class="hook">${esc(c.one_line_visual_promise)}</p></div><div class="card-body"><p class="operation"><span class="label">前 ${esc(c.opening.duration_seconds)} 秒，观众看什么</span>${c.opening.beats.map(esc).join('<br>')}</p><p class="risk"><span class="label">为什么需要三维</span>${esc(c.technical_sample.actual_wt_operation)}</p><details><summary>三档成年原创造型</summary>${c.looks.map(x=>`<p><strong>${esc(x.level)}</strong><br>${esc(x.design)}<br><span class="risk">${esc(x.silhouette_requirement)}</span></p>`).join('')}</details><details><summary>${esc(c.technical_sample.duration_seconds)} 秒小样怎样算成功</summary><ul>${c.technical_sample.success_criteria.map(x=>`<li>${esc(x)}</li>`).join('')}</ul><p>${esc(c.capability_maturity)}</p><p class="risk">尚未绑定最终原片；角色与视频均须单独验证。</p></details></div>${feedback(c)}</article>`;
  }
  function casting(c) {
    return `<article class="card casting-card" data-id="${esc(c.id)}"><div class="card-top"><div class="kicker"><span>原创虚构成年角色</span><span class="pending">单张外观预览</span></div><h2>${esc(c.title)}</h2><p class="hook">${esc(c.stage)}</p></div><a class="media" href="${esc(c.image_asset)}" target="_blank" rel="noopener" aria-label="查看${esc(c.title)}原图"><img src="${esc(c.image_asset)}" loading="lazy" alt="${esc(c.title)}的实际生成选角预览"><span class="media-label">点击展开原图</span></a><div class="card-body"><p class="risk">${esc(c.description)}</p><p class="operation">这张图用于选择面孔和衣服。人物姿态、相机与连续视频质量需要后续实际测试。</p><a class="source-link" href="${esc(c.image_asset)}" download>下载完整原图 ↓</a> <button class="related-source" data-source-id="${esc(c.source_case)}">看对应原片 →</button></div>${feedback(c)}</article>`;
  }
  function render() {
    releaseVideos();
    const items = D[state.tab], pages = Math.max(1,Math.ceil(items.length/SIZE));
    state.pages[state.tab] = Math.min(state.pages[state.tab],pages-1);
    const page = state.pages[state.tab];
    document.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.tab===state.tab)));
    $('#cards').setAttribute('aria-labelledby','tab-'+state.tab);
    $('#tab-explainer').textContent = {sources:'先选动作与题材。这里播放真实原片；有本地文件不代表已完成逐帧审核或生成测试。',briefs:'12个具体方案，每种能力3个。首轮推荐各选一个能力；未验证的空间与尺度操作会先做几何小样。',casting:`${D.casting.length}个衣装选项，${D.distinct_casting_identities}个独立成年虚构角色。Jade两套属于同一角色；单图不是视频质量证明。`}[state.tab];
    const fn = {sources:source,briefs:brief,casting}[state.tab];
    $('#cards').innerHTML = items.slice(page*SIZE,(page+1)*SIZE).map(fn).join('') || '<p class="no-cards">实际选角图准备中。</p>';
    // User notes never enter HTML parsing, even when restoring a shared fragment.
    $('#cards').querySelectorAll('[data-note]').forEach(t=>{
      const key=t.closest('[data-key]').dataset.key;
      t.value=state.feedback[key]?.note || '';
    });
    $('#page-info').textContent = `第 ${page+1} / ${pages} 页 · ${items.length} 项`;
    $('#prev').disabled = page===0; $('#next').disabled = page===pages-1;
    save();
  }
  $('#review-link').href = D.links.review; $('#dance-link').href = D.links.dance;
  $('#stage-badge').textContent = D.staging ? '本地预览 · 未发布' : '候选选择 · 尚未视频测试';
  for (const tab of ['sources','briefs','casting']) $('#count-'+tab).textContent = D[tab].length;
  document.addEventListener('click', e=>{
    const tab = e.target.closest('[data-tab]');
    if (tab) {state.tab=tab.dataset.tab;render();return;}
    const related = e.target.closest('[data-source-id]');
    if (related) {
      const index=D.sources.findIndex(c=>c.id===related.dataset.sourceId);
      if(index>=0){state.tab='sources';state.pages.sources=Math.floor(index/SIZE);render();$('.toolbar').scrollIntoView({behavior:'smooth'});}
      return;
    }
    const play = e.target.closest('[data-play]');
    if (play) {
      document.querySelectorAll('video').forEach(v=>v.pause());
      const v=play.parentElement.querySelector('video');v.src=play.dataset.play;v.preload='metadata';v.load();
      v.play().then(()=>{play.hidden=true;}).catch(()=>{$('#status').textContent='原片已加载，请使用播放器开始播放。';play.hidden=true;});return;
    }
    const vote = e.target.closest('[data-vote]'), clear=e.target.closest('[data-clear]');
    if (vote || clear) {
      const box=(vote || clear).closest('[data-key]'), key=box.dataset.key;
      const f=state.feedback[key] || {vote:null,note:''};
      f.vote=clear?null:(f.vote===vote.dataset.vote?null:vote.dataset.vote);state.feedback[key]=f;
      box.querySelectorAll('[data-vote]').forEach(b=>b.setAttribute('aria-pressed',String(f.vote===b.dataset.vote)));save();
    }
  });
  document.addEventListener('input',e=>{
    if (!e.target.matches('[data-note]')) return;
    const key=e.target.closest('[data-key]').dataset.key;
    state.feedback[key]={...(state.feedback[key] || {vote:null}),note:e.target.value.slice(0,1000)};save();
  });
  function turn(delta) {state.pages[state.tab]+=delta;render();$('.toolbar').scrollIntoView({behavior:'smooth',block:'start'});}
  $('#prev').addEventListener('click',()=>turn(-1));$('#next').addEventListener('click',()=>turn(1));
  $('#home-link').addEventListener('click',e=>{e.preventDefault();state.tab='sources';state.pages.sources=0;render();window.scrollTo({top:0,behavior:'smooth'});});
  $('#share').addEventListener('click',async()=>{
    const hash='#feedback='+encode({version:1,round:'20261127',tab:state.tab,page:state.pages[state.tab],feedback:state.feedback});
    history.replaceState(null,'',hash);
    const link=location.href;$('#share-box').hidden=false;$('#share-url').value=link;
    try {await navigator.clipboard.writeText(link);$('#status').textContent='分享链接已复制，打开后可恢复选择与备注。';}
    catch (_) {$('#share-url').focus();$('#share-url').select();$('#status').textContent='分享链接已生成，请复制下方链接。';}
  });
  window.addEventListener('hashchange',()=>{if(restoreHash())render();});
  // Native controls can resume a previously loaded player without our load button.
  document.addEventListener('play',e=>{
    if(e.target instanceof HTMLVideoElement) document.querySelectorAll('video').forEach(v=>{if(v!==e.target)v.pause();});
  },true);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)document.querySelectorAll('video').forEach(v=>v.pause());});
  window.addEventListener('pagehide',releaseVideos);
  restoreHash();render();
})();
