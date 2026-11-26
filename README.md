# Safari Mobile WebGPU 超解析度引擎 (`safari-webgpu-superres`)

![Version](https://img.shields.io/badge/version-v3.3.2-6366f1)
![Platform](https://img.shields.io/badge/platform-iOS%20%7C%20iPadOS%20%7C%20macOS%20Safari-007aff)
![WebGPU](https://img.shields.io/badge/engine-Pure%20WebGPU%20WGSL-10b981)
![Zero Dependencies](https://img.shields.io/badge/dependencies-none%20(%40grant%20none)-f59e0b)

專為 **iPhone、iPad（iOS / iPadOS）與 Mac Safari** 打造的零外部依賴純 **WebGPU** 即時影片超解析度與 **SDR → HDR（選用 Apple 真 EDR）** 畫質增強腳本。

突破傳統單純銳化與 AMD FSR 1.0 的限制，借鏡 `mpv` / `madVR` 高階播放器的空間結構重建管線，內建 **SSimSuperRes**、**Anime4K 輪廓重建** 與 **AMD FSR 1.0** 三大核心，支援 1:1 物理 Retina 像素點對點渲染、串流蚊式噪點抑制、原畫即時分割對比，以及 iOS 螢幕錄影不壓暗的標準 SDR 8-bit 預設輸出。

---

## 📁 專案檔案一覽

| 檔案 | 說明 |
| :--- | :--- |
| [`safari-webgpu-superres.user.js`](./safari-webgpu-superres.user.js) | **主程式 Userscript 腳本（目前版本：v3.3.2）** — 可直接放入 `Userscripts` 資料夾或一鍵安裝 |
| [`CHANGELOG.md`](./CHANGELOG.md) | **完整版本更新日誌**（記錄 `v1.0.0` ～ `v3.3.2` 架構演進與問題修復細節） |
| [`README.md`](./README.md) | **專案介紹、Userscripts App 安裝教學與網頁實操完整指南** |

👉 **GitHub Raw 直連下載／一鍵安裝網址：**
```text
https://raw.githubusercontent.com/joey971018yt/safari-webgpu-superres/main/safari-webgpu-superres.user.js
```

---

## ✨ 核心功能亮點

- **三大 WebGPU 超分核心即時切換**
  1. **`SSimSuperRes`（預設推薦）**：採用 `libplacebo EWA LanczosSharp` 無鋸齒升頻 → 回降模擬低解析基準圖 → 計算 `3×3` 高斯局部均值與變異數進行 **SSIM 結構相似度反演重建** + `1px AMD CAS` 精細銳化。自然還原縮放流失的真實紋理，零人工白邊。
  2. **`Anime4K 輪廓`（2D 動漫專用）**：針對串流動漫發虛線條進行 Sobel 梯度方向反向取樣收細（`ThinLines`）+ 發灰墨線谷底加深還原（`DarkenLines`）+ 嚴格 `3×3` 防振鈴（Anti-Ringing）夾限，線條俐落不變粗、無重影光暈。
  3. **`AMD FSR 1.0`**：經典 `FsrEasuF` 12-tap 邊緣自適應放大 + `2px` 多尺度亮度去模糊 + `1px AMD CAS`，GPU 負載極低。
- **串流壓縮去噪預處理**：內建輕量級 `3×3` 邊緣保持雙邊濾波（`sigmaRange = 0.024`），精準撫平 YouTube H.264 / VP9 蚊式壓縮噪點，絕不糊化動漫細髮絲與淡色陰影。
- **1:1 物理 Retina 像素對齊**：自動計算 `devicePixelRatio × visualViewport.scale`（上限 `3840×2160`），杜絕 Safari 合成器二次雙線性縮放抹糊細節；當顯示區域小於影片原解析度時自動改走 4-tap 超採樣抗鋸齒。
- **電影級 SDR → HDR 逆色調映射 & 選用 Apple 真 EDR**：
  - 預設以標準 **SDR 8-bit (`bgra8unorm`)** 輸出，**使用 iOS / iPadOS 內建螢幕錄影與截圖時 100% 維持正常亮度不變暗**。
  - 開啟 HDR（支援線性光局部對比強化與人像膚色保護）時，可自由一鍵開啟 **Apple 真 EDR (`rgba16float` + `extended`)**，在 XDR / OLED 螢幕上釋放超過 SDR 白點上限的真實高光。
- **第三方網站跨網域 (CORS) 兩段式相容機制**：若影片網站未開放跨網域像素讀取，自動降級為 **Safari GPU 合成器銳化備援**（SVG `<feConvolveMatrix>` + CSS 色彩增強），並提供「**一鍵標準 CORS 模式重載**」（附 4.5 秒逾時與自動回滾原播放進度）。
- **行動端觸控最佳化 UI（v3.3.2）**：零 `innerHTML` 純 Shadow DOM 介面（100% 相容 YouTube Trusted Types CSP 安全政策），支援**懸浮球自由拖曳**與**設定面板長按 `260ms` 任意拖曳定位**、防誤觸捲動保護及螢幕旋轉自動邊界校正。

---

## 🛠️ 前置準備：確認 Safari WebGPU 已開啟

* **系統需求**：iOS / iPadOS 17.4 以上，或 macOS Sonoma / Sequoia / Tahoe 以上之 Safari 瀏覽器。
* **Safari WebGPU 開關檢查**：
  * **iOS 26 / iPadOS 26 / macOS 26 以上**：Safari 已預設開啟 WebGPU，可直接跳至下方安裝步驟。
  * **iOS 17.4 ～ iOS 18.x / iPadOS 17.4 ～ 18.x**：
    1. 打開系統「**設定 (Settings)**」→ 滑到最下方點選「**App**」→「**Safari**」（iOS 17 請直接在設定列表點選「**Safari**」）。
    2. 滑到最底部點選「**進階 (Advanced)**」→「**Feature Flags**」。
    3. 在頂部搜尋欄輸入 `WebGPU`，將 **`WebGPU`** 開關打開（若有 `WebGPU HDR` 建議一併開啟），完成後上滑關閉 Safari 再重新打開。
  * **macOS Safari（若舊版未預設開啟）**：Safari 頂部選單列「設定」→「進階」勾選「顯示網頁開發者功能」→ 選單列「開發 (Develop)」→「Feature Flags」→ 搜尋並勾選 `WebGPU`。

---

## 📦 安裝教學（下載 Userscripts App 與放入資料夾）

在 iPhone / iPad / Mac 的 Safari 上，推薦使用開源、完全免費無廣告的 **[Userscripts](https://apps.apple.com/app/userscripts/id1463298887)** 擴充套件來載入本腳本。

### 步驟一：下載並設定腳本存放資料夾

1. 前往 App Store 搜尋並下載 **[Userscripts](https://apps.apple.com/app/userscripts/id1463298887)**（開發者：Justin Wasack / Quoid，圖示為深色背景搭配 `</>` 符號）。
2. 下載完成後，打開主畫面上的 **Userscripts App**。
3. 點擊畫面中的「**Set Userscripts Directory**」（或「**Change Userscripts Directory**」）按鈕，指定你要用來存放腳本的資料夾：
   * **單機使用**：在「檔案」選擇視窗中，選取 `我的 iPhone`（或 `我的 iPad`）底下的 `Userscripts` 資料夾，點擊右上角「**打開 (Open)**」。
   * **多機同步（推薦同時有 iPhone / iPad / Mac 的使用者）**：在 `iCloud 雲碟 (iCloud Drive)` 中新增一個名為 `Userscripts` 的資料夾並選取它，點擊右上角「**打開 (Open)**」。

### 步驟二：在系統設定啟用 Safari 延伸功能權限

1. 打開裝置的「**設定 (Settings)**」→（**App** →）「**Safari**」→ 點選「**延伸功能 (Extensions)**」。
2. 點進「**Userscripts**」，將「**允許延伸功能**」開關打開（若你常使用無痕模式看片，請同步打開「**在私密瀏覽中允許**」）。
3. 在下方網站權限區塊，將「**所有網站 (All Websites)**」（或特定影片網站如 `youtube.com`）設為「**允許 (Allow)**」。

### 步驟三：將本腳本放入資料夾（兩種方式任選其一）

#### 方式 A：下載 `.user.js` 檔案手動放入資料夾（最直覺穩定、推薦）

1. 在 Safari 開啟本專案的 [`safari-webgpu-superres.user.js`](./safari-webgpu-superres.user.js) 頁面點擊右上角 **Download raw file（下載圖示）**，或是長按以下連結選擇「**下載連結檔案**」：
   * [點此下載 `safari-webgpu-superres.user.js`](https://raw.githubusercontent.com/joey971018yt/safari-webgpu-superres/main/safari-webgpu-superres.user.js)
2. 打開 iPhone / iPad 內建的「**檔案 (Files)**」App，進入「**下載項目 (Downloads)**」找到剛下載的 `safari-webgpu-superres.user.js`。
   > 💡 **檔名檢查小提醒**：少數情況下若 Safari 自動在結尾多加了 `.txt`（變成 `safari-webgpu-superres.user.js.txt`），請長按檔案 → 點選「**重新命名**」，把最後面的 `.txt` 刪掉，確保檔名以 **`.user.js`**（或 `.js`）結尾。
3. 長按 `safari-webgpu-superres.user.js` → 點選「**移動 (Move)**」，將檔案移入你在**步驟一**設定好的 **`Userscripts` 資料夾**中。
4. 回到 Safari 打開任意網頁，點擊網址列旁的「**拼圖圖示 🧩**」（或左側選單按鈕）→ 點選「**Userscripts**」，確認清單中已出現 **`Safari Mobile WebGPU 超解析度引擎`** 且處於啟用狀態，即完成安裝！

#### 方式 B：透過 Safari 擴充彈窗一鍵安裝

1. 完成步驟一與步驟二後，直接在 Safari 點擊打開 [Raw 腳本直連頁面](https://raw.githubusercontent.com/joey971018yt/safari-webgpu-superres/main/safari-webgpu-superres.user.js)（畫面會顯示純文字程式碼）。
2. 點擊 Safari 網址列旁的「**拼圖圖示 🧩**」→ 點選「**Userscripts**」。
3. 擴充視窗上方會跳出 **`Tap to install`** 提示列，點擊後將說明拉到底部並按下「**Install**」，Userscripts 就會自動把檔案寫入你指定的資料夾並立即生效！

---

## 🎮 網頁實操使用說明（實戰操作指南）

安裝完成後，使用 Safari 前往 YouTube、Bilibili、動畫瘋或任何含有 `<video>` 播放器的影片網站，即可依照下列步驟操作：

### 1. 呼叫懸浮球與自由擺放面板

* **懸浮按鈕（FAB）**：網頁載入完成後，畫面右下角會出現「**⚪ GPU 超分**」半透明膠囊按鈕。
  * **移動懸浮球**：手指直接按住「GPU 超分」膠囊即可拖曳至畫面任意邊角，避免遮擋字幕或播放器進度條。
  * **展開／收合面板**：輕點一下膠囊即可展開「**WebGPU 超分引擎 v3.3.2**」控制面板；點擊面板右上角 `✕` 或再點一次膠囊即可收起面板（收起面板後，超分仍會在背景持續運作）。
* **長按拖曳整個控制面板（v3.3.2 新功能）**：
  * 手指**長按面板頂部標題列**（標有 `⋮⋮ 長按拖曳`）或**面板內空白處約 `0.26 秒`**，面板邊框會亮起藍紫光暈且徽章變為 `拖曳中...`（支援震動回饋），此時即可將整個設定視窗拖曳到畫面角落，邊看影片人物臉部／字幕細節、邊即時拉動滑桿調校！
  * 若手指按住未滿 `0.26 秒` 就直接上下滑動，則會保持原本順暢的面板內部上下捲動，完全不會誤觸拖曳。

### 2. 啟動超分與判讀即時狀態列

1. 先在網頁上**點擊播放影片**（確保影片已載入畫面幀）。
2. 打開控制面板，點擊藍色主按鈕「**啟動 WebGPU 超分**」。啟動成功後，右下角膠囊會亮起綠燈顯示「**🟢 超分中**」，主按鈕也會切換為紅色「**停止超分**」。
3. 面板上方的狀態資訊列會即時回報三項數據：
   * **`FPS`**：目前實際每秒超分渲染幀數。引擎採 `requestVideoFrameCallback` 事件驅動架構，30fps 影片只渲染 30 次、60fps 渲染 60 次，**暫停影片時自動降為 0 FPS 零耗電待機**。
   * **`1:1 Retina`**：顯示 `原始影片解析度 → 物理畫布解析度`（例如 `1280×720 → 2420×1361`），代表已精確鎖定螢幕物理像素點對點輸出。
   * **`輸出色彩`**：顯示目前色彩後端（預設為 `SDR 8-bit`；開啟真 EDR 時顯示 `真 EDR (16F)`；跨網域受限時顯示 `合成器濾鏡`）。

### 3. 選擇最適合片源的「超分核心」

切換核心時無須停止播放，畫面會瞬間無縫切換：

| 超分核心 | 最適合的影片類型 | 畫面特性與推薦情境 |
| :--- | :--- | :--- |
| **`SSimSuperRes`** *(預設)* | 真人電影、影集、MV、YouTube 日常影片、實況 | **畫質最自然均衡**：精確補償升頻遺失的高頻結構變異數，毛髮、衣物織紋與文字清晰立體且無銳化白邊。 |
| **`Anime4K 輪廓`** | 2D 新番動畫、手繪卡通、VTuber 切片 | **二次元線條救星**：自動收細因低碼率放大而發糊的粗輪廓線，並將發灰墨線微幅加深還原，呈現宛如原生 4K 的俐落手繪線條。 |
| **`AMD FSR 1.0`** | 3D 遊戲畫面、低功耗省電需求 | **經典邊緣自適應放大**：邊緣銳利度高、著色器運算量最輕，適合長時間觀看或舊機型省電使用。 |

### 4. 超分檔位、壓縮去噪與手動微調滑桿

* **三段快速檔位**：
  * **`1 檔 (自然)`**（重建 `0.50` / 銳化 `0.55`）：適合本身已是高碼率 1080p / 1440p，僅需輕微補足 Retina 螢幕銳利度的片源。
  * **`2 檔 (均衡)`**（重建 `0.85` / 銳化 `0.85`，預設）：適合絕大多數 720p / 1080p 串流影片與新番動畫。
  * **`3 檔 (極致)`**（重建 `1.25` / 銳化 `1.20`）：適合 360p / 480p 懷舊老片或高壓縮模糊片源。
* **`串流壓縮去噪 (去除蚊式噪點)`**：
  * 預設為「**開啟**」，會在放大前先濾除串流平台常見的邊緣蚊式噪點，避免噪點跟著被銳化放大。若觀看極高碼率原盤影片想保留細微底片顆粒感，可點擊切換為「關閉」。
* **進階獨立滑桿（`0.00` ～ `1.50`）**：
  * **`結構重建 / 邊緣收細強度`**：控制 SSimSuperRes 變異數增益、Anime4K 線條收細／墨線加深力道，或 FSR1 去模糊強度。
  * **`1px 精細銳化 (AMD CAS)`**：控制最後一道 AMD 對比自適應銳化，強化極細髮絲與字幕邊緣。

### 5. 「原畫對比」分割線與「全螢幕」實操要點

* **即時原畫對比**：
  * 點擊面板上的「**原畫對比**」按鈕，影片中央會出現一道發光藍線，**左半邊為 100% 未經二次採樣的 Safari 原生影片**，**右半邊為 WebGPU 超分增強畫面**。
  * 下方會同步展開「**對比分割線**」滑桿（`10% ～ 90%`），你可以在影片播放或暫停時左右拉動分割線，直接掃描比對超分前後的眼睛、髮絲與字幕清晰度差異！
* **全螢幕觀看（⚠️ 重要必讀！）**：
  * **請點擊本控制面板內的「全螢幕」按鈕，不要按 YouTube / 影片播放器自帶的全螢幕圖示！**
  * **原因**：在 iOS / iPadOS Safari 中，一旦觸發播放器自帶的「系統原生全螢幕」，系統會將 `<video>` 抽離至獨立系統媒體層，導致網頁上的 WebGPU `<canvas>` 覆蓋層被系統遮擋而看不到超分效果。
  * 使用本面板的「**全螢幕**」按鈕會進入高解析**網頁滿版全螢幕模式**：不僅完整保留 1:1 Retina 超分、對比分割線與控制面板，還支援直接輕點影片畫面切換播放／暫停；想退出時再打開面板點「**退出全螢幕**」即可。

### 6. SDR → HDR 逆色調映射與 Apple 真 EDR 實體高光

* 在面板底部的「**SDR → HDR 逆色調映射**」可選擇：
  * **`關閉`**（預設）：維持原片原始色彩與伽瑪曲線。
  * **`1 檔 (自然 HDR)`**：溫和拉開暗部細節與高光層次，並帶有膚色保護（人臉不會過飽和泛紅）。
  * **`2 檔 (鮮明 XDR)`**：強化局部對比、通透感與高光爆發力，適合風景、舞台演出與特效大片。
* **`Apple 真 EDR 實體高光` 開關（選擇 1 檔或 2 檔 HDR 時顯示）**：
  * **關閉（預設推薦日常／錄影使用）**：採用標準 `SDR 8-bit` 色調映射模擬高動態，**此時使用 iOS 內建螢幕錄影或截圖，錄出來的影片亮度 100% 正常，絕不會變暗或發灰！**
  * **開啟**：動態切換畫布為 `rgba16float` + `toneMapping: extended` 管線，在配備 XDR / ProMotion OLED 螢幕的 iPhone 與 iPad Pro 上激發超越網頁白色上限的真實物理高光。（*註：Apple 系統 ReplayKit 在錄製含真 EDR 圖層的畫面時會套用 HDR→SDR 壓暗轉換，若要螢幕錄影請先將此開關切回「關閉」，可即時無縫切換不中斷播放。*）

### 7. 遇到第三方網站跨網域 (CORS) 限制時的實操方式

部分第三方動漫站或獨立影音站因為 CDN 未標註跨網域標頭，瀏覽器安全機制會禁止 WebGPU 直接擷取 `<video>` 像素。此時本引擎提供兩段式無感應對：

1. **自動切換「Safari GPU 合成器銳化備援」**：面板會顯示提示訊息，輸出色彩變更為 `合成器濾鏡`，自動改用硬體加速 SVG `<feConvolveMatrix>` 捲積銳化搭配 CSS 色彩強化直接作用於原影片。你依然可以調整檔位、滑桿與 HDR 檔位（按「原畫對比」則可一鍵切換有無濾鏡對照）。
2. **一鍵嘗試解鎖完整 WebGPU**：面板上方會出現黃色按鈕「**嘗試以 CORS 模式重載影片（解鎖完整 WebGPU）**」。點擊後腳本會自動記錄當前播放秒數，嘗試以標準 `crossOrigin="anonymous"` 重新請求串流：
   * **若該站 CDN 支援 CORS**：將直接解鎖完整 `SSimSuperRes` / `Anime4K` WebGPU 管線並自動跳回原本的播放時間點！
   * **若伺服器拒絕或超過 4.5 秒**：會自動安全回滾回原播放狀態並維持合成器銳化備援，絕不會讓影片壞掉或卡死。

---

## ❓ 常見問題排解 (FAQ)

<details>
<summary><b>Q1：安裝完打開 YouTube 卻沒看到右下角的「GPU 超分」懸浮按鈕？</b></summary>

1. 點擊 Safari 網址列旁的「**拼圖圖示 🧩**」→「**Userscripts**」，確認頂部開關已開啟，且網站權限已設為「**永遠允許 / 所有網站允許**」。
2. 打開「檔案 (Files)」App 檢查 `Userscripts` 資料夾內的檔案名稱是否為 `safari-webgpu-superres.user.js`（確定沒有變成 `.user.js.txt`）。
3. 重新整理一次網頁（下拉重整或點擊重新載入按鈕）。
</details>

<details>
<summary><b>Q2：點擊啟動時出現「此瀏覽器未啟用 WebGPU」？</b></summary>

請參考上方「[前置準備：確認 Safari WebGPU 已開啟](#-前置準備確認-safari-webgpu-已開啟)」，前往系統「**設定 → (App →) Safari → 進階 → Feature Flags**」開啟 `WebGPU`，接著將 Safari 從背景上滑徹底關閉後重開即可。
</details>

<details>
<summary><b>Q3：為什麼按了播放器右下角的原生全螢幕按鈕後，看不出超分效果？</b></summary>

iOS / iPadOS 的系統原生全螢幕播放器獨立於網頁 DOM 之外，會遮住所有網頁 `<canvas>`。請先退出系統全螢幕，改點開「**GPU 超分**」面板中的「**全螢幕**」按鈕，即可享受滿版 1:1 Retina 超分畫面。
</details>

<details>
<summary><b>Q4：在同一網頁切換下一部影片後，畫面沒跟著更新怎麼辦？</b></summary>

若網站採用同一個 `<video>` 標籤換片（例如大多數 YouTube 切片情境），引擎會自動偵測新解析度並無縫銜接；若部分網站切片時會把舊 `<video>` 刪除並重建新標籤，只需打開面板點一下「**停止超分**」再點「**啟動 WebGPU 超分**」，即可重新綁定至新影片。
</details>

<details>
<summary><b>Q5：日後有新版本時該如何更新？</b></summary>

* **自動檢查更新**：本腳本標頭已內建 `@updateURL`，你可在 Safari 打開「拼圖圖示 🧩 → Userscripts」點擊檢查更新。
* **手動覆蓋**：直接重新下載最新的 [`safari-webgpu-superres.user.js`](https://raw.githubusercontent.com/joey971018yt/safari-webgpu-superres/main/safari-webgpu-superres.user.js) 放入 `Userscripts` 資料夾覆蓋舊檔，重新整理網頁即完成升級。
</details>

---

## 📝 版本更新日誌

目前最新版本為 **`v3.3.2`**（新增控制面板長按 `260ms` 自由拖曳定位、iOS/iPadOS 觸控手勢防衝突與自動邊界校正；`v3.3.1` 修正預設 SDR 8-bit 輸出使 iOS 螢幕錄影完全不變暗並提供獨立真 EDR 開關）。

完整歷代版本更新紀錄請參閱 👉 **[`CHANGELOG.md`](./CHANGELOG.md)**。
