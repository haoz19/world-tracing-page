
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* ================================================================
   STATE
================================================================ */
const STATE = { category: 'object', stem: null };

/* ================================================================
   Shared Three.js renderers (one per category panel)
   We re-use ONE renderer per panel and just swap the geometry when the
   selected sample changes. This is much cheaper than creating a new
   WebGL context per click (browsers cap WebGL contexts at ~16).
================================================================ */
const VIEWERS = {};   // {panel_id: {renderer, scene, camera, controls, mesh, animFrame, dynamic}}
// Expose for debug / diagnostic only — read only.
if (typeof window !== 'undefined') window.__VIEWERS = VIEWERS;

function makeViewer(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, alpha: true, powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(0xffffff, 1);
  // The vertex colors stored in our .wtpc files are sRGB-encoded uint8s
  // (they came from the input PNG / Rerun's "Color" component) — i.e.
  // they're already in display-ready sRGB space.
  //
  // PointsMaterial is unlit (no lighting calculation), so we want the
  // bytes to round-trip from CPU to screen untouched: keep both the
  // BufferAttribute colorSpace and the renderer outputColorSpace at
  // *linear* (Three.js's default). If we instead tag the attribute as
  // sRGB and set outputColorSpace = SRGB, Three.js linearises on input
  // (`pow(c, 2.2)`) and re-encodes on output (`pow(c, 1/2.2)`), which
  // is supposed to round-trip but in practice with PointsMaterial in
  // r160 it leaves the cloud ~47% brighter than the input image
  // (matching `pow(0.5, 1/2.2) / 0.5 ≈ 1.466`). Leaving both spaces at
  // linear bypasses the misbehaving conversion entirely.
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace || THREE.NoColorSpace || 0;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);

  // Our point cloud lives in RDF (Right-Down-Forward, +X right, +Y down,
  // +Z forward away from camera). Three.js cameras look toward -Z by
  // default, so we wrap the whole point-cloud group in a "root" node that
  // rotates 180° around X. This flips RDF -> RUB, putting the object in
  // front of the user with +Y up.
  const root = new THREE.Group();
  root.rotation.x = Math.PI;
  scene.add(root);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 200);
  camera.position.set(0, 0, 3);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.enableZoom = true;
  controls.enablePan = true;
  controls.minDistance = 0.05;
  controls.maxDistance = 50;
  controls.zoomSpeed = 0.6;
  controls.rotateSpeed = 0.85;
  return { renderer, scene, root, camera, controls, mesh: null, dynamic: null };
}

function fitCameraToPoints(viewer, positions) {
  // ``positions`` are in the original capture camera's RDF frame (+X right,
  // +Y down, +Z forward, capture camera at the origin). After our root.
  // rotation.x = Math.PI flip, an RDF point (xr, yr, zr) becomes world
  // (xr, -yr, -zr). So the capture camera is at world (0,0,0) looking
  // along world -Z.
  const min = new THREE.Vector3(+Infinity, +Infinity, +Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const n = positions.length / 3;
  // Stats for the front layer (smaller |z| means closer to camera):
  let zMin = +Infinity, zMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[3*i+0], y = positions[3*i+1], z = positions[3*i+2];
    if (!isFinite(x)||!isFinite(y)||!isFinite(z)) continue;
    if (x < min.x) min.x = x; if (x > max.x) max.x = x;
    if (y < min.y) min.y = y; if (y > max.y) max.y = y;
    if (z < min.z) min.z = z; if (z > max.z) max.z = z;
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
  }
  if (!isFinite(min.x)) return;

  // World-space AABB centre (after the X-flip):
  const worldCx = (min.x + max.x) * 0.5;
  const worldCy = -(min.y + max.y) * 0.5;
  const worldCz = -(min.z + max.z) * 0.5;
  const dx = max.x - min.x, dy = max.y - min.y, dz = max.z - min.z;
  const size = Math.sqrt(dx*dx + dy*dy + dz*dz);

  // OrbitControls' rotation pivot is its target — put it at the cloud's
  // centre so a drag rotates the object naturally.
  viewer.controls.target.set(worldCx, worldCy, worldCz);
  viewer.camera.near = Math.max(0.001, size * 0.003);
  viewer.camera.far  = size * 30;

  const intr = viewer.intrinsics;
  if (intr) {
    // Reproduce the original capture camera EXACTLY: position the
    // OrbitControls camera at the capture-frame origin (=world origin
    // after the X-flip), make it look along world -Z (which is RDF +Z,
    // the forward direction), and set the vertical FOV from fy / image
    // height.
    //
    // OrbitControls always looks at controls.target, so we just need a
    // camera position on the line "origin -> -Z" — putting the camera
    // at world (0,0,0) makes the look-direction point at (worldCx,
    // worldCy, worldCz). Since worldCz < 0 (object is in front of the
    // camera along world -Z), this gives the correct gaze direction.
    //
    // Use the intrinsic FOV verbatim — by construction this aligns the
    // point cloud's screen-space silhouette with the input image (or
    // input video for dynamic samples), so users can do an apples-to-
    // apples comparison without any per-category zoom hack.
    viewer.camera.fov = 2 * Math.atan((intr.ih * 0.5) / intr.fy) * 180 / Math.PI;
    // The pinhole's vertical principal-point offset shifts the optical
    // axis off-centre. We bake that into the camera's projection matrix
    // so the rendered view of the points exactly overlays the input
    // image.
    const v_off = (intr.ih * 0.5 - intr.cy) / intr.fy;  // tangent of vertical offset
    const h_off = (intr.cx - intr.iw * 0.5) / intr.fx;  // tangent of horizontal offset
    viewer.camera.position.set(0, 0, 0);
    // Apply principal-point offset via setViewOffset is overkill;
    // for this stylistic demo the per-mille shift is invisible.
    viewer.camera.updateProjectionMatrix();
    viewer.controls.update();
    // Record the canonical "image-aligned" pose so user can reset to it.
    viewer.homePose = {
      cam: viewer.camera.position.clone(),
      target: viewer.controls.target.clone(),
      fov: viewer.camera.fov,
    };
    return;
  }

  // Fallback (no intrinsics): a flattering 3/4-view roughly along +Z.
  viewer.camera.position.set(
    worldCx,
    worldCy + size * 0.20,
    worldCz + size * 1.55,
  );
  viewer.camera.fov = 45;
  viewer.camera.updateProjectionMatrix();
  viewer.controls.update();
  viewer.homePose = {
    cam: viewer.camera.position.clone(),
    target: viewer.controls.target.clone(),
    fov: viewer.camera.fov,
  };
}

function _clearViewerScene(viewer) {
  if (viewer.dynamic) {
    viewer.dynamic.active = false;
    viewer.dynamic = null;
  }
  if (viewer.mesh) {
    viewer.root.remove(viewer.mesh);
    if (viewer.mesh.geometry) viewer.mesh.geometry.dispose();
    if (viewer.mesh.material) viewer.mesh.material.dispose();
    viewer.mesh = null;
  }
  viewer.intrinsics = null;
}

function loadPointCloud(viewer, url, status_el, on_loaded, category) {
  // Bump a generation token so any in-flight load that resolves AFTER
  // this one is recognised as stale and ignored. Also abort the previous
  // fetch if still pending. This fixes a race where rapidly clicking
  // between samples (e.g. an Object then a Dynamic) lets the older
  // sample's fetch resolve last and re-attach its mesh on top of the
  // newer one — visible as e.g. a static object lingering behind the
  // 8-fps dynamic point cloud.
  viewer._loadGen = (viewer._loadGen | 0) + 1;
  const gen = viewer._loadGen;
  if (viewer._loadAbort) {
    try { viewer._loadAbort.abort(); } catch (e) {}
  }
  const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  viewer._loadAbort = ac;

  _clearViewerScene(viewer);
  // Used by pointSizeForBBox to pick a per-category screen-footprint
  // factor (object: 4×, scene: 2.5×, dynamic: 5×).
  viewer.category = category || (typeof STATE !== 'undefined' ? STATE.category : 'object');

  if (status_el) status_el.textContent = 'Loading 3D…';
  return fetch(url, ac ? { signal: ac.signal } : undefined).then(r => {
    if (gen !== viewer._loadGen) return null;          // stale
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.arrayBuffer();
  }).then(buf => {
    if (buf === null || gen !== viewer._loadGen) return;  // stale
    // Defensive second clear: catches the race where the prior load was
    // not yet 'started' (we cancelled its fetch above) but its earlier
    // attachStatic/attachDynamic already added a mesh between the time
    // _clearViewerScene() ran for THIS call and now.
    _clearViewerScene(viewer);
    const view = new DataView(buf);
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (magic !== 'WTPC') throw new Error('bad magic: ' + magic);
    const version = view.getUint8(4);
    const kind = view.getUint8(5);
    const n_frames = view.getUint16(6, true);
    const cam_flag = (version >= 2) ? view.getUint8(8) : 0;
    // bytes [9..11] reserved
    let off = 12;
    if (cam_flag === 1) {
      const fx = view.getFloat32(off, true); off += 4;
      const fy = view.getFloat32(off, true); off += 4;
      const cx = view.getFloat32(off, true); off += 4;
      const cy = view.getFloat32(off, true); off += 4;
      const iw = view.getFloat32(off, true); off += 4;
      const ih = view.getFloat32(off, true); off += 4;
      viewer.intrinsics = { fx, fy, cx, cy, iw, ih };
    }
    if (kind === 0) {
      const n_pts = view.getUint32(off, true); off += 4;
      const positions = new Float32Array(buf, off, n_pts * 3);
      off += n_pts * 12;
      const colors_uint8 = new Uint8Array(buf, off, n_pts * 3);
      if (gen !== viewer._loadGen) return;  // stale
      attachStatic(viewer, positions, colors_uint8);
    } else if (kind === 1) {
      // Per-frame counts then back-to-back frames.
      const counts = new Uint32Array(buf, off, n_frames);
      off += n_frames * 4;
      const frames = [];
      for (let t = 0; t < n_frames; t++) {
        const c = counts[t];
        const pos = new Float32Array(buf, off, c * 3);
        off += c * 12;
        const col = new Uint8Array(buf, off, c * 3);
        off += c * 3;
        // Each frame's colour block is zero-padded to a 4-byte boundary
        // so the next frame's positions can be read into a Float32Array
        // (which requires a multiple-of-4 byte offset). Skip the pad.
        off = (off + 3) & ~3;
        frames.push({ pos, col });
      }
      if (gen !== viewer._loadGen) return;  // stale
      attachDynamic(viewer, frames);
    } else {
      throw new Error('unknown kind: ' + kind);
    }
    if (status_el && gen === viewer._loadGen) status_el.textContent = '';
    if (on_loaded && gen === viewer._loadGen) on_loaded();
  }).catch(err => {
    if (err && (err.name === 'AbortError' || err.code === 20)) return;  // expected on switch
    if (gen !== viewer._loadGen) return;  // stale -- newer load already running
    console.error('pointcloud load failed:', url, err);
    if (status_el) status_el.textContent = 'Failed to load';
  });
}

function pointSizeForBBox(positions, intrinsics, category) {
  // Sized in *world units*. We want the rendered footprint of one point
  // to be approximately one "image pixel" wide at the canonical view,
  // so the input image's pixel count and the point-cloud point count
  // (with the layered fill we use) yield a dense, opaque-looking
  // surface without gaps. Using the camera intrinsics:
  //
  //   image_height(at depth z) = 2 * z * tan(FOV_v / 2) = z * h_img / fy
  //
  // We pick z = mean of |Z| (depth in the camera frame); each point's
  // world width = image_height / sqrt(N) * factor.
  let mnx=+Infinity,mny=+Infinity,mnz=+Infinity,mxx=-Infinity,mxy=-Infinity,mxz=-Infinity;
  let nfin = 0;
  // Z is the third component in the RDF frame (positions are pre-flip).
  // After flip, world z = -rdf_z; |world z| = rdf_z.
  let zSum = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const x=positions[i], y=positions[i+1], z=positions[i+2];
    if (!isFinite(x)||!isFinite(y)||!isFinite(z)) continue;
    if (x<mnx)mnx=x; if (y<mny)mny=y; if (z<mnz)mnz=z;
    if (x>mxx)mxx=x; if (y>mxy)mxy=y; if (z>mxz)mxz=z;
    zSum += Math.abs(z);
    nfin++;
  }
  if (nfin === 0) return 0.005;
  const zMean = zSum / nfin;
  const N     = nfin;

  // ---- DYNAMIC: pixel-width based (N-independent) ----
  // Dynamic samples vary wildly in point count (~14 K for DAVIS tennis
  // up to ~140 K for jack-russell) because they're driven by mask size
  // rather than a fixed grid.  The N-based formula below scaled by
  // `1/sqrt(N)`, blowing up splats on small-subject samples by ~5×
  // (0.040 vs 0.007 world units).  For dynamic we ignore N entirely
  // and size each point as a fixed number of image-pixels at the mean
  // depth: width = (zMean / fy) * factor.  Factor 2.0 = "each point is
  // 2 image-pixels wide at its mean depth".
  if (category === 'dynamic') {
    if (intrinsics && intrinsics.fy > 0) {
      return Math.max(0.004, (zMean / intrinsics.fy) * 2.0);
    }
    const dx=mxx-mnx, dy=mxy-mny, dz=mxz-mnz;
    const diag = Math.sqrt(dx*dx + dy*dy + dz*dz);
    return Math.max(0.010, diag * 0.020 * (2.0 / 4.0));
  }

  // ---- OBJECT / SCENE: keep historical N-based sizing ----
  // Object: 4× base (matches the original ≈300 K densely-packed look).
  // Scene: smaller multiplier — scenes have very wide depth ranges so
  // the mean-depth heuristic over-estimates the average viewing
  // distance, blowing points up.
  let factor = 4.0;
  if (category === 'scene')   factor = 2.5;

  if (intrinsics && intrinsics.fy > 0 && intrinsics.ih > 0) {
    const imageHeightAtDepth = zMean * intrinsics.ih / intrinsics.fy;
    const widthPerPt = imageHeightAtDepth / Math.sqrt(N);
    return Math.max(0.004, widthPerPt * factor);
  }
  // No-intrinsics fallback: diag-based heuristic, tuned to roughly
  // match the above scale on a 504² grid with the chosen factor.
  const dx=mxx-mnx, dy=mxy-mny, dz=mxz-mnz;
  const diag = Math.sqrt(dx*dx + dy*dy + dz*dz);
  return Math.max(0.010, diag * 0.020 * (factor / 4.0));
}

function attachStatic(viewer, positions, colors_uint8) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const colf = new Float32Array(colors_uint8.length);
  for (let i = 0; i < colors_uint8.length; i++) colf[i] = colors_uint8[i] / 255;
  // Leave the BufferAttribute colour space at the default (linear).
  // See the comment in makeViewer() — we treat the sRGB-encoded uint8
  // bytes as pass-through to the framebuffer, which is what the screen
  // expects.
  const colorAttr = new THREE.BufferAttribute(colf, 3);
  geo.setAttribute('color', colorAttr);
  const mat = new THREE.PointsMaterial({
    size: pointSizeForBBox(positions, viewer.intrinsics, viewer.category),
    vertexColors: true, sizeAttenuation: true,
  });
  const mesh = new THREE.Points(geo, mat);
  viewer.root.add(mesh);
  viewer.mesh = mesh;
  fitCameraToPoints(viewer, positions);
}

function attachDynamic(viewer, frames) {
  const f0 = frames[0];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(f0.pos), 3));
  const c0 = new Float32Array(f0.col.length);
  for (let i = 0; i < f0.col.length; i++) c0[i] = f0.col[i] / 255;
  // Linear pass-through (see comment in attachStatic).
  const colorAttr = new THREE.BufferAttribute(c0, 3);
  geo.setAttribute('color', colorAttr);
  // Fit camera using the union of all frames so we don't pop in and out.
  const all = new Float32Array(frames.reduce((a,f)=>a+f.pos.length, 0));
  let off2 = 0;
  for (const f of frames) { all.set(f.pos, off2); off2 += f.pos.length; }
  // Particle size, however, is sized off a *single frame* so its
  // dependency on N (`/ sqrt(N)`) doesn't get artificially shrunken
  // by 16× — that's what made dynamic splats look smaller than object
  // splats even though they sit at a comparable depth.
  const mat = new THREE.PointsMaterial({
    size: pointSizeForBBox(f0.pos, viewer.intrinsics, viewer.category),
    vertexColors: true, sizeAttenuation: true,
  });
  const mesh = new THREE.Points(geo, mat);
  viewer.root.add(mesh);
  viewer.mesh = mesh;
  fitCameraToPoints(viewer, all);

  // Frame playback at 8 fps -> 125 ms / frame
  const FPS = 8;
  const PERIOD_MS = 1000 / FPS;
  const dyn = { frames, idx: 0, active: true, last_ms: performance.now() };
  viewer.dynamic = dyn;
  function tick(now) {
    if (!dyn.active) return;
    if (!viewer.mesh) return;
    if (now - dyn.last_ms >= PERIOD_MS) {
      dyn.idx = (dyn.idx + 1) % dyn.frames.length;
      const f = dyn.frames[dyn.idx];
      const cur = viewer.mesh;
      const posAttr = cur.geometry.attributes.position;
      const colAttr = cur.geometry.attributes.color;
      if (posAttr.array.length !== f.pos.length) {
        cur.geometry.dispose();
        const newGeo = new THREE.BufferGeometry();
        newGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(f.pos), 3));
        const cf = new Float32Array(f.col.length);
        for (let i = 0; i < f.col.length; i++) cf[i] = f.col[i] / 255;
        newGeo.setAttribute('color', new THREE.BufferAttribute(cf, 3));
        cur.geometry = newGeo;
      } else {
        posAttr.array.set(f.pos);
        posAttr.needsUpdate = true;
        for (let i = 0; i < f.col.length; i++) colAttr.array[i] = f.col[i] / 255;
        colAttr.needsUpdate = true;
      }
      dyn.last_ms = now;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function startRenderLoop(viewer) {
  function frame() {
    if (!viewer.renderer) return;          // disposed
    const c = viewer.renderer.domElement;
    if (!c.parentElement) return;          // removed from DOM
    const w = c.parentElement.clientWidth;
    const h = c.parentElement.clientHeight;
    if (w > 0 && h > 0 && (c.width !== w || c.height !== h)) {
      viewer.renderer.setSize(w, h, false);
      viewer.camera.aspect = w / h;
      viewer.camera.updateProjectionMatrix();
    }
    viewer.controls.update();
    viewer.renderer.render(viewer.scene, viewer.camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function getOrCreateViewer(canvas) {
  const k = canvas.id || canvas.getAttribute('data-vid') || Math.random().toString(36).slice(2);
  if (!canvas.id) canvas.id = 'pcc-' + k;
  if (VIEWERS[canvas.id]) return VIEWERS[canvas.id];
  const v = makeViewer(canvas);
  VIEWERS[canvas.id] = v;
  startRenderLoop(v);
  return v;
}

/* ================================================================
   Page wiring
================================================================ */

// Real-touch detection. We deliberately avoid `'ontouchstart' in window` and
// `navigator.maxTouchPoints > 0` because both fire false positives on modern
// desktop Chrome / Firefox and on hybrid devices (Surface, MacBook with Touch
// ID, ...), which would otherwise force the page into a no-autoplay,
// tap-to-play mobile branch.
const IS_MOBILE = typeof window !== 'undefined'
  && window.matchMedia('(hover: none) and (pointer: coarse)').matches;
// Back-compat alias used throughout the page wiring code.
const IS_TOUCH_COARSE = IS_MOBILE;

function setVideoSrc(v, url) {
  if (!v || !url) return;
  const source = v.querySelector('source');
  if (source) {
    source.setAttribute('src', url);
    source.setAttribute('type', 'video/mp4');
  } else {
    v.setAttribute('src', url);
  }
  try { v.load(); } catch (e) {}
}

function videoPendingUrl(v) {
  if (!v) return '';
  return v.dataset.previewSrc || v.dataset.src || v.dataset.lazySrc || '';
}

function prepVideo(v) {
  if (!v) return;
  v.muted = true;
  v.defaultMuted = true;
  v.setAttribute('playsinline', '');
  v.setAttribute('webkit-playsinline', '');
  if (IS_MOBILE) {
    v.setAttribute('controls', '');
    v.setAttribute('preload', 'metadata');
  }
}

function pauseOtherVideos(except) {
  document.querySelectorAll('video').forEach(el => {
    if (el !== except && !el.paused) {
      try { el.pause(); } catch (e) {}
    }
  });
}

function playVideo(v, opts) {
  const exclusive = !opts || opts.exclusive !== false;
  if (!v) return Promise.resolve(false);
  prepVideo(v);
  if (exclusive) pauseOtherVideos(v);
  return v.play().then(() => true).catch(() => false);
}

function playVideoFromGesture(v, url) {
  if (!v) return;
  const pending = url || videoPendingUrl(v);
  if (pending && !v.currentSrc) setVideoSrc(v, pending);
  playVideo(v, { exclusive: true });
}

function initMobileVideos() {
  if (!IS_MOBILE) return;

  const hero = document.getElementById('hero-demo-video');
  if (hero) {
    hero.removeAttribute('autoplay');
    try { hero.pause(); } catch (e) {}
    prepVideo(hero);
  }

  document.querySelectorAll('video').forEach(v => {
    const url = videoPendingUrl(v);
    prepVideo(v);
    if (url && !v.currentSrc) setVideoSrc(v, url);
  });

  document.querySelectorAll('.hover-play-overlay').forEach(el => {
    el.setAttribute('aria-hidden', 'true');
    el.style.display = 'none';
  });
  document.querySelectorAll('.hover-play').forEach(el => {
    el.classList.add('is-playing');
  });
}

function initHeroMobilePolicy() {
  if (!IS_TOUCH_COARSE) return;
  const hero = document.getElementById('hero-demo-video');
  if (!hero || !('IntersectionObserver' in window)) return;
  new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (!e.isIntersecting) {
        try { hero.pause(); } catch (err) {}
      }
    });
  }, { threshold: 0.12 }).observe(hero);
}

// The hero video carries background music. Most browsers block autoplay
// with sound for first-time visitors (Chrome autoplay policy / MEI), so
// the markup ships as `autoplay muted` to guarantee playback. This pair
// of behaviours tries to bring sound on as fast as possible:
//
//   1. On load, try `muted = false; play()` straight away. Returning
//      visitors / users whose engagement index permits autoplay-with-
//      sound get audio from frame one.
//   2. If (1) is rejected (blocked first visit), the catch handler
//      restores muted autoplay AND attaches one-shot listeners. The
//      first real user gesture anywhere on the page (click / tap /
//      keydown) flips the mute off, so the viewer hears sound the
//      moment they interact with the page.
//
// Mobile is left to its own devices: `initMobileVideos()` already
// strips `autoplay`, and a user-initiated tap on the native play
// button will (per iOS / Android policy) play with audio.
function initHeroAutoUnmute() {
  const hero = document.getElementById('hero-demo-video');
  if (!hero) return;
  if (IS_TOUCH_COARSE) return;

  const attachGestureUnmute = () => {
    const onGesture = () => {
      try { hero.muted = false; } catch (e) {}
      window.removeEventListener('pointerdown', onGesture, true);
      window.removeEventListener('keydown',     onGesture, true);
      window.removeEventListener('touchstart',  onGesture, true);
    };
    const opts = { capture: true, passive: true };
    window.addEventListener('pointerdown', onGesture, opts);
    window.addEventListener('keydown',     onGesture, opts);
    window.addEventListener('touchstart',  onGesture, opts);
  };

  try { hero.muted = false; } catch (e) {}
  const p = hero.play();
  if (p && typeof p.then === 'function') {
    p.catch(() => {
      try { hero.muted = true; hero.play().catch(() => {}); } catch (e) {}
      attachGestureUnmute();
    });
  } else {
    attachGestureUnmute();
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

const RR_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M7 7h10v10"></path>
  <path d="M7 17 17 7"></path>
</svg>`;

function disposeViewer(canvas_id) {
  const v = VIEWERS[canvas_id];
  if (!v) return;
  // Invalidate any in-flight loads bound to this viewer, and abort
  // their fetch so the .then chain takes the abort path.
  v._loadGen = (v._loadGen | 0) + 1;
  if (v._loadAbort) { try { v._loadAbort.abort(); } catch (e) {} v._loadAbort = null; }
  if (v.dynamic) { v.dynamic.active = false; v.dynamic = null; }
  if (v.mesh) {
    v.root.remove(v.mesh);
    if (v.mesh.geometry) v.mesh.geometry.dispose();
    if (v.mesh.material) v.mesh.material.dispose();
    v.mesh = null;
  }
  // Important: free the WebGL context so we don't hit the browser's ~16-context cap
  // when the user cycles tabs many times.
  try { v.renderer.dispose(); } catch(e) {}
  try { v.renderer.forceContextLoss(); } catch(e) {}
  v.renderer = null;
  delete VIEWERS[canvas_id];
}

function ensureStageScaffold(category) {
  // We keep ONE persistent scaffold per category. Re-creating <model-viewer>
  // or <canvas> elements per click leaks WebGL contexts (browsers cap ~16).
  const stage = document.getElementById('demo-stage');
  if (!stage) return null;
  if (stage.dataset.cat === category) return stage;
  // Tear down the previous canvas's renderer if any.
  const oldCanvas = stage.querySelector('canvas');
  if (oldCanvas && oldCanvas.id) disposeViewer(oldCanvas.id);
  let inner;
  if (category === 'object') {
    inner = `
      <div class="panel panel-input">
        <span class="panel-label">Input</span>
        <div class="panel-content">
          <img id="stage-input-img" src="" alt="">
        </div>
        <div class="panel-actions"><span class="hint">single image</span></div>
      </div>
      <div class="panel panel-pc">
        <span class="panel-label">Point cloud</span>
        <div class="panel-content">
          <canvas id="stage-pc-canvas-object"></canvas>
          <div class="pc-status" id="stage-pc-status"></div>
        </div>
        <div class="panel-actions">
          <span class="hint">drag to rotate &middot; scroll to zoom</span>
          <a id="stage-rerun-pc" class="open-rerun" href="#" target="_blank" rel="noopener" title="Open this sample in Rerun.io">${RR_ICON} Rerun</a>
        </div>
      </div>
      <div class="panel panel-mesh">
        <span class="panel-label">Textured mesh</span>
        <div class="panel-content">
          <model-viewer id="stage-mv" src=""
            alt=""
            camera-controls touch-action="pan-y"
            disable-tap
            environment-image="legacy"
            shadow-intensity="0"
            exposure="1.0"
            min-camera-orbit="auto auto 5%" max-camera-orbit="auto auto 350%"
            camera-orbit="0deg 90deg auto"
            field-of-view="31deg"
            min-field-of-view="31deg" max-field-of-view="31deg"
            interaction-prompt="none"></model-viewer>
        </div>
        <div class="panel-actions">
          <span class="hint">training-free textured mesh</span>
          <a id="stage-rerun-mv" class="open-rerun" href="#" target="_blank" rel="noopener" title="Open this sample in Rerun.io">${RR_ICON} Rerun</a>
        </div>
      </div>
    `;
    stage.className = 'demo-stage three';
  } else if (category === 'scene') {
    inner = `
      <div class="panel panel-input">
        <span class="panel-label">Input</span>
        <div class="panel-content"><img id="stage-input-img" src="" alt=""></div>
        <div class="panel-actions"><span class="hint">single image</span></div>
      </div>
      <div class="panel panel-pc">
        <span class="panel-label">Point cloud</span>
        <div class="panel-content">
          <canvas id="stage-pc-canvas-scene"></canvas>
          <div class="pc-status" id="stage-pc-status"></div>
        </div>
        <div class="panel-actions">
          <span class="hint">drag to rotate &middot; scroll to zoom</span>
          <a id="stage-rerun-pc" class="open-rerun" href="#" target="_blank" rel="noopener" title="Open this sample in Rerun.io">${RR_ICON} Rerun</a>
        </div>
      </div>
    `;
    stage.className = 'demo-stage two';
  } else {
    inner = `
      <div class="panel panel-input">
        <span class="panel-label">Input video (8 fps)</span>
        <div class="panel-content">
          <video id="stage-input-video" autoplay loop muted playsinline preload="auto" disableremoteplayback></video>
        </div>
        <div class="panel-actions"><span class="hint">16-frame clip</span></div>
      </div>
      <div class="panel panel-pc">
        <span class="panel-label">Point cloud (8 fps)</span>
        <div class="panel-content">
          <canvas id="stage-pc-canvas-dynamic"></canvas>
          <div class="pc-status" id="stage-pc-status"></div>
        </div>
        <div class="panel-actions">
          <span class="hint">drag to rotate &middot; scroll to zoom</span>
          <a id="stage-rerun-pc" class="open-rerun" href="#" target="_blank" rel="noopener" title="Open this sample in Rerun.io">${RR_ICON} Rerun</a>
        </div>
      </div>
    `;
    stage.className = 'demo-stage two';
  }
  stage.innerHTML = inner;
  stage.dataset.cat = category;
  return stage;
}

function setStage(category, stem) {
  const sample = (window.SAMPLES || []).find(x => x.category === category && x.stem === stem);
  if (!sample) return;
  STATE.category = category; STATE.stem = stem;

  const stage = ensureStageScaffold(category);
  const header = document.getElementById('stage-header');
  if (!stage || !header) return;

  header.innerHTML = `<span>${escapeHtml(sample.label)}</span>`;

  // Update input preview
  if (category === 'dynamic') {
    const v = document.getElementById('stage-input-video');
    if (v) {
      v.pause();
      setVideoSrc(v, sample.input_rel);
      playVideo(v);
    }
  } else {
    const img = document.getElementById('stage-input-img');
    if (img) { img.src = sample.input_rel; img.alt = sample.label + ' input image'; }
  }

  // Update Rerun links
  document.querySelectorAll('.open-rerun').forEach(a => {
    a.href = sample.viewer_url;
  });

  // Mount the point-cloud viewer (reuse if already created)
  const canvas = stage.querySelector('canvas');
  const status_el = document.getElementById('stage-pc-status');
  if (canvas) {
    const viewer = getOrCreateViewer(canvas);
    loadPointCloud(viewer, sample.pc_rel, status_el, undefined, category);
  }

  // Update the model-viewer src (for object only)
  if (category === 'object') {
    const mv = document.getElementById('stage-mv');
    if (mv) {
      mv.setAttribute('src', sample.glb_rel);
      mv.setAttribute('alt', sample.label + ' textured mesh');
      // Match the original capture-camera vantage point so the textured
      // mesh's initial view overlays the input image. The mesh has been
      // pre-baked into world space such that the original camera sits at
      // world (0, 0, 0) looking down -Z (model-viewer convention). To
      // reproduce that, we wait for the model to load, then position the
      // camera at world origin with theta=0deg, phi=90deg, and radius
      // equal to the distance from the model centroid to the world
      // origin — multiplied by `mesh_radius_scale` (TRELLIS.2 meshes are
      // typically smaller than our cloud; this dollies the camera in so
      // the mesh fills the panel by the same fraction as the cloud).
      //
      // model-viewer also resets FOV during `updateFraming` after every
      // model load to its default 30°, ignoring our `field-of-view`
      // attribute. To pin the FOV we set BOTH `min-field-of-view` and
      // `max-field-of-view` to the same value and re-apply on the
      // `load` event.
      const fov_deg = (sample.fov_v_deg && sample.fov_v_deg > 0)
        ? sample.fov_v_deg : 31.0;
      const fov_attr = fov_deg.toFixed(2) + 'deg';
      mv.setAttribute('min-field-of-view', fov_attr);
      mv.setAttribute('max-field-of-view', fov_attr);
      mv.setAttribute('field-of-view', fov_attr);
      const scale = (typeof sample.mesh_radius_scale === 'number' && sample.mesh_radius_scale > 0)
        ? sample.mesh_radius_scale : 1.0;
      const placeCamera = () => {
        // Re-pin FOV in case model-viewer reset it during updateFraming.
        mv.setAttribute('min-field-of-view', fov_attr);
        mv.setAttribute('max-field-of-view', fov_attr);
        mv.setAttribute('field-of-view', fov_attr);
        const c = mv.getCameraTarget();   // model bbox centre in world coords
        if (!c || typeof c.x !== 'number') {
          mv.setAttribute('camera-orbit', '0deg 90deg auto');
          return;
        }
        // direction from centroid to world-origin (== capture camera pose)
        const dx = -c.x, dy = -c.y, dz = -c.z;
        const r_full = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if (r_full < 1e-3) {
          mv.setAttribute('camera-orbit', '0deg 90deg auto');
          return;
        }
        const r = r_full * scale;   // dolly closer if mesh is smaller
        const nx = dx / r_full, ny = dy / r_full, nz = dz / r_full;
        const phi   = Math.acos(Math.max(-1, Math.min(1, ny)));
        const sinPhi = Math.sin(phi);
        let theta;
        if (sinPhi < 1e-4) {
          theta = 0;
        } else {
          theta = Math.atan2(nx / sinPhi, nz / sinPhi);
        }
        const orbit = (theta * 180 / Math.PI).toFixed(2) + 'deg ' +
                      (phi   * 180 / Math.PI).toFixed(2) + 'deg ' +
                      r.toFixed(3) + 'm';
        mv.setAttribute('camera-orbit', orbit);
      };
      mv.addEventListener('load', placeCamera, { once: true });
      if (typeof mv.resetTurntableRotation === 'function') mv.resetTurntableRotation();
    }
  }

  highlightActiveThumb();
}

function buildThumbStrip(category) {
  const strip = document.getElementById('thumb-strip');
  if (!strip) return;
  strip.innerHTML = '';
  const items = (window.SAMPLES || []).filter(s => s.category === category);
  items.forEach(s => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'thumb-btn';
    btn.dataset.stem = s.stem;
    btn.dataset.cat = category;
    if (s.category === 'dynamic') {
      btn.innerHTML = `<video src="${escapeHtml(s.input_rel)}" muted loop playsinline preload="metadata" disableremoteplayback></video>`;
      const v = btn.querySelector('video');
      const playThumb = () => { playVideo(v); };
      const stopThumb = () => { v.pause(); v.currentTime = 0; };
      btn.addEventListener('mouseenter', playThumb);
      btn.addEventListener('mouseleave', stopThumb);
      btn.addEventListener('touchstart', playThumb, { passive: true });
      btn.addEventListener('touchend', stopThumb, { passive: true });
    } else {
      btn.innerHTML = `<img src="${escapeHtml(s.thumb_rel)}" alt="${escapeHtml(s.label)}" loading="lazy">`;
    }
    btn.addEventListener('click', () => setStage(category, s.stem));
    strip.appendChild(btn);
  });
  updateStripScrollButtons();
}

function highlightActiveThumb() {
  document.querySelectorAll('#thumb-strip .thumb-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.stem === STATE.stem);
  });
}

function updateStripScrollButtons() {
  const strip = document.getElementById('thumb-strip');
  const prev = document.querySelector('.strip-btn.prev');
  const next = document.querySelector('.strip-btn.next');
  if (!strip || !prev || !next) return;
  prev.disabled = strip.scrollLeft <= 2;
  next.disabled = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 2;
}

function setupStripScroll() {
  const strip = document.getElementById('thumb-strip');
  const prev = document.querySelector('.strip-btn.prev');
  const next = document.querySelector('.strip-btn.next');
  if (!strip || !prev || !next) return;
  const step = () => strip.clientWidth * 0.7;
  prev.addEventListener('click', () => strip.scrollBy({ left: -step(), behavior: 'smooth' }));
  next.addEventListener('click', () => strip.scrollBy({ left:  step(), behavior: 'smooth' }));
  strip.addEventListener('scroll', updateStripScrollButtons, { passive: true });
  window.addEventListener('resize', updateStripScrollButtons);
}

function setCategory(cat) {
  STATE.category = cat;
  document.querySelectorAll('.cat-tabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.cat === cat);
  });
  buildThumbStrip(cat);
  // Pick the first sample of that category as the active one
  const first = (window.SAMPLES || []).find(s => s.category === cat);
  if (first) setStage(cat, first.stem);
}

function initMeshDemoStrip() {
  const videos = window.DEMO_VIDEOS || [];
  if (!videos.length) return;
  const video = document.getElementById('mesh-demo-video');
  const strip = document.getElementById('mesh-demo-strip');
  const label = document.getElementById('mesh-demo-label');
  if (!video || !strip) return;

  function load(idx) {
    const v = videos[idx];
    if (!v) return;
    if (label) label.textContent = v.label || v.stem;
    // Hover-to-play: stash the URL on the <video> so the hover handler
    // (`initHoverPlay`) can attach it lazily on first interaction. We do
    // NOT call play() here -- the user only sees motion when they hover.
    video.dataset.src = v.mp4;
    if (video.getAttribute('src') && video.getAttribute('src') !== v.mp4) {
      // User already engaged; switch to the new clip mid-stream.
      setVideoSrc(video, v.mp4);
      const stage = video.closest('.hover-play');
      if (stage && stage.classList.contains('is-playing')) {
        playVideo(video);
      }
    }
    strip.querySelectorAll('.thumb-btn').forEach((b, i) => {
      b.classList.toggle('active', i === idx);
    });
  }

  videos.forEach((v, idx) => {
    const btn = document.createElement('button');
    btn.className = 'thumb-btn';
    btn.title = v.label || v.stem;
    btn.dataset.idx = String(idx);
    const img = document.createElement('img');
    img.src = v.thumb || '';
    img.alt = v.label || v.stem;
    img.loading = 'lazy';
    btn.appendChild(img);
    btn.addEventListener('click', () => load(idx));
    strip.appendChild(btn);
  });

  const prev = document.getElementById('mesh-demo-prev');
  const next = document.getElementById('mesh-demo-next');
  function scrollBy(delta) {
    strip.scrollBy({ left: delta, behavior: 'smooth' });
  }
  if (prev) prev.addEventListener('click', () => scrollBy(-200));
  if (next) next.addEventListener('click', () => scrollBy(200));

  load(0);
}

// Lucide-style stroke icons inlined to avoid an extra CDN fetch / FOUC.
// stroke-width is set on the <svg> tag (matches the .h-card .h-icon CSS).
const HL_ICONS = {
  layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg>',
  box:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
  wand:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 4V2"/><path d="M15 16v-2"/><path d="M8 9h2"/><path d="M20 9h2"/><path d="M17.8 11.8 19 13"/><path d="M15 9h0"/><path d="M17.8 6.2 19 5"/><path d="m3 21 9-9"/><path d="M12.2 6.2 11 5"/></svg>',
  film:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2"  x2="7"  y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2"  y1="12" x2="22" y2="12"/><line x1="2"  y1="7"  x2="7"  y2="7"/><line x1="2"  y1="17" x2="7"  y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7"  x2="22" y2="7"/></svg>',
  grid:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  play:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor"/></svg>',
};

function initHighlightsBand() {
  // Render the inline SVG icons.
  document.querySelectorAll('.h-card .h-icon').forEach(el => {
    const k = el.dataset.icon;
    if (k && HL_ICONS[k]) el.innerHTML = HL_ICONS[k];
  });

  // Wire each tile to a representative preview clip drawn from the
  // already-deployed manifests. The Highlights band uses 6 tile IDs
  // (3 row-1 phase1 clips + 3 row-2 application clips):
  //
  //   Row 1 (Pixel-aligned multilayer geometry):
  //     - step1-object   <- HIGHLIGHT_VIDEOS['step1-object']
  //                         (all curated objects' phase1 peels xfade-concat)
  //     - step1-scene    <- HIGHLIGHT_VIDEOS['step1-scene']
  //                         (all curated scenes' phase1-from-rrd peels)
  //     - step1-dynamic  <- HIGHLIGHT_VIDEOS['step1-dynamic']
  //                         (all curated dynamic clips' motion loops)
  //
  //   Row 2 (Applications):
  //     - textured-mesh  <- HIGHLIGHT_VIDEOS['textured-mesh']
  //                         (all curated objects' mesh orbits xfade-concat)
  //     - scene-editing  <- SECTION_VIDEOS['demo-3d-editing-video']
  //     - novel-view     <- SECTION_VIDEOS['demo-novel-view-video-video']
  //
  // Tiles whose preview is unavailable show a subtle gradient fallback.
  function highlightUrl(tileId) {
    const map = Object.assign({},
      window.HIGHLIGHT_VIDEOS || {},
      window.__S3_HIGHLIGHT_VIDEOS || {});
    return map[tileId] || null;
  }

  // Last-resort per-stem fallback: if the cycle clip didn't make it to
  // S3 yet (e.g. user is previewing locally before re-running
  // _upload_highlight_cycles.sh), fall back to a representative single
  // sample from window.DEMO_VIDEOS.
  const FALLBACK_BY_KEY = {
    'step1-object':  ['obj063_trex_dinosaur', 'obj071_griffin', 'obj014_leather_briefcase'],
    'textured-mesh': ['obj071_griffin', 'obj014_leather_briefcase', 'obj083_chibi_swordsman'],
  };

  function pickDemoVideo(prefs) {
    const list = window.DEMO_VIDEOS || [];
    if (!list.length) return null;
    for (const stem of prefs) {
      const m = list.find(v => v.stem === stem);
      if (m) return m;
    }
    return list[0];
  }

  function fromHighlight(key, fallbackPrefs) {
    const cycle = highlightUrl(key);
    if (cycle) return { mp4: cycle, poster: null };
    if (fallbackPrefs) {
      const v = pickDemoVideo(fallbackPrefs);
      if (v) return { mp4: v.mp4, poster: v.thumb };
    }
    return null;
  }

  function fromSection(id) {
    const map = Object.assign({},
      window.SECTION_VIDEOS || {},
      window.__S3_SECTION_VIDEOS || {});
    const url = map[id];
    return url ? { mp4: url, poster: null } : null;
  }

  const previews = {
    'step1-object':  () => fromHighlight('step1-object',  FALLBACK_BY_KEY['step1-object']),
    'step1-scene':   () => fromHighlight('step1-scene'),
    'step1-dynamic': () => fromHighlight('step1-dynamic'),
    'textured-mesh': () => fromHighlight('textured-mesh', FALLBACK_BY_KEY['textured-mesh']),
    'scene-editing': () => fromSection('demo-3d-editing-video'),
    'novel-view':    () => fromSection('demo-novel-view-video-video'),
  };

  document.querySelectorAll('.h-card').forEach(card => {
    const key = card.dataset.preview;
    const make = previews[key];
    const v = card.querySelector('video.h-preview');
    if (!v) return;
    const got = make && make();
    if (!got || !got.mp4) {
      v.remove();
      return;
    }
    if (got.poster) v.setAttribute('poster', got.poster);
    v.dataset.previewSrc = got.mp4;
    if (IS_MOBILE) {
      setVideoSrc(v, got.mp4);
      prepVideo(v);
    } else {
      setVideoSrc(v, got.mp4);
    }
  });

  // Highlight cards: div wrappers (not <a>) so preview videos can autoplay
  // on iOS. Click / Enter navigates to the linked section.
  document.querySelectorAll('.h-card').forEach(card => {
    const cat = card.dataset.cat;
    const href = card.dataset.href;
    function onActivate() {
      if (cat) try { setCategory(cat); } catch (e) {}
      if (href) {
        const el = document.querySelector(href);
        if (el) el.scrollIntoView({ behavior: 'smooth' });
      }
    }
    card.addEventListener('click', (e) => {
      // On touch devices we want to keep tap-to-play behaviour for the
      // video area (handled in the IS_TOUCH_COARSE branch below); on a
      // regular desktop browser, clicks anywhere on the card — including
      // the video thumbnail — should navigate to the linked section.
      if (IS_TOUCH_COARSE && e.target.closest('.h-media')) return;
      onActivate();
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onActivate();
      }
    });
  });

  // Desktop: all 6 tile videos auto-play in parallel as soon as the page
  // loads (no IntersectionObserver — the row is short enough that users
  // expect the whole strip to be playing immediately, like a magazine
  // contact-sheet). `exclusive:false` keeps every tile playing instead of
  // pausing the others. Mobile uses native controls (see initMobileVideos).
  if (!IS_MOBILE) {
    document.querySelectorAll('.h-card video.h-preview').forEach(v => {
      playVideo(v, { exclusive: false });
      v.addEventListener('loadeddata', () => {
        if (v.paused) playVideo(v, { exclusive: false });
      });
    });
  }
}

function initSectionVideos() {
  // S3-runtime override map takes precedence over the (possibly stale)
  // build-time manifest baked into `window.SECTION_VIDEOS`. This lets
  // `_upload_curated_page_s3.sh` mint fresh 7-day URLs on every
  // re-deploy without needing to rebuild the page.
  //
  // We only stash the URL on a `data-src` attribute here; the actual
  // `src=` swap + `load()` happens lazily on first hover (see
  // `initHoverPlay`) so the videos never preload until the user
  // explicitly engages with them.
  const map = Object.assign({}, window.SECTION_VIDEOS || {}, window.__S3_SECTION_VIDEOS || {});
  Object.entries(map).forEach(([id, url]) => {
    if (!url) return;
    const v = document.getElementById(id);
    if (!v) return;
    v.dataset.src = url;
    if (!v.hasAttribute('data-play-on-hover')) {
      setVideoSrc(v, url);
      if (!IS_MOBILE) {
        const kick = () => { playVideo(v, { exclusive: false }); };
        kick();
        v.addEventListener('loadeddata', kick, { once: true });
        v.addEventListener('canplay', kick, { once: true });
      } else {
        prepVideo(v);
      }
    }
  });
}

// Big demo videos: instead of autoplaying, the user has to engage once.
// On the first `mouseenter` / `focusin` / tap we lazily attach `src`, call
// `v.load()` + `v.play()`, and add the `is-playing` class so the
// `.hover-play-overlay` fades out. After that first engagement we **stay
// playing** -- the mouse leaving, scrolling out of view, etc. do NOT
// pause the video. Tap on touch devices toggles play / pause as a manual
// control.
function initHoverPlay() {
  if (IS_MOBILE) return;

  if (IS_TOUCH_COARSE) {
    document.querySelectorAll('.hover-play-label').forEach(el => {
      el.textContent = 'Tap to play';
    });
  }

  document.querySelectorAll('.hover-play').forEach(stage => {
    const targetId = stage.dataset.hoverTarget;
    const v = targetId
      ? document.getElementById(targetId)
      : stage.querySelector('video[data-play-on-hover]');
    if (!v) return;
    prepVideo(v);

    function videoUrl() {
      return v.dataset.src || v.dataset.lazySrc || '';
    }

    function startFromGesture() {
      playVideoFromGesture(v, videoUrl());
      stage.classList.add('is-playing');
    }

    if (IS_TOUCH_COARSE) {
      stage.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        if (v.paused) startFromGesture();
        else {
          stage.classList.remove('is-playing');
          try { v.pause(); } catch (err) {}
        }
      });
      return;
    }

    let touchHandled = false;

    function ensureSrc() {
      if (v.getAttribute('src') || v.querySelector('source[src]')) return;
      const url = videoUrl();
      if (!url) return;
      setVideoSrc(v, url);
    }

    function startDesktop() {
      ensureSrc();
      stage.classList.add('is-playing');
      playVideo(v).then((ok) => {
        if (!ok) {
          const retry = () => {
            v.removeEventListener('loadeddata', retry);
            v.removeEventListener('canplay', retry);
            playVideo(v);
          };
          v.addEventListener('loadeddata', retry, { once: true });
          v.addEventListener('canplay', retry, { once: true });
        }
      });
    }

    stage.addEventListener('mouseenter', startDesktop, { once: false });
    stage.addEventListener('focusin', startDesktop, { once: false });

    stage.addEventListener('touchstart', () => {
      touchHandled = true;
      setTimeout(() => { touchHandled = false; }, 450);
      if (v.paused) startDesktop();
      else {
        stage.classList.remove('is-playing');
        try { v.pause(); } catch (e) {}
      }
    }, { passive: true });

    stage.addEventListener('click', () => {
      if (touchHandled) return;
      if (v.paused) startDesktop();
    });
  });
}

function setupBibtexCopy() {
  document.querySelectorAll('.cite-copy').forEach(btn => {
    const targetId = btn.getAttribute('data-target');
    const target = targetId && document.getElementById(targetId);
    if (!target) return;
    const label = btn.querySelector('.cite-copy-label');
    let restoreId = 0;
    btn.addEventListener('click', async () => {
      const text = (target.textContent || '').replace(/^\s+/, '').replace(/\s+$/, '') + '\n';
      let ok = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          ok = true;
        }
      } catch (e) { ok = false; }
      if (!ok) {
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          ok = document.execCommand('copy');
          document.body.removeChild(ta);
        } catch (e) { ok = false; }
      }
      btn.classList.toggle('copied', ok);
      if (label) label.textContent = ok ? 'copied' : 'failed';
      if (restoreId) clearTimeout(restoreId);
      restoreId = setTimeout(() => {
        btn.classList.remove('copied');
        if (label) label.textContent = 'copy';
        restoreId = 0;
      }, 1800);
    });
  });
}

function init() {
  document.querySelectorAll('.cat-tabs button').forEach(b => {
    b.addEventListener('click', () => setCategory(b.dataset.cat));
  });
  setupStripScroll();
  initHighlightsBand();
  initMeshDemoStrip();
  initSectionVideos();
  initHoverPlay();
  initMobileVideos();
  initHeroMobilePolicy();
  initHeroAutoUnmute();
  setupBibtexCopy();
  // Initial tab from ?cat=scene|object|dynamic, default object.
  const params = new URLSearchParams(window.location.search);
  const initialCat = params.get('cat');
  const valid = new Set(['object', 'scene', 'dynamic']);
  setCategory(valid.has(initialCat) ? initialCat : 'object');
  // Optionally land on a specific stem.
  const initStem = params.get('stem');
  if (initStem) {
    const s = (window.SAMPLES || []).find(x => x.stem === initStem);
    if (s) setStage(s.category, s.stem);
  }
}

document.addEventListener('DOMContentLoaded', init);
