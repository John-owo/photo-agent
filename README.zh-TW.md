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
  已知 Workflow Copy 身分時會鎖定記錄的 catalog ID／UUID；每次 recovery 另存一份
  report，保留原有 operation 與 Checkpoint 證據。
- Ctrl-C／SIGTERM 中斷會留下可恢復的 durable 證據：唯讀階段中斷會結束為
  `CANCELLED`；backend side effect 已開始後則結束為 `REVIEW_REQUIRED`，不會悄悄重試
  mutation；backend lease 的釋放結果會記錄在 session 中。
- normalized plan 會自帶完整的 Parameter Registry snapshot 與明確版本；舊的
  未標版本／`0.1.0`／`0.2.0` plan 在進入 translation 或 mutation 前會依明確契約
  遷移到 `0.3.0`。除非 backend 宣告支援每一個 setting，Color Mixer channel
  會先被拒絕；共用的 translator golden-vector runner 會把不同 control group
  的預期結果分開驗證。
- Structured Tone Curve planning 使用獨立的 `0.1.0` registry，涵蓋 master／RGB
  point curve 與 parametric curve；點位 bounds、模式互斥、deterministic readback
  reconcile 與 golden vector 都有 schema 契約。Backend 必須逐一宣告所需 curve
  variant；在每張照片的 readback 與 render proof 完成前，registry policy 會禁止
  curve propagation。目前 adapter 尚無 structured curve mutation method，因此
  這一層只提供 planning／拒絕邊界。
- Scene-aware detail planning 會保留 scene／ISO context，並對 sharpening／noise
  reduction 控制做 bounds 與保守 dependency 檢查，也提供 deterministic readback
  helper 與完整 capability 宣告。AI Denoise 刻意不加入；在每張照片的 evidence
  完成前 detail propagation 仍禁止，而目前 adapter 尚無 detail mutation method。
- Context-safe optics planning 將 lens correction、camera profile 與 geometry
  分成不同 bounded operation。Profile name、geometry variant 必須有 backend
  明確宣告，且先具備 read／checkpoint／render prerequisite 與完整 setting
  support 才能進入未來寫入；propagation 仍禁止，目前 adapter 尚無 structured
  optics mutation method。
- Finishing／framing planning 將 vignette、grain、crop、rotation 分成不同
  bounded control，並保留 structured geometry readback。Crop／rotation 一律帶有
  明確的 per-photo human-review requirement；在真實 backend 證明 unrelated state
  preservation 前，propagation 仍禁止。
- Modern Color Grading planning 依 process version 分界，將 shadows、midtones、
  highlights、global wheel、blending、balance 分成獨立 bounded control。Legacy
  split toning 沒有 fallback 路徑；只有 backend 明確宣告所需 process version、
  controls、具體 settings 與 read／checkpoint／render prerequisite，才可進入未來
  execution 評估。Propagation 仍禁止，不支援的 intent 會明確交給人工接手。
- Existing-mask planning 將 Master inspection 與一份已驗證 Workflow Copy 上的單次
  調整分開。Selector 只能用 stable mask id 或唯一名稱；local parameter 有明確
  allowlist 與 bounds，readback 會驗證 geometry、opaque field、其他 mask 與 global
  settings 都被保留。不支援或不確定的 mask state 會交給人工接手，目前 adapter
  尚無 structured mask mutation method。
- Style Prior planning 讓受保護的 explicit preference rule 優先於 learned history，
  並記錄每個 prior 的 evidence、sample count、confidence。History 樣本不足時改用
  confidence 有上限的 general guidance；衝突或沒有 evidence 的結果維持
  review-required。
- Style Memory retrieval 使用 versioned dataset hash，依 lighting、subject、camera、
  lens、ISO、delivery 做 scene-conditioned matching。可選的 perceptual profile 只產生
  relationship，不複製 raw settings；受保護的 natural-skin reference、失敗例、無關
  match 與低 confidence history 都會被排除並留下明確 outcome。
- Style Memory 的 held-out evaluation 將 construction 與 held-out membership 固定在
  shoot 層級，只能從 construction shoots 檢索；failed 或 context 不完整的 held-out
  case 不納入有效 scoring，並回報 population、sample size、evidence confidence、
  failures 與 review outcomes。
- PhotoAgent Bench contract 會固定 dataset 與 split identity，要求 test split 涵蓋
  portrait、landscape、street、night、event、backlight、mixed-light、high-ISO、
  architecture、action 十種條件，並把 failures 與 `REVIEW_REQUIRED` 保留在
  denominator。缺少 case outcome 時一律變成 `REVIEW_REQUIRED`；這層 contract 不宣稱
  已完成真實 visual benchmark。
- common regression gate 會 discovery T30/T32/T34/T36/T38/T40/T42 各自擁有的 suite，
  確認每組仍保有自己的 regression 與 golden-vector tests；另外用 compatibility
  matrix 驗證 capability、trust、operation 與 major version，缺 suite、compatibility
  failure 或 workflow evidence 失敗時會 fail closed。
- evaluator calibration 會明確記錄 blinded randomized pair、benchmark/dataset identity、
  provider/model 與 human-label provenance，回報 agreement、unacceptable-result、review、
  convergence、recovery、缺 label 與缺 observation；不會把 model output 當成 human
  ground truth，真實真人校準仍是另外的 acceptance gate。
- provider adapter 現在提供 sparse、versioned capability manifest 與 generic structured-result
  contract。Mock、Codex-local、OpenAI analysis path 都會揭露 data boundary；不支援的
  comparison／ranking／planning／evaluation capability 會在 provider execution 前 fail
  closed，既有 OpenAI cloud-preview explicit opt-in 不變。
- local-model experiment boundary 使用注入的 local VLM runner，只把呼叫端提供的
  sanitized-preview path 傳給本機 runner，能力固定為 local-only 的 analysis，並驗證
  structured intent；quality、latency、hardware 限制要明確記錄，不會補造 evidence。
  這個 contract 本身不宣稱已有可用的 local model runtime 或品質結果。
- Privacy policy 現在是 versioned runtime contract：`local_only`、cloud preview、
  RAW、EXIF、GPS 權限彼此獨立；provider boundary manifest 會在 ingest/provider
  execution 前檢查；session manifest 只記錄 crossing 的 boolean；`ephemeral`
  retention 會在 workflow 後移除 session 內產生的 preview 圖片。既有
  `--allow-cloud-preview` 仍是明確的 preview-only 相容路徑。
- Anthropic adapter 已接上共用的 structured provider contract；只有明確允許
  cloud preview 時才送出 sanitized preview，provider payload 與 credential 不會進入
  durable artifact。真實 Anthropic API 與品質 evidence 要等獲授權的 experiment，
  目前仍未驗證。
- provider benchmark comparison 現在要求 OpenAI、Anthropic 與 local experiment
  使用同一個 frozen PhotoAgent Bench identity 與同一份 active privacy policy。每個
  run 都明確保存 provider/model、adapter/prompt 版本、cost／latency 狀態、schema
  compatibility、failure、review rate 與 denominator；這個 contract 不宣稱三個真實
  provider run 已經執行。
- 第三方 backend/provider plugin 現在使用嚴格的有版本 manifest 與公開的
  `manifest`／`create()` 模組契約。能力可以是 sparse，但缺少 workflow 要求的
  operation、trust boundary 不符或 core API major 不相容，都會在建立 adapter 前
  fail closed。XMP backend 是只建立新 sidecar 的範例，輸出會記錄
  `REVIEW_REQUIRED`，不會冒充視覺接受。
- 單張 apply 會先唯讀並驗證 Master；只有明確允許 apply 且計畫含可執行調整時，
  才建立一份帶 session 標記的 Workflow Copy。checkpoint、Develop mutation、讀回與
  render 只會指向已驗證的 Copy。dry-run／no-op 不會建立 Copy；輸入已是 Virtual
  Copy 或身分不確定時會停在 `REVIEW_REQUIRED`。
- 在 apply／recover／propagation 路徑進行任何 backend 讀取、checkpoint、mutation
  或 render 前，PhotoAgent 會先執行有版本的 MCP capability handshake。它從連線的
  server 真實取得版本、工具、信任邊界與 operation-semantics metadata；major 不相容、
  identity／trust 不符、manifest 格式錯誤或該路徑缺少必要 operation 時會 fail closed。
  自動化測試使用 Mock 與記憶體內 fake MCP server；真實 Lightroom 的 handshake 驗收仍未驗證。
- XMP fallback 只會建立新的 sidecar，並拒絕覆寫既有 sidecar 或來源檔案。
- `lightroom-mcp-john` 是外部 backend checkout；照片工作流程不會修改該 checkout。實際執行 Lightroom 時仍應使用非關鍵測試照片。

## 安裝與驗證

需要 Node.js 24 以上：

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd run lint
npm.cmd test
npm.cmd run build
npm.cmd run example
```

`npm.cmd run example` 是 clean clone 的 smoke 測試：它會在本工作區
`_agent_workspace` 底下的 per-run scratch 目錄建立合成 RAW／預覽圖，使用 mock
provider/backend 執行文件中記載的單張流程，恢復一個模擬中斷的 session，確認結果為
`ACCEPTED`、render 與 recovery report 都存在，驗證兩個來源 fixture 仍逐 byte 相同，
最後刪除該次執行目錄。Hosted CI 會透過 `PHOTO_AGENT_EXAMPLE_ROOT` 提供 ephemeral
runner 目錄作為 CI 專用等價路徑。

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

T09 clean-clone 與 live evidence 的驗收邊界，請見 [T09 evidence pack](docs/acceptance/t09-clean-clone-and-live-evidence.md)。

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

若 Copy 可能已建立、但回應中斷前尚未持久化 Copy 身分，recovery 會保留相同的
operation intent，先讀回記錄的 Master，再以相同 operation ID 呼叫明確標示為唯讀的
`reconcile_workflow_copy` 查詢，並驗證只得到同一份 persistent Copy。若 backend 沒有
這項唯讀能力，或讀回證據不足，就停在 `REVIEW_REQUIRED`，不會再呼叫
`create_virtual_copy`。若已有記錄，則只讀該 catalog ID，核對 Copy UUID 與 Master 關係。Develop mutation 與 Checkpoint
不會重送。每次執行會在 `recovery/` 新增獨立 JSON report，不覆寫原本的 Copy、
operation、Checkpoint、read-back 或錯誤證據。report 會解析每輪 operation intent、
Checkpoint 與已保存的 read-back，再把最後完成狀態和實際 Copy 比對；缺少證據標為
`insufficient`，互相衝突則標為 `contradictory`。

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
- [Plugin contract](docs/plugin-contract.zh-TW.md) — 第三方 adapter 的 manifest、
  trust、capability 與 fail-closed 載入規則。
- [MIT License](LICENSE)。
- [NOTICE.md](NOTICE.md) — `lightroom-mcp-john` 第三方 provenance 說明。
- 英文版：[README.md](README.md)。
