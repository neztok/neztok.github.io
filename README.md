# クイズ読み上げアプリ

Discord での画面共有を想定したクイズ出題用アプリです。Tkinter のコントロール画面と、pywebview で描画するプレゼンテーション画面を連携させ、タイプライタ表示と VOICEVOX による読み上げを同期再生します。スペースキーによる早押し停止や、ページ切り替え時の TTS 先読みなど、実況向けの運用に必要な最低限の機能を備えています。

## 構成

```
app/main.py       # Tkinter コントロール UI・子プロセス制御・VOICEVOX 連携
app/presenter.py  # プレゼンテーション用サブプロセス（pywebview + ブリッジサーバ）
web/index.html    # プレゼンテーション画面 HTML
web/style.css     # プレゼンテーション画面のテーマ・レイアウト
web/app.js        # タイプライタ制御・ページ分割・WebAudio 再生
samples/sample.quiz.txt  # クイズデータ（v1形式）
requirements.txt  # 必要ライブラリ
```

### 2 プロセス構成

本アプリは Tkinter のコントロール UI と pywebview のプレゼン画面を**別プロセス**で動作させます。親プロセス（`app/main.py`）は Tk メイン
ループを保持し、子プロセス（`app/presenter.py`）が pywebview ウィンドウとブリッジサーバを起動します。両プロセス間の通信は JSON メッ
セージで行い、以下の 2 種類から選択できます。

- `--bridge ws`（既定）: 子プロセスが WebSocket サーバ（`ws://127.0.0.1:<動的ポート>`）を立ち上げ、親プロセスとプレゼン JS 双方が接続し
  ます。低レイテンシでリアルタイムにイベントを双方向転送できます。
- `--bridge http`: 子プロセスが HTTP + Server-Sent Events（SSE）サーバを起動し、親→子は `POST /api/cmd`、子→親は `GET /api/events` の
  SSE で通知します。プレゼン JS は `EventSource` でコマンドを受信し、`fetch` で状態を送信します。ファイアウォールで HTTP を許可しや
  すい環境に適しています。

いずれの場合も、子プロセスは起動時に未使用ポートを動的に割り当て、コントロール UI からプレゼン JS へクエリパラメータ（`mode` / `port`）
で伝達します。外部に公開されないローカルループバック通信のため、通常は追加設定不要ですが、企業ネットワークなどで localhost への接続が
制限されている場合は、使用ポートの通過を許可してください。

フロー概要:

```
Tk (app/main.py)
   │ JSON / queue
   ▼
Bridge server + pywebview (app/presenter.py)
   │ WebSocket / HTTP (JSON)
   ▼
Presentation JS (web/app.js)
```

## 前提条件

- Python 3.10 以上
- VOICEVOX エンジン（ローカル API を `http://127.0.0.1:50021` で提供）
- 音声出力が可能な環境（WebAudio を使用）
- Windows / macOS / Linux で動作確認済み。Windows では Microsoft Edge WebView2 ランタイム（pywebview の `edgechromium` バックエンド）が必須です。未導入の場合は Microsoft 公式サイトからインストールし、必要に応じて `PYWEBVIEW_GUI=edgechromium` を指定してください。
- 親子プロセス間でローカルループバック通信（`127.0.0.1:<動的ポート>`）を使用します。企業ネットワークなどで localhost への WebSocket / HTTP 通信が制限される場合は、適宜許可を与えてください。

## セットアップ

1. リポジトリを取得後、任意の仮想環境を作成してアクティベートします。

   ```bash
   python -m venv .venv
   source .venv/bin/activate  # Windows は .venv\Scripts\activate
   ```

2. 依存ライブラリをインストールします。

   ```bash
   pip install -r requirements.txt
   ```

3. VOICEVOX エンジンを起動し、ローカル API が利用できる状態にします。

   - デスクトップ版 VOICEVOX で「エンジン起動」を押す、または `run.exe --host 127.0.0.1 --port 50021` などで CLI から起動します。

## 実行方法

### 親プロセスだけで起動する（通常運用）

```bash
python app/main.py --bridge ws --debug
```

- `--bridge` を省略すると WebSocket ブリッジが選択されます。HTTP + SSE を試す場合は `--bridge http` を指定してください。
- `--port` を省略すると、未使用のポートを自動で割り当てます。ファイアウォール設定済みのポートを使う場合のみ明示的に指定します（例: `--port 8765`）。
- `--debug` または環境変数 `DEBUG=1` を指定すると、起動から 30 秒間は親プロセスが WebSocket 接続のリトライ間隔や割り当てポートを、子プロセスが GUI バックエンドと `index.html` の絶対 URL、`WS listening on ws://...` といった診断ログを INFO レベルで出力します。
- Windows では Microsoft Edge WebView2 ランタイムが必須です。`PYWEBVIEW_GUI=edgechromium` を設定すると Edge バックエンドを強制できます。
- VOICEVOX エンジンが未起動でも 10 秒間隔で再検出します。後からエンジンを立ち上げた場合は、コントロール画面で「開始」を押し直せば音声が再取得されます。

### プロセスを分けてデバッグする場合

```bash
# 先にプレゼンプロセスを起動
python app/presenter.py --bridge ws --port 8765 --debug

# 続いてコントロールを同じブリッジ・ポートで起動
python app/main.py --bridge ws --port 8765 --debug
```

- HTTP + SSE フォールバックでは `--bridge http` を両方に指定してください（CORS と OPTIONS 応答は既に有効です）。
- `ブリッジ` ラベルが「接続中」になってから `READY` イベントが届くと、現在選択中の問題・設定が自動的に再同期されます。切断時は「未接続」に戻り、再接続後に音声プリフェッチが再実行されます。

- **コントロール画面**（Tkinter）と **プレゼン画面**（pywebview）の 2 つのウィンドウが開きます。
- 初期状態では `samples/sample.quiz.txt` を読み込みます。別ファイルを利用する場合は「クイズを開く」ボタンから選択してください。
- コントロール画面で問題を選択して「開始」を押すと、プレゼン画面にタイプライタ表示が始まります。

### 操作とショートカット

| 操作 | 説明 |
| ---- | ---- |
| Space | タイプライタと音声を即停止（100ms フラッシュ） |
| R | 停止状態から再開 |
| Enter | 正解を表示（再実行で解除は行いません） |
| PgUp / PgDn | ページ移動（停止状態で使用すると安全です） |
| Esc | アプリを終了 |

設定項目:

- **CPS**（Characters Per Second）: 10–18 の範囲で入力。次のフレーズから反映されます。
- **ポーズ係数**: 読点・文末ポーズに乗算する係数（0.8–1.4）。
- **ズーム**: プレゼン画面全体の拡大率（0.85–1.40）。
- **コンパクト表示**: 見出し領域の表示/非表示を切り替えます。

ステータスエリアでは、ブリッジ接続状態、現在のページ番号、進行中フレーズ、TTS キュー残数、VOICEVOX の起動状態を確認できます。

### プレゼン画面の仕様

- ベースカラー `#E6E5E4`・アクセント `#769CBF`・テキスト `#25271F`
- 本文は最大 10 行/ページを目安に自動分割し、28→26→24→22px と段階的に縮小します。なお、どうしても入りきらない場合はタイプライタ進行に合わせて自動スクロールします。
- 書記素単位でタイプライタを制御し、読点・文末・段落ごとに指定のポーズを追加します。
- WebAudio（AudioContext）で VOICEVOX の WAV を再生します。停止指示が入ると直ちに現在の音声を止め、キューを破棄します。
- 停止操作時は VOICEVOX への TTS 取得リクエストも中断し、再開時に必要なチャンクを再度要求します。
- `漢字《よみ》` のインラインルビ、`READING:` 辞書、`{{AQUES|...}}` の AQUES 指定に対応し、表示テキストと TTS を切り分けます。

## クイズデータ形式 (v1)

- UTF-8 テキスト。`---` のみの行で問題を区切ります。
- 各ブロックは以下のセクションを順に記述します。

```
# Q: タイトル（任意）
READING:
  - surface: 表記
    yomi: ヨミ

QUESTION:
問題文（複数行可）

ANSWER:
正解1｜正解2｜...

EXPLAIN:
解説（任意）
```

- `READING:` は全体／個別どちらにも記述できます。`surface` を表示テキストから検索して `yomi` のカタカナ読みへ差し替えます。
- インラインルビ `語《ご》` は表示は元の語のまま、読み上げ時のみ《ご》に差し替えます。
- `{{AQUES|...}}` で囲んだ箇所は VOICEVOX の `is_kana=true` として送信します。

## トラブルシュート

| 症状 | 対処 |
| ---- | ---- |
| VOICEVOX が未起動で音声が出ない | コントロール画面のステータスが「未起動」のままになります。エンジン起動後に再度「開始」を押すと音声が流れます。警告は初回のみ表示され、以後は無音で進行します。 |
| プレゼン画面が真っ白 | `web/index.html` が読み込めていない可能性があります。`python app/main.py` をプロジェクトルートで実行しているか確認してください。 |
| RuntimeError: main thread is not in main loop / no running event loop | 最新の 2 プロセス構成では、子プロセス内で専用の asyncio ループを立ち上げています。旧バージョンの `presenter.py` が残っていないか確認し、`WS listening on ws://...` ログが出ているかを `--debug` 付きで確認してください。ポート競合でも同様のエラーになるため、未使用ポートに変更するか、既存プロセスを終了します。 |
| 接続拒否（WinError 1225 など）で「未接続」から回復しない | `app/presenter.py` が指定ポートで待ち受けているか確認し、ファイアウォールに `127.0.0.1:<ポート>` への WebSocket/HTTP 通信を許可してください。`--debug` で「WebSocket bridge connected/disconnected」のログが循環している場合は、ポートやブリッジ方式を見直します。 |
| WebAudio が再生されない | ブラウザコンテキストがサスペンドされた場合があります。タイプライタ開始や再開を行うと AudioContext が自動的に `resume()` されます。 |
| 長文が収まらない | 自動縮小とスクロールが働かない場合は、問題文を句読点で分割するなど調整してください。 |
| READY が届かずコントロールに「未接続」と表示される | ファイアウォールで `127.0.0.1:<動的ポート>` への WebSocket / HTTP 通信が遮断されていないか確認してください。HTTP ブリッジの場合は `http://127.0.0.1:<ポート>/api/presentation/events` への EventSource が許可されている必要があります。接続が復旧すると `ブリッジ` ラベルが「接続中」に戻り、自動的に `READY` が再送されます。 |

## ライセンス

本リポジトリのコードは依頼仕様に基づくサンプル実装です。利用や改変は自己責任でお願いします。

## 開発者向けメモ

- 親プロセス（`app/main.py`）は Tk メインスレッドで `mainloop()` を実行し、子プロセスを `subprocess.Popen` で起動します。Tk ウィジェット操作はすべて `_drain_ui_queue()` 内（メインスレッド）に集約してください。
- 子プロセス（`app/presenter.py`）は pywebview ウィンドウとブリッジサーバを同一プロセスで立ち上げます。WebSocket モードでは `websockets`、HTTP モードでは `aiohttp` を使用します。双方とも JSON メッセージのみを送受信し、Tk オブジェクトを参照しません。
- プレゼン HTML は常に `index_path.resolve().as_uri()` で得た `file:///` 絶対 URL を用いて読み込みます。相対パス指定は白画面やリソース読み込み失敗の原因になります。
- `--debug` を指定すると、親はブリッジモード・割り当てポートを INFO ログに出力し、子は GUI バックエンドと `index.html` の絶対パスを記録します。動作確認やポート解放確認時に活用してください。
