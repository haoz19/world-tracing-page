"""Build the *curated* project page (single self-contained ``standalone.html``
plus a ``docs_curated/`` folder for GitHub Pages).

Layout (inspired by https://vggt-omega.github.io/):

  1. Hero: paper title, authors, affiliation, button row (PDF / arXiv /
     Code / BibTeX).
  2. Teaser: a single hero image (currently placeholder).
  3. Abstract.
  4. Interactive Examples (top-of-fold, "stage + thumb strip"):
       - Category tabs (Object / Scene / Dynamic).
       - One big **stage** that mirrors VGGT-Ω's selected demo:
           * object  : input image | point cloud canvas | textured mesh
                       <model-viewer>  (3 equal-width panels)
           * scene   : input image | point cloud canvas
           * dynamic : input mp4 (loops at 8 fps) | point cloud canvas
                       (loops in lock-step at 8 fps over 16 frames)
       - Below each 3D panel, a small rerun-icon button "Open in Rerun".
       - Below the stage, a horizontally-scrollable thumbnail strip with
         every sample in the current category.
  5. Task grid (4 cards linking to demos).
  6. Demo video sections (placeholder mp4s).
  7. Citation.
  8. Acknowledgements.

3D backends:
  * Point clouds: a single shared Three.js renderer driven by binary
    ``.wtpc`` files (built by ``_build_web_assets.py``).
  * Textured meshes: Google's ``<model-viewer>`` web component, loaded
    once per object via meshopt-compressed GLBs in ``assets/glb/``.
    Three.js + ``MeshoptDecoder`` is registered globally.

Inputs:
  * ``_curated_selection.json``     -- list of (stem, category, seed)
  * ``docs_curated/assets/pc/...``  -- ``.wtpc`` per stem (built earlier)
  * ``docs_curated/assets/input/...`` -- input thumb (jpg) or 8-fps mp4
  * ``docs_curated/assets/glb/...`` -- meshopt-compressed object GLBs
  * ``docs_curated/thumbnails/...`` -- 512² strip thumbnails

Usage::

    python _build_curated_page.py                            # uses _curated_selection.json
    python _build_curated_page.py --gh-user haoz19 \
        --gh-repo wt-multilayer-depth-demo --gh-tag v1       # bake real release URLs
    python _build_curated_page.py --url-template "https://..."  # custom
"""

from __future__ import annotations

import argparse
import base64
import json
import shutil
import urllib.parse
from pathlib import Path

REPO_ROOT = Path("/mnt/filestore/users/hao/wlt/src/wlt/experimental/users/hao/multilayer_depth_release_inference")
DOCS_DIR = REPO_ROOT / "docs_curated"
THUMBS_SRC = REPO_ROOT / "docs" / "thumbnails"
SELECTION = REPO_ROOT / "_curated_selection.json"
TEST_IMAGES = REPO_ROOT / "examples" / "test_images"
RRD_LOCAL = REPO_ROOT / "_demo_rrd_curated_local"

RERUN_VERSION = "0.22.0"

# ---------------------------------------------------------------------------
# Site content -- edit these to update copy without touching the layout code.
# ---------------------------------------------------------------------------

TITLE = "World Tracing"
TITLE_LINE_1 = "World Tracing"
SUBTITLE = "Generative Pixel-Aligned Geometry Beyond the Visible"

AUTHOR_LINKS = {
    'Hao Zhang':         'https://haoz19.github.io/',
    'Mohamed El Banani': 'https://mbanani.github.io/',
    'Jen-Hao Cheng':     'https://jen-haocheng.com/#/',
    'Paul Zhang':        'https://people.csail.mit.edu/pzpzpzp1/',
    'Yi Hua':            'https://hawaiii.github.io/',
    'Ben Mildenhall':    'https://bmild.github.io/',
    'Christoph Lassner': 'https://christophlassner.de/',
    'Narendra Ahuja':    'https://vision.ai.illinois.edu/narendra-ahuja/',
    'Gengshan Yang':     'https://gengshan-y.github.io/',
}


def _author(name: str, sup: str) -> str:
    """Render one author entry as a link to their homepage with the
    affiliation superscript outside the anchor (so the superscript
    stays uncolored / non-underlined and the link target only covers
    the name itself)."""
    href = AUTHOR_LINKS[name]
    return (
        f'<a href="{href}" target="_blank" rel="noopener">'
        f'{name}</a><sup>{sup}</sup>'
    )


AUTHORS_HTML = (
    f'{_author("Hao Zhang", "1,2")} &middot; '
    f'{_author("Mohamed El Banani", "1")} &middot; '
    f'{_author("Jen-Hao Cheng", "1")} &middot; '
    f'{_author("Paul Zhang", "1")}<br>'
    f'{_author("Yi Hua", "1")} &middot; '
    f'{_author("Ben Mildenhall", "1")} &middot; '
    f'{_author("Christoph Lassner", "1")} &middot; '
    f'{_author("Narendra Ahuja", "2")} &middot; '
    f'{_author("Gengshan Yang", "1")}'
)
AFFILIATIONS_HTML = (
    '<sup>1</sup>World Labs &nbsp;&nbsp; '
    '<sup>2</sup>University of Illinois Urbana-Champaign'
)

ARROW_SVG = (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    '<line x1="5" y1="12" x2="19" y2="12"></line>'
    '<polyline points="12 5 19 12 12 19"></polyline>'
    '</svg>'
)

LINKS = [
    {"label": "arXiv", "href": "#", "primary": True},
    {"label": "Code", "href": "https://github.com/haoz19/wt-multilayer-depth-demo"},
    {"label": "Model", "href": "#"},
    {"label": "BibTeX", "href": "#bibtex"},
]

ABSTRACT_HTML = """
Single-view to 3D methods often trade off faithfulness and completeness:
depth estimators are anchored to input pixels but stop at the visible
surface, while image-to-3D models generate complete shapes that are often
misaligned to the input. We introduce <em>World Tracing</em>, a generative
pixel-aligned geometry representation that produces 3D points faithfully
reproducing the input image, while containing complete geometry beyond
the visible surface. For each input pixel, World Tracing predicts an
ordered stack of camera-space 3D points, where the first layer represents
the visible surface and subsequent layers represent front-to-back
intersections with occluded surfaces. We instantiate this representation
as a world-tracing diffusion transformer (WT-DiT) that treats multiple
geometry layers as separate denoising tokens coupled through factorized
and global attention. WT-DiT is trained with pixel-space flow matching
using a mixed noise schedule to balance reconstruction vs. generation
capability. As a result, World Tracing demonstrates strong performance
on both visible-surface reconstruction and complete geometry generation
across object, scene, and dynamic benchmarks, outperforming both depth
predictors and image-to-3D generators. Furthermore, because it preserves
2D-to-3D correspondence, it directly enables text-driven 3D scene
editing, geometry-conditioned novel-view video synthesis, and training-free
integration with textured-mesh generators.
"""

ACKNOWLEDGEMENTS_HTML = """
We thank
<a href="https://profiles.stanford.edu/fei-fei-li" target="_blank" rel="noopener">Fei-Fei Li</a>,
<a href="https://web.eecs.umich.edu/~justincj/" target="_blank" rel="noopener">Justin Johnson</a>,
<a href="https://www.bart-ai.com/" target="_blank" rel="noopener">Bardienus Duisterhof</a>,
<a href="https://scholar.google.com/citations?user=zel3jUcAAAAJ&amp;hl=en" target="_blank" rel="noopener">Justin Cui</a>,
and <a href="https://zixuanh.com/" target="_blank" rel="noopener">Zixuan Huang</a>
for valuable discussions and feedback throughout this project.
The interactive 3D viewer is powered by
<a href="https://threejs.org" target="_blank" rel="noopener">Three.js</a>
and <a href="https://modelviewer.dev" target="_blank" rel="noopener">&lt;model-viewer&gt;</a>;
exported sessions open in <a href="https://rerun.io" target="_blank" rel="noopener">Rerun</a>.
Page layout inspired by
<a href="https://www.worldlabs.ai" target="_blank" rel="noopener">World Labs</a>.
"""

CITATION_BIB = """\
@inproceedings{zhang2026worldtracing,
  title     = {World Tracing: Generative Pixel-Aligned Geometry Beyond the Visible},
  author    = {Hao Zhang and Mohamed El Banani and Jen-Hao Cheng and Paul Zhang
               and Yi Hua and Ben Mildenhall and Christoph Lassner
               and Narendra Ahuja and Gengshan Yang},
  booktitle = {Advances in Neural Information Processing Systems (NeurIPS)},
  year      = {2026}
}
"""


# ---------------------------------------------------------------------------
# Sample loading
# ---------------------------------------------------------------------------


def _load_selection() -> dict:
    sel = json.loads(SELECTION.read_text())
    import re as _re

    def _clean_label(stem: str, category: str) -> str:
        s = stem
        if category == "object":
            s = _re.sub(r"^obj\d+_+", "", s)
        elif category == "scene":
            s = _re.sub(r"__seed\d+$", "", s)
            s = _re.sub(r"^scene_(indoor|outdoor)_\d+_", "", s)
            s = _re.sub(r"_\d+(?=_|$)", "", s)
        elif category == "dynamic":
            m = _re.match(r"^human__(\d+)_\d+_view(\d+)$", s)
            if m:
                return f"Human {m.group(1)} \u00b7 view {int(m.group(2))}"
            m = _re.match(r"^davis__(.+)_seg(\d+)$", s)
            if m:
                # Resampled segments (e.g. ``davis__tennis_seg00``).  Show as
                # "DAVIS · Tennis #1" so segment 00 reads as part 1, etc.
                name = m.group(1).replace("-", " ").replace("_", " ").title()
                return f"DAVIS \u00b7 {name} #{int(m.group(2)) + 1}"
            m = _re.match(r"^davis__(.+)$", s)
            if m:
                name = m.group(1).replace("-", " ").replace("_", " ").title()
                return f"DAVIS \u00b7 {name}"
            if "__" in s:
                s = s.split("__", 1)[1]
        parts = [p for p in s.replace("__", "_").split("_") if p]
        words = []
        for w in parts:
            wl = w.lower()
            if wl == "trex":          words.append("T-Rex");        continue
            if wl == "consistent4d":  words.append("Consistent4D"); continue
            if wl == "davis":         words.append("DAVIS");        continue
            if wl == "3d":            words.append("3D");           continue
            words.append(w.capitalize())
        return " ".join(words)

    import math as _math
    import struct as _struct

    def _read_fov_deg(wtpc_path: Path) -> float:
        """Peek the wtpc v2 header for vertical FOV (degrees). Returns 0 if
        intrinsics are absent or file is missing."""
        if not wtpc_path.exists():
            return 0.0
        try:
            with open(wtpc_path, "rb") as fh:
                head = fh.read(36)
            if head[:4] != b"WTPC":
                return 0.0
            version = head[4]
            cam_flag = head[8] if version >= 2 else 0
            if cam_flag != 1:
                return 0.0
            fy = _struct.unpack("<f", head[16:20])[0]
            ih = _struct.unpack("<f", head[32:36])[0]
            if fy <= 0 or ih <= 0:
                return 0.0
            return 2 * _math.atan((ih * 0.5) / fy) * 180.0 / _math.pi
        except Exception:
            return 0.0

    def _read_cloud_y_extent(wtpc_path: Path) -> float:
        """Read the wtpc static positions and return MV-world y-extent (i.e.
        cam-frame y-extent, since the JS viewer applies y-flip on display).
        Used to compute mesh_radius_scale so the textured mesh fills the
        same panel fraction as the point cloud."""
        if not wtpc_path.exists():
            return 0.0
        try:
            import numpy as _np
            with open(wtpc_path, "rb") as fh:
                buf = fh.read()
            if buf[:4] != b"WTPC" or buf[5] != 0:  # static only
                return 0.0
            off = 12 + (24 if buf[8] == 1 else 0)
            n = int(_struct.unpack("<I", buf[off:off+4])[0])
            off += 4
            pos = _np.frombuffer(buf, dtype=_np.float32, count=n*3, offset=off).reshape(n, 3)
            ys = pos[:, 1]
            ys = ys[_np.isfinite(ys)]
            if ys.size < 2:
                return 0.0
            return float(ys.max() - ys.min())
        except Exception:
            return 0.0

    def _read_mesh_y_extent_mv(glb_path: Path) -> float:
        """Return the staged + meshopt-compressed GLB's mesh y-extent in MV
        world coords. ``gltfpack -c`` quantises POSITION to UINT16 and
        encodes the dequantisation via node TRS (``translation + scale *
        quantised``); we use accessor.min/max (still ``[0, 0, 0]`` /
        ``[16383, ...]`` post-quant) plus the node's translation+scale to
        reconstruct the world-space extent without touching the
        meshopt-compressed binary."""
        if not glb_path.exists():
            return 0.0
        try:
            import struct as _s
            import json as _j
            with open(glb_path, "rb") as fh:
                hdr = fh.read(12)
                if hdr[:4] != b"glTF":
                    return 0.0
                jl, jt = _s.unpack("<II", fh.read(8))
                if jt != 0x4E4F534A:
                    return 0.0
                jbytes = fh.read(jl).decode("utf-8")
            doc = _j.loads(jbytes)
            nodes = doc.get("nodes", [])
            accs  = doc.get("accessors", [])
            meshes = doc.get("meshes", [])
            ymin, ymax = float("inf"), float("-inf")
            for node in nodes:
                m_idx = node.get("mesh")
                if m_idx is None or m_idx >= len(meshes):
                    continue
                tr = node.get("translation", [0, 0, 0])
                sc = node.get("scale", [1, 1, 1])
                ty, sy = float(tr[1]), float(sc[1])
                for prim in meshes[m_idx].get("primitives", []):
                    pos_acc = prim.get("attributes", {}).get("POSITION")
                    if pos_acc is None or pos_acc >= len(accs):
                        continue
                    acc = accs[pos_acc]
                    mn = acc.get("min"); mx = acc.get("max")
                    if not mn or not mx or len(mn) < 3:
                        continue
                    # World y = translation_y + scale_y * quant_y
                    wmin = ty + sy * float(mn[1])
                    wmax = ty + sy * float(mx[1])
                    if sy < 0:  # negative scale flips min/max
                        wmin, wmax = wmax, wmin
                    ymin = min(ymin, wmin)
                    ymax = max(ymax, wmax)
            if ymin == float("inf"):
                return 0.0
            return float(ymax - ymin)
        except Exception:
            return 0.0

    docs_root = REPO_ROOT / "docs_curated"
    for s in sel["samples"]:
        s["label"] = _clean_label(s["stem"], s["category"])
        s["thumb_rel"] = f"thumbnails/{s['category']}/{s['stem']}.jpg"
        s["pc_rel"] = f"assets/pc/{s['category']}/{s['stem']}.wtpc"
        if s["category"] == "object":
            s["glb_rel"] = f"assets/glb/{s['stem']}.glb"
            s["input_rel"] = f"assets/input/object/{s['stem']}.jpg"
        elif s["category"] == "scene":
            s["input_rel"] = f"assets/input/scene/{s['stem']}.jpg"
        else:
            s["input_rel"] = f"assets/input/dynamic/{s['stem']}.mp4"
        s["rrd_name"] = f"{s['stem']}__seed{s['seed']}.rrd"
        s["fov_v_deg"] = _read_fov_deg(docs_root / s["pc_rel"])
        # Mesh-size-match: TRELLIS.2 meshes are typically smaller than the
        # point cloud (handle / thin detail loss). Compute a per-sample
        # camera-distance multiplier so the textured mesh fills the same
        # panel fraction as the cloud (preserving the camera direction =
        # original capture pose).
        s["mesh_radius_scale"] = 1.0
        if s["category"] == "object":
            cy = _read_cloud_y_extent(docs_root / s["pc_rel"])
            my = _read_mesh_y_extent_mv(docs_root / s["glb_rel"])
            if cy > 1e-3 and my > 1e-3:
                ratio = my / cy
                s["mesh_radius_scale"] = round(max(0.5, min(1.0, ratio)), 4)
    return sel


def _make_release_urls(selection: dict, gh_user: str, gh_repo: str, gh_tag: str) -> None:
    for s in selection["samples"]:
        asset_name = f"{s['category']}__{s['stem']}__seed{s['seed']}.rrd"
        s["asset_name"] = asset_name
        rrd_url = (
            f"https://github.com/{gh_user}/{gh_repo}/releases/download/"
            f"{gh_tag}/{asset_name}"
        )
        s["rrd_url"] = rrd_url
        s["viewer_url"] = (
            f"https://app.rerun.io/version/{RERUN_VERSION}"
            f"?url={urllib.parse.quote(rrd_url, safe='')}"
        )


def _make_template_urls(selection: dict, template: str) -> None:
    for s in selection["samples"]:
        asset_name = f"{s['category']}__{s['stem']}__seed{s['seed']}.rrd"
        s["asset_name"] = asset_name
        rrd_url = template.format(filename=asset_name)
        s["rrd_url"] = rrd_url
        s["viewer_url"] = (
            f"https://app.rerun.io/version/{RERUN_VERSION}"
            f"?url={urllib.parse.quote(rrd_url, safe='')}"
        )


# ---------------------------------------------------------------------------
# Sync thumbnails
# ---------------------------------------------------------------------------


def _sync_thumbnails(selection: dict, out_dir: Path) -> None:
    for s in selection["samples"]:
        cat = s["category"]
        stem = s["stem"]
        dst = out_dir / "thumbnails" / cat / f"{stem}.jpg"
        src = THUMBS_SRC / cat / f"{stem}.jpg"
        if dst.exists() and (not src.exists() or dst.stat().st_mtime >= src.stat().st_mtime):
            continue
        if not src.exists():
            print(f"  [thumb-miss] {cat}/{stem}")
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)


# ---------------------------------------------------------------------------
# CSS / JS
# ---------------------------------------------------------------------------


CSS = """\
/* ===== Self-hosted Roobert (matches worldlabs.ai) ===== */
@font-face { font-family: 'Roobert'; src: url('assets/fonts/Roobert-Regular.otf') format('opentype'); font-weight: 400; font-style: normal; font-display: swap; }
@font-face { font-family: 'Roobert'; src: url('assets/fonts/Roobert-Medium.otf')  format('opentype'); font-weight: 500; font-style: normal; font-display: swap; }
@font-face { font-family: 'Roobert'; src: url('assets/fonts/Roobert-Bold.otf')    format('opentype'); font-weight: 700; font-style: normal; font-display: swap; }

:root {
  color-scheme: light;
  --bg: #ffffff;
  --bg-section: #ffffff;
  --bg-warm: #fbf9f4;
  --bg-card: #ffffff;
  --bg-card-2: #f7f6f3;
  --fg: #111111;
  --grey-100: #6b6b6b;
  --grey-200: #3d3d3d;
  --grey-300: #1f1f1f;
  --grey-dim: #9a9a9a;
  --border: rgba(0,0,0,0.08);
  --border-strong: rgba(0,0,0,0.16);
  --accent: #111111;
  --radius: 14px;
  --radius-pill: 9999px;
  --max-w: 1320px;
  --max-content: 880px;
}

* { box-sizing: border-box; }
html, body { background: var(--bg); color: var(--fg); margin: 0; padding: 0; }
body {
  font-family: 'Roobert', 'Helvetica Neue', Arial, sans-serif;
  font-size: 16px; line-height: 1.55; font-weight: 400;
  -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}

main {
  --main-gap: 88px;
  max-width: var(--max-w); margin: 0 auto; padding: 0 24px;
  display: flex; flex-direction: column; gap: var(--main-gap);
}
@media (min-width: 1024px) { main { --main-gap: 120px; padding: 0 40px; } }

a { color: var(--accent); text-decoration: none; transition: opacity .15s ease; }
a:hover { opacity: 0.78; }
hr { display: none; }
::selection { background: rgba(37,99,235,0.18); color: var(--fg); }

/* ===== Top nav bar ===== */
.nav {
  position: sticky; top: 0; z-index: 100;
  background: rgba(255,255,255,0.92);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  border-bottom: 1px solid var(--border);
}
.nav-inner {
  max-width: var(--max-w); margin: 0 auto; padding: 12px 24px;
  display: flex; align-items: center; justify-content: space-between; gap: 24px;
}
@media (min-width: 1024px) { .nav-inner { padding: 16px 40px; } }
.nav-brand { display: inline-flex; align-items: center; color: var(--fg); }
.nav-brand img.logo { height: 22px; width: auto; display: block; }
.nav-links { display: none; gap: 28px; }
@media (min-width: 768px) { .nav-links { display: inline-flex; } }
.nav-links a { color: var(--grey-200); font-size: 14px; font-weight: 500; letter-spacing: -0.005em; }
.nav-links a:hover { color: var(--fg); opacity: 1; }

/* ===== Hero ===== */
.hero {
  position: relative; padding: 48px 24px 24px;
  text-align: center; max-width: 980px; margin: 0 auto;
}
@media (min-width: 1024px) { .hero { padding: 64px 40px 28px; } }
.hero h1 {
  margin: 0 auto 16px;
  font-family: 'Gilda Display', 'Roobert', Georgia, serif;
  font-size: clamp(2.4rem, 5.8vw, 4.6rem);
  font-weight: 400; letter-spacing: -0.015em; line-height: 1.06; color: var(--fg);
  display: inline-flex; align-items: center; gap: 0.35em; flex-wrap: wrap;
  justify-content: center; text-align: center;
}
.hero h1 .birdmark { height: 0.82em; width: auto; display: inline-block; vertical-align: -0.12em; flex-shrink: 0; }
.hero h1 .accent { color: var(--grey-200); }
.hero .subtitle { margin: 0 auto 30px; font-size: clamp(1.05rem, 1.4vw, 1.2rem); color: var(--grey-100); max-width: 720px; line-height: 1.5; font-weight: 400; }
.hero .authors { font-size: 15px; color: var(--grey-200); margin: 0 auto 6px; max-width: 820px; line-height: 1.7; }
.hero .authors sup { color: var(--grey-dim); font-size: 0.75em; vertical-align: super; font-weight: 400; }
.hero .authors a {
  color: inherit;
  text-decoration: none;
  border-bottom: 1px solid transparent;
  transition: border-color 0.15s ease, color 0.15s ease;
}
.hero .authors a:hover { color: var(--fg); border-bottom-color: var(--accent); opacity: 1; }
.hero .authors a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.hero .affil { font-size: 13.5px; color: var(--grey-100); margin: 0 0 28px; line-height: 1.5; }
.hero .affil sup { color: var(--grey-dim); font-size: 0.78em; }
.hero .links { display: inline-flex; flex-wrap: wrap; gap: 10px; justify-content: center; }
.hero .links a {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 10px 18px;
  background: #ffffff; border: 1px solid var(--border); border-radius: var(--radius-pill);
  color: var(--fg); font-weight: 500; font-size: 14px; letter-spacing: -0.005em;
  transition: background .15s ease, border-color .15s ease, transform .15s ease;
  line-height: 1;
}
.hero .links a:hover { background: #f7f6f3; border-color: var(--border-strong); opacity: 1; }
.hero .links a:active { transform: scale(0.98); }
.hero .links a.primary { background: var(--fg); color: var(--bg); border-color: var(--fg); }
.hero .links a.primary:hover { background: var(--grey-300); border-color: var(--grey-300); }
.hero .links a svg { width: 14px; height: 14px; }

/* ===== Hero summary demo video =====
 * The 2.5-min summary video that opens the page. Sits between the
 * title/authors block and the first content section, full-width up to
 * 1320px (matching the teaser/results frames), with a soft rounded card
 * around the video so it doesn't feel pasted in.
 */
.hero-video { padding: 8px 24px 32px; max-width: 1320px; margin: 0 auto; }
@media (min-width: 1024px) { .hero-video { padding: 16px 32px 48px; } }
.hero-video-wrap {
  border-radius: var(--radius);
  overflow: hidden;
  background: #ffffff;
  border: 1px solid var(--border);
  box-shadow: 0 6px 28px -10px rgba(60, 50, 38, 0.10);
}
.hero-video-wrap video {
  display: block;
  width: 100%;
  height: auto;
  background: #f7f6f3;
}

/* ===== Teaser image ===== */
.teaser-img-wrap { margin: 8px auto 0; border-radius: var(--radius); overflow: hidden; background: #ffffff; padding: 16px; border: 1px solid var(--border); max-width: 1320px; }
.teaser-img-wrap--small { max-width: 1320px; padding: 12px 18px; }
@media (min-width: 1024px) { .teaser-img-wrap { padding: 20px 28px; } .teaser-img-wrap--small { padding: 16px 24px; } }
.teaser-img-wrap img { width: 100%; height: auto; display: block; }
.teaser-caption { text-align: center; font-size: 13px; color: var(--grey-100); line-height: 1.6; max-width: 760px; margin: 14px auto 0; }
.teaser-caption .orange { color: #e07b3a; font-weight: 500; }
.teaser-caption .grey   { color: #7a7a7a; font-weight: 500; }

/* ===== Highlights band (what World Tracing can do) ===== */
.highlights {
  display: flex; flex-direction: column; gap: 24px;
  align-items: center;
}
.section h2.highlights-title {
  font-family: 'Gilda Display', Georgia, serif;
  font-size: clamp(1.55rem, 2.2vw, 1.95rem); font-weight: 400;
  letter-spacing: -0.008em; line-height: 1.22; color: var(--fg);
  text-align: center; margin: 0 0 16px; max-width: 720px;
  text-wrap: balance;
}
.highlights-title .lede { display: block; }
.highlights-title em {
  font-style: italic; color: var(--grey-200);
  display: block; margin-top: 4px; font-size: 0.92em;
}
.highlights-title em::before { content: '\\2014\\00a0'; color: var(--grey-100); font-style: normal; }
@media (max-width: 720px) {
  .section h2.highlights-title { font-size: clamp(1.25rem, 5vw, 1.55rem); max-width: 92%; }
}

/* Two horizontally-banded rows, each with its own eyebrow + 3-col grid. */
.h-row {
  width: 100%;
  display: flex; flex-direction: column; gap: 10px;
  margin-top: 4px;
}
.h-row + .h-row { margin-top: 14px; }
.h-row-head {
  display: flex; align-items: baseline; gap: 14px;
  width: 100%;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}
.h-row-eyebrow {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10.5px; letter-spacing: 0.2em; text-transform: uppercase;
  color: var(--grey-100); font-weight: 500; flex-shrink: 0;
}
.h-row-label {
  font-family: 'Gilda Display', Georgia, serif;
  font-size: clamp(15px, 1.2vw, 17px);
  font-weight: 400; line-height: 1.25; letter-spacing: -0.004em;
  color: var(--fg);
}
/* On narrow viewports the eyebrow + descriptive label can't share a
   single row -- the eyebrow grabs all the width and the descriptive
   text gets squeezed into a one-word column. Stack them vertically
   instead so the descriptive text gets the full width. */
@media (max-width: 720px) {
  .h-row-head { flex-direction: column; align-items: flex-start; gap: 6px; }
  .h-row-label { font-size: 15px; line-height: 1.35; }
}
.highlights-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
  width: 100%;
  max-width: 960px;
  margin: 0 auto;
}
@media (max-width: 980px) { .highlights-grid { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 560px) { .highlights-grid { grid-template-columns: 1fr; } }

.h-card {
  position: relative; display: flex; flex-direction: column;
  background: #ffffff;
  border: 1px solid var(--border);
  border-radius: 14px;
  text-decoration: none; color: var(--fg);
  overflow: hidden;
  isolation: isolate;
  box-shadow: 0 1px 2px rgba(0,0,0,0.025);
  transition: border-color .2s ease, transform .25s ease, box-shadow .25s ease;
}
.h-card:hover {
  border-color: var(--border-strong);
  transform: translateY(-3px);
  box-shadow: 0 12px 36px rgba(0,0,0,0.07), 0 2px 6px rgba(0,0,0,0.04);
  opacity: 1;
}
.h-card .h-media {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 10;
  background: linear-gradient(160deg, #f7f6f3 0%, #efeee9 100%);
  overflow: hidden;
  border-bottom: 1px solid var(--border);
}
.h-card .h-media video,
.h-card .h-media img {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  object-fit: cover;
  object-position: center;
  display: block;
  background: #ffffff;
  transition: transform .6s ease;
}
.h-card:hover .h-media video,
.h-card:hover .h-media img { transform: scale(1.03); }
.h-card .h-media::after {
  content: '';
  position: absolute; inset: 0;
  background: linear-gradient(180deg, rgba(255,255,255,0) 60%, rgba(0,0,0,0.05) 100%);
  pointer-events: none;
}
.h-card .h-icon {
  position: absolute; top: 10px; left: 10px; z-index: 2;
  width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  background: rgba(255,255,255,0.94);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--fg);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  box-shadow: 0 1px 2px rgba(0,0,0,0.04);
}
.h-card .h-icon svg { width: 14px; height: 14px; stroke-width: 1.7; }
.h-card .h-num {
  position: absolute; top: 11px; right: 12px; z-index: 2;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 9.5px; letter-spacing: 0.12em;
  color: var(--grey-100);
  background: rgba(255,255,255,0.85);
  padding: 3px 7px; border-radius: 4px;
  border: 1px solid var(--border);
  backdrop-filter: blur(4px);
}
.h-card .h-body {
  display: flex; flex-direction: column; gap: 6px;
  padding: 12px 14px 14px;
  flex: 1;
}
.h-card .h-title {
  font-family: 'Gilda Display', Georgia, serif;
  font-size: clamp(14px, 1.05vw, 16px);
  font-weight: 400; line-height: 1.25; letter-spacing: -0.004em;
  color: var(--fg);
}
.h-card .h-blurb {
  font-size: 12px; line-height: 1.5;
  color: var(--grey-100);
  margin: 0;
}
.h-card .h-cta {
  display: inline-flex; align-items: center; gap: 6px;
  margin-top: auto;
  font-size: 12px; font-weight: 500; letter-spacing: 0.005em;
  color: var(--grey-200);
  transition: color .15s ease, transform .15s ease;
}
.h-card .h-cta svg { width: 12px; height: 12px; transition: transform .2s ease; }
.h-card:hover .h-cta { color: var(--fg); }
.h-card:hover .h-cta svg { transform: translateX(2px); }

/* ===== Section ===== */
.section { display: flex; flex-direction: column; gap: 22px; position: relative; }
.section.centered { text-align: center; align-items: center; }
.section.centered .lead { margin-left: auto; margin-right: auto; }
.section h2 { font-family: 'Gilda Display', Georgia, serif; font-size: clamp(1.8rem, 3.0vw, 2.4rem); font-weight: 400; margin: 0; letter-spacing: -0.012em; line-height: 1.15; color: var(--fg); }
.section.centered h2 { margin: 0 auto; }
.section .lead { font-size: clamp(1rem, 1.1vw, 1.08rem); color: var(--grey-200); max-width: var(--max-content); line-height: 1.65; }
.section .lead em { color: var(--fg); font-style: normal; font-weight: 500; }

/* ----- Section header chrome (eyebrow + title + accent rule) -----
   Each major section opens with this stack:
     <div class="section-head">
       <span class="section-num">04</span>
       <span class="section-eyebrow">Applications</span>
       <h2>...</h2>
       <span class="section-rule"></span>
     </div>
   Numbered eyebrow gives each chapter a quiet identifier without
   shouting; the 1-px hairline rule under the title anchors it. */
.section-head {
  display: flex; flex-direction: column;
  align-items: inherit; /* inherits from .section.centered (= center) */
  gap: 12px; margin: 0;
}
.section.centered .section-head,
.section .section-head--centered { align-items: center; text-align: center; align-self: center; }
.section-num,
.section-eyebrow {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--grey-100); font-weight: 500; line-height: 1;
}
.section-num { color: var(--grey-dim); }
.section-num + .section-eyebrow::before {
  content: '\\00b7'; margin: 0 8px; color: var(--grey-dim);
}
.section-num,
.section-eyebrow { display: inline; }
.section-head .section-meta { display: block; margin-bottom: 2px; }
.section-head h2 { margin: 0; }
.section-rule {
  display: inline-block; width: 32px; height: 1px;
  background: var(--accent); opacity: 0.55; margin-top: 4px;
}

/* ----- Tonal alternation (warm wash for every other section) -----
   The wash extends edge-to-edge of the viewport while the inner
   content stays inside the .section's normal max-width. We use the
   `100vw - 100%` margin trick so it works without changing the
   document outline or breaking horizontal scrolling. */
.section.washed {
  background: var(--bg-warm);
  margin-left: calc((100% - 100vw) / 2);
  margin-right: calc((100% - 100vw) / 2);
  padding-left: max(24px, calc((100vw - 100%) / 2 + 24px));
  padding-right: max(24px, calc((100vw - 100%) / 2 + 24px));
  padding-top: 80px;
  padding-bottom: 80px;
}
@media (min-width: 1024px) {
  .section.washed { padding-top: 96px; padding-bottom: 96px; }
}
/* When two adjacent sections are both washed, drop the gap so the
   wash reads as one continuous band. (Currently we never schedule
   two adjacent washes, but this keeps the rule resilient if reorder.) */
.section.washed + .section.washed { margin-top: calc(-1 * var(--main-gap, 88px)); }

/* ===== Category tabs ===== */
.cat-tabs-wrap { display: flex; justify-content: center; margin-bottom: 4px; }
.cat-tabs { display: inline-flex; gap: 0; background: #f7f6f3; border: 1px solid var(--border); border-radius: var(--radius-pill); padding: 4px; }
.cat-tabs button { background: transparent; color: var(--grey-200); border: 0; border-radius: var(--radius-pill); padding: 6px 16px; font-size: 12.5px; font-weight: 500; cursor: pointer; font-family: inherit; transition: background .15s ease, color .15s ease; letter-spacing: -0.005em; }
.cat-tabs button:hover { color: var(--fg); }
.cat-tabs button.active { color: var(--bg); background: var(--fg); }

/* ===== Interactive demo stage ===== */
.demo-stage {
  display: grid;
  gap: 14px;
  width: 100%;
  align-items: stretch;
}
.demo-stage.three { grid-template-columns: 1fr 1fr 1fr; }
/* `.two` (scene + dynamic) uses a 6-track grid so each panel ends up the
 * SAME WIDTH as a panel in the object layout (~1/3 of the stage). The
 * two panels are CENTRED by occupying tracks 2-3 and 4-5, with one
 * empty fr-track on each side acting as outer margin. Keeps panel size
 * visually consistent across tabs. */
.demo-stage.two   { grid-template-columns: repeat(6, 1fr); }
.demo-stage.two > .panel:nth-child(1) { grid-column: 2 / span 2; }
.demo-stage.two > .panel:nth-child(2) { grid-column: 4 / span 2; }

@media (max-width: 980px) {
  .demo-stage.three { grid-template-columns: 1fr 1fr; }
  .demo-stage.three .panel-mesh { grid-column: 1 / -1; }
  .demo-stage.two { grid-template-columns: 1fr 1fr; }
  .demo-stage.two > .panel:nth-child(1),
  .demo-stage.two > .panel:nth-child(2) { grid-column: auto; }
}
@media (max-width: 680px) {
  .demo-stage.three, .demo-stage.two { grid-template-columns: 1fr; }
}

.panel {
  display: flex; flex-direction: column;
  background: #ffffff;
  border: 1px solid var(--border); border-radius: var(--radius);
  overflow: hidden;
  min-height: 340px;
  position: relative;
}
.panel .panel-label {
  position: absolute; top: 10px; left: 12px; z-index: 5;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--grey-100); padding: 3px 8px;
  background: rgba(255,255,255,0.85); backdrop-filter: blur(6px);
  border-radius: 4px; border: 1px solid var(--border);
  pointer-events: none;
}
.panel .panel-content {
  flex: 1; position: relative; min-height: 0;
  display: flex; align-items: center; justify-content: center;
  background: #ffffff;
}
.panel .panel-content img,
.panel .panel-content video {
  max-width: 100%; max-height: 100%; width: 100%; height: 100%;
  object-fit: contain;
  display: block;
}
.panel .panel-content canvas {
  display: block;
  width: 100% !important;
  height: 100% !important;
}
.panel .panel-content model-viewer {
  width: 100%; height: 100%;
  background: #ffffff;
  --progress-bar-color: var(--fg);
}
.panel .panel-actions {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  background: #fafafa;
  font-size: 11.5px; color: var(--grey-100);
}
.panel .panel-actions .hint {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10px; letter-spacing: 0.03em;
  color: var(--grey-dim);
}
.panel .open-rerun {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 8px; border-radius: var(--radius-pill);
  background: var(--bg); border: 1px solid var(--border);
  color: var(--grey-200); font-size: 10.5px; font-weight: 500;
  text-decoration: none;
  transition: background .15s ease, color .15s ease, border-color .15s ease;
  letter-spacing: 0.005em;
}
.panel .open-rerun svg { width: 11px; height: 11px; }
.panel .open-rerun:hover { background: var(--fg); color: var(--bg); border-color: var(--fg); opacity: 1; }
.panel .pc-status {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  font-size: 12px; color: var(--grey-dim); pointer-events: none;
  letter-spacing: 0.02em;
}

/* ===== Stage header (label of current sample) ===== */
.stage-header {
  display: flex; justify-content: center; align-items: center; gap: 16px;
  font-family: 'Gilda Display', Georgia, serif;
  font-size: 20px; color: var(--fg);
  margin-bottom: 4px;
}
.stage-header .stem {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px; color: var(--grey-100); letter-spacing: 0.02em;
}

/* ===== Thumbnail strip below stage ===== */
.thumb-strip-wrap { position: relative; }
.thumb-strip {
  display: flex; gap: 10px; overflow-x: auto;
  scroll-snap-type: x mandatory; padding: 4px 2px 10px;
  scrollbar-width: thin; scrollbar-color: var(--grey-dim) transparent;
}
.thumb-strip::-webkit-scrollbar { height: 6px; }
.thumb-strip::-webkit-scrollbar-track { background: transparent; }
.thumb-strip::-webkit-scrollbar-thumb { background: var(--grey-dim); border-radius: 4px; }
.thumb-strip::-webkit-scrollbar-thumb:hover { background: var(--grey-100); }

.thumb-btn {
  flex: 0 0 auto;
  width: 88px; height: 88px;
  background: #ffffff;
  border: 1.5px solid var(--border);
  border-radius: 10px;
  padding: 0;
  cursor: pointer;
  overflow: hidden;
  position: relative;
  transition: border-color .12s ease, transform .12s ease;
  scroll-snap-align: start;
}
.thumb-btn:hover { border-color: var(--border-strong); transform: translateY(-1px); }
.thumb-btn.active {
  border-color: var(--fg);
  border-width: 2px;
}
.thumb-btn img, .thumb-btn video {
  width: 100%; height: 100%;
  object-fit: contain;
  background: #ffffff;
  display: block;
}

.strip-btn {
  position: absolute; top: 50%; transform: translateY(-50%);
  width: 30px; height: 30px; border-radius: 50%;
  background: var(--bg); border: 1px solid var(--border-strong);
  color: var(--fg); cursor: pointer; z-index: 5;
  display: flex; align-items: center; justify-content: center;
  font-size: 14px; font-weight: 500; box-shadow: 0 2px 8px rgba(0,0,0,0.06);
  font-family: inherit; padding: 0;
}
.strip-btn.prev { left: -8px; }
.strip-btn.next { right: -8px; }
.strip-btn:hover { background: var(--bg-section); transform: translateY(-50%) scale(1.06); }
.strip-btn:disabled { opacity: 0.3; cursor: not-allowed; }
@media (max-width: 720px) { .strip-btn { display: none; } }

/* ===== Demo video ===== */
.demo-video { background: var(--bg-section); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; position: relative; aspect-ratio: 16 / 9; width: 100%; }
.demo-video video { width: 100%; height: 100%; display: block; object-fit: cover; }
.demo-video .placeholder { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--grey-100); text-align: center; background: var(--bg-section); }
.demo-video .placeholder .icon { width: 60px; height: 60px; border-radius: 50%; border: 1px solid var(--border-strong); background: var(--bg); display: flex; align-items: center; justify-content: center; margin-bottom: 18px; }
.demo-video .placeholder .icon::after { content: ''; width: 0; height: 0; border-style: solid; border-width: 9px 0 9px 16px; border-color: transparent transparent transparent var(--fg); margin-left: 4px; }
.demo-video .placeholder p { margin: 4px 0; font-family: 'Gilda Display', Georgia, serif; font-size: 22px; color: var(--fg); letter-spacing: -0.015em; }
.demo-video .placeholder .note { font-size: 12.5px; color: var(--grey-100); letter-spacing: 0.01em; }

/* Demo video stage (1:1 square, white background, swappable via thumbs) */
.demo-video-stage {
  position: relative;
  width: 100%;
  max-width: 480px;
  margin: 0 auto;
  aspect-ratio: 1 / 1;
  background: #ffffff;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  box-shadow: 0 1px 6px rgba(0,0,0,0.04);
}
.demo-video-stage video {
  width: 100%; height: 100%;
  display: block;
  object-fit: contain;
  background: #ffffff;
}
.demo-video-label {
  position: absolute;
  left: 14px; bottom: 14px;
  padding: 6px 12px;
  background: rgba(255,255,255,0.92);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 12px;
  letter-spacing: 0.02em;
  color: var(--grey-200);
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  pointer-events: none;
  backdrop-filter: blur(4px);
}

/* ===== Hover-to-play overlay (big demo videos) ===== */
.hover-play { cursor: pointer; }
.hover-play-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  background: rgba(255, 255, 255, 0.55);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  transition: opacity 220ms ease;
  pointer-events: none;
  z-index: 2;
}
.hover-play.is-playing .hover-play-overlay { opacity: 0; }
.hover-play-icon {
  width: 64px; height: 64px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.96);
  border: 1px solid var(--border-strong);
  box-shadow: 0 6px 18px rgba(20, 24, 32, 0.12);
  display: flex; align-items: center; justify-content: center;
  position: relative;
  transition: transform 180ms ease, box-shadow 180ms ease;
}
.hover-play:hover .hover-play-icon {
  transform: scale(1.06);
  box-shadow: 0 8px 22px rgba(20, 24, 32, 0.18);
}
.hover-play-icon::after {
  content: '';
  width: 0; height: 0;
  border-style: solid;
  border-width: 11px 0 11px 18px;
  border-color: transparent transparent transparent var(--fg);
  margin-left: 4px;
}
.hover-play-label {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--grey-200);
  background: rgba(255, 255, 255, 0.85);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 5px 12px;
}
.demo-thumb-strip-wrap { max-width: 720px; margin: 18px auto 0; }
.demo-thumb-strip-wrap .thumb-btn {
  width: 72px; height: 72px;
  border-radius: 8px;
}

/* ===== Citation ===== */
.cite-wrap {
  position: relative;
  width: 100%;
  max-width: var(--max-content);
  margin: 0;
}
pre.cite {
  background: var(--bg-section);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 22px 26px;
  padding-right: 110px;
  overflow-x: auto;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--grey-200);
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  margin: 0;
  text-align: left;
}
.cite-copy {
  position: absolute;
  top: 10px;
  right: 12px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 10.5px;
  font-family: 'Roobert', sans-serif;
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--grey-100);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 999px;
  cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
  -webkit-appearance: none;
  appearance: none;
}
.cite-copy:hover { color: var(--fg); border-color: var(--accent); }
.cite-copy:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.cite-copy.copied { color: var(--fg); border-color: var(--accent); }
.cite-copy .ico {
  width: 12px; height: 12px;
  stroke: currentColor; stroke-width: 1.6;
  fill: none; stroke-linecap: round; stroke-linejoin: round;
}

/* ===== Footer ===== */
footer { margin: 0; padding: 32px 24px 48px; max-width: var(--max-w); margin: 0 auto; color: var(--grey-100); text-align: center; font-size: 13px; letter-spacing: 0.01em; border-top: 1px solid var(--border); }
@media (min-width: 1024px) { footer { padding: 36px 40px 56px; } }
footer a { color: var(--grey-200); }
footer a:hover { color: var(--fg); opacity: 1; }

@media (max-width: 720px) {
  .hero { padding: 36px 0 16px; }
  .hero h1 { font-size: 2.2rem; }
  main { gap: 72px; }
  .panel { min-height: 260px; }
}
"""


# JavaScript: Three.js point cloud viewer + thumbnail strip + tab logic.
# Loaded as an ES module so we can `import` three.js from a CDN.
JS_MODULE = r"""
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
      v.src = sample.input_rel;
      v.load();
      v.play().catch(() => {});
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
      // Lazily play the thumbnail video to save bandwidth.
      const v = btn.querySelector('video');
      btn.addEventListener('mouseenter', () => { v.play().catch(()=>{}); });
      btn.addEventListener('mouseleave', () => { v.pause(); v.currentTime = 0; });
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
      video.src = v.mp4;
      try { video.load(); } catch (e) {}
      const stage = video.closest('.hover-play');
      if (stage && stage.classList.contains('is-playing')) {
        video.play().catch(() => {});
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
    v.setAttribute('src', got.mp4);
    try { v.load(); } catch (e) {}
  });

  // Row-1 tiles are deep-links into the Interactive examples section;
  // wire their click to also switch the category tabs to the matching
  // bucket (object / scene / dynamic) so the user lands on the right
  // tab right away.
  document.querySelectorAll('.h-card[data-cat]').forEach(card => {
    const cat = card.dataset.cat;
    if (!cat) return;
    card.addEventListener('click', () => {
      try { setCategory(cat); } catch (e) {}
    });
  });

  // Auto-play tile videos when they scroll into view to keep the band
  // feeling alive without paying the bandwidth cost up-front. Pause
  // out-of-view tiles to avoid 4 mp4s decoding in parallel.
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        const v = e.target;
        if (e.isIntersecting) {
          v.play().catch(() => {});
        } else {
          v.pause();
        }
      });
    }, { threshold: 0.35 });
    document.querySelectorAll('.h-card video.h-preview').forEach(v => io.observe(v));
  } else {
    document.querySelectorAll('.h-card video.h-preview').forEach(v => {
      v.play().catch(() => {});
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
      v.setAttribute('src', url);
      try { v.load(); v.play().catch(() => {}); } catch (e) {}
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
  document.querySelectorAll('.hover-play').forEach(stage => {
    const targetId = stage.dataset.hoverTarget;
    const v = targetId
      ? document.getElementById(targetId)
      : stage.querySelector('video[data-play-on-hover]');
    if (!v) return;

    function ensureSrc() {
      if (v.getAttribute('src')) return;
      const url = v.dataset.src || v.dataset.lazySrc;
      if (!url) return;
      v.setAttribute('src', url);
      try { v.load(); } catch (e) {}
    }

    function start() {
      ensureSrc();
      stage.classList.add('is-playing');
      v.play().catch(() => {});
    }

    // Mouse + keyboard users: first hover or focus latches the video on.
    stage.addEventListener('mouseenter', start, { once: false });
    stage.addEventListener('focusin', start, { once: false });

    // Touch devices: tap to toggle (no hover state). After the first tap
    // we keep the play/pause control so the user can stop a clip if they
    // want.
    stage.addEventListener('touchstart', () => {
      if (v.paused) {
        start();
      } else {
        stage.classList.remove('is-playing');
        try { v.pause(); } catch (e) {}
      }
    }, { passive: true });

    // Click on the overlay after a mouse-only interaction also kicks it
    // off (in case `mouseenter` was missed because the user moved
    // straight from outside the page).
    stage.addEventListener('click', () => {
      if (v.paused) start();
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
"""


def _load_section_videos() -> dict:
    """Load presigned URLs for the standalone demo-section videos
    (`3D scene editing` and `Geometry-guided novel-view video`). The
    manifest is written by ``_upload_curated_page_s3.sh`` after it
    copies the source mp4s into the curated-page S3 prefix.

    Returns a dict mapping video-id (matches the `<video>` id in the
    HTML) to a fresh 7-day presigned URL.
    """
    manifest_path = REPO_ROOT / "_section_videos.json"
    if not manifest_path.exists():
        return {}
    try:
        return json.loads(manifest_path.read_text())
    except Exception:
        return {}


def _load_highlight_videos() -> dict:
    """Load presigned URLs for the homepage Highlights-band cycle clips.

    Tile ids match the ``data-preview`` attribute on each ``.h-card``:

    * ``step1-object``  → ``highlights_step1_object.mp4``
    * ``step1-scene``   → ``highlights_step1_scene.mp4``
    * ``step1-dynamic`` → ``highlights_step1_dynamic.mp4``
    * ``textured-mesh`` → ``highlights_mesh.mp4``

    The manifest is written by ``_upload_highlight_cycles.sh``.
    """
    manifest_path = REPO_ROOT / "_highlight_videos.json"
    if not manifest_path.exists():
        return {}
    try:
        return json.loads(manifest_path.read_text())
    except Exception:
        return {}


def _load_demo_videos(selection: dict) -> list[dict]:
    """Load the demo-video manifest (mp4 + thumb URLs, 7-day presigned) and
    join it against the curated samples so the order matches the strip in
    the rest of the page.
    """
    manifest_path = REPO_ROOT / "_demo_videos.json"
    if not manifest_path.exists():
        return []
    try:
        manifest = json.loads(manifest_path.read_text())
    except Exception:
        return []
    out = []
    for s in selection["samples"]:
        stem = s["stem"]
        entry = manifest.get(stem)
        if not entry or "mp4" not in entry:
            continue
        out.append({
            "stem": stem,
            "label": s["label"],
            "mp4": entry["mp4"],
            "thumb": entry.get("thumb", ""),
        })
    return out


def _build_data_js(selection: dict) -> str:
    samples = []
    for s in selection["samples"]:
        samples.append({
            "stem": s["stem"],
            "label": s["label"],
            "category": s["category"],
            "seed": s["seed"],
            "thumb_rel": s["thumb_rel"],
            "input_rel": s["input_rel"],
            "pc_rel": s["pc_rel"],
            "glb_rel": s.get("glb_rel", ""),
            "viewer_url": s.get("viewer_url", "#"),
            "rrd_url": s.get("rrd_url", "#"),
            "asset_name": s.get("asset_name", ""),
            "fov_v_deg": round(float(s.get("fov_v_deg", 0.0)), 3),
            "mesh_radius_scale": round(float(s.get("mesh_radius_scale", 1.0)), 4),
        })
    demo_videos = _load_demo_videos(selection)
    section_videos = _load_section_videos()
    highlight_videos = _load_highlight_videos()
    return (
        "// auto-generated by _build_curated_page.py\n"
        f"window.SAMPLES = {json.dumps(samples, indent=2)};\n"
        f"window.DEMO_VIDEOS = {json.dumps(demo_videos, indent=2)};\n"
        f"window.SECTION_VIDEOS = {json.dumps(section_videos, indent=2)};\n"
        f"window.HIGHLIGHT_VIDEOS = {json.dumps(highlight_videos, indent=2)};\n"
    )


# ---------------------------------------------------------------------------
# Asset inlining helpers (for standalone.html)
# ---------------------------------------------------------------------------


def _inline_fonts_and_images(css: str, html: str, out_dir: Path) -> tuple[str, str]:
    """Embed fonts + small images as base64 data: URIs."""
    assets_dir = out_dir / "assets"

    font_files = {
        "Roobert-Regular.otf": "font/otf",
        "Roobert-Medium.otf":  "font/otf",
        "Roobert-Bold.otf":    "font/otf",
    }
    for fname, mime in font_files.items():
        p = assets_dir / "fonts" / fname
        if p.exists():
            b64 = base64.b64encode(p.read_bytes()).decode()
            css = css.replace(f"assets/fonts/{fname}", f"data:{mime};base64,{b64}")

    image_files = {
        "worldlabs_logo.png": "image/png",
        "worldlabs_birdmark.png": "image/png",
        "teaser.png": "image/png",
    }
    for fname, mime in image_files.items():
        p = assets_dir / fname
        if p.exists():
            b64 = base64.b64encode(p.read_bytes()).decode()
            html = html.replace(f"assets/{fname}", f"data:{mime};base64,{b64}")

    return css, html


# ---------------------------------------------------------------------------
# HTML builder
# ---------------------------------------------------------------------------


HEAD_SCRIPTS = """\
<!-- model-viewer needs to know where to fetch the meshopt decoder *before*
     it tries to load any GLB that uses EXT_meshopt_compression. -->
<script>
  self.ModelViewerElement = self.ModelViewerElement || {};
  self.ModelViewerElement.meshoptDecoderLocation = 'https://cdn.jsdelivr.net/npm/meshoptimizer@0.21.0/meshopt_decoder.js';
</script>
<script type="module" src="https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/es-module-shims@1.10.0/dist/es-module-shims.js" crossorigin="anonymous"></script>
<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
  }
}
</script>
"""


def _build_html(*, link_inline_assets: bool, css: str, js_module: str, data_js: str,
                selection: dict, out_dir: Path | None = None) -> str:
    links_html = " ".join(
        (
            f'<a href="{l["href"]}" '
            f'class="{"primary" if l.get("primary") else ""}" '
            f'{"target=_blank rel=noopener" if l["href"].startswith("http") else ""}>'
            f'{l["label"]} {ARROW_SVG}'
            f'</a>'
        )
        for l in LINKS
    )

    css_for_head = css
    if link_inline_assets and out_dir is not None:
        css_for_head, _ = _inline_fonts_and_images(css, "", out_dir)

    if link_inline_assets:
        head_assets = (
            f"<style>{css_for_head}</style>\n"
            f"<script>{data_js}</script>\n"
            f"<script type='module'>{js_module}</script>"
        )
    else:
        head_assets = (
            '<link rel="stylesheet" href="style.css">\n'
            '<script src="data.js"></script>\n'
            '<script type="module" src="app.js"></script>'
        )

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{TITLE} &mdash; {SUBTITLE}</title>
  <meta name="description" content="{SUBTITLE}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Gilda+Display&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  {HEAD_SCRIPTS}
  {head_assets}
</head>
<body>

<section class="hero">
  <h1>
    <img class="birdmark" src="assets/worldlabs_birdmark.png" alt="">
    <span>{TITLE_LINE_1}</span>
  </h1>
  <p class="subtitle">{SUBTITLE}</p>
  <p class="authors">{AUTHORS_HTML}</p>
  <p class="affil">{AFFILIATIONS_HTML}</p>
  <div class="links">{links_html}</div>
</section>

<!-- Hero summary demo video. Autoplays muted+looped, with native controls
     so the viewer can scrub the timeline and pause when something
     interesting flies by. Source mp4 lives on S3, URL is presigned at
     deploy time (see `_upload_curated_page_s3.sh`). -->
<section class="hero-video">
  <div class="hero-video-wrap">
    <video id="hero-demo-video"
           autoplay muted loop playsinline preload="metadata"
           controls controlslist="nodownload noplaybackrate"
           disablepictureinpicture disableremoteplayback
           poster="">
      <source src="" type="video/mp4">
    </video>
  </div>
</section>

<main>

<!-- =========== "What World Tracing can do" highlights band =========== -->
<section class="section centered" id="highlights">
  <div class="section-head">
    <span class="section-meta"><span class="section-num">01</span><span class="section-eyebrow">What World Tracing can do</span></span>
    <h2 class="highlights-title">
      <span class="lede">A single image becomes a layered 3D world.</span>
      <em>Across objects, scenes, and dynamic content.</em>
    </h2>
    <span class="section-rule"></span>
  </div>

  <!-- Row 1 — Pixel-aligned multilayer geometry across object / scene / dynamic. -->
  <div class="h-row">
    <div class="h-row-head">
      <span class="h-row-eyebrow">Pixel-aligned multilayer geometry</span>
      <span class="h-row-label">An ordered stack of 3D points per pixel &mdash; visible surfaces and the geometry hidden behind them.</span>
    </div>
    <div class="highlights-grid">
      <a class="h-card" href="#results" data-cat="object" data-preview="step1-object">
        <div class="h-media">
          <span class="h-icon" data-icon="layers"></span>
          <span class="h-num">01</span>
          <video class="h-preview" muted loop playsinline preload="metadata" disableremoteplayback></video>
        </div>
        <div class="h-body">
          <h3 class="h-title">Object</h3>
          <p class="h-blurb">From a single object photo, we predict every layer of geometry the object occupies in front of and behind the visible surface.</p>
          <span class="h-cta">See examples {ARROW_SVG}</span>
        </div>
      </a>
      <a class="h-card" href="#results" data-cat="scene" data-preview="step1-scene">
        <div class="h-media">
          <span class="h-icon" data-icon="grid"></span>
          <span class="h-num">02</span>
          <video class="h-preview" muted loop playsinline preload="metadata" disableremoteplayback></video>
        </div>
        <div class="h-body">
          <h3 class="h-title">Scene</h3>
          <p class="h-blurb">The same predictor scales to full indoor and outdoor scenes &mdash; multi-room interiors, facades, and gardens get a layered point cloud per pixel.</p>
          <span class="h-cta">See examples {ARROW_SVG}</span>
        </div>
      </a>
      <a class="h-card" href="#results" data-cat="dynamic" data-preview="step1-dynamic">
        <div class="h-media">
          <span class="h-icon" data-icon="play"></span>
          <span class="h-num">03</span>
          <video class="h-preview" muted loop playsinline preload="metadata" disableremoteplayback></video>
        </div>
        <div class="h-body">
          <h3 class="h-title">Dynamic</h3>
          <p class="h-blurb">For short video clips we predict per-frame layered point clouds that stay 3D-consistent as the subject moves.</p>
          <span class="h-cta">See examples {ARROW_SVG}</span>
        </div>
      </a>
    </div>
  </div>

  <!-- Row 2 — Downstream applications enabled by the layered geometry. -->
  <div class="h-row">
    <div class="h-row-head">
      <span class="h-row-eyebrow">Applications enabled by World Tracing</span>
      <span class="h-row-label">The layered geometry plugs into existing 3D and video models &mdash; no retraining needed.</span>
    </div>
    <div class="highlights-grid">
      <a class="h-card" href="#results" data-cat="object" data-preview="textured-mesh">
        <div class="h-media">
          <span class="h-icon" data-icon="box"></span>
          <span class="h-num">04</span>
          <video class="h-preview" muted loop playsinline preload="metadata" disableremoteplayback></video>
        </div>
        <div class="h-body">
          <h3 class="h-title">Training-free textured mesh</h3>
          <p class="h-blurb">Lift our layered point cloud into a textured mesh by plugging it into off-the-shelf mesh generators &mdash; no fine-tuning needed.</p>
          <span class="h-cta">See examples {ARROW_SVG}</span>
        </div>
      </a>
      <a class="h-card" href="#demo-3d-editing" data-preview="scene-editing">
        <div class="h-media">
          <span class="h-icon" data-icon="wand"></span>
          <span class="h-num">05</span>
          <video class="h-preview" muted loop playsinline preload="metadata" disableremoteplayback></video>
        </div>
        <div class="h-body">
          <h3 class="h-title">3D scene editing</h3>
          <p class="h-blurb">Add, replace or remove objects in a scene &mdash; the layered geometry keeps every edit consistent across novel views.</p>
          <span class="h-cta">See examples {ARROW_SVG}</span>
        </div>
      </a>
      <a class="h-card" href="#demo-novel-view-video" data-preview="novel-view">
        <div class="h-media">
          <span class="h-icon" data-icon="film"></span>
          <span class="h-num">06</span>
          <video class="h-preview" muted loop playsinline preload="metadata" disableremoteplayback></video>
        </div>
        <div class="h-body">
          <h3 class="h-title">Geometry-guided video</h3>
          <p class="h-blurb">Pair our predicted geometry with a video diffusion model to render temporally-consistent fly-throughs that obey 3D structure.</p>
          <span class="h-cta">See examples {ARROW_SVG}</span>
        </div>
      </a>
    </div>
  </div>
</section>

<section class="section centered washed" id="abstract">
  <div class="section-head">
    <span class="section-meta"><span class="section-num">02</span><span class="section-eyebrow">The paper in one paragraph</span></span>
    <h2>Abstract</h2>
    <span class="section-rule"></span>
  </div>
  <p class="lead">{ABSTRACT_HTML}</p>
</section>

<!-- =========== Interactive examples =========== -->
<section class="section" id="results">
  <div class="section-head section-head--centered">
    <span class="section-meta"><span class="section-num">03</span><span class="section-eyebrow">Explore the results</span></span>
    <h2>Interactive examples</h2>
    <span class="section-rule"></span>
  </div>

  <div class="cat-tabs-wrap">
    <div class="cat-tabs">
      <button data-cat="object" class="active">Objects</button>
      <button data-cat="scene">Scenes</button>
      <button data-cat="dynamic">Dynamic</button>
    </div>
  </div>

  <div class="stage-header" id="stage-header"></div>
  <div class="demo-stage three" id="demo-stage"></div>

  <div class="thumb-strip-wrap">
    <button class="strip-btn prev" aria-label="scroll left">&larr;</button>
    <div class="thumb-strip" id="thumb-strip"></div>
    <button class="strip-btn next" aria-label="scroll right">&rarr;</button>
  </div>

  <p class="lead" style="text-align:center;align-self:center;margin-top:8px;">
    World Tracing produces <em>pixel-aligned layered geometry</em> from a single
    image or a monocular video. For each object we additionally lift our point
    cloud into a training-free textured mesh. Click any thumbnail to load a
    different example; click the <em>Rerun</em> button below each viewer to
    open the full layered recording.
  </p>
</section>

<section class="section centered washed" id="demo-textured-mesh">
  <div class="section-head">
    <span class="section-meta"><span class="section-num">04</span><span class="section-eyebrow">Applications</span></span>
    <h2>Training-free textured-mesh generation</h2>
    <span class="section-rule"></span>
  </div>
  <p class="lead" style="max-width:760px;margin:0 auto 20px;">
    For each example we lift our layered point cloud into a textured mesh
    without any fine-tuning. The video below walks through the full pipeline:
    <em>input image &rarr; first depth layer &rarr; all layers &rarr; textured mesh</em>.
    Click any thumbnail to swap the object.
  </p>
  <div class="demo-video-stage hover-play" id="mesh-demo-stage" data-hover-target="mesh-demo-video">
    <video id="mesh-demo-video" loop muted playsinline preload="none" data-play-on-hover></video>
    <div class="hover-play-overlay" aria-hidden="true">
      <span class="hover-play-icon"></span>
      <span class="hover-play-label">Hover to play</span>
    </div>
    <div class="demo-video-label" id="mesh-demo-label"></div>
  </div>
  <div class="thumb-strip-wrap demo-thumb-strip-wrap">
    <button class="strip-btn prev" id="mesh-demo-prev" aria-label="scroll left">&larr;</button>
    <div class="thumb-strip" id="mesh-demo-strip"></div>
    <button class="strip-btn next" id="mesh-demo-next" aria-label="scroll right">&rarr;</button>
  </div>
</section>

<section class="section centered" id="demo-3d-editing">
  <div class="section-head">
    <span class="section-meta"><span class="section-num">05</span><span class="section-eyebrow">Applications</span></span>
    <h2>3D scene editing</h2>
    <span class="section-rule"></span>
  </div>
  <p class="lead" style="max-width:760px;margin:0 auto 20px;">
    Our layered geometry treats every object as a fully-realised 3D
    asset. We can insert, replace, or remove objects in a scene point
    cloud and the edit propagates consistently through novel views.
  </p>
  <div class="demo-video hover-play" data-hover-target="demo-3d-editing-video">
    <video id="demo-3d-editing-video" loop muted playsinline preload="none" data-play-on-hover></video>
    <div class="hover-play-overlay" aria-hidden="true">
      <span class="hover-play-icon"></span>
      <span class="hover-play-label">Hover to play</span>
    </div>
  </div>
</section>

<section class="section centered washed" id="demo-novel-view-video">
  <div class="section-head">
    <span class="section-meta"><span class="section-num">06</span><span class="section-eyebrow">Applications</span></span>
    <h2>Geometry-guided novel-view video</h2>
    <span class="section-rule"></span>
  </div>
  <p class="lead" style="max-width:760px;margin:0 auto 20px;">
    Pair our predicted geometry with a video diffusion model
    (Wan2.2 VACE) and produce temporally-consistent novel-view
    flythrough videos that obey the underlying 3D structure.
  </p>
  <div class="demo-video hover-play" data-hover-target="demo-novel-view-video-video">
    <video id="demo-novel-view-video-video" loop muted playsinline preload="none" data-play-on-hover></video>
    <div class="hover-play-overlay" aria-hidden="true">
      <span class="hover-play-icon"></span>
      <span class="hover-play-label">Hover to play</span>
    </div>
  </div>
</section>

<section class="section compact centered" id="bibtex">
  <div class="section-head">
    <span class="section-meta"><span class="section-num">07</span><span class="section-eyebrow">Cite this work</span></span>
    <h2>BibTeX</h2>
    <span class="section-rule"></span>
  </div>
  <div class="cite-wrap">
    <button type="button" class="cite-copy" data-target="cite-bibtex" aria-label="Copy BibTeX to clipboard">
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V6a2 2 0 0 1 2-2h9"></path></svg>
      <span class="cite-copy-label">copy</span>
    </button>
    <pre class="cite" id="cite-bibtex">{CITATION_BIB}</pre>
  </div>
</section>

<section class="section centered" id="ack">
  <div class="section-head">
    <span class="section-meta"><span class="section-num">08</span><span class="section-eyebrow">Thanks</span></span>
    <h2>Acknowledgements</h2>
    <span class="section-rule"></span>
  </div>
  <p class="lead">{ACKNOWLEDGEMENTS_HTML}</p>
</section>

</main>

<footer>
  &copy; 2026 World Labs &middot;
  Powered by <a href="https://threejs.org" target="_blank" rel="noopener">Three.js</a>,
  <a href="https://modelviewer.dev" target="_blank" rel="noopener">model-viewer</a>,
  and <a href="https://rerun.io" target="_blank" rel="noopener">Rerun {RERUN_VERSION}</a>
</footer>

</body>
</html>
"""


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--selection", type=Path, default=SELECTION)
    p.add_argument("--out-dir", type=Path, default=DOCS_DIR)
    p.add_argument("--gh-user", default="haoz19")
    p.add_argument("--gh-repo", default="wt-multilayer-depth-demo")
    p.add_argument("--gh-tag", default="v1")
    p.add_argument(
        "--url-template", default=None,
        help="If given, use this template (with {filename}) instead of building a GitHub release URL."
    )
    p.add_argument(
        "--standalone-only", action="store_true",
        help="Only emit a single self-contained standalone.html (no docs/ dir)"
    )
    args = p.parse_args()

    selection = _load_selection()
    print(f"loaded selection: {len(selection['samples'])} samples")

    if args.url_template:
        print(f"using URL template: {args.url_template}")
        _make_template_urls(selection, args.url_template)
    else:
        print(f"using GitHub Release URLs: github.com/{args.gh_user}/{args.gh_repo}/releases/{args.gh_tag}")
        _make_release_urls(selection, args.gh_user, args.gh_repo, args.gh_tag)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    _sync_thumbnails(selection, args.out_dir)
    data_js = _build_data_js(selection)

    if not args.standalone_only:
        (args.out_dir / "style.css").write_text(CSS)
        (args.out_dir / "app.js").write_text(JS_MODULE)
        (args.out_dir / "data.js").write_text(data_js)
        (args.out_dir / "index.html").write_text(
            _build_html(link_inline_assets=False, css=CSS, js_module=JS_MODULE, data_js=data_js, selection=selection)
        )

    standalone = _build_html(
        link_inline_assets=True, css=CSS, js_module=JS_MODULE, data_js=data_js,
        selection=selection, out_dir=args.out_dir,
    )
    _, standalone = _inline_fonts_and_images(CSS, standalone, args.out_dir)
    (args.out_dir / "standalone.html").write_text(standalone)
    sz_kb = (args.out_dir / "standalone.html").stat().st_size / 1024
    print(f"wrote {args.out_dir}/standalone.html ({sz_kb:.1f} KB)")
    print(f"wrote {args.out_dir}/index.html + assets")

    # Asset upload manifest (used by the github-release uploader)
    manifest = []
    for s in selection["samples"]:
        rrd = RRD_LOCAL / s["category"] / s["rrd_name"]
        manifest.append({
            "asset_name": s.get("asset_name", ""),
            "local_path": str(rrd),
            "exists": rrd.exists(),
            "size_mb": round(rrd.stat().st_size / 1024 / 1024, 2) if rrd.exists() else None,
        })
    (args.out_dir / "_release_manifest.json").write_text(json.dumps(manifest, indent=2))
    missing = [m for m in manifest if not m["exists"]]
    if missing:
        print(f"  WARN: {len(missing)} rrd missing locally:")
        for m in missing[:5]:
            print(f"    - {m['local_path']}")
    else:
        total = sum(m["size_mb"] for m in manifest)
        print(f"  all {len(manifest)} rrd present locally ({total:.1f} MB total)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
