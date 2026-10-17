[English](README.md) | [한국어](README.ko.md) | **日本語** | [繁體中文](README.zh-Hant.md) | [简体中文](README.zh-CN.md)

# パルワールド セーブ変換ツール

パルワールドの協力プレイ（マルチ）ワールドを専用サーバー用のセーブに、または専用サーバーのワールドを協力プレイ用のセーブに戻す変換を、すべてブラウザ上で行います。セーブファイルがお使いのパソコンの外に送られることはありません。

**オンライン版はこちら:** [パルワールド セーブ変換ツール](https://www.keepworlds.com/ja/tools/palworld-save-converter?utm_source=github&utm_medium=referral&utm_campaign=palworld_2610_github_converter)

## なぜ必要なのか

協力プレイのワールドでは、ホストのキャラクターは固定の仮 ID で保存されています。一方、専用サーバーは Steam アカウントをもとにプレイヤーごとに ID を割り当てます。そのため協力プレイのワールドをそのままサーバーへ移すと、ホストは新規キャラクターとして扱われ、それまでの持ち物はすべて古い ID を指したまま残ってしまいます。このツールは、それらをまとめて正しい ID に付け替えます。

## できること

- **協力プレイ → 専用サーバー:** ホストを協力プレイ用の仮 ID から、専用サーバーが割り当てる ID に移します。ID はホストの Steam ID から計算するため（可能ならセーブフォルダのパスから自動で読み取ります）、先にサーバーへ参加しておく必要はありません。
- **専用サーバー → 協力プレイ:** 逆方向です。サーバーのワールドを誰かの PC に戻したいときに使います。
- キャラクターにひもづくものをすべて移します: ギルドの所属とギルドマスター権限、パルの所有権、パーティとパルボックスの枠、次元パル保管庫、建築物の建築者記録、チェストのパスワードロック、死亡時のドロップ。
- クロスプレイの仲間（Xbox、PlayStation、Mac）も、一度サーバーに参加して割り当てられた ID が分かれば一緒に移せます。
- ダウンロードを出す前に、書き出したファイルを読み直して、変更したすべての項目を検証します。
- パルワールド 1.0 のセーブ（Oodle 圧縮の `PlM`）と、それ以前の zlib セーブ（`PlZ`）に対応しています。Steam 版のセーブのみが対象です。
- 元のフォルダには手を加えず、結果を zip でお渡しします。

## 使い方

1. **セーブをバックアップします。** ツールは読み込むだけですが、コピーを取っておけば安心です。
2. **ワールドフォルダを探します。**
   - Windows（Steam）の協力プレイワールド: `%LOCALAPPDATA%\Pal\Saved\SaveGames\`。中に Steam ID 名のフォルダがあり、その中にワールドごとに長い 16 進数の名前のフォルダがあります。`SaveGames` フォルダごと選べば、ツールがワールドを一覧にします。
   - 専用サーバー: サーバーのインストールフォルダ（例: `steamapps/common/PalServer/`）内の `Pal/Saved/SaveGames/0/<ワールド ID>/`。先にこのワールドフォルダをパソコンにコピーしてください。
3. **ツールを開き、変換の方向を選んでフォルダを選択します。**
4. **変換するキャラクターを選びます。** 協力プレイのワールドなら、ふつうはホストがあらかじめ選ばれています。
5. **移し先の ID を確認します。** 協力プレイ → サーバーの場合は、自動で入力された Steam ID を確認するか、サーバーでホストに割り当てられた ID を直接入力します。
6. **変換して zip をダウンロードします。**
7. **所定の場所に置きます。**
   - サーバーへ: サーバーを停止し、zip 内のワールドフォルダを `Pal/Saved/SaveGames/0/` に置き、`Pal/Saved/Config/WindowsServer/GameUserSettings.ini`（Linux は `LinuxServer/`）の `DedicatedServerName` をそのフォルダ名に書き換えてから、サーバーを起動します。
   - 協力プレイへ戻す: ゲーム内で新しい協力プレイワールドを作って一度入り、終了したあと、zip 内のファイルでそのワールドフォルダのファイルを上書きします。

変換したワールドを本格的に使う前に、ゲーム内でキャラクター・パル・ギルドを確認してください。元のワールドはそのまま残っています。

## ローカルで動かす

Node.js 22.18 以降が必要です。

```sh
npm install
npm run dev
```

`npm run build` を実行すると、どこにでも置ける静的サイトが `dist/` に出力されます。`npm run check` は型チェックと `scripts/check.mjs` の静的チェックを実行します。

## クレジット

セーブの読み書きは [zlmitchell/palworld-save-toolkit](https://github.com/zlmitchell/palworld-save-toolkit)、Oodle の展開は [SnosMe/ooz-wasm](https://github.com/SnosMe/ooz-wasm)（[powzix/ooz](https://github.com/powzix/ooz) ベース）のコードを無改変で使用しており、どちらも GPL-3.0 です。フィールド構造は [palworld-save-tools](https://github.com/cheahjs/palworld-save-tools)（MIT）に従っています。詳しくは [THIRD_PARTY.md](THIRD_PARTY.md) をご覧ください。

## ライセンス

[GPL-3.0](LICENSE)。

パルワールド専用サーバーのホスティングを提供する [KeepWorlds](https://www.keepworlds.com/ja?utm_source=github&utm_medium=referral&utm_campaign=palworld_2610_github_converter) がメンテナンスしています。Pocketpair とは関係ありません。
