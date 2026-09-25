# pi-jev-tree-guard

**新しいファイルの作成（`write`）を Jev（TypeSafe System One）で意味的にチェックする** Pi 拡張です。
既存のディレクトリ・ファイルツリーと、これから追加しようとしているファイルを Jev に渡し、
「その場所・その名前でよいか」を判定します。チェックを満たさない作成は **実行前にブロック** し、
指定した文字列をツール結果としてモデルに返します。

- `write` で **まだ存在しないパス** にだけフックする（既存ファイルの上書きは既定でチェックしない）
- プロジェクトのツリー（上限付き・ignore 対応）を描画して Jev に渡す
- 新規作成されるディレクトリは `auth/ (new dir)`、追加されるファイルは `login.ts (new)` のように後置で明示する
- ファイル名（glob）ごとにチェック内容を指定できる
- マッチした複数ルールの checks と context は1リクエストにマージされる（API アクセスはファイルごとに1回）
- Jev に実際に送られる context と state を `/jev-tree-guard context <file>` で確認できる
- プロジェクトごとの設定ファイル `.jev-tree-guard.json`（AGENTS.md と同じく上位ディレクトリへ探索し、最初に見つかった 1 つだけを使う）

想定用途は「ディレクトリやファイル構成を適切に整理・配置するように guard する」ことです。
`pi-jev-guard`（編集内容のチェック）の姉妹プラグインで、こちらは **配置（placement）** に特化しています。

## 動作の流れ

```
write ツールコール
        │
        ▼
対象パスが存在する？
        ├─ 存在する（上書き）→ onlyNewFiles なら何もせず終了
        └─ 存在しない（新規）
                │
                ▼
        対象ディレクトリから上位へ .jev-tree-guard.json を探索し、
        最初に見つかった 1 つを採用（信頼済みの作業ディレクトリ内でのみ有効）
                │
                ▼
        ignore（glob）にマッチしたファイルはチェックせずに終了
                │
                ▼
        採用した設定の files（glob）にマッチするルールの checks を集める
                │
                ▼
        作業ディレクトリのツリーを描画
        （maxTreeEntries / maxTreeDepth で上限、treeIgnore で除外、
          対象パスは常に表示し、new / new dir を後置する）
                │
                ▼
        Jev に「ツリー + ファイル内容」と yes/no の質問を1リクエストでまとめて投げる（noul）
                │
                ├─ すべて合格 → そのまま作成を実行
                └─ 1つでも不合格 → ツールコールを失敗させ、fail の文字列を返す
```

## インストール

```bash
# リポジトリのルートで依存を入れる（workspace リンクの作成。必須）
npm install

# パッケージとしてインストール
pi install /path/to/pi-jev/packages/tree-guard
```

`pi-jev-tree-guard` は `@pi-jev/core`（共有の配管）を参照するため、単一ファイルを
`~/.pi/agent/extensions/` にコピーする運用はできません。

`pi-jev-guard` と併用できます。`edit` は `pi-jev-guard`、`write` の新規作成は `pi-jev-tree-guard` が担当します。

## クイックスタート

1. プロジェクトで `/jev-tree-guard init` を実行すると `.jev-tree-guard.json` の雛形ができます。
2. ルールと `context`（プロジェクトのディレクトリ構成・命名規則）を編集します。

```json
{
  "minProbability": 0.5,
  "onError": "allow",
  "onlyNewFiles": true,
  "context": "src/ は機能単位で分割する。tests/ は src/ をミラーする。ドキュメントは docs/ に置く。",
  "rules": [
    {
      "name": "Application code",
      "files": ["src/**/*.ts"],
      "checks": [
        "新しいファイルは、その役割に対応する機能ディレクトリに置かれている",
        "ファイル名は兄弟ファイルの命名規則と一致している",
        { "check": "既存モジュールと責務が重複している", "negate": true },
        { "check": "機能に属するのに src/ 直下に置かれている", "negate": true }
      ],
      "fail": "配置チェックに失敗しました ({file}):\n{checks}\n既存ツリーに合う場所と名前を選んでから、もう一度 write してください。"
    }
  ]
}
```

3. 設定を確認します。

```
/jev-tree-guard check src/features/auth/login.ts
```

対象ファイルがまだ存在しなくても、既に存在していても実行できます。既存ファイルを指定した場合は
「新規作成するつもり」として扱い、ツリーからそのファイルを除いて判定します（配置の見直しに便利です）。

## 設定ファイル `.jev-tree-guard.json`

探索は AGENTS.md と同じで、**作成対象ファイルのディレクトリ → 親ディレクトリ → … → ファイルシステム root** の順に
上へ見ていき、**最初に見つかった 1 つだけ**を使います。複数の設定ファイルはマージされません。
ユーザー共通設定（`~/.pi/agent/jev-tree-guard.json` など）はありません。共通の設定を使いたい場合は、
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
| `onError` | `"allow"` | Jev に接続できない時の挙動。`"block"` で作成を止める |
| `onlyNewFiles` | `true` | `true` なら存在しないパスへの `write` だけをチェックする |
| `includeContent` | `true` | ツリーに加えて、作成しようとしているファイルの内容も Jev に送る |
| `maxFileChars` | `40000` | Jev に送るファイル内容の最大文字数（中央を省略） |
| `maxTreeEntries` | `400` | ツリーに含めるエントリ数の上限 |
| `maxTreeDepth` | `5` | ツリーの最大深さ。対象パス上のディレクトリは常にたどる |
| `treeIgnore` | 主要な生成物ディレクトリ | ツリーから隠す glob。指定すると既定値を置き換える |
| `timeoutMs` | `20000` | 1回のリクエストのタイムアウト |
| `fail` | 自動生成 | 失敗時に返す文字列（全ルール共通の既定値） |
| `context` | なし | すべてのチェックに渡すプロジェクト固有の前提知識（ディレクトリ構成など） |
| `ignore` | なし | チェックしないファイルの glob。マッチしたファイルは一切チェックしない |
| `includeFileName` | `true` | state に `file: <プロジェクト相対パス> (new)` 行を含める |
| `rules` | `[]` | ルールの配列 |

`treeIgnore` の既定値は `.git`, `node_modules`, `.venv`, `__pycache__`, `dist`, `build`, `target`,
`vendor`, `.next`, `.cache`, `.pi/tasks`, `coverage` などです。

### ルール

| キー | 説明 |
|---|---|
| `name` | 表示名。`{rule}` で参照できる |
| `enabled` | `false` でルールを無効化 |
| `files` | glob または glob の配列。**省略するとすべてのファイルにマッチ**。`/` を含まない場合はファイル名にマッチ |
| `checks` | 文字列、または `{ "check": "...", "minProbability": 0.8, "negate": true }` の配列 |
| `fail` | このルール専用の失敗メッセージ |
| `context` | このルール専用の前提知識 |
| `minProbability` | このルールのチェックの既定しきい値 |
| `negate` | このルールのチェックの既定の反転設定 |

glob は `**`（任意の階層）、`*`（同一階層内）、`?`（1文字）に対応します。
先頭に `!` を付けると除外パターンになります。パターンは設定ファイルのあるディレクトリからの相対パスで判定します。

### 確率の反転（`negate`）

Jev は否定形（「〜していない」）より肯定形のほうが精度よく答えられることがあります。
`negate: true` を付けると、チェック文字列を**失敗の状態**としてそのまま Jev に投げ、返ってきた確率を反転して合否を判定します。

```json
{
  "name": "Placement",
  "files": ["src/**/*.ts"],
  "negate": true,
  "checks": [
    "機能に属するファイルが src/ 直下に置かれている",
    "似た名前のファイルが別の場所に既にある",
    { "check": "新しいディレクトリを不必要に増やしている", "negate": false }
  ]
}
```

- `negate` はルール単位の既定値になり、チェック単位で上書きできます。
- `minProbability` は反転後も「要件が満たされている確率の下限」です。

### `fail` で使えるプレースホルダ

| プレースホルダ | 内容 |
|---|---|
| `{file}` | 作成対象ファイル（作業ディレクトリからの相対パス） |
| `{rule}` | ルール名（未指定なら設定ファイル名） |
| `{checks}` / `{details}` | 失敗したチェックの一覧（確率付き） |
| `{probability}` | 失敗したチェックのうち最も低い合格確率 |

`fail` を書かなければ「どのチェックがどれくらいの確率で失敗したか」を自動生成して返します。

## Jev に渡される内容

Jev へは1リクエストにつき1つの `state`（文字列）を送ります。マッチした複数ルールの checks と `context` は
**1つのリクエストにマージ**されるため、API アクセスはファイルごとに1回です。state の形式は次のとおりです。

````
<マージされた context>

file: src/features/auth/login.ts (new)

project tree
```
./
  src/
    features/
      auth/ (new dir)
        login.ts (new)
  docs/
    README.md
```

file content
```
export function login() { ... }
```
````

- 先頭は、トップレベルの `context` とマッチした各ルールの `context` を空行で連結したものです（重複は除去）。
- `file:` 行はプロジェクト相対パスと、`new` / `overwrite` の別を示します（`"includeFileName": false` で無効化）。
- `project tree` は作業ディレクトリをルートにした相対パス表示です。既存のディレクトリのみのパスには `/`、新規作成されるディレクトリには `auth/ (new dir)`、追加されるファイルには `login.ts (new)` のように**後置**で印が付きます（名前の頭が揃うので階層の深さが読みやすくなります）。
- `file content` は作成しようとしているファイルの内容です（`"includeContent": false` で省略）。
- エントリ数の上限や深さの上限に達しても、**対象ファイルのパスは必ず表示**されます。切り詰めた場合は state の `note:` 行で Jev に伝えます（`check` / `context` コマンドの表示は `tree: N entries (truncated)` / `(depth limited)`）。
- `maxTreeEntries` / `maxTreeDepth` / `treeIgnore` は設定ファイルで調整できます。
- `onlyNewFiles: false` のときは `file:` 行が `(overwrite)` になり、既存ファイルはそのままツリーに現れます。

## コマンド

| コマンド | 説明 |
|---|---|
| `/jev-tree-guard` | 現在の設定・エンドポイント・キーの状態を表示 |
| `/jev-tree-guard init` | 作業ディレクトリに `.jev-tree-guard.json` の雛形を作成 |
| `/jev-tree-guard check <file>` | 作成せずに配置チェックを実行（既存ファイルは「新規」として扱う） |
| `/jev-tree-guard context [<file>]` | マージされた context と Jev に送られる state を表示（`<file>` 省略時は採用される設定の context のみ） |
| `/jev-tree-guard on` / `off` | このセッションでのチェックを有効化 / 無効化 |

`JEV_TREE_GUARD_DISABLE=1` で常時無効にもできます。

### `context` と送信 state の確認

`/jev-tree-guard context <file>` は **Jev へ接続せずに**、マージされた context と、実際に送られる state を表示します。

````
jev-tree-guard context: src/features/login.ts
config: /repo/.jev-tree-guard.json — 2 rule(s)
enabled: true   onlyNewFiles: true   includeFileName: true

context (from /repo/.jev-tree-guard.json):
----
src/ は機能単位で分割する。
----
file line: file: src/features/login.ts (new)

rules merged into one request: 2 — Application, Style
merged context (2 part(s)):
----
src/ は機能単位で分割する。

src/ 直下は避ける。
----

state sent to Jev (as a new file):
----
src/ は機能単位で分割する。

src/ 直下は避ける。

file: src/features/login.ts (new)

project tree
```
./
  src/
    features/
      login.ts (new)
    existing.ts
```
----
````

- `<file>` を省略すると、cwd から探索して採用される設定の `context` を表示します。
- `ignore` にマッチするファイルには「送信されない」と表示します。
- API キーがなくても実行できます。

`/jev-tree-guard check <file>` の結果にも `state sent to Jev:` セクションが付きます
（長い state は省略されます。全文は `context` サブコマンドで確認してください）。

## API キーとエンドポイント

次の順で探します（`apiKeyEnv` → 汎用名 → エンドポイント固有名）。
`process.env` を先に見て、無ければ対象ファイルと作業ディレクトリから上位へ `.env` を探します。
`pi-jev-guard` と同じ解決ロジックです。

| エンドポイント | 環境変数 | 既定モデル |
|---|---|---|
| TypeSafe（既定） | `SYSTEMONE_API_KEY`, `TYPESAFE_API_KEY` | `jev-1.13.0` |
| OpenRouter | `OPENROUTER_API_KEY` | `typesafe/jev-1.13` |
| OpenCode Zen | `OPENCODE_API_KEY`, `OPENCODE_ZEN_API_KEY` | `jev-1.13` |
| Command Code | `COMMANDCODE_API_KEY` | `typesafe/jev` |

- `SYSTEMONE_ENDPOINT` が設定されていればそれを最優先で使います。
- 明示した `endpoint` / `SYSTEMONE_ENDPOINT` が無い場合は、利用可能なキーから自動選択します（TypeSafe → OpenRouter → OpenCode Zen → Command Code の順）。

## Jev の容量制限

- 1 リクエストの `state` + 最長の質問は、32k トークン程度に収める必要があります。
- `maxFileChars` と `maxTreeEntries` は文字数・件数の上限で、トークン数は見ていません。巨大なツリーと大きなファイルでは超過し得ます。超過時は HTTP 400 となり、`onError` に従います（既定は作成を通す）。

## セキュリティ上の注意

- チェック時、**プロジェクトのツリー、作成しようとしているファイルの内容、`context` が Jev のエンドポイントへ送信されます。** マッチした全ルールの checks が1リクエストにまとめられ、プロジェクト相対パスも含まれます。機密情報を含むリポジトリではルールと `treeIgnore` を絞ってください。
- `.jev-tree-guard.json` は、**作業ディレクトリが信頼されている場合のみ**有効です。未信頼のプロジェクトでは無視され、警告を表示します。
- 探索はファイルシステム root まで行くため、信頼済みの作業ディレクトリより上にある設定も採用されます（AGENTS.md と同じ挙動）。親ディレクトリを共有する環境では、第三者が置いた設定が採用され得る点に注意してください。
- 作業ディレクトリ外を対象にした `write` は、プロジェクトツリーが存在しないためチェックしません（警告を出して通過）。
- `onError` の既定は `"allow"`（Jev が落ちていても作成を通す）です。厳密に止めたい場合は `"block"` を設定してください。

## 制限事項

- フックするのは `write` ツールだけです。`bash` のリダイレクトや `cp` などで行われるファイル作成は対象外です。
- 既存ファイルの上書きは既定でチェックしません（`onlyNewFiles: false` で有効化できますが、その場合はチェック文言も配置に限らず調整してください）。
- ツリーは `maxTreeEntries` / `maxTreeDepth` で打ち切られます。巨大なリポジトリでは `context` に対象領域の説明を書くか、サブディレクトリ側に `.jev-tree-guard.json` を置いてください。
- Jev の回答は確率です。`minProbability` で感度を調整してください（既定 `0.5`）。

## 開発

```bash
npm test        # node:test（モックした Jev エンドポイントで検証）
```

実際の Jev に対する簡易 E2E:

```bash
cd /tmp/jev-tree-e2e   # .jev-tree-guard.json と src/ などを用意
pi -p --no-session --model <provider>/<model> \
  --extension /path/to/pi-jev/packages/tree-guard/src/index.ts \
  "src/ に新しいモジュールを追加して"
```
