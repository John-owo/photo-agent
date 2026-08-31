# PhotoAgent 插件契約

PhotoAgent 會在 workflow 使用插件前，先讀取並驗證一份有版本的 manifest。
同一個 loader 可以載入 `backend` 與 `provider` 插件；插件只應宣告自己真的
支援的 operation。

## 模組格式

插件模組要輸出兩個值：`manifest` 與 `create()`。manifest 至少包含：

```js
export const manifest = {
  plugin_type: "backend",
  plugin_id: "example-backend",
  plugin_version: "0.1.0",
  core_api_version: "0.1.0",
  capabilities: ["read_current_edit"],
  trust_boundary: {
    transport: "in-process fixture",
    authentication: "none",
    cloud: false,
  },
  operations: {
    read_current_edit: {
      supported: true,
      side_effect: "read_only",
      idempotent: true,
      reversible: "true_undo",
      scope: "photo",
      requires_active_selection: false,
      requires_editor_foreground: false,
      concurrency: "parallel_safe",
      retry_policy: "automatic",
      safe_to_resume: true,
    },
  },
};

export function create() {
  return new ExampleBackend();
}
```

`plugin_version` 是 adapter 自己的版本；`core_api_version` 是它採用的
PhotoAgent 插件 API 版本。loader 只接受相同的 core API major；major 不同時，
會在呼叫 `create()` 前拒絕。`plugin_type`、版本、capability、trust boundary
與 operation semantics 都是嚴格契約，不是可有可無的註解。

## Sparse capability 與 fail closed

插件不支援的 operation 可以完全不放進 `capabilities` 與 `operations`，但不能
把別的 adapter 的能力抄過來。每一個列出的 capability 都必須有
`supported: true` 的 operation semantics。workflow 若要求缺少的 operation，
loader 會在建立 adapter 前停止，並說明應改用哪種插件。

呼叫端要明確指定預期的 trust boundary；插件不能自己偷偷改寫信任邊界。
`transport`、`authentication`、`cloud` 三個欄位都要完全相同。operation
semantics 會描述副作用、可逆性、作用範圍、並行限制、重試政策、恢復安全性，
以及支援的設定 allowlist。

Backend 通常宣告 `read_current_edit`、`create_checkpoint`、`render_preview` 等
編輯器 operation。Provider 可以宣告 `analysis`，若實作 `AnalysisProvider`，還要
另外提供共用的 provider capability/data-boundary manifest。不能因為另一個
adapter 支援 render、讀回、雲端或 mutation，就替目前的插件代稱支援。

## Adapter 安全規則

- 不可破壞來源 RAW、預覽、sidecar 或 export；只能建立新檔或使用明確的
  backend checkpoint，不能覆寫來源或既有 sidecar。
- credential、provider payload、RAW、EXIF、GPS 不得進入 durable artifact。雲端
  預覽必須同時符合 active privacy policy，且只能傳明確允許的 sanitized preview。
- 如果 adapter 不能 render 或讀回編輯器實際解讀結果，要寫進 result/session
  artifact。只建立 sidecar 只能是 `REVIEW_REQUIRED`，不能算視覺接受。
- 不確定的 non-idempotent mutation 不可盲目重試；要先讀回或交人工處理。

可直接參考的社群模板與可執行範例是
`examples/plugins/xmp-sidecar-plugin.mjs` 與
`examples/run-plugin-example.mjs`。它們只使用合成檔案。
