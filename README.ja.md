# Strata モデル切替版（Windowsデスクトップアプリ）

このforkは、ユーザーが追加したモデルをチャット上部から切り替えられるStrataです。特定の3モデルには固定せず、Strata対応のローカルモデルやAPIモデルを自由に追加できます。

## Windowsへのインストール

1. [Releases](https://github.com/bassmicrobe/Strata-Managed-Models/releases/latest) から Windows x64用のsetup.exe をダウンロードします。
2. インストーラーを実行します。管理者権限は不要です。Node.jsとStrata Controlを同梱しています。
3. スタートメニューの **Strata Managed Models** を開きます。専用ウィンドウが起動するので、初回のモデル画面で使いたいモデルを追加します。

Windows 10／11の64ビット版が対象です。専用ウィンドウはRust製で、WindowsのWebView2で表示します。必要な場合はセットアップがWebView2を導入します。モデル本体は含めず、ユーザーが選んだときに取得します。

## モデルの追加と切替

- PC内で動かすモデルは「モデル」画面から導入・取り込みます。
- 既存のモデルAPIは「設定 → Models／モデル」から接続を追加します。
- 追加したモデルはチャット上部の選択メニューに反映されます。未読込のローカルモデルは読み込み完了後に切り替わります。
- モデルの切替でチャット履歴を消す必要はありません。モデルごとの量子化・コンテキストなどは保存設定を使います。

[詳しい日本語の使い方](managed-local/windows-installer/README.ja.md) はインストーラーにも同梱しています。

## 自動テストと修正

**Strata → 自動テストでコーディング** から有効にすると、専用チャットでコードを編集し、テスト実行、失敗ログを使った修正、再実行を続けられます。スタートメニューからも開けます。コード実行用のエージェント部品をインストーラーに同梱し、追加済みモデルを選んで使えます。

専用チャットはファイル編集とコマンドを確認なしで実行する **Bypass** モードです。初回に説明を確認して有効にします。モデル設定はそのPCの保存値を使います。[手順と実行環境の説明](managed-local/windows-installer/README.ja.md#自動テストでコーディング) を参照してください。

<a id="tailscale"></a>

## Tailscaleで他の端末から使う（任意）

初期設定ではこのPC内だけで使います。別のPCやスマートフォンから使う場合は、実行PCと接続側の端末に [Tailscale](https://tailscale.com/download) を別途導入し、同じTailnetへ参加してください。

1. **実行PC**でStrataに使いたいモデルを追加し、スタートメニューの **Strata Managed Models → Tailscaleで共有** を選びます。
2. 初回にHTTPS／Serveの有効化画面が開いたら、Tailscaleへログインして案内を完了し、もう一度 **Tailscaleで共有** を実行します。
3. 専用ウィンドウで **Strata → 共有URLをコピー** を選び、コピーした **`https://…ts.net/` のURL**を接続側のブラウザーで開きます。`:8443` などのポート番号が付いている場合は省略しないでください。
4. チャット上部のモデル名から追加済みモデルを選び、通常どおり使います。接続側にStrataやモデル本体は不要で、推論は実行PCで行います。

実行PCの電源・Tailscale・Strataを起動したまま、スリープしない状態で使います。共有メニューが見つからない旧インストーラー版では、[最新のsetup.exe](https://github.com/bassmicrobe/Strata-Managed-Models/releases/latest)を上書き実行してください。設定・会話・モデルは保持します。

共有先でも同じ会話履歴・モデル・操作画面を使います。ユーザー別の領域は作りません。アクセスを許可する人や端末はTailscale側の権限で管理します。共有はTailnet内のServeを使い、Funnelによるインターネット公開は行いません。

停止は、回答やモデル操作が終わってから **Tailscale共有を停止** を選びます。再開は **Tailscaleで共有** です。[設定・使い方・つながらない場合の確認](managed-local/windows-installer/README.ja.md#tailscale) を参照してください。

## 更新と管理

このforkの管理ブランチは managed-models です。大元の安定版を毎時確認し、取り込み・テスト・画面ビルド・Windowsインストーラー試験に合格した版だけを公開します。起動時は、その検証済み配布版を確認します。

Windowsアプリの新版がある場合は、起動時に現在の版と新しい版を表示します。「はい」でSHA-256を照合したセットアップを取得して開き、「いいえ」で後回しにできます。手動確認は **Strata → 更新を確認** です。設定・会話・モデルは引き継ぎます。

競合や検証エラーがあれば前の配布版を使います。アンインストール時にも、設定・会話履歴・モデルは保持します。

- [forkの運用説明](managed-local/README.ja.md)
- [自動検証の結果](https://github.com/bassmicrobe/Strata-Managed-Models/actions/workflows/managed-updates.yml)
- [公式Strataの日本語README](https://github.com/Niko1221/Strata/blob/main/README.ja.md)

---

## 以下は上流Strataの日本語説明です

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/host/public/brand/strata-lockup-dark.svg">
    <img src="apps/host/public/brand/strata-lockup-light.svg" alt="Strata" width="340">
  </picture>
</p>

<h3 align="center">あなた自身のパソコンで、高性能な AI を。</h3>
<p align="center">チャット、コーディング、画像の処理を、すべてローカルで。</p>

<p align="center">
  <a href="#モデル">モデル</a> · <a href="#インストール"><b>インストール</b></a> ·
  <a href="#ハードウェア">ハードウェア</a> · <a href="#ツール">ツール</a> ·
  <a href="#ヘルプ">ヘルプ</a> · <a href="#strata-を支援する">支援</a>
</p>

<p align="center">
  <a href="https://github.com/Niko1221/Strata/releases/latest"><img src="https://img.shields.io/github/v/release/Niko1221/Strata?label=download&color=0ab887" alt="Strata をダウンロード"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Niko1221/Strata" alt="MIT ライセンス"></a>
  <a href="https://github.com/sponsors/Niko1221"><img src="https://img.shields.io/badge/Sponsor-EA4AAA?logo=githubsponsors&logoColor=fff" alt="GitHub Sponsors で Strata を支援する"></a>
  <a href="https://buymeacoffee.com/strataengine"><img src="https://img.shields.io/badge/Buy_me_a_coffee-FFDD00?logo=buymeacoffee&logoColor=000" alt="Buy Me a Coffee で Strata を支援する"></a>
</p>

<p align="center"><sub><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <b>日本語</b> · <a href="README.de.md">Deutsch</a> · <a href="README.fr.md">Français</a> · <a href="README.es.md">Español</a> · <a href="README.pt-BR.md">Português</a> · <a href="README.pl.md">Polski</a></sub></p>

**無料でオープンソース。自分の環境で動かせます。** デスクトップで、またはお好みのコーディングツールと一緒に Strata を使えます。アカウントは不要です。

## モデル

まず **ISTA-DASLab** をおすすめします。次に **Unsloth** などの提供元です。メモリに収まる互換モデルがある場合に選べます。

<details>
<summary><img src="docs/media/models/qwen.svg" width="22" alt="" align="middle"> &nbsp;<b>Qwen3.8-Flash-Next</b></summary>

| 提供元 | 選択肢 |
| --- | --- |
| **ISTA-DASLab · おすすめ** | Q2\_0, IQ2\_XS, IQ3\_XXS, IQ3\_S。[Coder: IQ1\_M](docs/MODELS.md#coder)（コーディング向け）。 |
| **Unsloth** | UD-IQ4\_XS, UD-Q4\_K\_XL, UD-Q5\_K\_XL, UD-Q6\_K\_XL, Q8\_0 |
| **Gyro · agentionai** | [Gyro-S, Gyro-M](https://huggingface.co/agentionai/Qwen3.8-Flash-Next-Gyro-GGUF)。メモリ使用量は少ないですが、動作は遅くなります。 |
| **その他の選択肢** | [Swift 1.5](docs/MODELS.md#swift-15), [NVFP4](docs/NVFP4.md), [OrcaRouter](docs/ORCA.md) |

[サイズ、必要なメモリ、互換性を比べる](docs/MODELS.md)。

</details>

<details>
<summary><img src="docs/media/models/qwen.svg" width="22" alt="" align="middle"> &nbsp;<b>Qwen3.6-35B-A3B</b></summary>

**Unsloth:** UD-Q4_K_XL, UD-Q6_K_XL, Q8_0。現在、このモデルで文書化されているパックです。

[モデルガイドと互換性](docs/QWEN36.md)。

</details>

<details>
<summary><img src="docs/media/models/deepseek.svg" width="22" alt="" align="middle"> &nbsp;<b>DeepSeekV4.1-Flash-1017</b></summary>

**デスクトップアプリ**と**ターミナル**で使えます。メモリに収まらない分は SSD から読み込むため、空きディスク容量がたくさん必要です。

| セット（ISTA-DAS） | ダウンロード | 必要な空き容量 |
| --- | ---: | ---: |
| 1.75 bpw | 239 GB | 約245 GB |
| 2.00 bpw | 257 GB | 約265 GB |
| 2.25 bpw | 274 GB | 約280 GB |

NVIDIA RTX 30・40・50 シリーズ（Windows と Linux）と、AMD Radeon AI PRO R9700（Linux）で動きます。セットアップがファイルと DeepSeek エンジンをダウンロードし、モデルを起動します。

```sh
strata launch --family deepseek41 --model ist-das-2.00bpw --plan
```

Strata 0.2.5 で 2.00 bpw のセットを使って測定しました。「出力」は回答の速さ、「プロンプト」は Strata が入力を読み込む速さです。

| ハードウェア | 出力 | プロンプト |
| --- | ---: | ---: |
| RTX 5070 12 GB, 64 GB RAM | 4〜6 トークン/秒 | 約 110 トークン/秒 (4K) |
| RTX 3060 12 GB, 46 GB RAM | 9〜11 トークン/秒 | 約 155 トークン/秒 (4K) |
| 1x Radeon AI PRO R9700, 251 GB RAM | 21〜25 トークン/秒 | 320〜360 トークン/秒 (8K) |
| 4x Radeon AI PRO R9700 | 74〜77 トークン/秒 | 400〜450 トークン/秒 (8K) |

[メモリ、ディスク、詳細](docs/DEEPSEEK41.md) · [リリースノート](https://github.com/Niko1221/Strata/releases)

</details>

<a id="the-other-sizes"></a>

どれが動くかわからない場合は、[お使いのパソコンに合うモデルを選ぶ](docs/MODELS.md#pick-by-memory)。

## インストール

<a id="option-a-the-strata-app"></a>

### デスクトップアプリ

**[Windows、Linux、Mac 用の Strata をダウンロード →](https://github.com/Niko1221/Strata/releases/latest)**

アプリをインストールし、モデルを選んで、チャットを始めましょう。インストーラーはシステムごとに1つです。初回起動時に、アプリがお使いのグラフィックスカード用のエンジンをダウンロードします。[インストーラーのヘルプ](docs/INSTALL.md#the-app)。

<sub>ファイル: `Strata-0.2.9-windows-x64-setup.exe` · `Strata-0.2.9-linux-x86_64.AppImage` · `Strata-0.2.9-macos-arm64.dmg`</sub>

<p align="center">
  <img src="docs/media/app-chat.png" width="900" alt="チャットとライブのコードプレビューを並べて表示した Strata デスクトップアプリ">
  <br><sub>チャット、ファイル、ライブプレビューを1つのウィンドウで。</sub>
</p>

<a id="option-b-the-terminal-one-line"></a>

### ターミナルアプリ

ターミナルのほうが好みですか？ Strata をインストールして、**`strata launch`** を実行します。

<details open>
<summary><b>インストールコマンド</b></summary>

**Linux / Mac**

```sh
curl -fsSL https://github.com/Niko1221/Strata/releases/latest/download/install.sh -o install.sh && sh install.sh
```

**Windows PowerShell**

```powershell
irm https://github.com/Niko1221/Strata/releases/latest/download/install.ps1 | iex
```

Windows では、インストール後に新しいターミナルを開きます。そのあと:

```sh
strata launch
```

画面の案内に従って、モデルをダウンロードして起動します。[ターミナルガイド](docs/TERMINAL_LAUNCH.md)。

</details>

<p align="center">
  <img src="docs/media/terminal-monitor.png" width="900" alt="モデルの動作、速度、メモリ、最近のリクエストを表示する Strata ターミナルアプリ">
  <br><sub>動作中のモデルとハードウェアの状態を確認できます。</sub>
</p>

<a id="build-from-source"></a>

[ソースからビルド](docs/SOURCE_INSTALL.md) · [Docker](docs/DOCKER.md) · [インストールガイド（全文）](docs/INSTALL.md)

<a id="what-you-need"></a>

## ハードウェア

| 対応ハードウェア | ガイド |
| --- | --- |
| **NVIDIA GeForce RTX 20 / 30 / 40 / 50 シリーズ** | [NVIDIA のセットアップ](docs/INSTALL.md#what-you-need) |
| **AMD Radeon RX 7700 / 7800 / 7900、RX 9060 / 9070、AI PRO R9700** | [AMD のセットアップ](docs/AMD_HIP.md) |
| **AMD Radeon RX 6800 / 6900 · 試験的** | [RX 6000 のセットアップ](docs/AMD_HIP.md#rdna2-gfx1030) |
| **Intel Arc · Linux** | [Intel のセットアップ](docs/INTEL_ARC.md) |
| **Apple Silicon · M1 以降** | [Mac のセットアップ](docs/MAC.md) |
| **AMD Ryzen AI Max · Strix Halo** | [Strix Halo のセットアップ](docs/STRIX_HALO.md) |

<a id="using-it"></a>

## ツール

**Claude Code · Codex CLI · OpenCode · oh-my-pi · pi.dev · Hermes Agent · OpenClaw**。OpenAI 互換と Anthropic 互換の API を通じて、ほかのツールも使えます。

**`strata connect`** を実行すると、お使いのツールの設定方法が表示されます。[接続ガイド](docs/TERMINAL_LAUNCH.md#connect-your-apps-strata-connect)。

<a id="guides"></a>
<a id="how-fast-is-it"></a>
<a id="how-does-it-work"></a>
<a id="something-went-wrong"></a>

## ヘルプ

[すべてのガイド](docs) · [トラブルシューティング](docs/TROUBLESHOOTING.md) · [不具合を報告](https://github.com/Niko1221/Strata/issues/new/choose) ·
[ベンチマーク](docs/COMMUNITY_BENCHMARKS.md) · [仕組み](docs/HOW_IT_WORKS.md) · [貢献する](CONTRIBUTING.md)

## Strata を支援する

**ローカル AI をみんなに開かれたものに。** GitHub でのスポンサーやコーヒー1杯が、開発と、より多くのハードウェアでのテストの支えになります。

<a href="https://github.com/sponsors/Niko1221"><img src="https://img.shields.io/badge/Sponsor_on_GitHub-EA4AAA?style=for-the-badge&logo=githubsponsors&logoColor=white" alt="GitHub Sponsors: Strata を支援する" height="48"></a>
<a href="https://buymeacoffee.com/strataengine"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me a Coffee: Strata を支援する" height="48"></a>

### いつも支えてくださる方々

Strata を支えてくださるすべての方に感謝します。

<!-- supporters:start (one line per public supporter, newest last; copy a line and change the GitHub name in all four places) -->
<a href="https://github.com/ryan4yin"><img src="https://github.com/ryan4yin.png?size=96" width="48" height="48" alt="ryan4yin" title="ryan4yin"></a>
<a href="https://github.com/themactep"><img src="https://github.com/themactep.png?size=96" width="48" height="48" alt="themactep" title="themactep"></a>
<a href="https://github.com/macintog"><img src="https://github.com/macintog.png?size=96" width="48" height="48" alt="macintog" title="macintog"></a>
<a href="https://github.com/bisonbet"><img src="https://github.com/bisonbet.png?size=96" width="48" height="48" alt="bisonbet" title="bisonbet"></a>
<a href="https://github.com/vizv"><img src="https://github.com/vizv.png?size=96" width="48" height="48" alt="vizv" title="vizv"></a>
<!-- supporters:end -->

[MIT ライセンス](LICENSE) · [クレジットとモデルのライセンス](docs/HOW_IT_WORKS.md#credits) · [プライバシー](docs/SAFETY.md)

<a id="option-c-let-your-ai-set-it-up"></a>

<sub>AI ツールと自動リーダー向け: <a href="AGENTS.md">技術リファレンス</a> · <a href="docs/AI_SETUP.md">セットアップ手順</a></sub>

**スポンサー、ハードウェア提携、共同開発のご相談:** [niko.veit@outlook.com](mailto:niko.veit@outlook.com).
