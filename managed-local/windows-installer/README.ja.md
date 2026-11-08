# Strata モデル切替版 — Windows用

この版では、ユーザーが追加したモデルをチャット上部から選べます。特定の3モデルには固定していません。

## インストール

1. [配布ページ](https://github.com/bassmicrobe/Strata-Managed-Models/releases/latest)から `Strata-Managed-Models-バージョン-windows-x64-setup.exe` をダウンロードします。
2. インストーラーを実行します。管理者権限は不要です。Windows 10／11の64ビット版に対応します。
3. スタートメニューの **Strata Managed Models** を開きます。初回はモデル選択画面が開きます。

Node.jsとStrata Controlを同梱しています。別途Node.jsやPythonをインストールする必要はありません。画面は既定のブラウザーで開き、ホストはこのPCの `127.0.0.1` で動きます。

## モデルを追加する

**PC内でモデルを動かす場合**は、画面の「モデル」からStrata対応モデルの種類・量子化を選び、画面の案内に従ってエンジンとモデルを導入します。手元にある対応モデルを取り込むこともできます。必要なGPU・メモリー・空き容量はモデルによって異なります。

**既存のモデルAPIを使う場合**は、設定の「Models／モデル」でAPI接続を追加します。スタートメニューの **API connections** からも開けます。接続先、必要なAPIキー、モデルIDを設定します。

モデル本体はインストーラーに入っていません。ユーザーが画面で選んだときに取得します。大きいモデルは数十GB以上になることがあります。

## モデルを切り替える

チャット上部のモデル名をクリックします。追加済みのローカルモデルと、保存したAPIモデルが一覧に表示されます。未読込のローカルモデルを選ぶと、保存済みの設定で読み込み、準備完了後に切り替わります。会話履歴は保持します。

モデルの追加・削除に応じて一覧も変わります。新しいチャットを作り直す必要はありません。ローカルモデルの設定画面はスタートメニューの **Models** から開けます。

<a id="tailscale"></a>

## Tailscaleで他の端末から使う（任意）

初期設定ではこのPC内だけで使います。Tailscaleはインストーラーに含めていません。

本家のUIはローカル専用です。この共有機能は、このforkで追加した任意の拡張です。[本家のセキュリティ方針](https://github.com/Niko1221/Strata/blob/main/SECURITY.md)も参照してください。

1. **モデルを実行するPC**にこのforkのWindows用インストーラーを導入し、使いたいモデルを追加します。**接続側のPCやスマートフォン**にはStrataやモデル本体を導入する必要はありません。
2. 両方の端末に [公式のTailscale](https://tailscale.com/download) を別途導入し、ログインして同じTailnetへ接続します。
3. 実行PCのスタートメニューから **Strata Managed Models → Tailscaleで共有** を選びます。初回にHTTPS／Serveの有効化や権限の確認を求められた場合は、Tailscale側の案内を完了してから、もう一度 **Tailscaleで共有** を実行します。
4. 開いた **`https://…ts.net/` のURL**を接続側へ渡し、ブラウザーで開きます。`:8443` などのポート番号があれば省略しないでください。URLは実行PCごとに異なります。接続側の `127.0.0.1` を開いても実行PCには接続できません。
5. チャット上部のモデル名からモデルを選び、通常どおり質問します。モデルの読み込みと推論は実行PCで行われます。モデル切り替えで会話履歴を消す必要はありません。

共有メニューがない旧インストーラー版では、[最新のsetup.exe](https://github.com/bassmicrobe/Strata-Managed-Models/releases/latest)を上書き実行してください。設定・会話・モデルは保持します。

実行PCでは、TailscaleとStrataを起動したまま使います。PCの電源が切れている間やスリープ中は接続できません。共有を有効にした後は、通常の起動でも共有URLを開きます。

共有は [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) によるTailnet内のHTTPS接続です。Funnelによるインターネット公開は行いません。既存のServe設定は上書きせず、空いている共有ポートを使います。利用できるポートがなければ、エラーを表示して止まります。

**共有先でも、実行PCと同じ会話履歴・モデル・操作画面を使います。** ユーザー別の領域や操作権限は設けていません。アクセスを許可する人や端末は、Tailscale側のアクセス権で管理してください。

共有を止めるには、回答やモデル操作が完了してから **Tailscale共有を停止** を選びます。PC内だけの利用へ戻ります。再開する場合は **Tailscaleで共有** を選びます。

### つながらない場合

- 両端末のTailscaleが接続済みで、同じTailnetに参加しているか確認します。
- 実行PCが起動中で、Strataが開き、スリープしていないか確認します。
- HTTPS／Serveの初回設定を完了した後、共有メニューをもう一度実行します。
- 実行PCで開いたHTTPS URLを、ポート番号も含めてそのまま使います。
- Tailscale側のアクセス権で、接続する端末・利用者から共有先への通信が許可されているか確認します。
- Tailscaleや共有ポートのエラーが出た場合は、その案内を解消してから再実行します。他のServe設定は上書きしません。

## 更新

通常の起動時に、このforkの検証済み配布版を確認します。新しい本体を別フォルダーに準備し、起動確認後に切り替えます。通信や検証に失敗した場合は、現在の版で起動します。回答やモデル操作の途中は更新を延期します。

GitHub側では大元の安定版を毎時確認します。取り込み・テスト・ビルドに成功した版だけを公開します。競合がある場合は、修正されるまで前の配布版を使います。

## 保存先と終了

- アプリ：通常は `%LOCALAPPDATA%\Programs\StrataManaged`
- 設定・会話・コンポーネント：`%LOCALAPPDATA%\StrataManaged`
- モデル：画面で指定した保存先

既存の公式Strataとは別のフォルダーを使います。ブラウザーを閉じてもホストやモデルが動き続ける場合があります。終了時は、アプリ内でモデルを停止してください。

Windowsの「インストールされているアプリ」から **Strata Managed Models** をアンインストールできます。このアプリが作成したTailscale共有を解除してからアプリ本体を除去し、設定・会話・モデルは保持します。共有解除を確認できない場合は削除を中止し、案内を表示します。他のTailscale共有は削除しません。

## 配布元

- [このfork](https://github.com/bassmicrobe/Strata-Managed-Models)
- [Releasesとチェックサム](https://github.com/bassmicrobe/Strata-Managed-Models/releases)
- [自動検証の結果](https://github.com/bassmicrobe/Strata-Managed-Models/actions/workflows/managed-updates.yml)
- [公式Strata](https://github.com/Niko1221/Strata)

現時点のインストーラーにはコード署名を付けていません。配布物のSHA-256は同じリリースの `managed-host.json` に記載します。ライセンスはインストール先の `licenses` と各ランタイムに同梱しています。
