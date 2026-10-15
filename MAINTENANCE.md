# Panduan Pemeliharaan & Reverse Engineering OpenCode Gateway

Dokumen ini mencatat cara kerja internal OpenCode free tier dan langkah-langkah reverse engineering ketika upstream OpenCode CLI / API melakukan pembaruan di masa mendatang.

---

## 1. Arsitektur & Aturan Gateway OpenCode (Free Tier)

Upstream OpenCode memvalidasi permintaan ke free/public lane melalui kombinasi identitas client, format session, URL endpoint, dan struktur tools:

1. **Endpoint URL**:
   - Endpoint utama telah dipindahkan dari `/zen/v1` ke `/inference/v1`.
   - Chat Completions: `https://opencode.ai/inference/v1/chat/completions` (OpenAI format).
   - Responses API: `https://opencode.ai/inference/v1/responses` (khusus keluarga Muse Spark).
   - Dynamic Model List: `https://opencode.ai/inference/v1/models`.

2. **Header Identitas (Fingerprinting)**:
   - `Authorization: Bearer public`: Kredensial publik resmi yang digunakan OpenCode CLI.
   - `User-Agent`: Format `opencode/<channel>/<version>/cli` (contoh: `opencode/latest/2.0.28/cli`).
   - `x-opencode-client`: `cli`.
   - `x-opencode-project`: 40 karakter lowercase hex (SHA-256 dari string project).
   - `x-opencode-session`: `ses_<descending_hex><base62>`.
   - `x-opencode-session-id`, `x-session-affinity`, `x-session-id`, `X-Session-Id`: Diselaraskan nilainya sama dengan session ID.
   - **PENTING**: Jangan pernah menyertakan header `x-opencode-request`. Upstream akan langsung menolak dengan `403 FreeTierError` jika header ini hadir.

3. **Injeksi Core Tools Asli**:
   - Upstream mewajibkan payload berformat agen dengan 5 core tools: `shell`, `edit`, `glob`, `grep`, `read`.
   - Nama tool untuk terminal harus `shell`, **bukan** `bash`.
   - Deskripsi dan parameter schema tools tidak boleh berupa stub/dummy (gateway memeriksa konsistensi definisi tools asli OpenCode).
   - Tool custom milik client (seperti `weather`, `task`, dsb) tetap dipertahankan, namun 5 core tools di atas akan otomatis diinjeksi jika belum ada.

---

## 2. Cara Menguji & Menangkap Request OpenCode CLI (MITM)

Jika di kemudian hari OpenCode free tier kembali mengembalikan `403 FreeTierError` atau format baru:

### Langkah A: Buat CA & MITM Proxy Lokal

Jalankan script MITM proxy berikut menggunakan Bun untuk menangkap request dan respons asli dari CLI OpenCode resmi:

```typescript
// /tmp/mitm_inspect.ts
import * as http from "http";
import * as https from "https";
import * as net from "net";
import * as fs from "fs";
import { execSync } from "child_process";

if (!fs.existsSync("/tmp/ca.crt")) {
  execSync('openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/ca.key -out /tmp/ca.crt -days 365 -subj "/CN=MITM CA"');
  execSync('openssl req -new -nodes -keyout /tmp/opencode.ai.key -out /tmp/opencode.ai.csr -subj "/CN=opencode.ai"');
  execSync('openssl x509 -req -in /tmp/opencode.ai.csr -CA /tmp/ca.crt -CAkey /tmp/ca.key -CAcreateserial -out /tmp/opencode.ai.crt -days 365');
}

const certs = {
  key: fs.readFileSync("/tmp/opencode.ai.key"),
  cert: fs.readFileSync("/tmp/opencode.ai.crt"),
};

const fakeServer = https.createServer(certs, (req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", c => chunks.push(c));
  req.on("end", () => {
    const bodyStr = Buffer.concat(chunks).toString("utf8");
    console.log("\n==================== CAPTURED REQUEST ====================");
    console.log("METHOD:", req.method);
    console.log("URL:", req.url);
    console.log("HEADERS:", JSON.stringify(req.headers, null, 2));
    if (bodyStr) console.log("BODY:", bodyStr);

    const clientReq = https.request({
      hostname: "opencode.ai",
      port: 443,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: "opencode.ai" }
    }, clientRes => {
      console.log("STATUS:", clientRes.statusCode);
      res.writeHead(clientRes.statusCode!, clientRes.headers);
      clientRes.pipe(res);
    });
    clientReq.on("error", err => {
      res.writeHead(502);
      res.end();
    });
    if (bodyStr) clientReq.write(bodyStr);
    clientReq.end();
  });
});

fakeServer.listen(18889);

const proxy = http.createServer();
proxy.on("connect", (req, clientSocket, head) => {
  const [host] = req.url!.split(":");
  if (host === "opencode.ai") {
    const mitmSocket = net.connect(18889, "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      mitmSocket.write(head);
      mitmSocket.pipe(clientSocket);
      clientSocket.pipe(mitmSocket);
    });
  }
});

proxy.listen(18888, () => console.log("MITM Proxy siap di port 18888"));
```

### Langkah B: Jalankan OpenCode CLI melalui Proxy

Di terminal lain, jalankan CLI OpenCode dengan menyematkan CA cert dan proxy:

```bash
NODE_EXTRA_CA_CERTS=/tmp/ca.crt SSL_CERT_FILE=/tmp/ca.crt \
NO_PROXY=127.0.0.1,localhost HTTPS_PROXY=http://127.0.0.1:18888 \
opencode run --standalone --model opencode/big-pickle "say hi"
```

Periksa output MITM untuk melihat:
1. Endpoint URL baru yang dituju (misal `/inference/v1/...`).
2. Versi `User-Agent` yang dikirim CLI.
3. Header `x-opencode-*` yang ditambahkan atau dihapus.
4. Struktur JSON body dan tools yang disertakan.

---

## 3. Titik Pembaruan Kode (File yang Perlu Diupdate)

1. **`src/zen-headers.ts`**:
   - `OPENCODE_USER_AGENT`: Sesuaikan jika OpenCode memperbarui minimal versi CLI yang diterima (misal `opencode/latest/<new_version>/cli`).
   - `ZEN_BASE_URL` & `ZEN_ANTHROPIC_BASE_URL`: Jika path gateway berpindah.
   - Header transform di `applyOpenCodeFreeHeaders()`.

2. **`src/zen-payload.ts`**:
   - `OPENCODE_GENUINE_TOOLS`: Perbarui skema atau daftar tools jika ada penambahan/perubahan definisi tool bawaan OpenCode.

3. **`src/discovery.ts`**:
   - `ZEN_MODELS_URL`: Endpoint untuk refresh daftar model live.

4. **`omp-entry.ts`**:
   - Adapter untuk OMP runtime (mengatur `before_provider_request` hook dan header default provider).

---

## 4. Pengujian & Verifikasi

Setelah melakukan perubahan, selalu jalankan tes berikut:

```bash
# 1. Jalankan unit test internal
bun test src/

# 2. Jalankan smoke test live end-to-end langsung ke API OpenCode
bun scripts/smoke-real.ts

# 3. Uji langsung di OMP CLI
omp -p --model opencode-free/big-pickle --no-session "say hi"
```
