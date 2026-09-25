# pi-jev-guard

ファイル編集（`edit` / `write`）を **Jev（TypeSafe System One）** で意味的にチェックする Pi 拡張です。
チェックを満たさない編集は **実行前にブロック** し、指定した文字列をツール結果としてモデルに返します。

- ファイル名（glob）ごとにチェック内容を指定できる
- プロジェクトごとの設定ファイル `.jev-guard.json`（AGENTS.md と同じく上位ディレクトリへ探索し、最初に見つかった 1 つだけを使う）
- マッチした複数ルールの checks と context は1リクエストにマージされる（API アクセスはファイルごとに1回）
- Jev に実際に送られる context と state を `/jev-guard context <file>` で確認できる
- チェックを満たさなければツールコールを失敗させ、`fail` に書いた任意の文字列を返す

## 動作の流れ

```
edit / write ツールコール
        │
        ▼
編集対象ファイルのディレクトリから上位へ .jev-guard.json を探索し、
最初に見つかった 1 つを採用（信頼済みの作業ディレクトリ内でのみ有効）
        │
        ▼
ignore（glob）にマッチしたファイルはチェックせずに終了
        │
        ▼
採用した設定の files（glob）にマッチするルールの checks と context を1つにマージ
        │
        ▼
Jev に1リクエストで yes/no の質問としてまとめて投げる（noul）
        │
        ├─ すべて合格 → そのまま編集を実行
        └─ 1つでも不合格 → ツールコールを失敗させ、fail の文字列を返す
```

## インストール

```bash
# リポジトリのルートで依存を入れる（workspace リンクの作成。必須）
npm install

# パッケージとしてインストール
pi install /path/to/pi-jev/packages/guard
```

`pi-jev-guard` は `@pi-jev/core`（共有の配管）を参照するため、単一ファイルを
`~/.pi/agent/extensions/` にコピーする運用はできません。

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

探索は AGENTS.md と同じで、**編集対象ファイルのディレクトリ → 親ディレクトリ → … → ファイルシステム root** の順に
上へ見ていき、**最初に見つかった 1 つだけ**を使います。複数の設定ファイルはマージされません。
ユーザー共通設定（`~/.pi/agent/jev-guard.json` など）はありません。共通の設定を使いたい場合は、
リポジトリ root やホームディレクトリなど、祖先のディレクトリに 1 枚置いてください。

採用された設定が `enabled: false` の場合は、チェックが無効になります。

### トップレベル

| キー | 既定値 | 説明 |
|---|---|---|
| `enabled` | `true` | `false` でチェックを無効化 |
| `endpoint` | 自動 | Jev のエンドポイント URL |
| `model` | 自動 | Jev のモデル名 |
| `apiKeyEnv` | 自動 | API キーを読む環境変数名 |
| `minProbability` | `0.5` | チェック合格に必要な「yes」の確率 |
| `onError` | `"allow"` | Jev に接続できない時の挙動。`"block"` で編集を止める |
| `scope` | 自動 | `"change"`（変更部分）/ `"file"`（ファイル全体）/ `"both"`（ファイル全体+変更部分） |
| `includeFileName` | `true` | state にプロジェクト相対パスの `file: <path>` 行を含める |
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

`ignore` に glob を書くと、そのファイルは採用された設定のどのルールでもチェックされません。
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
- `ignore` にマッチしたファイルはチェックされず、Jev へのリクエストも送られません。
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
| `/jev-guard context [<file>]` | マージされた context と Jev に送られる state を表示（`<file>` 省略時は採用される設定の context のみ） |
| `/jev-guard on` / `off` | このセッションでのチェックを有効化 / 無効化 |

`JEV_GUARD_DISABLE=1` で常時無効にもできます。

### `context` と送信 state の確認

Jev へは1リクエストにつき1つの `state`（文字列）を送ります。マッチした複数ルールの checks と `context` は
**1つのリクエストにマージ**されるため、API アクセスはファイルごとに1回です。state の形式は次のとおりです。

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

- `context` はトップレベルの `context` と、マッチした各ルールの `context` を空行で連結したものです（重複は除去）。
- `file:` はプロジェクト相対パスです（`"includeFileName": false` で無効化）。
- `file edit` セクションに変更部分（before/after）が入ります。`scope` に応じて、ファイル全体とファイル編集のどちらか、または両方が含まれます。

`/jev-guard context <file>` は **Jev へ接続せずに**、マージされた context と、実際に送られる state を表示します。

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
You are a high-quality documentation expert.

file: docs/README.md
```
# Title
...
```
----
````

- `<file>` を省略すると、cwd から探索して採用される設定の `context` を表示します。
- `ignore` にマッチするファイルには「送信されない」と表示します。
- API キーがなくても実行できます。

`/jev-guard check <file>` の結果にも `state sent to Jev:` セクションが付きます
（長い state は省略されます。全文は `context` サブコマンドで確認してください）。

## チェック対象（scope）

- `edit` の既定は `"change"`：**変更部分（before/after）だけ**を Jev に渡します。
  既存の問題で無関係な編集がブロックされないため、こちらが既定です。
- `write` は常に**ファイル全体**を渡します（`scope` は無視されます）。
- `"scope": "file"` を設定すると `edit` でも編集後のファイル全体を渡します。
- `"scope": "both"` を設定すると、**ファイル全体と変更部分（before/after）の両方**を渡します。ファイル全体が `maxFileChars` を超える場合は全体のみを切り詰め、変更部分はそのまま渡します。
- ファイル全体を計算できない場合（完全一致の置換が成立しない場合など）は、`"file"` でも `"both"` でも変更部分にフォールバックします。

既定では state に `file: <プロジェクト相対パス>` 行を含めて対象ファイルを Jev に伝えます（`"includeFileName": false` で無効化）。Jev はファイルの種類やパスを踏まえて判定できます。

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

- チェック時、**編集内容（ファイル全体・変更部分・その両方）と `context` が Jev のエンドポイントへ送信されます。** プロジェクト相対パスと、マッチした全ルールの checks が1リクエストにまとめて送られます。機密情報を含むファイルではルールを絞ってください。
- `.jev-guard.json` は、**作業ディレクトリが信頼されている場合のみ**有効です。未信頼のプロジェクトでは無視され、警告を表示します。
- 探索はファイルシステム root まで行くため、信頼済みの作業ディレクトリより上にある設定も採用されます（AGENTS.md と同じ挙動）。親ディレクトリを共有する環境では、第三者が置いた設定が採用され得る点に注意してください。
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
  --extension /path/to/pi-jev/packages/guard/src/index.ts \
  "note.txt に BANANA という行を追加して"
```
