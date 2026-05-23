# assets branch

Binary assets (`.wtpc` point clouds, `.glb` textured meshes) served
through jsDelivr CDN at:

    https://cdn.jsdelivr.net/gh/haoz19/world-tracing-page@assets/<path>

jsDelivr adds the CORS headers that GitHub Release downloads lack,
which is what lets the interactive viewer on
[the project page](https://haoz19.github.io/world-tracing-page/) fetch
these files cross-origin from `<canvas>` / `<model-viewer>`.

Big-file budgets:

  - pc/  : ~500 MB (38 .wtpc, max 35 MB)
  - glb/ : ~115 MB (10 .glb, max 15 MB)

RRDs and demo videos are NOT here -- they live on the
[v1 GitHub Release](https://github.com/haoz19/world-tracing-page/releases/tag/v1)
and load through Rerun's web viewer / `<video>` tags, which don't
need explicit CORS headers.
