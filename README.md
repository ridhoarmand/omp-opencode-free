# omp-opencode-free

Free OpenCode models in [OMP](https://omp.sh) and [Pi](https://github.com/earendil-works/pi), with no personal API key.

## Fitur

- **Tanpa API Key Pribadi**: Otomatis menyematkan kredensial publik upstream OpenCode (`Authorization: Bearer public`).
- **Support OMP & Pi**: Mendukung OMP runtime serta Pi coding agent standar.
- **Fingerprint Gateway Terlengkap**:
  - Menggunakan endpoint `/inference/v1` terbaru.
  - User-Agent sesuai OpenCode CLI terbaru (`opencode/latest/.../cli`).
  - Hashing session dan project ID 40-hex lowercase.
  - Injeksi definisi skema resmi OpenCode tools (`shell`, `edit`, `glob`, `grep`, `read`).
- **Dukungan Model Free Lengkap**:
  - Chat completions (`big-pickle`, `cat-jam-free`, `mimo-v2.6-flash-free`, `step-5-preview-free`, `space-bunny-free`, dll).
  - Responses API (`muse-spark-1.2-contributor-free`, `muse-spark-1.3-contributor-free`).
  - Full streaming, reasoning blocks, dan native tool calling.

## Instalasi

### Untuk OMP

```bash
omp plugin install git@github.com:ridhoarmand/omp-opencode-free.git
```

Atau link lokal saat development:
```bash
omp plugin link /path/to/omp-opencode-free
```

### Untuk Pi

```bash
pi install git@github.com:ridhoarmand/omp-opencode-free.git
```

## Penggunaan

Pilih model free dari model picker OMP / Pi (misal `opencode-free/big-pickle`, `opencode-free/cat-jam-free`), atau jalankan langsung dari command line:

```bash
omp -p --model opencode-free/big-pickle "baca file README.md"
```

## Development & Pengujian

Menggunakan [Bun](https://bun.sh):

```bash
bun install
bun test src/             # Unit tests (64 passing)
bun scripts/smoke-real.ts # Live end-to-end tests ke OpenCode Inference API
```

Untuk panduan reverse engineering dan cara update ketika ada rilis baru OpenCode, baca [MAINTENANCE.md](./MAINTENANCE.md).

## Lisensi

[GPL-3.0-or-later](./LICENSE) — © 2026 ridhoarmand
