[English](README.md) | **한국어** | [日本語](README.ja.md) | [繁體中文](README.zh-Hant.md) | [简体中文](README.zh-CN.md)

# 팰월드 세이브 변환기

팰월드 협동(멀티) 월드를 전용 서버(데디 서버)용 세이브로, 또는 전용 서버 월드를 다시 협동 세이브로 변환합니다. 모든 처리는 브라우저 안에서 끝나며, 세이브 파일은 내 컴퓨터 밖으로 나가지 않습니다.

**온라인에서 바로 사용하기:** https://www.keepworlds.com/ko/tools/palworld-save-converter?utm_source=github&utm_medium=referral&utm_campaign=palworld_2610_github_converter

## 왜 필요한가요

협동 월드에서는 호스트 캐릭터가 고정된 임시 ID로 저장됩니다. 반면 전용 서버는 Steam 계정을 바탕으로 플레이어마다 ID를 부여합니다. 그래서 협동 월드를 그대로 서버에 옮기면 호스트가 새 캐릭터로 시작하게 되고, 원래 갖고 있던 것들은 모두 예전 ID를 가리킨 채 남습니다. 이 도구는 그 전부를 올바른 ID로 옮겨 줍니다.

## 할 수 있는 일

- **협동 → 전용 서버:** 호스트를 협동용 임시 ID에서 전용 서버가 부여할 ID로 옮깁니다. ID는 호스트의 Steam ID로 계산하므로(가능하면 세이브 폴더 경로에서 자동으로 읽어 옵니다) 먼저 서버에 접속해 볼 필요가 없습니다.
- **전용 서버 → 협동:** 반대 방향입니다. 서버 월드를 누군가의 PC로 되돌릴 때 씁니다.
- 캐릭터를 가리키는 모든 것을 함께 옮깁니다: 길드 소속과 길드장 권한, 팰 소유권, 파티와 팰 상자 슬롯, 차원 팰 보관함, 건축물의 건설자 기록, 상자 비밀번호 잠금, 사망 시 떨어뜨린 물건.
- 크로스플레이 친구(Xbox, PlayStation, Mac)도 서버에 한 번 접속해 받은 ID를 알면 함께 옮길 수 있습니다.
- 다운로드를 제공하기 전에 기록한 파일을 다시 읽어, 바꾼 항목을 하나하나 검증합니다.
- 팰월드 1.0 세이브(Oodle 압축 `PlM`)와 이전 zlib 세이브(`PlZ`)를 모두 지원합니다. Steam 세이브만 해당됩니다.
- 원본 폴더는 건드리지 않고 zip 파일로 결과를 내려받습니다.

## 사용 방법

1. **세이브를 백업하세요.** 도구는 파일을 읽기만 하지만, 복사본을 하나 만들어 두면 안심입니다.
2. **월드 폴더를 찾습니다.**
   - Windows(Steam)의 협동 월드: `%LOCALAPPDATA%\Pal\Saved\SaveGames\`. 그 안에 Steam ID 이름의 폴더가 있고, 다시 그 안에 긴 16진수 이름의 월드 폴더가 월드마다 하나씩 있습니다. `SaveGames` 폴더를 통째로 선택하면 도구가 월드 목록을 보여 줍니다.
   - 전용 서버: 서버 설치 폴더(예: `steamapps/common/PalServer/`) 안의 `Pal/Saved/SaveGames/0/<월드 ID>/`. 먼저 이 월드 폴더를 내 컴퓨터로 복사해 두세요.
3. **도구를 열고 변환 방향을 고른 뒤 폴더를 선택합니다.**
4. **변환할 캐릭터를 고릅니다.** 협동 월드라면 보통 호스트가 미리 선택되어 있습니다.
5. **대상 ID를 확인합니다.** 협동 → 서버라면 자동으로 채워진 Steam ID를 확인하거나, 서버에서 호스트에게 부여된 ID를 직접 입력하세요.
6. **변환한 뒤 zip을 내려받습니다.**
7. **제자리에 넣습니다.**
   - 서버로 옮길 때: 서버를 끄고, zip 안의 월드 폴더를 `Pal/Saved/SaveGames/0/`에 넣은 다음, `Pal/Saved/Config/WindowsServer/GameUserSettings.ini`(Linux는 `LinuxServer/`)의 `DedicatedServerName`을 그 폴더 이름으로 바꾸고 서버를 켭니다.
   - 협동으로 되돌릴 때: 게임에서 새 협동 월드를 만들어 한 번 들어갔다 나온 뒤, zip 안의 파일로 그 월드 폴더의 파일을 덮어씁니다.

변환한 월드를 본격적으로 쓰기 전에 게임 안에서 캐릭터, 팰, 길드부터 확인하세요. 기존 월드는 그대로 남아 있습니다.

## 로컬에서 실행하기

Node.js 22.18 이상이 필요합니다.

```sh
npm install
npm run dev
```

`npm run build`를 실행하면 어디서나 호스팅할 수 있는 정적 사이트가 `dist/`에 만들어집니다. `npm run check`는 타입 검사와 `scripts/check.mjs`의 정적 검사를 실행합니다.

## 크레딧

세이브 파서와 기록 코드는 [zlmitchell/palworld-save-toolkit](https://github.com/zlmitchell/palworld-save-toolkit)을, Oodle 압축 해제는 [SnosMe/ooz-wasm](https://github.com/SnosMe/ooz-wasm)([powzix/ooz](https://github.com/powzix/ooz) 기반)을 수정 없이 그대로 사용하며, 둘 다 GPL-3.0입니다. 필드 구조는 [palworld-save-tools](https://github.com/cheahjs/palworld-save-tools)(MIT)를 따릅니다. 자세한 내용은 [THIRD_PARTY.md](THIRD_PARTY.md)를 참고하세요.

## 라이선스

[GPL-3.0](LICENSE).

팰월드 전용 서버 호스팅 [KeepWorlds](https://www.keepworlds.com/ko?utm_source=github&utm_medium=referral&utm_campaign=palworld_2610_github_converter)가 관리합니다. Pocketpair와는 관련이 없습니다.
