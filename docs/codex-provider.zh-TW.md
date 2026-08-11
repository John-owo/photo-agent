# Codex 本機 provider 契約

`CodexProvider` 是本 alpha 版本不使用 API 的分析路徑。CLI 不會啟動另一個 Codex 程序，也不會上傳圖片；它會建立可保存的 session 交接資料，讓目前的 Codex 工作階段執行本機 `raw-photo-lightroom-preset` skill，並回傳小型、可稽核的 JSON 產物。

## 流程

1. 使用一組明確的 RAW/預覽圖配對，執行 `edit-one --provider codex`。
2. session 會寫入 `inputs/analysis.jpg`、`codex-analysis-request.md` 與預期的 `codex-intent.json` 路徑，然後停在 `CODEX_INPUT_REQUIRED`。
3. 目前的 Codex 工作階段讀取交接要求，使用 `view_image` 檢查本機預覽，並遵循 skill 的 RAW-first 與 Lightroom closed-loop 規則。JPEG 可以用於構圖、對焦與表情的初步判斷，但不能取代色彩真值。
4. Codex 只在 `codex-intent.json` 寫入 `SemanticIntentPlan` JSON 物件。CLI 會使用所有 provider 共用的同一份 Zod schema 驗證它。
5. 執行 `resume --intent-file ...` 後，才會進入 deterministic translator、checkpoint、readback 與可丟棄 render 階段。

## 安全邊界

- RAW、EXIF 與 GPS 僅留在本機。
- 交接流程對 Lightroom 與來源照片都是唯讀。
- 意圖格式錯誤或內容有歧義時，session 會失敗，不會自行猜測。
- `--backend lightroom --apply` 仍是另一個明確的操作，應使用非關鍵測試照片。

英文版請見 [codex-provider.md](codex-provider.md)。
