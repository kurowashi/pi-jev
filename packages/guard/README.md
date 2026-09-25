# pi-jev-guard

`edit` / `write` の内容を **Jev（TypeSafe System One）** で意味的にチェックする Pi 拡張です。
合格しない編集は実行前にブロックし、`fail` に書いた文字列をモデルへ返します。

## 動作の流れ

1. `edit` / `write` のツールコールで起動する
2. 対象ファイルのディレクトリから上位へ `.jev-guard.json` を探し、**最初に見つかった 1 つ**を使う（信頼済みの作業ディレクトリ内のみ）
3. `ignore` にマッチしたファイルはそのまま通す
4. マッチしたルールの checks と context を 1 つにまとめ、Jev へ yes/no の質問として送る
5. すべて合格なら編集を実行。1 つでも不合格ならツールコールを失敗させ、`fail` の文字列を返す

## できること

- ファイル（glob）ごとにチェック内容を切り替える
- ルール単位・チェック単位で `minProbability` と `negate` を指定する
- 複数ルールを 1 リクエストにまとめる（API アクセスはファイルごとに 1 回）
- `/jev-guard context <file>` で、Jev に送る内容を確認する

## インストール

```bash
npm install                                # @pi-jev/core の workspace リンクを作る
pi install /path/to/pi-jev/packages/guard  # パッケージとして追加
```

`@pi-jev/core` を参照するため、ファイル 1 つを `~/.pi/agent/extensions/` へコピーする使い方はできません。

## クイックスタート

1. `/jev-guard init` で `.jev-guard.json` の雛形を作る
2. ルールを書く
3. `/jev-guard check src/index.ts` で結果を確認する

```json
{
  "minProbability": 0.5,
  "onError": "allow",
  "context": "このプロジェクトではコメントは日本語で書く。",
  "rules": [
    {
      "name": "TypeScript",
      "files": ["**/*.ts", "**/*.tsx"],
      "checks": [
        "`any` 型を使っていない",
        "console.log を追加していない",
        { "check": "公開関数に戻り値の型が書かれている", "minProbability": 0.8 }
      ],
      "fail": "チェックに失敗しました ({file}):\n{checks}\n修正してから再度編集してください。"
    }
  ]
}
```

## 設定ファイル

`.jev-guard.json` は対象ファイルのディレクトリから上位（ファイルシステム root まで）へ探し、
最初に見つかった 1 つだけを使います。複数ファイルのマージもユーザー共通設定もありません。
共通の設定はリポジトリ root など祖先のディレクトリに 1 枚置いてください。

### トップレベル

| キー | 既定値 | 説明 |
|---|---|---|
| `enabled` | `true` | `false` でチェックを無効化 |
| `endpoint` | 自動 | Jev のエンドポイント URL |
| `model` | 自動 | Jev のモデル名 |
| `apiKeyEnv` | 自動 | API キーを読む環境変数名 |
| `minProbability` | `0.5` | 合格に必要な「yes」の確率 |
| `onError` | `"allow"` | Jev に接続できないときの挙動。`"block"` で編集を止める |
| `scope` | 自動 | `"change"` / `"file"` / `"both"`（後述） |
| `includeFileName` | `true` | state に `file: <path>` 行を含める |
| `maxFileChars` | `40000` | ファイル内容の最大文字数（超えた分は中央を省略） |
| `timeoutMs` | `20000` | 1 リクエストのタイムアウト |
| `fail` | 自動生成 | 失敗時に返す文字列（全ルール共通の既定値） |
| `context` | なし | すべてのチェックに渡す前提知識 |
| `ignore` | なし | チェックしないファイルの glob |
| `rules` | `[]` | ルールの配列 |

### ルール

| キー | 説明 |
|---|---|
| `name` | 表示名。`{rule}` で参照できる |
| `enabled` | `false` でルールを無効化 |
| `files` | glob または glob の配列。`/` を含まない場合はファイル名にマッチ。省略するとどのファイルにもマッチしない |
| `checks` | 文字列、または `{ "check": "...", "minProbability": 0.8, "negate": true }` の配列 |
| `fail` | このルール専用の失敗メッセージ |
| `context` | このルール専用の前提知識 |
| `minProbability` | チェックの既定しきい値（ルール単位） |
| `negate` | チェックの既定の反転（ルール単位） |

glob は `**`（任意の階層）、`*`（同一階層内）、`?`（1 文字）に対応します。先頭の `!` は除外パターンです。
パターンは設定ファイルのあるディレクトリからの相対パスで判定します。

### `ignore`：ファイルを対象外にする

`ignore` にマッチしたファイルはチェックされず、Jev へのリクエストも送られません。

```json
{
  "ignore": ["**/__init__.py", "**/generated/**", "*.min.js"],
  "rules": [{ "files": "**/*.py", "checks": ["No prints"] }]
}
```

- 文字列 1 つでも配列でも指定できます。`/` を含まないパターンはファイル名にマッチします。
- `!` で除外を打ち消せます（例: `["*.py", "!keep.py"]` では `keep.py` だけチェックされます）。
- `/jev-guard check` は `ignored` と表示し、Jev には接続しません。

### `negate`：否定形を肯定形に置き換える

Jev は否定形より肯定形のほうが精度よく答えることがあります。
`negate: true` はチェック文字列を**失敗の状態**として送り、返ってきた確率を反転して判定します。

```json
{
  "name": "Quality",
  "files": ["**/*.ts"],
  "negate": true,
  "checks": [
    "コードが汚い",
    "不要な複雑さがある",
    { "check": "コメントが日本語でない", "negate": false }
  ]
}
```

`negate` はルール単位の既定値で、チェック単位に上書きできます。
`minProbability` は反転後も「要件を満たす確率の下限」です。上の例で `0.5` なら、
`コードが汚い` の確率が 0.5 以下のときに合格します。表示には `negated` の印が付きます。

### `fail` のプレースホルダ

| プレースホルダ | 内容 |
|---|---|
| `{file}` | 編集対象ファイル（作業ディレクトリからの相対パス） |
| `{rule}` | ルール名（未指定なら設定ファイル名） |
| `{checks}` / `{details}` | 失敗したチェックの一覧（確率付き） |
| `{probability}` | 失敗したチェックのうち最も低い合格確率 |

`fail` を書かなければ、失敗したチェックと確率から自動生成します。

## チェック対象（`scope`）

| 値 | 送る内容 |
|---|---|
| `"change"` | 変更部分（before/after）のみ。`edit` の既定 |
| `"file"` | ファイル全体 |
| `"both"` | ファイル全体と変更部分 |

- `write` は常にファイル全体を送ります（`scope` は無視）。
- `"both"` でファイル全体が `maxFileChars` を超える場合は、全体だけを切り詰めます。
- 編集後ファイルを計算できないとき（完全一致の置換が成立しないなど）は、変更部分にフォールバックします。

## コマンド

| コマンド | 説明 |
|---|---|
| `/jev-guard` | 設定・エンドポイント・キーの状態を表示 |
| `/jev-guard init` | `.jev-guard.json` の雛形を作業ディレクトリに作成 |
| `/jev-guard check <file>` | 編集せずに現在の内容でチェック |
| `/jev-guard context [<file>]` | 送信される context と state を表示 |
| `/jev-guard on` / `off` | このセッションのチェックを有効化 / 無効化 |

`JEV_GUARD_DISABLE=1` で常時無効にできます。

## Jev に送られる内容

1 リクエストにつき `state` 文字列を 1 つ送ります。複数ルールは 1 つにまとめます。

````
<マージされた context>

file: docs/README.md
```
<編集後のファイル全体>
```

file edit
```diff
<変更部分（before/after）>
```
````

- 先頭はトップレベル `context` とマッチしたルールの `context` を空行で連結したもの（重複は除去）。
- `file:` 行は `includeFileName: false` で消せます。
- `file edit` は `scope` に応じて含まれます。

`/jev-guard context <file>` は **Jev へ接続せず**、同じ内容を表示します
（`<file>` 省略時は採用される設定の `context` だけ）。

````
jev-guard context: docs/README.md
config: /repo/.jev-guard.json — 2 rule(s)
enabled: true   includeFileName: true

context: (none)
file line: file: docs/README.md

rules merged into one request: 2 — Common, Markdown
merged context (1 part(s)):
----
You are a high-quality documentation expert.
----

state sent to Jev (whole file; an edit request follows `scope`):
----
...
----
````

`/jev-guard check <file>` の結果にも `state sent to Jev:` が付きます（長い state は省略されます）。

## API キーとエンドポイント

`process.env` を先に見て、無ければ対象ファイルと作業ディレクトリから上位へ `.env` を探します。
使うキーは `apiKeyEnv` → 汎用名 → エンドポイント固有名の順です。

| エンドポイント | 環境変数 | 既定モデル |
|---|---|---|
| TypeSafe（既定） | `SYSTEMONE_API_KEY`, `TYPESAFE_API_KEY` | `jev-1.13.0` |
| OpenRouter | `OPENROUTER_API_KEY` | `typesafe/jev-1.13` |
| OpenCode Zen | `OPENCODE_API_KEY`, `OPENCODE_ZEN_API_KEY` | `jev-1.13` |
| Command Code | `COMMANDCODE_API_KEY` | `typesafe/jev` |

- `SYSTEMONE_ENDPOINT` は最優先で使います。
- 明示した `endpoint` / `SYSTEMONE_ENDPOINT` が無い場合は、キーから自動選択します（TypeSafe → OpenRouter → OpenCode Zen → Command Code）。
- 接続先を固定するには `endpoint` / `model` / `apiKeyEnv` を設定します。

```json
{
  "endpoint": "https://openrouter.ai/api/alpha/decisions",
  "model": "typesafe/jev-1.13",
  "apiKeyEnv": "OPENROUTER_API_KEY"
}
```

## Jev の容量制限

- 1 リクエストの `state` + 最長の質問は、32k トークン程度に収める必要があります。
- `maxFileChars` は文字数でトークン数は見ていません。日本語では 40,000 文字が超過し得ます。超過時は HTTP 400 となり、`onError` に従います（既定は編集を通す）。

## セキュリティ上の注意

- 編集内容（ファイル全体・変更部分・その両方）と `context` は Jev のエンドポイントへ送信されます。機密情報を含むファイルではルールを絞ってください。
- `.jev-guard.json` は作業ディレクトリが信頼されている場合のみ有効です。未信頼のプロジェクトでは警告を表示して無視します。
- 探索はファイルシステム root まで行くため、信頼済みの作業ディレクトリより上にある設定も採用されます。親ディレクトリを共有する環境では注意してください。
- 作業ディレクトリ外のファイルにはプロジェクト設定を適用しません。
- `onError` の既定は `"allow"` です。Jev が落ちていても編集を通しますが、厳密に止めたい場合は `"block"` を設定してください。

## 制限事項

- フックするのは `edit` と `write` だけです。`bash` などによるファイル変更は対象外です。
- `scope: "file"` / `"both"` の edit は、編集ツールと同じ完全一致の置換で編集後ファイルを予測します。予測できない場合は変更部分のみをチェックします。
- Jev の回答は確率です。`minProbability` で感度を調整してください（既定 `0.5`）。

## 開発

```bash
npm test        # node:test（モックした Jev エンドポイントで検証）
```

実際の Jev に対する簡易 E2E:

```bash
cd /tmp/jev-e2e   # .jev-guard.json と対象ファイルを用意
pi -p --no-session --model <provider>/<model> \
  --extension /path/to/pi-jev/packages/guard/src/index.ts \
  "note.txt に BANANA という行を追加して"
```
