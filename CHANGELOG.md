# 版本更新日誌 (Changelog)

專案名稱：**Safari Mobile WebGPU 超解析度引擎** (`safari-webgpu-superres.user.js`)  
最後更新日期：2026-11-26  
目前版本：**v3.3.2**

---

## [3.3.2] - 2026-11-26
### 新增
- **控制視窗長按拖曳定位**：支援長按控制面板頂部標題列或面板空白處約 `260ms`，即可將整個視窗拖曳至畫面任意位置。
- **拖曳狀態視覺回饋**：標題列新增 `⋮⋮ 長按拖曳` 徽章，進入拖曳狀態時邊框亮起藍紫光暈、徽章切換為 `拖曳中...`。

### 最佳化
- **iPadOS / iOS Safari 觸控手勢防衝突**：
  - 點擊或操作按鈕、滑桿、選項時不觸發視窗拖曳。
  - 長按未滿 `260ms` 前滑動超過 `10px` 會自動取消長按，保留原本的面板上下捲動體驗。
  - 拖曳進行中於 `window` 層級攔截 `pointermove` / `touchmove` 與長按選單 (`contextmenu`)，避免快速拖曳斷觸或帶動背景頁面捲動。
- **可視區域自動邊界校正**：新增 `clampSheetPos()` 與響應式 `max-width`，螢幕旋轉、分割畫面或關閉後重新展開面板時自動確保視窗不會超出畫面邊界。

---

## [3.3.1] - 2026-11-25
### 修正
- **修正 iOS 內建螢幕錄影錄製 SDR 影片畫面變暗的問題**：
  - 查明 WebGPU Canvas 預設啟用 `rgba16float` + `toneMapping: 'extended'`（Apple EDR）會觸發 iOS ReplayKit 對 SDR 內容執行 HDR→SDR 壓暗轉換。
  - 預設輸出色彩改回標準 **SDR 8-bit (`bgra8unorm`)**，確保螢幕錄影與一般 SDR 影片亮度完全正常。

### 新增
- **動態色彩空間切換 (`configureColorSpace`) 與選用 EDR 開關**：新增「Apple 真 EDR 實體高光」獨立開關（預設關閉），於引擎中快取 `finalPipelineSdr` 與 `finalPipelineEdr` 雙管線，可於執行中即時切換而不中斷播放。

---

## [3.3.0] - 2026-11-25
### 新增
- **第三方動漫網站 CORS 跨網域限制兩段式相容機制**：
  - **自動 Safari GPU 合成器降級**：當 `copyExternalImageToTexture` 因網站未開放 CORS 而被瀏覽器安全策略阻擋時，自動切換為瀏覽器原生 SVG `<feConvolveMatrix>` 銳化濾鏡搭配 CSS 色彩強化，維持可用畫質增強。
  - **一鍵標準 CORS 重新載入 (`tryEnableCorsReload`)**：於面板提供重試按鈕，以標準 `crossOrigin="anonymous"` 嘗試重新載入影片串流以解鎖完整 WebGPU 管線；內建 `4.5s` 逾時保護與失敗自動回滾原播放進度機制，不破壞播放體驗。

---

## [3.2.1] - 2026-11-25
### 修正
- **徹底修正 Anime4K 輪廓模式造成線條變粗、重影與糊化的問題**：
  - 修正梯度方向回採樣符號錯誤（原本 `uv + dirN * pushPx` 會將線條向外膨脹，改為 `uv - dirN * pushPx` 將背景向邊緣內拉以正確收細線條）。
  - 補上 `DarkenLines` 墨線加深還原與嚴格 `3×3 min/max` 防振鈴（Anti-Ringing）夾限，避免高對比線條產生白邊或光暈。
- **微調前置雙邊去噪參數**：將 `DENOISE_FS_WGSL` 的 `sigmaRange` 由 `0.042` 收緊至 `0.024`，僅濾除串流蚊式壓縮噪點，保留動漫細髮絲與淡色陰影細節。

---

## [3.2.0] - 2026-11-25
### 新增
- **多核心 WebGPU 超分引擎架構**（借鏡 mpv / madVR 空間與結構重建管線，彌補瀏覽器環境缺乏遊戲 G-Buffer 無法套用 FSR 2/3 的限制）：
  - **SSimSuperRes（預設）**：可選邊緣保持雙邊去噪（`DENOISE_FS_WGSL`）→ `EWA LanczosSharp` 放大（或降頻 4-tap 超採樣）→ 回降參考圖（`SSIM_DOWN_FS_WGSL`）→ SSIM 區域均值／變異數結構反演 + 1px AMD CAS（`SR_FINAL_FS_WGSL`）。
  - **Anime4K 輪廓模式**：針對二次元線條的梯度邊緣重建核心。
  - **AMD FSR 1.0 模式**：保留經典 `FsrEasuF` 邊緣自適應放大 + 2px 亮度去模糊 + 1px AMD CAS 管線。
- **可選串流壓縮去噪開關**：針對 YouTube H.264 / VP9 壓縮噪點提供獨立開關，避免銳化放大噪點。

---

## [3.1.0] - 2026-11-25
### 修正
- **修正「原畫對比」左側原畫比真實影片更模糊的失真問題**：
  - 一般視窗模式下改用 CSS `clip-path: inset(0 0 0 ${pct}%)` 直接裁切覆蓋層 `<canvas>`，讓左側直接透出未經二次採樣的原生 Safari `<video>` 畫面，並搭配獨立分隔線覆蓋層；網頁偽全螢幕模式下改採 4-tap 著色器原畫採樣對比。
- **強化 SDR→HDR 逆向色調映射效果**：
  - 升級線性光逆向色調映射曲線、加入 `5×5` 區域對比強化與膚色保護鮮豔度提升，提供 `0 / 1 / 2` 三段強度切換與高光動態範圍支援。

---

## [3.0.0] - 2026-11-25
### 移除
- **全面移除補幀功能（光流與 RIFE）**：依實測回饋，瀏覽器端即時 AI 補幀實用性低且耗能，精簡架構並專注於超解析度與 SDR→HDR 畫質引擎。

### 修正與重構
- **徹底解決早期版本超分反而變模糊的問題**：
  - 鎖定 `<canvas>` 為 **1:1 物理 Retina 像素對應**（`window.devicePixelRatio * visualViewport.scale`），避免 Safari 合成器對高解析度畫布二次雙線性縮放抹糊 1px 銳化細節。
  - 當輸出解析度小於等於來源解析度（`outW <= srcW`）時，自動切換為 4-tap 區域超採樣路徑。
  - 修正 FSR 1.0 `FsrEasuF` 視窗截斷（`min(d2, clp)`）與 RCAS 負分母符號錯誤。
  - 修正 WebKit WGSL 嚴格語法相容問題（動態索引陣列改用 `var`、`pow()` 底數防 `NaN` 夾限、`textureSampleLevel(..., 0.0)` 與 `textureLoad(..., 0)` 精確取樣）。
- **新增 3 檔畫質預設（自然 / 均衡 / 極致）與網頁偽全螢幕模式**。

---

## [1.2.0] - 2026-11-25
### 修正
- 修正 iPadOS Safari 上 Shadow DOM 內隱藏 `<input type="file">` 無法點擊與無法選取 `.onnx` 模型檔的問題（移至 Shadow DOM 外並移除 `accept` 限制）。
- 改以串流 `fetch()` 搭配狀態提示框取代原 `GM.xmlHttpRequest` 主路徑，改善行動版 Safari 相容性。

---

## [1.1.0] - 2026-11-25
### 修正
- **修正 YouTube 懸浮按鈕無法顯示的問題**：全面移除 `innerHTML` 改以純 DOM (`document.createElement` / `textContent`) 建構 Shadow DOM UI，100% 相容 YouTube Trusted Types CSP 安全政策。
- 移除 header 中會造成載入阻塞的 `@require` 外部相依，改為零外部依賴 (`@grant none`)。

---

## [1.0.0] - 2026-11-25
### 新增
- 初版發布：針對行動版 Safari / iPadOS `Userscripts` 擴充套件打造的 WebGPU 影片超解析度與補幀實驗原型。
- 建立事件驅動渲染（`requestVideoFrameCallback`）、浮動控制按鈕與 Shadow DOM 設定面板基礎架構。
