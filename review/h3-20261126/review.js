"use strict";

(() => {
  const DATASET = "wt-h3-20261126-v1";
  const STORAGE_KEY = `wt-review:${DATASET}:v1`;
  const PAGE_SIZE = 3, NOTE_LIMIT = 1200, SHARE_LIMIT = 16000, FILE_LIMIT = 256 * 1024;
  const STATUS = { unreviewed: "未评", good: "值得保留", bad: "需要改进" };
  const REASONS = { identity: "人物身份", motion: "动作", camera: "相机", geometry: "几何", background: "背景", temporal: "时间连贯", other: "其他" };
  const TRAJECTORIES = { arc_right120: "右侧 120°", orbit360: "完整 360°",
    truck_follow_landing: "侧向跟随 · 落步",
    low_slide_pedestal_reveal: "低机位横移 · 抬升",
    dolly_medium_parallax: "全身推到中景 · 侧移",
    truck_push_threequarter: "斜侧跟随 · 推近" };
  const ROUNDS = { round3: "新一轮：镜头与人脸对照", geometry3: "新一轮：几何清理对照",
    round2: "上一轮：逐帧可见 RGB", identity: "早期：首帧 RGB＋深度", depth_only: "早期：仅深度" };
  const $ = (selector, parent = document) => parent.querySelector(selector);
  const state = { results: [], byId: new Map(), reviews: new Map(), page: 1, active: null, storageAvailable: true, pending: null, ready: false, defaultRound: "identity" };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, className = "button") {
    const node = el("button", className, text); node.type = "button"; return node;
  }
  function notify(message, kind = "") {
    const box = $("#notice"); box.className = `notice ${kind}`; box.textContent = message; box.hidden = false;
  }
  function safeUrl(value) {
    if (typeof value !== "string" || !value || value.length > 4096) return null;
    try { const url = new URL(value, location.href); return ["http:", "https:"].includes(url.protocol) ? url.href : null; }
    catch { return null; }
  }
  function link(label, url, download = false) {
    const a = el("a", "", label); a.href = url; a.rel = "noopener noreferrer";
    a.referrerPolicy = "no-referrer";
    if (download) a.download = ""; else a.target = "_blank";
    return a;
  }
  function emptyReview(id) { return { id, status: "unreviewed", reasons: [], note: "", updated_at: new Date().toISOString() }; }
  function meaningful(row) { return row.status !== "unreviewed" || row.reasons.length > 0 || row.note.trim().length > 0; }
  function sameReview(a, b) { return a.status === b.status && a.note === b.note && [...a.reasons].sort().join("|") === [...b.reasons].sort().join("|"); }
  function getReview(id) { return state.reviews.get(id) || emptyReview(id); }
  function feedbackDocument() {
    return { schema_version: 1, dataset_id: DATASET, exported_at: new Date().toISOString(),
      feedback: state.results.map(row => state.reviews.get(row.id)).filter(row => row && meaningful(row)) };
  }
  function validateFeedback(documentValue, compact = false) {
    if (!documentValue || typeof documentValue !== "object" || Array.isArray(documentValue)) throw new Error("反馈文件必须是 JSON 对象。");
    const version = compact ? documentValue.v : documentValue.schema_version;
    const dataset = compact ? documentValue.d : documentValue.dataset_id;
    if (version !== 1) throw new Error("不支持这个反馈版本，请使用 schema_version 1。");
    if (dataset !== DATASET) throw new Error("反馈属于另一份结果清单，未导入任何记录。");
    const rawRows = compact ? documentValue.r : documentValue.feedback;
    if (!Array.isArray(rawRows) || rawRows.length > 200) throw new Error("反馈列表无效或条数过多。");
    const seen = new Set(), rows = []; let unknown = 0;
    for (const raw of rawRows) {
      if (compact && (!Array.isArray(raw) || raw.length !== 4)) throw new Error("分享链接中的记录格式无效。");
      const row = compact ? { id: raw[0], status: raw[1], reasons: raw[2], note: raw[3] } : raw;
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("反馈记录格式无效。");
      if (typeof row.id !== "string" || !/^[A-Za-z0-9_.:-]{1,180}$/.test(row.id)) throw new Error("结果 ID 格式无效。");
      if (seen.has(row.id)) throw new Error("同一结果出现了重复记录，请先去除重复项。");
      seen.add(row.id);
      if (typeof row.status !== "string" || !Object.hasOwn(STATUS, row.status)) throw new Error("反馈状态无效。");
      if (!Array.isArray(row.reasons) || row.reasons.length > 7 || row.reasons.some(reason => typeof reason !== "string" || !Object.hasOwn(REASONS, reason))) throw new Error("问题原因无效。");
      if (new Set(row.reasons).size !== row.reasons.length) throw new Error("问题原因不能重复。");
      if (typeof row.note !== "string" || row.note.length > NOTE_LIMIT) throw new Error(`备注不能超过 ${NOTE_LIMIT} 字符。`);
      if (!state.byId.has(row.id)) { unknown += 1; continue; }
      let updatedAt = new Date().toISOString();
      if (!compact && row.updated_at !== undefined) {
        if (typeof row.updated_at !== "string" || row.updated_at.length > 40 || !Number.isFinite(Date.parse(row.updated_at))) throw new Error("反馈更新时间格式无效。");
        updatedAt = row.updated_at;
      }
      rows.push({ id: row.id, status: row.status, reasons: [...row.reasons], note: row.note, updated_at: updatedAt });
    }
    return { rows, unknown };
  }
  function disableStorage(message) {
    state.storageAvailable = false; $("#storage-label").textContent = "当前仅在页面暂存";
    $("#save-explanation").textContent = "浏览器存储不可用；请复制反馈链接或导出清单，刷新前先保存。";
    notify(message, "warning");
  }
  function loadLocal() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      if (raw.length > FILE_LIMIT) throw new Error("本地记录过大");
      const parsed = validateFeedback(JSON.parse(raw));
      for (const row of parsed.rows) if (meaningful(row)) state.reviews.set(row.id, row);
    } catch { disableStorage("已有本地记录无法读取，或浏览器禁止存储。原记录未被覆盖；本次反馈请用链接或 JSON 保存。"); }
  }
  function persist() {
    if (!state.storageAvailable) return false;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(feedbackDocument())); return true; }
    catch { disableStorage("浏览器未能保存标记。当前反馈仍在页面中，请及时复制反馈链接或导出 JSON。"); return false; }
  }
  function updateSummary(filteredCount) {
    const totals = { good: 0, bad: 0, unreviewed: 0 };
    for (const row of state.results) totals[getReview(row.id).status] += 1;
    $("#review-summary").textContent = `${filteredCount} 条符合筛选 · 已标记 ${totals.good + totals.bad} / ${state.results.length} · 待改进 ${totals.bad} 条`;
  }
  function writeReview(id, patch, card) {
    const row = { ...getReview(id), ...patch, updated_at: new Date().toISOString() };
    if (meaningful(row)) state.reviews.set(id, row); else state.reviews.delete(id);
    const saved = persist();
    if (card) {
      const pill = $(".status-pill", card); pill.className = `status-pill ${row.status}`; pill.textContent = STATUS[row.status];
      card.querySelectorAll("button[data-status]").forEach(node => node.setAttribute("aria-pressed", String(node.dataset.status === row.status)));
      $("[data-role=save-state]", card).textContent = saved ? "已自动保存" : "仅暂存本页，请导出";
    }
    updateSummary(filteredResults().length);
  }
  function filteredResults() {
    const round = $("#round-filter").value, caseId = $("#case-filter").value, trajectory = $("#trajectory-filter").value;
    const review = $("#review-filter").value, query = $("#search").value.trim().toLocaleLowerCase();
    return state.results.filter(row => {
      if (round !== "all" && row.round !== round) return false;
      if (caseId !== "all" && row.case !== caseId) return false;
      if (trajectory !== "all" && row.trajectory !== trajectory) return false;
      const feedback = getReview(row.id);
      if (review !== "all" && feedback.status !== review) return false;
      return !query || [row.title, row.case, row.category, row.variant_label, row.note || "", feedback.note].join(" ").toLocaleLowerCase().includes(query);
    });
  }
  function markSuppressed(runtime, video, event) {
    let values = runtime.suppressed.get(video);
    if (!values) { values = new Map(); runtime.suppressed.set(video, values); }
    values.set(event, performance.now() + 1200);
  }
  function consumeSuppressed(runtime, video, event) {
    const values = runtime.suppressed.get(video), until = values?.get(event);
    if (until === undefined) return false;
    values.delete(event); return until > performance.now();
  }
  function loadedVideos(runtime) { return runtime.panels.map(panel => panel.video).filter(video => video.hasAttribute("src")); }
  function pauseRuntime(runtime) {
    for (const video of loadedVideos(runtime)) if (!video.paused) { markSuppressed(runtime, video, "pause"); video.pause(); }
  }
  function cancelSync(runtime) {
    runtime.operation += 1;
    runtime.syncAbort?.abort(); runtime.syncAbort = null; runtime.syncing = false;
  }
  function releaseRuntime(runtime) {
    cancelSync(runtime); runtime.released = true; pauseRuntime(runtime);
    for (const panel of runtime.panels) {
      panel.video.removeAttribute("src"); panel.video.querySelectorAll("source").forEach(node => node.remove());
      panel.video.preload = "none"; panel.video.load(); panel.video.hidden = true;
      panel.stage.classList.remove("is-loaded"); panel.play.hidden = false;
    }
    runtime.card.classList.remove("is-active"); runtime.mediaState.textContent = "未加载";
    if (state.active === runtime) state.active = null;
  }
  function releaseActive() { if (state.active) releaseRuntime(state.active); }
  function activate(runtime) {
    if (state.active && state.active !== runtime) releaseRuntime(state.active);
    state.active = runtime; runtime.released = false; runtime.card.classList.add("is-active");
  }
  function loadPanel(runtime, panel) {
    activate(runtime);
    if (panel.video.hasAttribute("src")) return;
    panel.video.src = panel.url; panel.video.preload = "metadata"; panel.video.muted = true;
    panel.video.playbackRate = Number(runtime.speed.value); panel.video.hidden = false;
    panel.stage.classList.add("is-loaded"); panel.play.hidden = true; panel.video.load();
    runtime.mediaState.textContent = `${loadedVideos(runtime).length} 路已加载`;
  }
  function loadAll(runtime) { activate(runtime); runtime.panels.forEach(panel => loadPanel(runtime, panel)); }
  function playVideo(runtime, video) {
    markSuppressed(runtime, video, "play");
    const promise = video.play();
    if (promise?.catch) promise.catch(() => { runtime.mediaState.textContent = "请点击视频播放"; });
  }
  function waitForMedia(video, predicate, signal) {
    if (signal.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError"));
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const events = ["loadedmetadata", "loadeddata", "canplay", "seeked", "progress"];
      let timer;
      const finish = error => {
        clearTimeout(timer); events.forEach(event => video.removeEventListener(event, check));
        video.removeEventListener("error", failed); signal.removeEventListener("abort", aborted);
        if (error) reject(error); else resolve();
      };
      const check = () => { if (predicate()) finish(); };
      const failed = () => finish(new Error("视频未能加载"));
      const aborted = () => finish(new DOMException("Cancelled", "AbortError"));
      events.forEach(event => video.addEventListener(event, check));
      video.addEventListener("error", failed); signal.addEventListener("abort", aborted, { once: true });
      timer = setTimeout(() => finish(new Error("等待视频超时")), 15000);
      check();
    });
  }
  async function synchronize(runtime, master, shouldPlay, requestedTime = master.currentTime) {
    cancelSync(runtime);
    const operation = runtime.operation, controller = new AbortController();
    runtime.syncAbort = controller; runtime.syncing = true; runtime.master = master;
    const current = () => state.active === runtime && !runtime.released && runtime.operation === operation && !controller.signal.aborted;
    // Pause first: seeking one stream while another advances creates a persistent offset.
    pauseRuntime(runtime); loadAll(runtime); runtime.mediaState.textContent = "正在对齐视频…";
    const videos = loadedVideos(runtime);
    // This is an explicit synchronization request. Metadata-only preload may
    // otherwise stop before canplay on browsers that honor that hint strictly.
    for (const video of videos) if (video.preload !== "auto") {
      video.preload = "auto";
      if (video.readyState < 3 && video.networkState === HTMLMediaElement.NETWORK_IDLE) video.load();
    }
    try {
      await Promise.all(videos.map(video => waitForMedia(video, () => video.readyState >= 3, controller.signal)));
      if (!current()) return;
      for (const video of videos) {
        const target = Math.max(0, Math.min(requestedTime, Number.isFinite(video.duration) ? video.duration : requestedTime));
        if (Math.abs(video.currentTime - target) > .001) {
          markSuppressed(runtime, video, "seeking"); video.currentTime = target;
        }
      }
      await Promise.all(videos.map(video => waitForMedia(video, () => !video.seeking && video.readyState >= 3, controller.signal)));
      if (!current()) return;
      if (shouldPlay) {
        const attempts = videos.map(video => { markSuppressed(runtime, video, "play"); return video.play(); });
        const results = await Promise.allSettled(attempts);
        if (!current()) return;
        if (results.some(result => result.status === "rejected")) throw new Error("请再次点击播放");
      }
      runtime.mediaState.textContent = shouldPlay ? `${videos.length} 路联动播放` : `${videos.length} 路已对齐 · 暂停`;
    } catch (error) {
      if (current()) { pauseRuntime(runtime); runtime.mediaState.textContent = `${error.message}，可重试或单独播放`; }
    } finally {
      if (runtime.operation === operation) { runtime.syncing = false; runtime.syncAbort = null; }
    }
  }
  function playRuntime(runtime, requestedPanel) {
    activate(runtime);
    const panel = requestedPanel || runtime.panels.find(item => item.key === "generated");
    runtime.master = panel.video;
    if (runtime.sync.checked) {
      synchronize(runtime, panel.video, true, panel.video.ended ? 0 : panel.video.currentTime);
    } else {
      cancelSync(runtime); loadPanel(runtime, panel);
      if (panel.video.ended) panel.video.currentTime = 0;
      playVideo(runtime, panel.video);
    }
  }
  function wireVideo(runtime, panel) {
    const video = panel.video;
    video.addEventListener("play", () => {
      if (state.active !== runtime || consumeSuppressed(runtime, video, "play") || runtime.syncing) return;
      runtime.master = video;
      if (runtime.sync.checked) synchronize(runtime, video, true);
    });
    video.addEventListener("pause", () => {
      if (state.active !== runtime || consumeSuppressed(runtime, video, "pause") || runtime.syncing || !runtime.sync.checked) return;
      synchronize(runtime, video, false);
    });
    video.addEventListener("seeking", () => {
      if (state.active !== runtime || consumeSuppressed(runtime, video, "seeking") || runtime.syncing || !runtime.sync.checked) return;
      synchronize(runtime, video, !video.paused);
    });
    video.addEventListener("timeupdate", () => {
      if (state.active !== runtime || runtime.syncing || !runtime.sync.checked || runtime.master !== video || video.paused || video.seeking) return;
      if (loadedVideos(runtime).some(peer => peer !== video && !peer.seeking && Math.abs(peer.currentTime - video.currentTime) > .06)) synchronize(runtime, video, true);
    });
    video.addEventListener("ratechange", () => {
      if (state.active !== runtime || consumeSuppressed(runtime, video, "ratechange")) return;
      runtime.speed.value = String(video.playbackRate);
      for (const peer of loadedVideos(runtime)) if (peer !== video && peer.playbackRate !== video.playbackRate) { markSuppressed(runtime, peer, "ratechange"); peer.playbackRate = video.playbackRate; }
    });
    video.addEventListener("error", () => { if (video.hasAttribute("src")) runtime.mediaState.textContent = "加载失败，可重试或下载"; });
  }
  function createPanel(runtime, key, title, urlValue, posterValue) {
    const url = safeUrl(urlValue); if (!url) return;
    const figure = el("figure", `media-panel ${key}`), heading = el("figcaption", "panel-heading");
    heading.append(el("span", "", title), link("下载原片 ↗", url, true));
    const stage = el("div", "panel-stage"), fallback = el("div", "poster-missing", "点击加载视频");
    stage.append(fallback);
    const poster = safeUrl(posterValue);
    if (poster) {
      const image = el("img"); image.src = poster; image.alt = `${title}的预览图`; image.loading = "lazy"; image.decoding = "async";
      image.referrerPolicy = "no-referrer"; image.addEventListener("error", () => image.hidden = true); stage.append(image);
    }
    const video = el("video"); video.dataset.panel = key; video.controls = true; video.playsInline = true; video.muted = true;
    video.defaultMuted = true; video.preload = "none"; video.hidden = true; video.setAttribute("aria-label", `${runtime.title}：${title}`);
    const play = button("", "panel-play"); play.setAttribute("aria-label", `播放${title}`);
    play.append(el("span", "play-circle", "▶"), el("span", "", "点击播放"));
    stage.append(video, play); figure.append(heading, stage); runtime.panelsNode.append(figure);
    const panel = { key, url, video, stage, play }; runtime.panels.push(panel);
    play.addEventListener("click", () => playRuntime(runtime, panel)); wireVideo(runtime, panel);
  }
  function createCard(row, absoluteIndex) {
    const feedback = getReview(row.id), card = el("article", "result-card"); card.dataset.id = row.id;
    const header = el("div", "card-header"), headingGroup = el("div"), titleLine = el("div", "card-title-line");
    titleLine.append(el("h3", "", row.title), el("span", `status-pill ${feedback.status}`, STATUS[feedback.status]));
    const meta = el("div", "card-meta");
    for (const text of [row.category, TRAJECTORIES[row.trajectory] || row.trajectory, row.variant_label, `${(row.frames / row.fps).toFixed(2)} 秒 · ${row.fps} fps`]) meta.append(el("span", "meta-tag", text));
    meta.firstChild.classList.add("round-tag"); headingGroup.append(titleLine, meta);
    header.append(headingGroup, el("span", "card-index", String(absoluteIndex + 1).padStart(2, "0"))); card.append(header);
    if (row.note) { const details = el("details", "card-observation"); details.append(el("summary", "", "查看已有观察"), el("p", "card-note", row.note)); card.append(details); }
    const controls = el("div", "media-controls"), play = button("▶ 播放对比", "button primary small"), load = button("仅加载", "button small"), pause = button("暂停", "button small"), unload = button("释放视频", "button small quiet");
    play.dataset.action = "play"; load.dataset.action = "load"; pause.dataset.action = "pause"; unload.dataset.action = "unload";
    const syncLabel = el("label", "inline-check"), sync = el("input"); sync.type = "checkbox"; sync.checked = true; sync.dataset.role = "sync"; syncLabel.append(sync, document.createTextNode("联动播放"));
    const speedLabel = el("label", "speed-label", "速度"), speed = el("select"); speed.dataset.role = "speed"; speed.setAttribute("aria-label", "播放速度");
    for (const rate of [.5, .75, 1, 1.25, 1.5, 2]) { const option = el("option", "", `${rate}×`); option.value = String(rate); speed.append(option); } speed.value = "1"; speedLabel.append(speed);
    const mediaState = el("span", "media-state", "未加载"), panelsNode = el("div", "panels");
    const runtime = { card, title: row.title, panels: [], panelsNode, sync, speed, mediaState, master: null, suppressed: new WeakMap(), released: false, operation: 0, syncing: false, syncAbort: null };
    controls.append(play, load, pause, unload, syncLabel, speedLabel, mediaState); card.append(controls, panelsNode);
    createPanel(runtime, "source", row.source_label || "原动作 · 参考", row.source, row.source_poster);
    createPanel(runtime, "depth", row.depth_label || "实际深度条件", row.depth, row.depth_poster);
    if (row.baseline) createPanel(runtime, "baseline", row.baseline_label || "仅深度对照", row.baseline, row.baseline_poster);
    createPanel(runtime, "generated", row.output_label || (row.round === "identity" ? "首帧 RGB＋深度结果" : "H3 生成结果"), row.video, row.poster);
    panelsNode.style.setProperty("--panel-count", String(runtime.panels.length));
    play.addEventListener("click", () => playRuntime(runtime)); load.addEventListener("click", () => { cancelSync(runtime); loadAll(runtime); pauseRuntime(runtime); runtime.mediaState.textContent = `${loadedVideos(runtime).length} 路已加载 · 暂停`; });
    pause.addEventListener("click", () => {
      if (state.active !== runtime) return;
      if (sync.checked) synchronize(runtime, runtime.master || runtime.panels.at(-1).video, false);
      else { cancelSync(runtime); pauseRuntime(runtime); }
    });
    unload.addEventListener("click", () => releaseRuntime(runtime));
    sync.addEventListener("change", () => {
      play.textContent = sync.checked ? "▶ 播放对比" : "▶ 播放结果";
      if (state.active !== runtime) return;
      if (sync.checked) { const master = runtime.master || runtime.panels.at(-1).video; synchronize(runtime, master, !master.paused); }
      else { cancelSync(runtime); runtime.mediaState.textContent = `${loadedVideos(runtime).length} 路已加载 · 单独播放`; }
    });
    speed.addEventListener("change", () => loadedVideos(runtime).forEach(video => { markSuppressed(runtime, video, "ratechange"); video.playbackRate = Number(speed.value); }));

    const reviewArea = el("div", "review-area"), choice = el("div"); choice.append(el("p", "review-label", "你的评价"));
    const statusButtons = el("div", "status-buttons");
    for (const [value, label] of Object.entries(STATUS)) {
      const node = button(label, `status-button ${value}`); node.dataset.status = value; node.setAttribute("aria-pressed", String(feedback.status === value));
      node.addEventListener("click", () => { writeReview(row.id, { status: value }, card); if ($("#review-filter").value !== "all" && $("#review-filter").value !== value) render(); }); statusButtons.append(node);
    }
    choice.append(statusButtons);
    const reasons = el("fieldset", "reason-list"), options = el("div", "reason-options"); reasons.append(el("legend", "", "问题原因（可多选）"));
    for (const [value, label] of Object.entries(REASONS)) {
      const wrapper = el("label", "reason-option"), input = el("input"); input.type = "checkbox"; input.dataset.reason = value; input.checked = feedback.reasons.includes(value);
      input.addEventListener("change", () => { const selected = [...options.querySelectorAll("input:checked")].map(node => node.dataset.reason); writeReview(row.id, { reasons: selected }, card); });
      wrapper.append(input, el("span", "", label)); options.append(wrapper);
    }
    reasons.append(options); choice.append(reasons);
    const notes = el("div"), noteLabel = el("label", "note-label"); noteLabel.append(el("span", "", "备注 · 哪一段、哪里需要改进？"));
    const note = el("textarea"); note.dataset.role = "note"; note.maxLength = NOTE_LIMIT; note.value = feedback.note; note.rows = 3;
    note.placeholder = "例如：0.8 秒后脸部变化，转到背面时手臂粘连；建议保留服装颜色。";
    const noteFooter = el("div", "note-footer"), saveState = el("span", "", state.reviews.has(row.id) ? "已保存的标记" : "修改后自动保存"), count = el("span", "", `${note.value.length} / ${NOTE_LIMIT}`);
    saveState.dataset.role = "save-state"; noteFooter.append(saveState, count);
    note.addEventListener("input", () => { count.textContent = `${note.value.length} / ${NOTE_LIMIT}`; writeReview(row.id, { note: note.value }, card); });
    noteLabel.append(note); notes.append(noteLabel, noteFooter); reviewArea.append(choice, notes); card.append(reviewArea);
    const footer = el("div", "card-footer"), sourceLink = safeUrl(row.source_url);
    if (row.appearance_condition) footer.append(link("查看逐帧 RGB 条件 ↗", safeUrl(row.appearance_condition)));
    if (row.mask_preview) footer.append(link("查看重绘区域 ↗", safeUrl(row.mask_preview)));
    if (row.reference_image) footer.append(link("查看真实人物参考图 ↗", safeUrl(row.reference_image)));
    if (row.camera_path) footer.append(link("查看相机路径 ↗", safeUrl(row.camera_path)));
    if (row.depth_comparison) footer.append(link("查看原始／过滤／表面渲染深度对照 ↗", safeUrl(row.depth_comparison)));
    if (row.legacy_geometry_comparison) footer.append(link((row.legacy_geometry_comparison_label || "查看原大角度镜头的几何对照") + " ↗", safeUrl(row.legacy_geometry_comparison)));
    footer.append(el("span", "result-id", row.id)); if (sourceLink) footer.append(link("素材来源 ↗", sourceLink)); card.append(footer);
    return card;
  }
  function render() {
    releaseActive();
    const filtered = filteredResults(), totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    state.page = Math.min(Math.max(1, state.page), totalPages);
    const cards = $("#cards"); cards.replaceChildren();
    const start = (state.page - 1) * PAGE_SIZE;
    filtered.slice(start, start + PAGE_SIZE).forEach((row, index) => cards.append(createCard(row, start + index)));
    $("#result-count").textContent = String(filtered.length); updateSummary(filtered.length);
    const label = `第 ${state.page} / ${totalPages} 页`;
    $("#page-label").textContent = label; $("#page-label-bottom").textContent = label;
    document.querySelectorAll("[data-page=prev]").forEach(node => node.disabled = state.page <= 1);
    document.querySelectorAll("[data-page=next]").forEach(node => node.disabled = state.page >= totalPages);
    $("#empty-state").hidden = filtered.length > 0;
  }
  function populateFilters() {
    const cases = new Map(), trajectories = new Set();
    for (const row of state.results) { if (!cases.has(row.case)) cases.set(row.case, row.title); trajectories.add(row.trajectory); }
    for (const [value, title] of cases) { const option = el("option", "", title); option.value = value; $("#case-filter").append(option); }
    for (const value of trajectories) { const option = el("option", "", TRAJECTORIES[value] || value); option.value = value; $("#trajectory-filter").append(option); }
  }
  function clearFeedbackHash() {
    if (location.hash.startsWith("#feedback=")) history.replaceState(null, "", location.pathname + location.search);
  }
  function previewImport(parsed, origin) {
    if (!parsed.rows.length) throw new Error(parsed.unknown ? "这份反馈没有本清单中的已知结果，未导入任何记录。" : "没有可导入的反馈记录。");
    const conflicts = [], fresh = [], same = [];
    for (const row of parsed.rows) {
      const existing = state.reviews.get(row.id);
      if (!existing) fresh.push(row); else if (sameReview(existing, row)) same.push(row); else conflicts.push(row);
    }
    state.pending = { ...parsed, origin, conflicts, fresh, same };
    $("#import-description").textContent = origin === "link" ? "检测到反馈链接。确认合并后，这些标记才会加入当前浏览器。" : "文件已读取，尚未修改任何本地标记。";
    const stats = $("#import-stats"); stats.replaceChildren();
    for (const label of [`新增 ${fresh.length}`, `冲突 ${conflicts.length}`, `相同 ${same.length}`, `未知 ID 跳过 ${parsed.unknown}`]) stats.append(el("span", "", label));
    const preview = $("#import-preview"); preview.replaceChildren();
    for (const row of parsed.rows) {
      const entry = el("div", "import-item"), result = state.byId.get(row.id), existing = state.reviews.get(row.id);
      entry.append(el("strong", "", `${result.title} · ${TRAJECTORIES[result.trajectory] || result.trajectory}`));
      entry.append(el("p", "", `导入：${STATUS[row.status]}${row.reasons.length ? " · " + row.reasons.map(reason => REASONS[reason]).join("、") : ""}${existing && !sameReview(existing, row) ? ` ｜ 本地：${STATUS[existing.status]}（有冲突）` : ""}`));
      if (row.note) entry.append(el("p", "", row.note)); preview.append(entry);
    }
    $("#conflict-policy").value = "keep_local"; $("#conflict-policy").disabled = !conflicts.length;
    if (!$("#import-dialog").open) $("#import-dialog").showModal();
  }
  function mergePending() {
    if (!state.pending) return;
    const overwrite = $("#conflict-policy").value === "use_import"; let merged = 0, preserved = 0;
    for (const row of state.pending.rows) {
      const existing = state.reviews.get(row.id);
      if (existing && !sameReview(existing, row) && !overwrite) { preserved += 1; continue; }
      if (existing && sameReview(existing, row)) continue;
      if (meaningful(row)) state.reviews.set(row.id, row); else state.reviews.delete(row.id);
      merged += 1;
    }
    const saved = persist(); state.pending = null; $("#import-dialog").close(); clearFeedbackHash(); render();
    notify(`已合并 ${merged} 条记录${preserved ? `，保留 ${preserved} 条本地冲突记录` : ""}。${saved ? "已保存到此浏览器。" : "当前仅暂存页面，请导出反馈。"}`, saved ? "" : "warning");
  }
  function cancelImport() { state.pending = null; $("#import-dialog").close(); clearFeedbackHash(); }
  function exportFeedback() {
    if (!state.ready) return;
    const data = feedbackDocument(), blob = new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob), anchor = document.createElement("a"); anchor.href = url;
    anchor.download = `${DATASET}-feedback-${new Date().toISOString().slice(0, 10)}.json`; document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000); notify(`已导出 ${data.feedback.length} 条反馈。发送这个 JSON 文件即可转交标记和备注。`);
  }
  function encodeCompact(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value)); let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 4096) binary += String.fromCharCode(...bytes.subarray(offset, offset + 4096));
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function decodeCompact(payload) {
    if (!payload || payload.length > SHARE_LIMIT || !/^[A-Za-z0-9_-]+$/.test(payload)) throw new Error("反馈链接无效或过长，请改用 JSON 文件导入。");
    const binary = atob(payload.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - payload.length % 4) % 4));
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }
  async function shareFeedback() {
    if (!state.ready) return;
    const feedback = feedbackDocument().feedback;
    if (!feedback.length) { notify("先为至少一条结果添加标记、原因或备注，再复制反馈链接。", "warning"); return; }
    const payload = encodeCompact({ v: 1, d: DATASET, r: feedback.map(row => [row.id, row.status, row.reasons, row.note]) });
    if (payload.length > SHARE_LIMIT) { notify("反馈内容较长，无法生成便于分享的链接。请点击「导出反馈清单」保存并发送完整清单。", "warning"); $("#export-feedback").focus(); return; }
    const url = new URL(location.href); url.search = "";
    url.searchParams.set("v", state.results.some(row => ["round3", "geometry3"].includes(row.round)) ? "round3" : "round2");
    url.hash = `feedback=${payload}`; const text = url.href;
    try { if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable"); await navigator.clipboard.writeText(text); notify(`已复制包含 ${feedback.length} 条反馈的链接。发送链接即可转交；备注包含在链接中。`); return; }
    catch { /* Fall back to a selectable link when clipboard access is unavailable. */ }
    const temporary = document.createElement("textarea"); temporary.value = text; temporary.setAttribute("readonly", "");
    temporary.style.position = "fixed"; temporary.style.top = "-10000px"; document.body.append(temporary); temporary.select();
    let copied = false; try { copied = document.execCommand("copy"); } catch { copied = false; } temporary.remove();
    if (copied) { notify(`已复制包含 ${feedback.length} 条反馈的链接。发送链接即可转交。`); return; }
    $("#share-link-text").value = text; $("#share-dialog").showModal(); $("#share-link-text").focus(); $("#share-link-text").select();
  }
  function inspectFragment() {
    if (!state.ready || !location.hash.startsWith("#feedback=")) return;
    try { previewImport(validateFeedback(decodeCompact(location.hash.slice(10)), true), "link"); }
    catch (error) { notify(`未导入链接反馈：${error.message}`, "error"); }
  }
  function bindPage() {
    for (const id of ["round-filter", "case-filter", "trajectory-filter", "review-filter"]) $("#" + id).addEventListener("change", () => { if (state.ready) { state.page = 1; render(); } });
    let searchTimer;
    $("#search").addEventListener("input", () => { releaseActive(); clearTimeout(searchTimer); searchTimer = setTimeout(() => { if (state.ready) { state.page = 1; render(); } }, 150); });
    document.querySelectorAll("[data-page]").forEach(node => node.addEventListener("click", () => { state.page += node.dataset.page === "next" ? 1 : -1; render(); $(".results-toolbar").scrollIntoView({ behavior: "auto", block: "start" }); }));
    $("#reset-filters").addEventListener("click", () => { $("#round-filter").value = state.defaultRound; for (const id of ["case-filter", "trajectory-filter", "review-filter"]) $("#" + id).value = "all"; $("#search").value = ""; state.page = 1; render(); });
    $("#export-feedback").addEventListener("click", exportFeedback); $("#share-feedback").addEventListener("click", shareFeedback);
    $("#import-feedback").addEventListener("click", () => { if (state.ready) $("#feedback-file").click(); });
    $("#feedback-file").addEventListener("change", async event => {
      const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
      try { if (file.size > FILE_LIMIT) throw new Error("文件超过 256 KiB，请缩小反馈清单。"); previewImport(validateFeedback(JSON.parse(await file.text())), "file"); }
      catch (error) { notify(`未导入文件：${error.message}`, "error"); }
    });
    $("#merge-feedback").addEventListener("click", mergePending); $("#cancel-import").addEventListener("click", cancelImport);
    $("#import-dialog").addEventListener("cancel", event => { event.preventDefault(); cancelImport(); });
    $("#close-share").addEventListener("click", () => $("#share-dialog").close());
    addEventListener("hashchange", inspectFragment); addEventListener("pagehide", releaseActive);
  }
  async function start() {
    bindPage();
    try {
      const response = await fetch("data.json", { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data.schema_version !== 1 || data.dataset_id !== DATASET || !Array.isArray(data.results)) throw new Error("清单版本不匹配");
      for (const row of data.results) {
        if (!row || typeof row.id !== "string" || !/^[A-Za-z0-9_.:-]{1,180}$/.test(row.id) || state.byId.has(row.id)) throw new Error("结果 ID 无效或重复");
        if (!Object.hasOwn(ROUNDS, row.round) || !Number.isFinite(row.frames) || !Number.isFinite(row.fps) || row.frames < 1 || row.fps <= 0) throw new Error("结果参数无效");
        if (["title", "case", "category", "trajectory", "variant", "variant_label"].some(key => typeof row[key] !== "string")) throw new Error("结果字段缺失");
        if (![row.video, row.source, row.depth].every(safeUrl)) throw new Error("媒体地址无效");
        if ([row.appearance_condition, row.mask_preview, row.reference_image, row.camera_path, row.depth_comparison, row.legacy_geometry_comparison].some(value => value !== undefined && !safeUrl(value))) throw new Error("条件预览地址无效");
        if (row.note !== undefined && typeof row.note !== "string") throw new Error("观察记录格式无效");
        if (["baseline_label", "output_label", "depth_label", "source_label", "legacy_geometry_comparison_label"].some(key => row[key] !== undefined && typeof row[key] !== "string")) throw new Error("对照标题格式无效");
        state.byId.set(row.id, row); state.results.push(row);
      }
      const select = $("#round-filter"); select.replaceChildren();
      for (const [name, label] of Object.entries(ROUNDS)) if (state.results.some(row => row.round === name)) {
        const option = el("option", "", label); option.value = name; select.append(option);
      }
      state.defaultRound = select.options[0].value;
      const all = el("option", "", "全部轮次"); all.value = "all"; select.append(all);
      const requested = new URL(location.href).searchParams.get("round");
      select.value = Object.hasOwn(ROUNDS, requested) && state.results.some(row => row.round === requested) ? requested : state.defaultRound;
      state.ready = true; populateFilters(); loadLocal(); render(); inspectFragment();
    } catch (error) { $("#review-summary").textContent = "结果清单尚未加载"; notify(`无法读取结果清单：${error.message}。请通过网站地址打开页面；稍后刷新重试。`, "error"); }
  }
  start();
})();
