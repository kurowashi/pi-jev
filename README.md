# pi-jev-guard

ファイル編集（`edit` / `write`）を **Jev（TypeSafe System One）** で意味的にチェックする Pi 拡張です。
チェックを満たさない編集は **実行前にブロック** し、指定した文字列をツール結果としてモデルに返します。

- ファイル名（glob）ごとにチェック内容を指定できる
- プロジェクトごとの設定ファイル `.jev-guard.json`（AGENTS.md と同じように上位ディレクトリへ探索）
- チェックを満たさなければツールコールを失敗させ、`fail` に書いた任意の文字列を返す

## 動作の流れ

```
edit / write ツールコール
        │
        ▼
編集対象ファイルのディレクトリから上位へ .jev-guard.json を探索
（プロジェクト設定は信頼済みの作業ディレクトリ内でのみ有効）
        │
        ▼
ignore（glob）にマッチしたファイルはチェックせずに終了
        │
        ▼
files（glob）にマッチするルールの checks を集める
        │
        ▼
Jev に yes/no の質問としてまとめて投げる（noul）
        │
        ├─ すべて合格 → そのまま編集を実行
        └─ 1つでも不合格 → ツールコールを失敗させ、fail の文字列を返す
```

## インストール

```bash
# パッケージとしてインストール
pi install /path/to/jev-guard

# または1回だけ読み込んで試す
pi -e /path/to/jev-guard/extensions/jev-guard.ts
```

1ファイルだけなので `~/.pi/agent/extensions/jev-guard.ts` にコピーしても動きます（依存パッケージなし）。

## クイックスタート

1. プロジェクトで `/jev-guard init` を実行すると `.jev-guard.json` の雛形ができます。
2. ルールを編集します。

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

3. 設定を確認します。

```
/jev-guard check src/index.ts
```

## 設定ファイル `.jev-guard.json`

探索は AGENTS.md と同じで、**編集対象ファイルのディレクトリ → 親ディレクトリ → … → ルート** の順です。
近い設定が優先され、ルールはすべての階層から集められます（近い階層のルールから評価）。
ユーザー共通設定として `~/.pi/agent/jev-guard.json` も読み込まれます（`PI_CODING_AGENT_DIR` で変更可）。

### トップレベル

| キー | 既定値 | 説明 |
|---|---|---|
| `enabled` | `true` | `false` でこの設定を無効化 |
| `endpoint` | 自動 | Jev のエンドポイント URL |
| `model` | 自動 | Jev のモデル名 |
| `apiKeyEnv` | 自動 | API キーを読む環境変数名 |
| `minProbability` | `0.5` | チェック合格に必要な「yes」の確率 |
| `onError` | `"allow"` | Jev に接続できない時の挙動。`"block"` で編集を止める |
| `scope` | 自動 | `"change"`（変更部分）/ `"file"`（ファイル全体）/ `"both"`（ファイル全体+変更部分） |
| `includeFileName` | `true` | 対象ファイル名を `context` の先頭に `Target file: <path>` として含める |
| `maxFileChars` | `40000` | Jev に送る最大文字数。超えたら変更部分のみに切替 |
| `timeoutMs` | `20000` | 1回のリクエストのタイムアウト |
| `fail` | 自動生成 | 失敗時に返す文字列（全ルール共通の既定値） |
| `context` | なし | すべてのチェックに渡すプロジェクト固有の前提知識 |
| `ignore` | なし | チェックしないファイルの glob。どれかの設定でマッチすると、そのファイルは一切チェックしない |
| `rules` | `[]` | ルールの配列 |

### ルール

| キー | 説明 |
|---|---|
| `name` | 表示名。`{rule}` で参照できる |
| `enabled` | `false` でルールを無効化 |
| `files` | glob または glob の配列。`/` を含まない場合はファイル名にマッチ |
| `checks` | 文字列、または `{ "check": "...", "minProbability": 0.8, "negate": true }` の配列 |
| `fail` | このルール専用の失敗メッセージ |
| `context` | このルール専用の前提知識 |
| `minProbability` | このルールのチェックの既定しきい値 |
| `negate` | このルールのチェックの既定の反転設定 |

glob は `**`（任意の階層）、`*`（同一階層内）、`?`（1文字）に対応します。
先頭に `!` を付けると除外パターンになります。パターンは設定ファイルのあるディレクトリからの相対パスで判定します。

### チェック対象外にする（`ignore`）

`ignore` に glob を書くと、そのファイルはどの設定のどのルールでもチェックされません。
`__init__.py` のような定型的なファイルや生成物をまとめて対象外にできます。

```json
{
  "ignore": ["**/__init__.py", "**/generated/**", "*.min.js"],
  "rules": [
    { "files": "**/*.py", "checks": ["No prints"] }
  ]
}
```

- 文字列 1 つでも配列でも指定できます。書き方は `files` と同じで、`/` を含まないパターンはファイル名にマッチします。
- 先頭に `!` を付けると除外を打ち消せます（例: `["*.py", "!keep.py"]` では `keep.py` だけチェックされます）。
- 探索された設定のうち **1 つでも** `ignore` にマッチすると、そのファイルはチェックされず、Jev へのリクエストも送られません。親ディレクトリ側の設定のルールも適用されません。
- `/jev-guard check` では `ignored` と表示され、Jev には接続しません。

### 確率の反転（`negate`）

Jev は否定形（「〜していない」）より肯定形のほうが精度よく答えられることがあります。
`negate: true` を付けると、チェック文字列を**失敗の状態**としてそのまま Jev に投げ、返ってきた確率を反転して合否を判定します。

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

- `negate` はルール単位の既定値になり、チェック単位で上書きできます。
- `minProbability` は反転後も「要件が満たされている確率の下限」です。上の例で `minProbability: 0.5` なら、`コードが汚い` の確率が 0.5 以下のときに合格します。
- 失敗メッセージと `/jev-guard check` の表示は反転後の確率で、`negated` の印が付きます。

### `fail` で使えるプレースホルダ

| プレースホルダ | 内容 |
|---|---|
| `{file}` | 編集対象ファイル（作業ディレクトリからの相対パス） |
| `{rule}` | ルール名（未指定なら設定ファイル名） |
| `{checks}` / `{details}` | 失敗したチェックの一覧（確率付き） |
| `{probability}` | 失敗したチェックのうち最も低い合格確率 |

`fail` を書かなければ「どのチェックがどれくらいの確率で失敗したか」を自動生成して返します。

## コマンド

| コマンド | 説明 |
|---|---|
| `/jev-guard` | 現在の設定・エンドポイント・キーの状態を表示 |
| `/jev-guard init` | 作業ディレクトリに `.jev-guard.json` の雛形を作成 |
| `/jev-guard check <file>` | 編集せずに現在のファイル内容でチェックを実行 |
| `/jev-guard on` / `off` | このセッションでのチェックを有効化 / 無効化 |

`JEV_GUARD_DISABLE=1` で常時無効にもできます。

## チェック対象（scope）

- `edit` の既定は `"change"`：**変更部分（before/after）だけ**を Jev に渡します。
  既存の問題で無関係な編集がブロックされないため、こちらが既定です。
- `write` は常に**ファイル全体**を渡します（`scope` は無視されます）。
- `"scope": "file"` を設定すると `edit` でも編集後のファイル全体を渡します。
- `"scope": "both"` を設定すると、**ファイル全体と変更部分（before/after）の両方**を渡します。ファイル全体が `maxFileChars` を超える場合は全体のみを切り詰め、変更部分はそのまま渡します。
- ファイル全体を計算できない場合（完全一致の置換が成立しない場合など）は、`"file"` でも `"both"` でも変更部分にフォールバックします。

既定では、`context` の先頭に `Target file: <path>` を付けて対象ファイル名を Jev に伝えます（`"includeFileName": false` で無効化）。Jev はファイルの種類やパスを踏まえて判定できます。

## API キーとエンドポイント

次の順で探します（`apiKeyEnv` → 汎用名 → エンドポイント固有名）。
`process.env` を先に見て、無ければ編集対象ファイルと作業ディレクトリから上位へ `.env` を探します。

| エンドポイント | 環境変数 | 既定モデル |
|---|---|---|
| TypeSafe（既定） | `SYSTEMONE_API_KEY`, `TYPESAFE_API_KEY` | `jev-1.13.0` |
| OpenRouter | `OPENROUTER_API_KEY` | `typesafe/jev-1.13` |
| OpenCode Zen | `OPENCODE_API_KEY` | `jev-1.13` |
| Command Code | `COMMANDCODE_API_KEY` | `typesafe/jev` |

- `SYSTEMONE_ENDPOINT` が設定されていればそれを最優先で使います。
- TypeSafe のキーが無く `OPENROUTER_API_KEY` がある場合は、OpenRouter のエンドポイントを自動選択します。
- 接続先を固定したい場合は設定ファイルに `endpoint` / `model` / `apiKeyEnv` を書いてください。

例（OpenRouter）:

```json
{
  "endpoint": "https://openrouter.ai/api/alpha/decisions",
  "model": "typesafe/jev-1.13",
  "apiKeyEnv": "OPENROUTER_API_KEY"
}
```

## セキュリティ上の注意

- チェック時、**編集内容（ファイル全体・変更部分・その両方）と `context` が Jev のエンドポイントへ送信されます。** 機密情報を含むファイルではルールを絞ってください。
- プロジェクトの `.jev-guard.json` は、**作業ディレクトリが信頼されている場合のみ**有効です。未信頼のプロジェクトでは無視され、警告を表示します。ユーザー設定 `~/.pi/agent/jev-guard.json` は常に有効です。
- 作業ディレクトリ外のファイルにはプロジェクト設定を適用しません。
- `onError` の既定は `"allow"`（Jev が落ちていても編集を通す）です。厳密に止めたい場合は `"block"` を設定してください。

## 制限事項

- フックするのは `edit` と `write` だけです。`bash` などで行われるファイル変更は対象外です。
- `edit` の `scope: "file"` / `"both"` は、編集ツールと同じ完全一致の置換で編集後ファイルを予測します。予測できない場合（ファジーマッチが必要な場合など）は変更部分のみをチェックします。
- Jev の回答は確率です。`minProbability` で感度を調整してください（既定 `0.5`）。否定形のチェックは `negate` で肯定形に書き換えられます。

## 開発

```bash
npm test        # node:test（モックした Jev エンドポイントで検証）
```

実際の Jev に対する簡易 E2E:

```bash
cd /tmp/jev-e2e   # .jev-guard.json と対象ファイルを用意
pi -p --no-session --model <provider>/<model> \
  --extension /path/to/jev-guard/extensions/jev-guard.ts \
  "note.txt に BANANA という行を追加して"
```
