[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [繁體中文](README.zh-Hant.md) | **简体中文**

# 幻兽帕鲁存档转换工具

把幻兽帕鲁的联机（合作）世界转成专用服务器存档，或把专用服务器上的世界转回联机存档，全程在浏览器里完成。存档文件不会离开你的电脑。

**在线使用：** [幻兽帕鲁存档转换工具](https://www.keepworlds.com/tools/palworld-save-converter?utm_source=github&utm_medium=referral&utm_campaign=palworld_2610_github_converter)

## 为什么需要它

联机世界里，房主的角色用一个固定的占位 ID 保存；专用服务器则按 Steam 账号给每个玩家分配 ID。所以把联机世界直接搬到服务器上，房主会变成一个新角色，原来拥有的东西全都还指向旧 ID。这个工具会把它们一起迁到正确的 ID 上。

## 功能

- **联机 → 专用服务器：** 把房主从联机用的占位 ID 迁到专用服务器会分配的 ID。ID 由房主的 Steam ID 计算得出（能从存档文件夹路径读到时自动填好），不需要先进一次服务器。
- **专用服务器 → 联机：** 反方向，把服务器上的世界搬回某个人的电脑。
- 指向这个角色的一切都会跟着迁：公会成员身份与会长权限、帕鲁归属、队伍与帕鲁终端的格子、次元帕鲁储存、建筑的建造者记录、箱子的密码锁、死亡掉落物。
- 跨平台的朋友（Xbox、PlayStation、Mac）只要进服务器一次、拿到服务器分配的 ID，也能一起迁过去。
- 提供下载之前，会把写出的文件重新读一遍，逐项核对改过的每个字段。
- 支持幻兽帕鲁 1.0 存档（Oodle 压缩的 `PlM`）和更早的 zlib 存档（`PlZ`）。仅限 Steam 版存档。
- 不改动原文件夹，结果以 zip 下载。

## 使用方法

1. **先备份存档。** 工具只读不写，但多留一份总归放心。
2. **找到世界文件夹。**
   - Windows（Steam）上的联机世界：`%LOCALAPPDATA%\Pal\Saved\SaveGames\`。里面有一个以 Steam ID 命名的文件夹，再往里每个世界各有一个长串十六进制名称的文件夹。直接选整个 `SaveGames` 文件夹，工具会列出所有世界。
   - 专用服务器：服务器安装目录（例如 `steamapps/common/PalServer/`）下的 `Pal/Saved/SaveGames/0/<世界 ID>/`。请先把这个世界文件夹复制到你的电脑上。
3. **打开工具，选择转换方向，再选择文件夹。**
4. **选择要转换的角色。** 联机世界一般已经默认选中房主。
5. **确认目标 ID。** 联机 → 服务器时，检查自动填好的 Steam ID，或手动填写服务器给房主分配的 ID。
6. **转换并下载 zip。**
7. **放到对应位置。**
   - 搬到服务器：先停服，把 zip 里的世界文件夹放进 `Pal/Saved/SaveGames/0/`，再把 `Pal/Saved/Config/WindowsServer/GameUserSettings.ini`（Linux 为 `LinuxServer/`）里的 `DedicatedServerName` 改成这个文件夹的名字，然后开服。
   - 搬回联机：在游戏里新建一个联机世界，进去一次再退出，然后用 zip 里的文件覆盖这个世界文件夹里的文件。

正式使用转换后的世界之前，请先在游戏里确认角色、帕鲁和公会。原来的世界原样保留。

## 本地运行

需要 Node.js 22.18 或更高版本。

```sh
npm install
npm run dev
```

运行 `npm run build` 会在 `dist/` 生成一个可以部署到任何地方的静态网站。`npm run check` 会执行类型检查和 `scripts/check.mjs` 里的静态检查。

## 致谢

存档解析与写回原样使用 [zlmitchell/palworld-save-toolkit](https://github.com/zlmitchell/palworld-save-toolkit)，Oodle 解压使用 [SnosMe/ooz-wasm](https://github.com/SnosMe/ooz-wasm)（基于 [powzix/ooz](https://github.com/powzix/ooz)），两者均为 GPL-3.0。字段结构参照 [palworld-save-tools](https://github.com/cheahjs/palworld-save-tools)（MIT）。详见 [THIRD_PARTY.md](THIRD_PARTY.md)。

## 许可证

[GPL-3.0](LICENSE)。

由幻兽帕鲁专用服务器托管服务 [KeepWorlds](https://www.keepworlds.com/?utm_source=github&utm_medium=referral&utm_campaign=palworld_2610_github_converter) 维护。与 Pocketpair 无关。
