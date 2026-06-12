# World Tracing — Project Page

Source for the interactive demo page at
<https://haoz19.github.io/world-tracing/>.

The page shows ~38 image-to-3D point cloud examples produced by our
multilayer-depth diffusion model.  Each card has:

* An inline three.js viewer that streams the pre-baked ``.wtpc`` file.
* A "Rerun" deep-link that opens the full ``.rrd`` in <app.rerun.io>.
* A short looping mp4 preview of the input image / video.

For the inference code that generated these recordings, see the
``world-tracing`` (formerly ``wt``) inference package.

## Layout

```
.                                   <- main branch
├── _build_curated_page.py          # Selection -> HTML/CSS/JS
├── _build_release_override.py      # Generates _s3_override.js with GH Release URLs
├── _upload_release_full.py         # Uploads 1.85 GB of RRD/wtpc/mp4 to a release
├── _deploy_gh_pages.sh             # Builds + pushes to gh-pages
├── _curated_selection.json         # 38-sample manifest
├── thumbnails/                     # Per-sample thumbnail jpgs (1.1 MB)
└── examples/test_images/           # Staged DAVIS segment inputs
```

The ``gh-pages`` branch contains only the *built* page; do not edit it
by hand.

## Rebuild + redeploy the page

```bash
# Authenticate once
gh auth login

# All large binary assets ALREADY live in the GitHub Release named "v1".
# (See _upload_release_full.py for the inventory.)

# To re-publish after changing _curated_selection.json or any HTML/JS:
bash _deploy_gh_pages.sh
```

## Add a new sample

1. Generate its ``.rrd`` and ``.wtpc`` via the inference repo.
2. Add an entry in ``_curated_selection.json``.
3. ``python _upload_release_full.py`` — only-missing assets uploaded.
4. ``bash _deploy_gh_pages.sh``.
