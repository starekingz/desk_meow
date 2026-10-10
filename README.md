# 桌面遊戲喵

以 Electron 製作的 Windows 10/11 桌面遊戲。Google 登入後，玩家頭像球會在螢幕 75% 高度的透明角色層上滾動；一般程式視窗可自然蓋住角色層。好友在線時，位置會透過 WebRTC 直接同步。

## 開始使用

1. 安裝 Node.js 20 以上版本。
2. 執行 `npm install`。
3. 在 [Firebase Console](https://console.firebase.google.com/) 建立專案。
4. 啟用 Authentication → Sign-in method → Google。
5. 建立 Cloud Firestore，將 `firestore.rules` 的內容部署為安全規則。
6. 複製 `.env.example` 為 `.env`，填入 Firebase Web App 設定。
7. 執行 `npm run dev`。

## 操作

- `←` / `→`：沿著地板左右滾動
- `↑` / `↓`：不會移動或飛行
- `Ctrl + Alt + 方向鍵`：備援控制方式
- 點擊螢幕下半部：角色沿地板滾到對應的水平位置；上半部點擊不會移動
- 左鍵點擊自己或好友的角色：顯示名稱與移動速度；滑鼠離開角色 2 秒後面板淡出
- 粉藍流光桌布是選用功能，首次啟動不會修改目前桌布，可在設定面板中自行啟用

直接方向鍵只會在 Windows 桌面位於最上層時啟用；切換到瀏覽器、遊戲或其他程式後會自動解除，回到桌面時恢復。
- `Ctrl + Alt + M`：展開／收合右下角懸浮球設定
- `Ctrl + Shift + M`：備援切換快捷鍵
- `F9`：強制叫回控制視窗

登入後可點擊自己的 UID 來複製，將 UID 傳給好友後即可互相加入。雙方啟動程式時，線上狀態和頭像球位置會自動連線同步。

好友位置使用 WebRTC DataChannel 點對點傳送。Firestore 只保存帳號、好友清單，以及每次建立連線時的一份 offer／answer；角色移動不會寫入 Firestore。雙方需要互相加入 UID 才會建立連線。若網路屬於無法透過 STUN 打洞的嚴格 NAT，需另外設定 TURN 伺服器。

## 打包 Windows 安裝程式

執行 `npm run dist`，輸出會在 `dist` / `release` 相關建置目錄中。Firebase 的 Web API Key 可出現在客戶端；真正的資料權限由 `firestore.rules` 與 Authentication 保護，請勿在 `.env` 放入服務帳號私鑰。

## 已知邊界

角色與地板由獨立透明視窗顯示在 Windows 桌面上方；偵測到一般程式位於前景時，角色層會降到該程式下方。選擇啟用粉藍流光桌布後，程式才會透過 Lively Wallpaper v2.2.1.0 載入背景，且不會永久修改系統桌布檔案。Electron 控制程式會透過本機 `127.0.0.1:32145` 即時傳送自己與好友的球體位置；這個連線只在本機使用。

登入後，控制程式會收合成右下角粉藍頭像球。點擊懸浮球即可展開設定與好友面板；開啟設定不會停止角色層或選用桌布。程式也常駐於 Windows 系統匣，若快捷鍵被其他軟體占用，可按兩下系統匣圖示或右鍵選擇「開啟控制介面」。

透明桌面角色層與桌布功能是 Windows 10/11 專屬功能。
