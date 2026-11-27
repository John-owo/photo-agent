# 局部遮罩與過夜批次修圖

這份文件說明 photo-agent 的兩個新能力：

1. **幾何局部遮罩**：放射狀（`Mask/CircularGradient`）與線性漸層（`Mask/Gradient`）。
2. **過夜批次**：睡前在 Claude Code 或 Codex 下一句指令，agent 自己看圖、決定調整與遮罩、套用、渲染、檢查、微調，早上看晨間報告。

英文摘要見 [masks-and-overnight.md](masks-and-overnight.md)。

## 相依條件

| 項目                   | 需要的版本                                                                                                 | 狀態                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------ |
| lightroom-mcp 遮罩寫入 | `feat/set-develop-masks`（[John-owo/lightroom-mcp#15](https://github.com/John-owo/lightroom-mcp/pull/15)） | 尚未合併                       |
| lightroom-mcp 遮罩讀回 | `feat/mask-readback`（疊在 #15 之上的 PR）                                                                 | 尚未合併                       |
| Lightroom 外掛         | 上述分支的 `plugin/LightroomMCP.lrplugin` 需安裝到 Lightroom                                               | 需手動安裝並重新啟動 Lightroom |

後端能力是在 handshake 時偵測的，不靠設定：

- `set_develop_settings` 的 input schema 接受 `MaskGroupBasedCorrections`，就代表可以**寫入**遮罩（`apply_geometric_mask`）。
- `get_photo_metadata` 的 tool `_meta` 帶有 `io.github.john-owo.lightroom-mcp/mask-readback` `{version: 1}`，就代表可以**讀回**遮罩（`read_geometric_masks`）。
- `search_photos` 可用時，photo-agent 會把 RAW 路徑解析成 catalog ID，所以批次時不必手動給 `--photo-id`。

舊版後端沒有遮罩能力時，photo-agent 會**降級為只做全域調整**，並把原因寫進 `masks/mask-decision.json`、`iteration-report.json` 和晨間報告。

## 遮罩意圖（AI 寫什麼）

AI 不會直接寫 Lightroom 的原始 table。它只寫語意意圖，由確定性 translator 轉換：

```json
{
  "id": "face",
  "target": "左側背光的人臉",
  "region": {
    "type": "radial",
    "center_x": 0.3,
    "center_y": 0.4,
    "width": 0.2,
    "height": 0.3,
    "angle_deg": 0,
    "feather": 70,
    "invert": false
  },
  "adjustments": [
    { "parameter": "exposure", "direction": "increase", "strength": "medium" },
    { "parameter": "shadows", "direction": "increase", "strength": "slight" }
  ],
  "placement_certainty": "clear",
  "rationale": "人臉比背景暗約一檔",
  "confidence": 0.85
}
```

- 座標是整張畫面的比例：x 由左（0）到右（1），y 由上（0）到下（1）。
- 線性漸層用 `full_x/full_y`（效果 100%）到 `zero_x/zero_y`（效果 0%），點可以稍微超出畫面。
- 每張照片最多 3 個遮罩，每個遮罩最多 4 個參數。可用參數：exposure、temperature、tint、contrast、highlights、shadows、whites、blacks、texture、clarity、dehaze、saturation（Lightroom 沒有局部 vibrance）。
- `placement_certainty: "subjective"` 代表位置是美學判斷，或區域邊界在預覽裡看不清楚。

## Translator 規則（已實測的 Lightroom 特性）

| 規則                                    | 實作                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `Flipped: true` 才作用在橢圓內          | `invert: false` 會寫成 `Flipped: true`；暗角這類 `invert: true` 寫成 `Flipped: false` |
| `LocalExposure2012` 約等於 EV / 4       | 曝光強度先換算成 EV（slight 0.15、medium 0.3、strong 0.5），再除以 4                  |
| 其他局部參數是 -1 到 1，0.1–0.15 就有感 | slight 0.08、medium 0.15、strong 0.25                                                 |
| 強度上限                                | 局部曝光最多 ±0.75 EV；其他參數最多 ±0.35                                             |
| 寫入會整組取代                          | 寫入前一定先讀回、合併（見下節）                                                      |

## 合併與安全

- photo-agent 一律只寫自己建立的 **Workflow Copy（虛擬複本）**，原始照片（Master）不會被改動。
- 自己寫的遮罩以 `CorrectionName = "photo-agent:<session_id>:<mask_id>"` 標記，其他遮罩一律視為使用者的遮罩：
  - **能讀回時（`merge_readback`）**：先讀出複本上既有的遮罩，保留所有使用者遮罩、只替換本 session 的遮罩，寫入後再讀回比對。
  - **使用者遮罩含筆刷、AI 或範圍遮罩時**：lightroom-mcp 只接受幾何遮罩，原樣寫回會失敗，所以不寫遮罩，降級為全域調整。
  - **讀回結果是 `absent`（Lightroom 沒回傳遮罩 key）**：分不出「沒有遮罩」和「這版 Lightroom 不提供」，不會當成空集合，改走下面的「無法讀回」規則。
  - **後端無法讀回時（`replace_unverified`）**：互動模式下不寫遮罩。無人值守模式或加 `--allow-mask-replace` 時，若 RAW 旁的 XMP sidecar 沒有遮罩紀錄才寫，並記錄 `before_status: "unverified_assumed_empty"`。這時被覆蓋的只會是複本繼承來的遮罩，Master 上的仍在。
- 每次寫入前都會先存 `masks/iteration-N-intent.json`（含寫入前完整遮罩集合），寫完再存 `masks/iteration-N-result.json`。
- `recover` 會讀這些紀錄：只有 intent、沒有 result 時回報 `mask_write_outcome_uncertain`；能讀回時會比對 Lightroom 現況。它**永遠不會重試寫入**。
- Lightroom 的 develop checkpoint 存不了遮罩，所以另外提供還原指令：

```powershell
node dist\src\cli.js restore-masks --session <SESSION_DIR> --iteration 1 --backend lightroom
```

這會把該次寫入前的遮罩集合寫回同一個複本，並重新驗證複本身分。

## 評估器怎麼判斷遮罩

評估時會把每個遮罩的位置、範圍與強度（曝光以 EV 表示）一起交給評估者，評估者要對每個遮罩回 `mask_feedback`：

| assessment    | 意義                             | photo-agent 的處理                                       |
| ------------- | -------------------------------- | -------------------------------------------------------- |
| `ok`          | 自然、有幫助                     | 保留                                                     |
| `too_strong`  | 光暈、硬邊、色塊、亮度或顏色斷層 | 下一輪所有局部值減半，太小就移除                         |
| `unnecessary` | 看不出差別                       | 下一輪移除                                               |
| `misplaced`   | 落在錯的區域、切過主體           | 互動模式：停下來 `REVIEW_REQUIRED`；無人值守：移除後繼續 |

`accept` 必須所有遮罩都是 `ok`。評估者不能新增遮罩，只能調整既有的遮罩。

## 互動模式與無人值守模式

|                      | `--mode interactive`（edit-one／resume 預設） | `--mode unattended`（batch 預設）      |
| -------------------- | --------------------------------------------- | -------------------------------------- |
| `subjective` 遮罩    | 先擱置，等 `--approve-masks <id,…\|all>`      | 照樣套用（有強度上限），交給評估器把關 |
| 後端無法讀回遮罩     | 不寫遮罩                                      | XMP sidecar 沒有遮罩紀錄時可以寫       |
| 評估器說 `misplaced` | 停下等你看                                    | 移除該遮罩後繼續                       |

## 過夜批次：睡前一句指令

### 你要說的話

在 Claude Code 或 Codex 裡說，例如：

> 用 photo-agent 過夜修 `D:\photo\2026-11-30 台南`，Lightroom 已開。

agent 會照 [photo-agent skill](../skills/codex/SKILL.md) 的流程做。實際上是 agent 自己看圖，不會呼叫任何視覺模型 API。

### agent 的迴圈

```powershell
# 1. 建立批次（預設 provider=codex、evaluator=handoff、mode=unattended）
node dist\src\cli.js batch --root 'D:\photo\shoot' --backend lightroom --lightroom-mcp-entry '<server>\dist\index.js'

# 2. 讀 <BATCH_DIR>\worklist.md：每一項都列出要看的圖、規則檔和要寫的 JSON 路徑
#    analyze：看預覽，寫 SemanticIntentPlan（可含遮罩）
#    evaluate：看渲染（和原始預覽比較），寫 EvaluationResult（含 mask_feedback）

# 3. 寫完後推進整批，重複 2–3 直到 worklist 是空的
node dist\src\cli.js batch --resume '<BATCH_DIR>' --backend lightroom --lightroom-mcp-entry '<server>\dist\index.js'

# 4. 早上看 <BATCH_DIR>\report.md
```

- 每張照片都有自己的 session、Workflow Copy、intent/readback 證據與 recover 支援。
- 一張失敗不會中斷整批；連續失敗 5 次（可用 `--max-consecutive-failures` 調整）就停止，避免 Lightroom 掛掉時把整個資料夾跑完。
- `batch --resume` 是冪等的：完成的照片跳過；套用到一半中斷的照片只會用 `recover` 讀回，不會重新套用。
- 只有 RAW、沒有 JPEG 的資料夾：batch 會用 Lightroom 匯出一張基準渲染當預覽（新檔，不改 catalog）。
- 晨間報告（`report.md`）列出完成、需要你看、失敗與等 agent 的照片，以及每張的遮罩紀錄（降級原因、減半或移除）。不滿意的照片直接刪掉那張虛擬複本即可。

### 上網找參考

agent 拿不準色調時，可以用自己的網頁搜尋查同類場景常見的調色方式，把參考風格寫進 `creative_goal`。不會去爬 Instagram 圖片：Instagram 需要登入，自動抓圖也違反它的使用條款。

### 選用：不經 agent，直接呼叫模型 API

如果想讓批次完全不需要 agent 盯著，可以改用 API provider。這會把清理過、去除 EXIF 的 JPEG 送到雲端，所以要加 `--allow-cloud-preview`：

```powershell
node dist\src\cli.js batch --root '<DIR>' --provider claude --evaluator claude --allow-cloud-preview --web-references
```

Claude provider 預設模型是 `claude-opus-5-5`（可用 `PHOTO_AGENT_CLAUDE_MODEL` 改），帶伺服器端 web search，並開啟 refusal fallback；認證走 Anthropic SDK 的預設來源，例如 `ANTHROPIC_API_KEY`。OpenAI provider 仍可用（`--provider openai --evaluator openai`）。

## RAW 和相機 JPG 怎麼配對

資料夾怎麼分都可以，不用改成固定結構：

1. 先找同一個資料夾裡的同名 JPG（`DSC_1.NEF` 旁邊的 `DSC_1.JPG`）。
2. 找不到，就從 RAW 所在的資料夾往外一層一層找同名 JPG，最近的那一層優先。`raw\` + `jpg\`、`RAW\` + `JPEG\`、每天一組子資料夾都能配到；同名檔案在別天的資料夾裡也不會搞混。
3. 由 Lightroom、Photoshop、DxO PhotoLab、Capture One、NX Studio 等軟體匯出的 JPG（例如 `修好的\`），檔案裡會寫著匯出軟體，會被排除，不拿來當「修圖前」的參考。
4. 同一層還是有兩張以上，或一張 JPG 被兩個 RAW 搶，就不猜，標成「需要你看」。
5. 沒有相機 JPG 的 RAW，改用 Lightroom 渲染一張當預覽。

## 挑片、副本命名與尼康配方

### 只修挑過的照片

`batch` 預設會修資料夾裡每一張 RAW。在 Lightroom 先挑片，再加篩選：

```powershell
node dist\src\cli.js batch --root '<DIR>' --backend lightroom --only-picked      # 只修標為「留用」的
node dist\src\cli.js batch --root '<DIR>' --backend lightroom --min-rating 3     # 只修 3 星以上
```

有加篩選時，標為「排除」的照片一律跳過。排除了幾張、哪些不在目錄裡，晨間報告開頭會寫。

### 副本叫 v1、v2、v3

副本建立並驗證身分後，photo-agent 會把它改名成同一張原圖底下下一個沒用過的 `vN`。改名是「比對後才寫」：副本名字必須還是建立時的標記，否則不改。photo-agent 之後用目錄 ID 和 UUID 辨認副本，不靠名字。需要 lightroom-mcp 的 `rename_virtual_copy`（`feat/virtual-copy-rename`）；舊版會保留原本的標記名稱。`--no-version-names` 可關閉。

### 從尼康配方的色調開始修

Lightroom 不會套用 NEF 裡的尼康配方，所以預設渲染和相機 JPG 差很多（實測 DSC_8447 平均差 19.2，套用配方描述檔後 2.8，0–255 刻度）。

1. 建批次時，photo-agent 用 exiftool 讀每張 NEF 的相機型號和 Picture Control（配方）名稱。
2. 到 `%APPDATA%\Adobe\CameraRaw\Settings` 找相符的 Look 描述檔（由 `nikon-recipe-acr-profile` skill 產生，名稱含配方名、相機限制相符）。
3. lightroom-mcp 不能直接設描述檔，所以 photo-agent 寫一個只設定這個描述檔的預設 `photo-agent recipe <描述檔>`（放在 `Settings\photo-agent\`）。**新預設要重開 Lightroom 才會載入。**
4. 每張副本改名後、第一次調整前，先套用這個預設。

批次輸出的 `recipes` 會列出 `missing_profiles`（沒有描述檔的配方與張數）。人還在的話，agent 會問要不要先用 `nikon-recipe-acr-profile` 做描述檔（需要至少 12 組用該配方拍的 RAW+JPG，約 15–25 分鐘）；過夜時就照常修，那些照片從 Adobe 預設色彩開始，晨間報告會寫。`--no-recipe` 可關閉。

限制：Lightroom 的檢查點存不了描述檔，`restore-masks` 和檢查點還原都不會拿掉描述檔；刪掉副本即可。

## 不在範圍內：筆刷與 AI 遮罩（調查筆記）

- **AI 遮罩**（選取主體、天空、人物）：Lightroom 存的是 AI 運算結果的參照，`applyDevelopSettings` 不會重新計算，寫進去不會生效。不實作。
- **筆刷**（`Mask/Paint`）：遮罩是一串手繪筆觸（dabs）資料。目前沒有驗證過 Lightroom SDK 會不會接受外部產生的筆觸，lightroom-mcp 的寫入驗證也明確拒絕 `Mask/Paint`。若要做可行性研究：先用 `get_photo_metadata` 讀回一個人工畫的筆刷遮罩，看 dabs 格式；再在可拋棄的虛擬複本上原樣寫回，比對渲染。這需要改 lightroom-mcp 的寫入白名單，而且要先實機驗證，目前**沒有做**。
- **範圍遮罩**（亮度、色彩範圍）：會巢狀在 correction 裡；lightroom-mcp 只接受純量欄位，所以使用者照片上若有這類遮罩，photo-agent 會降級為全域調整，不會把它們洗掉。

## 驗證狀態

- 自動化（mock 後端，無 Lightroom）：遮罩轉換、合併、降級、讀回不一致、recover、restore-masks、評估交接、批次推進與晨間報告都有測試。
- lightroom-mcp 讀回的 Lua 部分：用 fengari（Lua 5.3 的 JS 實作）跑了相關 spec，通過；Lightroom 本身用的是 Lua 5.1，正式 CI 還沒跑。
- 實機 Lightroom（2026-11-27，DSC_8446–8448）：遮罩寫入與讀回、副本改名成 v1/v2、配方預設套用、評估交接都跑通，3 張都通過；細節見 WORKLOG。
