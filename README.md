# assets branch

Binary assets (`.wtpc` point clouds, `.glb` textured meshes, demo
mp4s, input video clips) served through jsDelivr CDN at:

    https://cdn.jsdelivr.net/gh/haoz19/world-tracing-page@assets/<path>

jsDelivr adds the CORS headers that GitHub Release downloads lack,
which is what lets the interactive viewer on
[the project page](https://haoz19.github.io/world-tracing-page/) fetch
these files cross-origin from `<canvas>` / `<model-viewer>` /
`<video>`.

Big-file budgets (jsDelivr per-file limit = 50 MB):

  - pc/                  : ~500 MB (38 .wtpc, max 35 MB)
  - glb/                 : ~115 MB (10 .glb, max 15 MB)
  - videos/sections/     : ~45 MB  (3 mp4 — hero + scene editing + geom)
  - videos/highlights/   : ~48 MB  (4 mp4 — object/scene/dynamic/mesh tiles)
  - videos/demo/         : ~60 MB  (10 mp4 + 10 thumb.jpg)
  - videos/input/dynamic/: ~1.6 MB (20 small mp4 previews)

RRDs are NOT here -- they live on the
[v1 GitHub Release](https://github.com/haoz19/world-tracing-page/releases/tag/v1)
and load through Rerun's web viewer (which can talk to the Release
via the version-pinned `app.rerun.io/version/X.Y.Z?url=...` flow).
