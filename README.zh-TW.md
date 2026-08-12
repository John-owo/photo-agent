# photo-agent（繁體中文）

## 這是什麼？

`photo-agent` 是一個與後端無關的 AI 攝影工作流程代理，將一組明確配對的 RAW／預覽圖轉成可追蹤的 `analyze → plan → apply → render` 工作階段。它負責工作流程以及安全、恢復邊界；`lightroom-mcp-john` 是用來套用調整並讀回／產生 render 狀態的外部 Lightroom MCP backend，不是定義整個 agent 的核心。現行 `0.3` alpha 在可恢復的 v0.1 流程上，加入有界 closed loop 編輯、shoot indexing、選片與光線 review、代表照片編排，以及受保護的 propagation。

### 與 `lightroom-mcp` 的關係

| Repository                                                            | 負責                                                                                                                | 不負責                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [`John-owo/photo-agent`](https://github.com/John-owo/photo-agent)     | 工作流程狀態、安全／恢復政策、語意調色計畫、closed-loop 評估、選片、分群與整場拍攝編排。                            | Lightroom catalog 傳輸與 Lightroom Classic 外掛。          |
| [`John-owo/lightroom-mcp`](https://github.com/John-owo/lightroom-mcp) | 可獨立使用的 MCP server 與 Lightroom Classic Lua 外掛：catalog 讀寫、Develop settings、checkpoint、render／export。 | PhotoAgent 的迭代政策、選片判斷、場景分群或批次 job 狀態。 |

v0.1 工作把 PhotoAgent 從原本合併在 Lightroom fork 的流程程式抽成獨立
repository。依賴是單向的：PhotoAgent 可以把 Lightroom MCP 當成其中一個
backend；Lightroom MCP 可由任何 MCP client 獨立使用，不依賴 PhotoAgent。舊 fork
內的 `raw-photo-lightroom-preset` 是歷史工作流程指引；新的 workflow engine
功能在本 repository 開發。

## 狀態：v0.3 alpha（package version 為 `0.3.0-alpha.0`）

> **Alpha／僅供測試。** v0.2 與 v0.3 的自動化 gate 已通過，且一張非關鍵
> RAW 已完成 Lightroom adapter 的實際讀取、匯出與人工視覺檢查，全程沒有
> 修改 Develop 設定。主觀批次 culling、實際代表照片編輯／propagation，
> 以及 evaluator 與人工判斷的一致性仍未驗證。請勿在尚未確認環境適配前，
> 將此版本直接用於正式照片或無法取代的照片庫。

## 平台假設

以下所有指令範例均以 Windows PowerShell 撰寫；`npm.cmd`、反斜線路徑、PowerShell 環境變數語法，以及以反引號換行都是刻意採用的寫法。Node.js CLI 本身沒有刻意限制為 Windows，但本 alpha 尚未驗證非 Windows 的 Lightroom 整合，因此目前以 Windows + PowerShell 為支援設定。若只在其他平台執行 CLI／Mock，可將 `npm.cmd` 改為 `npm`、改用該平台的環境變數語法與路徑分隔符，並將 `PHOTO_AGENT_LIGHTROOM_MCP_ENTRY` 設為對應平台的 executable；其他平台的 Lightroom 使用仍視為未驗證。

## 安全保證

- 絕不刪除、重新命名或覆寫任何來源照片、RAW、sidecar、預覽圖或匯出檔。
- RAW 檔案與 EXIF/GPS metadata 絕不上傳。除非明確提供 `--allow-cloud-preview`，否則不會傳送雲端預覽；即使允許，也只有本機清理過的預覽圖可傳送。
- 預設的 `--provider codex` 路徑只建立本機交接資料，不會呼叫視覺模型 API；OpenAI provider 必須明確選取才會啟用。
- Lightroom mutation 發生 timeout 後絕不盲目重試；會先讀回 backend 狀態，若無法確定是否已套用，就停在 `REVIEW_REQUIRED`。
- 中斷後使用 `recover` 只會讀回狀態並 reconcile session，不會自動重試 mutation。
- XMP fallback 只會建立新的 sidecar，並拒絕覆寫既有 sidecar 或來源檔案。
- `lightroom-mcp-john` 是外部 backend checkout；照片工作流程不會修改該 checkout。實際執行 Lightroom 時仍應使用非關鍵測試照片。

## 安裝與驗證

需要 Node.js 24 以上：

```powershell
npm.cmd install
npm.cmd run check
npm.cmd run lint
npm.cmd test
npm.cmd run build
```

## 環境變數

以下四個變數對應 `.env.example` 的說明：

| 變數                              | 用途                                                                                       | 預設值                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `OPENAI_API_KEY`                  | 明確選用 OpenAI provider、evaluator 或 shoot analyzer，且允許雲端預覽時使用的 credential。 | 未設定（空值）                                     |
| `PHOTO_AGENT_OPENAI_MODEL`        | OpenAI 分析與評估路徑使用的模型名稱。                                                      | `gpt-5.6-terra`                                    |
| `PHOTO_AGENT_LIGHTROOM_MCP_ENTRY` | 本機 `lightroom-mcp-john` MCP server 的 executable entry。                                 | `D:\photo\lightroom-mcp-john\server\dist\index.js` |
| `PHOTO_AGENT_SESSION_ROOT`        | 產生 session 狀態與 render 的根目錄。                                                      | `.photo-agent\sessions`                            |

## v0.2／v0.3 指令

使用 fixtures 或非關鍵測試配對執行 deterministic closed loop：

```powershell
node dist\src\cli.js edit-one --raw <RAW> --preview <JPEG> --backend mock --provider mock --apply --evaluator mock --max-iterations 3
```

使用 `--evaluator openai --allow-cloud-preview` 可將 mock evaluator 換成需明確
選用、回傳結構化結果的視覺 evaluator；在 `resume` 選用 OpenAI evaluator 時也
必須提供相同同意旗標。只有新建立、已清理的 session JPEG 可傳送；預設與 mock
路徑都不會呼叫 OpenAI。

建立保守、唯讀的整場報告，並從同一組 durable jobs 繼續：

```powershell
node dist\src\cli.js shoot --root <SHOOT_DIR> --session-root .photo-agent\shoots --analysis-file <REVIEW_JSON>
node dist\src\cli.js shoot --resume <SESSION_DIR> --analysis-file <REVIEW_JSON>
node dist\src\cli.js shoot --root <SHOOT_DIR> --session-root .photo-agent\shoots --analyzer openai --allow-cloud-preview
```

選填的 review file 保存通過 schema 驗證、由使用者或 Codex 提供的選片與光線
判斷，且不能與 `--analyzer openai` 同時使用。兩者都未明確選用時，所有照片
都保持 `review`。OpenAI analyzer 每個有預覽的 asset 只送出一次結構化請求，
而且只使用清理過的 session 副本。shoot 指令不會寫入星等、色標、調色或來源
檔。詳見 [v0.2 實作紀錄](docs/implementation/v0.2.md)與
[v0.3 實作紀錄](docs/implementation/v0.3.md)。

## Codex 本機流程（預設）

預設 provider 不會呼叫視覺模型 API，也不會啟動另一個 Codex 程序。它會在本機建立交接資料，讓目前的 Codex 工作階段讀取已清理的預覽圖，依照 `raw-photo-lightroom-preset` skill 檢查 RAW/Lightroom 流程，並寫出通過 schema 驗證的意圖檔案。

使用明確配對的 RAW/JPEG 啟動交接：

```powershell
node dist/src/cli.js edit-one `
  --raw 'C:\path\photo.NEF' `
  --preview 'C:\path\photo.JPG' `
  --backend mock `
  --provider codex
```

讀取產生的 `codex-analysis-request.md`，在目前的 Codex 工作階段檢查其中指定的本機圖片，然後在同一個 session 目錄寫入 `codex-intent.json`。接著執行驗證過的計畫：

```powershell
node dist/src/cli.js resume `
  --session 'C:\path\to\.photo-agent\sessions\<session-id>' `
  --intent-file 'C:\path\to\.photo-agent\sessions\<session-id>\codex-intent.json' `
  --backend mock `
  --apply
```

只有在確認本機 MCP 連線、且使用非關鍵測試照片時，才使用 `--backend lightroom`。交接流程不會上傳 RAW 或 EXIF/GPS 資料。

## Mock 流程

Mock 路徑供測試使用，不會連線 OpenAI 或 Lightroom。請只處理你有權使用、且明確配對的 RAW/JPEG：

```powershell
node dist/src/cli.js edit-one --raw 'C:\path\photo.NEF' --preview 'C:\path\photo.JPG' --backend mock --provider mock
```

## 選擇性 API provider/backend

OpenAI provider 只有在明確指定 `--provider openai` 時才會啟用。請使用已匯入 Lightroom 的非關鍵照片。預覽圖會先在本機清理，RAW 永遠不會上傳；若要傳送雲端預覽與執行變更，必須明確加上對應旗標：

```powershell
$env:OPENAI_API_KEY = '...'
node dist/src/cli.js edit-one `
  --raw 'C:\path\photo.NEF' `
  --preview 'C:\path\photo.JPG' `
  --backend lightroom `
  --provider openai `
  --allow-cloud-preview `
  --apply
```

若 MCP entry 不在預設位置，請設定 `PHOTO_AGENT_LIGHTROOM_MCP_ENTRY`。所有產生的狀態與 render 都會寫在 session 根目錄；程式不會寫入交付資料夾或來源照片。

## 恢復中斷的 session

如果程式在 backend 操作期間中斷，請先 reconcile session，再重新執行任何操作。
`recover` 只會讀回目前 backend 狀態並將 session 移到 `REVIEW_REQUIRED`，不會自動重試 mutation：

```powershell
node dist/src/cli.js recover `
  --session 'C:\path\to\.photo-agent\sessions\<session-id>' `
  --backend lightroom
```

## XMP fallback

對支援的全域調色參數，可以用已驗證的 intent 與目前設定快照輸出新的 XMP sidecar。
既有檔案不會被覆寫：

```powershell
node dist/src/cli.js export-xmp `
  --raw 'C:\path\photo.NEF' `
  --intent-file examples\sample-intent.json `
  --current-settings examples\current-settings.json `
  --output .photo-agent\exports\photo.xmp
```

## 參考連結

- [AGENTS.md](AGENTS.md) — repository 安全與開發規範。
- [ROADMAP.md](ROADMAP.md) — 專案目標與里程碑。
- [v0.1 實作紀錄](docs/implementation/v0.1.md)。
- [v0.1–v0.3 後續方向](docs/implementation/v0.1-v0.3-direction.zh-TW.md)。
- [Codex 交接契約](docs/codex-provider.zh-TW.md)。
- [Examples](examples/README.md) — 可重現的 fixture 指令。
- [MIT License](LICENSE)。
- [NOTICE.md](NOTICE.md) — `lightroom-mcp-john` 第三方 provenance 說明。
- 英文版：[README.md](README.md)。
