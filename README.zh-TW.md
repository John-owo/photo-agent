# photo-agent（繁體中文）

與後端無關的 AI 攝影工作流程代理，現為 `v0.1-alpha`。

這個版本先處理一組明確配對的 RAW 與預覽圖，用來驗證執行環境、標準化調色契約，以及 Lightroom adapter 邊界；選片、批次處理與 Style Memory 會留到後續版本。

## 安裝與驗證

需要 Node.js 24 以上：

```powershell
npm.cmd install
npm.cmd run check
npm.cmd run lint
npm.cmd test
npm.cmd run build
```

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

更多背景與限制請參閱：[AGENTS.md](AGENTS.md)、[ROADMAP.md](ROADMAP.md)、[v0.1-alpha 實作紀錄](docs/implementation/v0.1-alpha.zh-TW.md)、[Codex 交接契約](docs/codex-provider.zh-TW.md)。英文版請見 [README.md](README.md)。
