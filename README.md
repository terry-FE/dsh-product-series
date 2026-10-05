# dsh-product-series

A DeepSeek Harness **bundle** that registers one agent tool,
`generate_product_series`: it reads the Figma product artwork already in the
workspace, uses it as an image-generation reference, and writes a visually
consistent series of **400×400 WebP** product images.

```
workspace Figma assets  →  reference images  →  provider (Seedream/Ark)  →  400×400 WebP series
```

## What it does

- **Finds the artwork itself.** Scans `referenceDir` (default: the session
  working directory) recursively for images, so `figma-import/assets/…` and
  `figma-bridge/out/<node>/assets/…` are both found without the caller knowing
  either layout. Candidates under a `figma-*`/`assets` directory are preferred
  and the plugin's own output folder is skipped, so earlier frames are never fed
  back in as references.
- **Pins one look across the series.** Every frame is generated with the same
  reference images attached and an explicit style contract, so the frames match
  each other instead of drifting.
- **Isolates one product per frame.** A Figma series key visual is usually a
  *group* shot; the prompt states that the references are a style guide only, so
  the model renders the single product asked for rather than reproducing the
  group.
- **Guarantees the deliverable size and format.** Provider output (2048×2048
  from Ark) is decoded, area-average rescaled to exactly 400×400, and encoded as
  WebP by **ffmpeg**.
- **Never overwrites a previous series.** An existing filename gets a `-2`,
  `-3`, … suffix.

## Requirements

- Node `^22.19.0 || >=24.0.0`
- **ffmpeg on PATH** (or `DSH_FFMPEG_PATH`, or the plugin's `ffmpegPath` config).
  It needs `libwebp` encode and `webp` decode, which every standard build has.
  Missing ffmpeg fails the call immediately, before any provider request.
- An Ark (Volcengine) API key with a Seedream image model activated

## Install

```bash
# from the npm registry
dsh plugin --profile web add dsh-product-series

# or from a packed tarball
npm pack
dsh plugin --profile web add /absolute/path/to/dsh-product-series-0.1.0.tgz
```

`dsh plugin add` installs the package and, because this package declares
`dsh.bundle.patch`, appends it to `dsh.profile.bundles` in the profile's
`package.json`. The bundle's own `cordis.patch.yml` then inserts the
`product-series` entry into the composed profile, so no manual patch editing is
required. Restart the profile (or reload) to pick it up.

### Configure the API key

The plugin resolves its key through DSH's credential seam, checking
`ARK_API_KEY`, then `SEEDREAM_API_KEY`, then the process environment for either.
Set it in **Settings → Plugins → Image generation** (the same key
`dsh-image-gen` uses), or export it:

```bash
export ARK_API_KEY=...        # PowerShell: $env:ARK_API_KEY = '...'
```

### Pick a model the account can actually call

Ark model availability is **per account**. A name that exists in Ark's catalogue
but is not activated answers `ModelNotOpen` / `InvalidEndpointOrModel`, so the
default may need changing:

```bash
curl -s https://ark.cn-beijing.volces.com/api/v3/models \
  -H "Authorization: Bearer $ARK_API_KEY" \
  | grep -o '"id":"[^"]*seedream[^"]*"'
```

Then override the model in your profile's `cordis.patch.yml`, which is applied
after this bundle's layer:

```yaml
- id: product-series
  name: dsh-product-series
  config:
    model: doubao-seedream-5-0-pro-260628
```

This bundle's defaults live in its own [`cordis.patch.yml`](./cordis.patch.yml):
`baseURL`, `model`, `size`, `watermark`, `concurrency`, `maxReferences`,
`outputFolder`, `webpQuality`, and `ffmpegPath`.

## Use

Ask the agent in plain language:

> 用工作区里的 Figma 素材，生成 4 张 400x400 的数码配件产品图

or call the tool directly:

| Parameter | Required | Default | Meaning |
| --- | --- | --- | --- |
| `prompt` | yes | — | What the series shows. |
| `referenceDir` | no | session working directory | Where the Figma artwork lives; searched recursively. |
| `count` | no | `1` | How many frames, 1–10. |
| `outputDir` | no | `<working dir>/product-series` | Where frames are written. |
| `style` | no | — | Extra style direction applied to every frame. |

Each frame takes roughly **1–2 minutes** (2K generation), so generation runs
with bounded parallelism (`concurrency`, default 2) and one retry per frame for
transient rate limits.

The result lists every written path; failed frames are reported individually
rather than failing the whole run, and the call only errors if *every* frame
failed.

## Develop

```bash
npm test          # image pipeline + domain + plugin-surface tests, no provider calls
npm run e2e       # real generation against the provider (spends credits)
npm run fixtures  # regenerate pipeline test fixtures (needs ffmpeg)
```

Image processing is delegated to ffmpeg rather than reimplemented: the codecs are
already installed, tested, and known correct, and a hand-written codec is a
liability nobody asked for. ffmpeg is invoked **file-to-file** rather than with
pipes, because DSH's sandbox denies a child process whose stdio is piped
(`spawn EPERM`) — so an implementation that piped image bytes through ffmpeg
would work standalone and fail inside DSH.

- `lib/image-ffmpeg.mjs` — ffmpeg discovery, decode+rescale+encode to WebP.
- `lib/webp.mjs` — reads canvas dimensions straight from the WebP container, so
  tests verify the delivered file's bytes rather than trusting ffmpeg to check
  itself.
- `lib/ark.mjs` — Ark/Seedream request, response extraction, retryable-error
  classification, bounded-concurrency pool.
- `lib/series.mjs` — reference discovery and ranking, prompt composition,
  output naming.
- `plugin.mjs` — the registered tool; `index.js` re-exports it as the bundle
  entry the loader resolves.

`test/register-stubs.mjs` maps `@deepseek-ai/dsh-tools` and
`@deepseek-ai/cordis` to local stubs during tests: they are host-supplied peer
dependencies, not something this bundle installs. The `dsh-tools` stub mirrors
the registry's schema-authoring validation, so a schema mistake fails in
`npm test` instead of at boot.
