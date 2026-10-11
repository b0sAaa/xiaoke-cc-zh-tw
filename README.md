# 小克桌寵 · Claude 桌面端本體版

桌面右下角的一隻小克。

> 這是 [Hatk3451/xiaoke-cc](https://github.com/Hatk3451/xiaoke-cc) 的**繁體中文版**，介面、臺詞和提示訊息都改成了繁體，其餘功能不變。

在 [aklnaaw/dsh-xiaoke-widget](https://github.com/aklnaaw/dsh-xiaoke-widget) 原有的小克基礎上，
把她從 DSH 網頁裡搬出來，做成了跟著 **Claude 桌面端 / Claude Code** 走的本體版。

## 能看什麼

腳下一根 **Weekly · all models** 量槽，用得越多剩得越少；每輪對話結束冒個泡，告訴你這輪花了多少；點量槽能看今日和近 7 天的賬本。

## 官方額度

量槽優先顯示 Claude 官方的每週額度（右鍵 → 讀取官方額度，預設開）。做法是在背景開一個隱藏的 `claude`、送 `/usage`、讀畫面上的百分比後關掉：約 4 秒、不花 token，啟動時、每輪結束後（至少隔 5 分鐘）和點量槽時各讀一次。

- 需要電腦上有 `claude` 命令列且已登入（`claude` → `/login`），並先在這個資料夾開過一次 `claude` 信任它。
- 右鍵可勾選「顯示 5 小時量槽」，會出現在每週量槽下面。
- 讀不到時自動退回用對話記錄估算；估算只看得到本機 Claude Code，不含網頁、手機等用量，只能參考。
- 右鍵「額度重置時間」可手動設定；讀到官方數字時會自動對齊。

## 和原版的區別

- 掛在 DSH 網頁 → **獨立桌寵**，跟著 Claude Code 一起開關
- DeepSeek 餘額 → **Claude 每週額度量槽**（按 API 價折算，第一次用點量槽填一下當前已用百分比）

## 安裝

```bash
git clone https://github.com/b0sAaa/xiaoke-cc-zh-tw.git
cd xiaoke-cc-zh-tw
npm install
npm run hooks:install
```

裝完開個 Claude Code 對話就出來了。嫌麻煩可以讓DS或者Claude幫你弄。

需要 Windows + Node.js 18+。

## 致謝

小克的立繪、臺詞、音效全是原作者的功勞，這個軟體只是讓Claude換了個應用。
原作者 **aklnaaw**，再往上是 **MeteorNOX** 的小鯨魚掛件。
Claude 桌面端本體版由 **Hatk3451** 製作，本倉庫僅做繁體中文化。

立繪和音效原作者宣告不授予再分發，所以本倉庫不附帶，`npm install` 時從原倉庫下載，僅供個人使用。
程式碼 MIT，見 [LICENSE](LICENSE)。
