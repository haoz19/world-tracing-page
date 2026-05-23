"""Build ``docs_curated/_release_override.js`` so the demo page resolves
all binary assets from GitHub Release permanent URLs (not S3 presigned
URLs that expire every 7 days).

The page already loads ``_s3_override.js`` at runtime (it overrides the
fields baked into ``data.js`` so URLs are refreshable without a full
page rebuild).  This script writes the equivalent override file in the
same format, but with stable GH Release URLs:

    https://github.com/<user>/<repo>/releases/download/<tag>/<flat-name>

The output file is also called ``_s3_override.js`` for compatibility
with the existing standalone.html template; we just regenerate its
contents so all entries point at GitHub Release instead of S3.

Usage::

    python _build_release_override.py
    python _build_release_override.py --gh-user X --gh-repo Y --gh-tag v1
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

_DEFAULT_PAGE_REPO = Path(__file__).resolve().parent
_DEFAULT_INFER_WORKSPACE = Path(
    os.environ.get(
        "WT_INFER_WORKSPACE",
        "/mnt/filestore/users/hao/wlt/src/wlt/experimental/users/hao/"
        "multilayer_depth_release_inference",
    )
)

# Same skip list as _upload_release_full.py keeps in sync.
SKIP_FILES = {
    "assets/demo_videos/hero_demo_4k.mp4",
    "assets/demo_videos/hero_demo_1440p.mp4",
    "assets/demo_videos/hero_demo_v2_1440p.mp4",
}


def _flat(rel: str) -> str:
    return rel.replace("/", "__")


def _url(repo_full: str, tag: str, asset_name: str) -> str:
    return f"https://github.com/{repo_full}/releases/download/{tag}/{asset_name}"


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--gh-user", default="haoz19")
    p.add_argument("--gh-repo", default="world-tracing-page")
    p.add_argument("--gh-tag", default="v1")
    p.add_argument(
        "--out-name", default="_s3_override.js",
        help="output filename inside docs_curated/ (kept as _s3_override.js "
             "to match the standalone.html template)",
    )
    p.add_argument(
        "--rerun-version", default="0.22.0",
        help="rerun viewer version used for app.rerun.io?url=...",
    )
    p.add_argument(
        "--page-repo", type=Path, default=_DEFAULT_PAGE_REPO,
        help="page repo checkout (where docs_curated/ lives)",
    )
    p.add_argument(
        "--infer-workspace", type=Path, default=_DEFAULT_INFER_WORKSPACE,
        help="fallback: inference workspace, in case docs_curated/ hasn't "
             "been rebuilt yet inside the page repo",
    )
    args = p.parse_args()

    # Locate docs_curated/ -- prefer page-repo, fall back to infer-ws.
    docs_candidates = [
        args.page_repo / "docs_curated",
        args.infer_workspace / "docs_curated",
    ]
    docs_dir = next(
        (d for d in docs_candidates if (d / "_release_manifest.json").exists()),
        None,
    )
    if docs_dir is None:
        print("  ERROR: no docs_curated/_release_manifest.json found in:")
        for d in docs_candidates:
            print(f"    {d}")
        return 1
    print(f"  docs_curated: {docs_dir}")

    repo_full = f"{args.gh_user}/{args.gh_repo}"
    print(f"Building release override for github.com/{repo_full} tag={args.gh_tag}")

    # 1) RRDs (window.__S3_URLS, keyed by asset_name).
    rrd_urls: dict[str, str] = {}
    for e in json.loads((docs_dir / "_release_manifest.json").read_text()):
        if not e["exists"]:
            continue
        rrd_urls[e["asset_name"]] = _url(repo_full, args.gh_tag, e["asset_name"])
    print(f"  RRDs:     {len(rrd_urls)}")

    # 2) Thumbnails (window.__S3_THUMBS, keyed by 'thumbnails/.../<stem>.jpg').
    #    GitHub Pages serves these directly so we DON'T put them in the
    #    Release; the override map stays empty -> the page falls back to
    #    the relative URL `thumbnails/.../*.jpg` baked into data.js.
    thumb_urls: dict[str, str] = {}
    print(f"  Thumbs:   served by Pages (override empty)")

    # 3) Inline-viewer assets (wtpc / glb / input mp4+jpg). Keyed by the
    #    relative path baked into data.js (e.g. 'assets/pc/object/X.wtpc').
    asset_urls: dict[str, str] = {}
    for sub, suffix in [
        ("pc",    ".wtpc"),
        ("glb",   ".glb"),
        ("input", None),
    ]:
        d = docs_dir / "assets" / sub
        if not d.is_dir():
            continue
        for f in sorted(d.rglob("*")):
            if not f.is_file():
                continue
            if suffix and f.suffix.lower() != suffix:
                continue
            rel = f.relative_to(docs_dir).as_posix()
            if rel in SKIP_FILES:
                continue
            asset_urls[rel] = _url(repo_full, args.gh_tag, _flat(rel))
    print(f"  Inline:   {len(asset_urls)}")

    # 4) Hero/section demo videos (window.__S3_SECTION_VIDEOS).
    section_video_map = {
        "hero-demo-video":             "assets/demo_videos/hero_demo_v3_1440p.mp4",
        "demo-3d-editing-video":       "assets/demo_videos/scene_editing.mp4",
        "demo-novel-view-video-video": "assets/demo_videos/geometry_guided.mp4",
    }
    section_videos = {
        vid: _url(repo_full, args.gh_tag, _flat(rel))
        for vid, rel in section_video_map.items()
    }
    print(f"  Sections: {len(section_videos)}")

    # 5) Highlight cycle videos (window.__S3_HIGHLIGHT_VIDEOS).
    highlight_video_map = {
        "step1-object":  "highlights/highlights_step1_object.mp4",
        "step1-scene":   "highlights/highlights_step1_scene.mp4",
        "step1-dynamic": "highlights/highlights_step1_dynamic.mp4",
        "textured-mesh": "highlights/highlights_mesh.mp4",
    }
    highlight_videos = {
        tid: _url(repo_full, args.gh_tag, _flat(rel))
        for tid, rel in highlight_video_map.items()
    }
    print(f"  Highlights: {len(highlight_videos)}")

    # 6) Object demo videos (window.__S3_DEMO_VIDEOS).
    #    Source of stem list: _demo_videos.json, which lives in the
    #    inference workspace (it's produced by the per-object orbit
    #    render pipeline) and is also mirrored into the page repo root
    #    so the page repo is self-contained.
    demo_videos: dict[str, dict[str, str]] = {}
    demo_json_candidates = [
        args.page_repo / "_demo_videos.json",
        args.infer_workspace / "_demo_videos.json",
    ]
    demo_json = next((p for p in demo_json_candidates if p.exists()), None)
    if demo_json is not None:
        for stem in sorted(json.loads(demo_json.read_text()).keys()):
            demo_videos[stem] = {
                "mp4":   _url(repo_full, args.gh_tag, _flat(f"demo_videos/{stem}.mp4")),
                "thumb": _url(repo_full, args.gh_tag, _flat(f"demo_videos/{stem}_thumb.jpg")),
            }
    print(f"  ObjDemo:  {len(demo_videos)}")

    # Compose JS.  This is byte-for-byte the same shape as the legacy
    # _s3_override.js so standalone.html / index.html consume it without
    # any HTML changes.
    override = (
        "\n// runtime override -- URLs point to permanent GitHub Release assets\n"
        f"window.__S3_URLS = {json.dumps(rrd_urls)};\n"
        f"window.__S3_THUMBS = {json.dumps(thumb_urls)};\n"
        f"window.__S3_ASSETS = {json.dumps(asset_urls)};\n"
        f"window.__S3_SECTION_VIDEOS = {json.dumps(section_videos)};\n"
        f"window.__S3_HIGHLIGHT_VIDEOS = {json.dumps(highlight_videos)};\n"
        f"window.__S3_DEMO_VIDEOS = {json.dumps(demo_videos)};\n"
        "if (Array.isArray(window.DEMO_VIDEOS)) {\n"
        "  window.DEMO_VIDEOS = window.DEMO_VIDEOS.map(function(d){\n"
        "    var k = d && (d.stem || d.id || d.asset_name);\n"
        "    var nu = k && window.__S3_DEMO_VIDEOS[k];\n"
        "    if (nu) {\n"
        "      if (nu.mp4) d.mp4 = nu.mp4;\n"
        "      if (nu.thumb) d.thumb = nu.thumb;\n"
        "    }\n"
        "    return d;\n"
        "  });\n"
        "}\n"
        "window.SAMPLES = (window.SAMPLES || []).map(function(s){\n"
        "  var u = window.__S3_URLS[s.asset_name];\n"
        f"  if (u) {{ s.rrd_url = u; s.viewer_url = 'https://app.rerun.io/version/{args.rerun_version}?url=' + encodeURIComponent(u); }}\n"
        "  var t = window.__S3_THUMBS[s.thumb_rel];\n"
        "  if (t) { s.thumb_rel = t; }\n"
        "  ['pc_rel','glb_rel','input_rel'].forEach(function(k){\n"
        "    var v = window.__S3_ASSETS[s[k]];\n"
        "    if (v) s[k] = v;\n"
        "  });\n"
        "  return s;\n});\n"
    )
    out_path = docs_dir / args.out_name
    out_path.write_text(override)
    print(f"\nWrote {out_path} ({len(override)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
