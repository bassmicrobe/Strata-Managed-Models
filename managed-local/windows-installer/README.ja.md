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

## 更新

通常の起動時に、このforkの検証済み配布版を確認します。新しい本体を別フォルダーに準備し、起動確認後に切り替えます。通信や検証に失敗した場合は、現在の版で起動します。回答やモデル操作の途中は更新を延期します。

GitHub側では大元の安定版を毎時確認します。取り込み・テスト・ビルドに成功した版だけを公開します。競合がある場合は、修正されるまで前の配布版を使います。

## 保存先と終了

- アプリ：通常は `%LOCALAPPDATA%\Programs\StrataManaged`
- 設定・会話・コンポーネント：`%LOCALAPPDATA%\StrataManaged`
- モデル：画面で指定した保存先

既存の公式Strataとは別のフォルダーを使います。ブラウザーを閉じてもホストやモデルが動き続ける場合があります。終了時は、アプリ内でモデルを停止してください。

Windowsの「インストールされているアプリ」から **Strata Managed Models** をアンインストールできます。アプリ本体を除去し、設定・会話・モデルは保持します。

## 配布元

- [このfork](https://github.com/bassmicrobe/Strata-Managed-Models)
- [Releasesとチェックサム](https://github.com/bassmicrobe/Strata-Managed-Models/releases)
- [自動検証の結果](https://github.com/bassmicrobe/Strata-Managed-Models/actions/workflows/managed-updates.yml)
- [公式Strata](https://github.com/Niko1221/Strata)

現時点のインストーラーにはコード署名を付けていません。配布物のSHA-256は同じリリースの `managed-host.json` に記載します。ライセンスはインストール先の `licenses` と各ランタイムに同梱しています。
