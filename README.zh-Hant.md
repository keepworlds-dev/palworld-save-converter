[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | **繁體中文** | [简体中文](README.zh-CN.md)

# 幻獸帕魯存檔轉換工具

把幻獸帕魯的合作（多人連線）世界轉成專用伺服器存檔，或把專用伺服器的世界轉回合作存檔，全程在瀏覽器裡完成。存檔檔案不會離開你的電腦。

**線上直接使用：** https://www.keepworlds.com/zh-Hant/tools/palworld-save-converter?utm_source=github&utm_medium=referral&utm_campaign=palworld_2610_github_converter

## 為什麼需要它

在合作世界裡，房主的角色是用一個固定的佔位 ID 儲存的；專用伺服器則依照 Steam 帳號替每位玩家分配 ID。所以把合作世界直接搬到伺服器上，房主會變成一個全新角色，原本擁有的東西全都還指向舊 ID。這個工具會把它們一併搬到正確的 ID 上。

## 功能

- **合作 → 專用伺服器：** 把房主從合作用的佔位 ID 搬到專用伺服器會分配的 ID。ID 由房主的 Steam ID 計算得出（能從存檔資料夾路徑讀到時會自動填入），不必先進伺服器一次。
- **專用伺服器 → 合作：** 反方向，把伺服器上的世界搬回某人的電腦。
- 指向該角色的一切都會跟著搬：公會成員身分與會長權限、帕魯歸屬、隊伍與帕魯終端的欄位、次元帕魯儲藏、建築物的建造者紀錄、箱子的密碼鎖、死亡掉落物。
- 跨平台的朋友（Xbox、PlayStation、Mac）只要進伺服器一次、拿到伺服器分配的 ID，也能一起搬過去。
- 提供下載之前，會重新讀取寫出的檔案，逐項核對改過的每個欄位。
- 支援幻獸帕魯 1.0 存檔（Oodle 壓縮的 `PlM`）與更早的 zlib 存檔（`PlZ`）。僅限 Steam 版存檔。
- 不動原始資料夾，結果以 zip 下載。

## 使用方式

1. **先備份存檔。** 工具只會讀取，但多留一份總是安心。
2. **找到世界資料夾。**
   - Windows（Steam）的合作世界：`%LOCALAPPDATA%\Pal\Saved\SaveGames\`。裡面有一個以 Steam ID 命名的資料夾，再往裡每個世界各有一個長串十六進位名稱的資料夾。直接選整個 `SaveGames` 資料夾，工具就會列出所有世界。
   - 專用伺服器：伺服器安裝資料夾（例如 `steamapps/common/PalServer/`）裡的 `Pal/Saved/SaveGames/0/<世界 ID>/`。請先把這個世界資料夾複製到你的電腦上。
3. **開啟工具，選擇轉換方向，再選擇資料夾。**
4. **選擇要轉換的角色。** 合作世界通常已經預先選好房主。
5. **確認目標 ID。** 合作 → 伺服器時，檢查自動填入的 Steam ID，或手動輸入伺服器替房主分配的 ID。
6. **轉換並下載 zip。**
7. **放到正確位置。**
   - 搬到伺服器：先停止伺服器，把 zip 裡的世界資料夾放進 `Pal/Saved/SaveGames/0/`，再把 `Pal/Saved/Config/WindowsServer/GameUserSettings.ini`（Linux 為 `LinuxServer/`）裡的 `DedicatedServerName` 改成該資料夾名稱，然後啟動伺服器。
   - 搬回合作：在遊戲裡新建一個合作世界，進去一次後離開，再用 zip 裡的檔案覆蓋該世界資料夾中的檔案。

正式使用轉換後的世界之前，請先在遊戲裡確認角色、帕魯和公會。原本的世界會原封不動地留著。

## 在本機執行

需要 Node.js 22.18 以上版本。

```sh
npm install
npm run dev
```

執行 `npm run build` 會在 `dist/` 產生可部署到任何地方的靜態網站。`npm run check` 會執行型別檢查與 `scripts/check.mjs` 的靜態檢查。

## 致謝

存檔解析與寫回直接使用未經修改的 [zlmitchell/palworld-save-toolkit](https://github.com/zlmitchell/palworld-save-toolkit)，Oodle 解壓縮使用 [SnosMe/ooz-wasm](https://github.com/SnosMe/ooz-wasm)（基於 [powzix/ooz](https://github.com/powzix/ooz)），兩者皆為 GPL-3.0。欄位結構參照 [palworld-save-tools](https://github.com/cheahjs/palworld-save-tools)（MIT）。詳見 [THIRD_PARTY.md](THIRD_PARTY.md)。

## 授權

[GPL-3.0](LICENSE)。

由幻獸帕魯專用伺服器託管服務 [KeepWorlds](https://www.keepworlds.com/zh-Hant?utm_source=github&utm_medium=referral&utm_campaign=palworld_2610_github_converter) 維護。與 Pocketpair 無關。
