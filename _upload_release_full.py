"""Upload **all** large demo-page assets to a GitHub Release as permanent
download URLs.

This replaces the previous S3-presigned-URL deploy path (which expired
every 7 days) with permanent GitHub Release assets so the project page
can be served from GitHub Pages without any URL-refresh chore.

Asset categories handled (~1.8 GB / ~130 files total):

  * 38 RRDs           (curated Rerun recordings, single-seed)
  * 38 .wtpc          (binary point clouds for inline viewer)
  * 10 .glb           (training-free textured mesh)
  * 16 input mp4      (16-frame looping previews)
  * 16 input jpg      (object/scene first-frame previews)
  *  3 hero/section videos (skips ``hero_demo_4k.mp4`` 203MB by default)
  *  4 highlight cycle videos
  * 10 object demo videos + 10 thumbnails

Asset names use the flat ``<rel-path-with-/-as-_>`` scheme so the URL
is just ``releases/download/<tag>/<flat-name>`` for every asset.

Usage::

    # 0) Authenticate once
    export GH_TOKEN=ghp_xxx           # OR run `gh auth login`

    # 1) Create the repo (one-time, see _deploy_gh_pages.sh)
    gh repo create haoz19/world-tracing-page --public ...

    # 2) Create the release (one-time)
    gh release create v1 -R haoz19/world-tracing-page \
        --title "Project page assets v1" --notes "..."

    # 3) Upload everything (this script)
    python _upload_release_full.py
    python _upload_release_full.py --dry-run        # see plan only
    python _upload_release_full.py --clobber        # re-upload existing
    python _upload_release_full.py --only-missing   # default behaviour

The output URL pattern is::

    https://github.com/haoz19/world-tracing-page/releases/download/v1/<flat-name>

E.g.::

    .../v1/object__obj014_leather_briefcase__seed3.rrd
    .../v1/assets__pc__object__obj014_leather_briefcase.wtpc
    .../v1/assets__demo_videos__hero_demo_v3_1440p.mp4
    .../v1/highlights__highlights_mesh.mp4
    .../v1/demo_videos__obj014_leather_briefcase.mp4
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

# Default paths: the page repo's own root (where this script lives) for
# docs_curated/_release_manifest.json, plus an external "inference
# workspace" for the large binary asset sources (RRDs / highlight /
# object demo mp4s rendered by the inference pipeline).
#
# All paths can be overridden by CLI args so this script runs from any
# checkout of haoz19/world-tracing-page, not just the original
# inference dir.
_DEFAULT_PAGE_REPO = Path(__file__).resolve().parent
_DEFAULT_INFER_WORKSPACE = Path(
    os.environ.get(
        "WT_INFER_WORKSPACE",
        "/mnt/filestore/users/hao/wlt/src/wlt/experimental/users/hao/"
        "multilayer_depth_release_inference",
    )
)
_DEFAULT_OBJ_DEMO_ROOT = Path(
    os.environ.get(
        "WT_OBJ_DEMO_ROOT",
        "/mnt/filestore/users/hao/auto-experiments/trellis_hybrid_ab/"
        "outputs/v4_wt_release_curated",
    )
)

# Names that should NOT be uploaded.
SKIP_FILES = {
    "assets/demo_videos/hero_demo_4k.mp4",         # 203 MB; 1440p is enough
    "assets/demo_videos/hero_demo_1440p.mp4",      # v1 / v2 superseded
    "assets/demo_videos/hero_demo_v2_1440p.mp4",
}


def _flat(rel: str) -> str:
    """Turn ``a/b/c.ext`` into ``a__b__c.ext`` (GitHub Release asset name)."""
    return rel.replace("/", "__")


def _release_url(repo_full: str, tag: str, asset_name: str) -> str:
    return f"https://github.com/{repo_full}/releases/download/{tag}/{asset_name}"


# ---------------------------------------------------------------------------
# Asset enumeration
# ---------------------------------------------------------------------------


def _enumerate_assets(
    page_repo: Path,
    infer_ws: Path,
    obj_demo_root: Path,
) -> list[dict]:
    """Return ``[{rel, asset_name, local_path, size_mb, kind}, ...]``.

    Args
    ----
    page_repo
        Root of the page repo checkout.  Used to find
        ``docs_curated/_release_manifest.json`` and the page-built
        inline-viewer assets under ``docs_curated/assets/``.
    infer_ws
        Inference workspace where RRDs, highlight mp4s, and the
        hero/section videos were rendered by the inference pipeline.
        These are large and not committed to the page repo.
    obj_demo_root
        Where the per-object orbit demos live
        (e.g. ``<root>/obj014_leather_briefcase/_demo/demo.mp4``).
    """
    out: list[dict] = []

    # docs_curated/ MAY live either inside the page repo (after a page
    # rebuild) OR inside the inference workspace (the original build
    # location).  Use whichever has the manifest.
    docs_candidates = [
        page_repo / "docs_curated",
        infer_ws / "docs_curated",
    ]
    docs_dir = next(
        (d for d in docs_candidates if (d / "_release_manifest.json").exists()),
        None,
    )
    if docs_dir is None:
        print(
            "  ERROR: no docs_curated/_release_manifest.json found in any of:",
            flush=True,
        )
        for d in docs_candidates:
            print(f"    {d}", flush=True)
        sys.exit(1)
    print(f"  docs_curated:  {docs_dir}")

    # 1) RRDs from _release_manifest.json.
    for e in json.loads((docs_dir / "_release_manifest.json").read_text()):
        if not e["exists"]:
            continue
        out.append(
            dict(
                rel=f"rrd/{e['asset_name']}",
                asset_name=e["asset_name"],  # already flat
                local_path=Path(e["local_path"]),
                size_mb=e["size_mb"],
                kind="rrd",
            )
        )

    # 2) Curated inline-viewer assets (pc/glb/input).
    for sub, suffix in [
        ("pc",    ".wtpc"),
        ("glb",   ".glb"),
        ("input", None),  # mp4 + jpg
    ]:
        for f in sorted((docs_dir / "assets" / sub).rglob("*")):
            if not f.is_file():
                continue
            if suffix and f.suffix.lower() != suffix:
                continue
            rel = f.relative_to(docs_dir).as_posix()
            if rel in SKIP_FILES:
                continue
            out.append(
                dict(
                    rel=rel,
                    asset_name=_flat(rel),
                    local_path=f,
                    size_mb=round(f.stat().st_size / 1e6, 2),
                    kind="inline",
                )
            )

    # 3) Hero / section demo videos (skip the heavyweight 4k version).
    for f in sorted((docs_dir / "assets" / "demo_videos").glob("*.mp4")):
        rel = f.relative_to(docs_dir).as_posix()
        if rel in SKIP_FILES:
            continue
        out.append(
            dict(
                rel=rel,
                asset_name=_flat(rel),
                local_path=f,
                size_mb=round(f.stat().st_size / 1e6, 2),
                kind="hero_video",
            )
        )

    # 4) Highlight cycle videos (always read from the inference workspace).
    highlight_dir = infer_ws / "_highlight_cycles_local"
    highlight_names = [
        "highlights_step1_object.mp4",
        "highlights_step1_scene.mp4",
        "highlights_step1_dynamic.mp4",
        "highlights_mesh.mp4",
    ]
    for name in highlight_names:
        p = highlight_dir / name
        if not p.exists():
            print(f"  WARNING: highlight video missing: {p}", flush=True)
            continue
        rel = f"highlights/{name}"
        out.append(
            dict(
                rel=rel,
                asset_name=_flat(rel),
                local_path=p,
                size_mb=round(p.stat().st_size / 1e6, 2),
                kind="highlight",
            )
        )

    # 5) Object demo videos + thumbnails (10 each).
    demo_videos_json = infer_ws / "_demo_videos.json"
    if demo_videos_json.exists():
        dv = json.loads(demo_videos_json.read_text())
        for stem in sorted(dv.keys()):
            mp4 = obj_demo_root / stem / "_demo" / "demo.mp4"
            thumb = obj_demo_root / stem / "_demo" / "demo_thumb.jpg"
            if mp4.exists():
                out.append(
                    dict(
                        rel=f"demo_videos/{stem}.mp4",
                        asset_name=_flat(f"demo_videos/{stem}.mp4"),
                        local_path=mp4,
                        size_mb=round(mp4.stat().st_size / 1e6, 2),
                        kind="obj_demo_mp4",
                    )
                )
            if thumb.exists():
                out.append(
                    dict(
                        rel=f"demo_videos/{stem}_thumb.jpg",
                        asset_name=_flat(f"demo_videos/{stem}_thumb.jpg"),
                        local_path=thumb,
                        size_mb=round(thumb.stat().st_size / 1e6, 2),
                        kind="obj_demo_thumb",
                    )
                )

    return out


# ---------------------------------------------------------------------------
# Existing-asset query
# ---------------------------------------------------------------------------


def _existing_assets(repo_full: str, tag: str) -> set[str]:
    cmd = ["gh", "release", "view", tag, "-R", repo_full, "--json", "assets"]
    try:
        out = subprocess.check_output(cmd, text=True, stderr=subprocess.PIPE)
    except subprocess.CalledProcessError as e:
        msg = (e.stderr or "") + (e.output or "")
        if "release not found" in msg.lower() or "not found" in msg.lower():
            return set()
        raise
    return {a["name"] for a in json.loads(out).get("assets", [])}


# ---------------------------------------------------------------------------
# Upload loop
# ---------------------------------------------------------------------------


def _upload_one(repo_full: str, tag: str, asset: dict, clobber: bool) -> bool:
    """Upload a single asset; returns True on success."""
    cmd = [
        "gh", "release", "upload", tag, "-R", repo_full,
        f"{asset['local_path']}#{asset['asset_name']}",
    ]
    if clobber:
        cmd.append("--clobber")
    try:
        subprocess.check_call(cmd)
        return True
    except subprocess.CalledProcessError as e:
        print(f"  FAILED [{asset['asset_name']}]: {e}", flush=True)
        return False


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--gh-user", default="haoz19")
    p.add_argument("--gh-repo", default="world-tracing-page")
    p.add_argument("--gh-tag", default="v1")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument(
        "--clobber", action="store_true",
        help="re-upload assets that already exist in the release",
    )
    p.add_argument(
        "--only-missing", action="store_true", default=True,
        help="(default) skip assets that already exist in the release",
    )
    p.add_argument(
        "--page-repo", type=Path, default=_DEFAULT_PAGE_REPO,
        help="page repo checkout (where docs_curated/ lives after a rebuild)",
    )
    p.add_argument(
        "--infer-workspace", type=Path, default=_DEFAULT_INFER_WORKSPACE,
        help="inference workspace where RRDs / highlights / hero videos were "
             "rendered (also accepts the WT_INFER_WORKSPACE env var)",
    )
    p.add_argument(
        "--obj-demo-root", type=Path, default=_DEFAULT_OBJ_DEMO_ROOT,
        help="root for per-object orbit demos (also accepts WT_OBJ_DEMO_ROOT)",
    )
    args = p.parse_args()

    repo_full = f"{args.gh_user}/{args.gh_repo}"
    print(f"  page-repo:      {args.page_repo}")
    print(f"  infer-ws:       {args.infer_workspace}")
    print(f"  obj-demo-root:  {args.obj_demo_root}")
    assets = _enumerate_assets(
        args.page_repo, args.infer_workspace, args.obj_demo_root
    )
    total_mb = sum(a["size_mb"] for a in assets)

    print(f"Discovered {len(assets)} assets, {total_mb:.0f} MB total")
    print(f"  target  : github.com/{repo_full}  tag={args.gh_tag}")

    # Group summary
    by_kind: dict[str, list[dict]] = {}
    for a in assets:
        by_kind.setdefault(a["kind"], []).append(a)
    for k in sorted(by_kind.keys()):
        sub_mb = sum(a["size_mb"] for a in by_kind[k])
        print(f"  - {k:15s}  {len(by_kind[k]):3d} files   {sub_mb:6.1f} MB")

    if args.dry_run:
        print("\n(dry run; no commands will be executed)")
        for a in assets:
            print(f"  {a['size_mb']:6.1f} MB  {a['asset_name']}")
        return 0

    try:
        existing = _existing_assets(repo_full, args.gh_tag)
    except FileNotFoundError:
        print("ERROR: `gh` CLI not found in PATH; install GitHub CLI first.")
        return 1
    print(f"\nFound {len(existing)} assets already in the release.")

    todo = []
    skipped = 0
    for a in assets:
        if a["asset_name"] in existing and not args.clobber:
            skipped += 1
            continue
        todo.append(a)
    print(f"  will upload : {len(todo)}")
    print(f"  will skip   : {skipped} (already present)")

    if not todo:
        print("Nothing to do.")
        return 0

    ok = 0
    fail = 0
    for i, a in enumerate(todo, 1):
        print(
            f"[{i:3d}/{len(todo)}] {a['size_mb']:6.1f} MB  {a['asset_name']}",
            flush=True,
        )
        if _upload_one(repo_full, args.gh_tag, a, args.clobber):
            ok += 1
        else:
            fail += 1

    print()
    print(f"DONE: ok={ok}  fail={fail}  skipped={skipped}")
    return 0 if fail == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
