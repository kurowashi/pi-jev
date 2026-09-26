# pi-jev-placement-guard

新規ファイルの作成（`write`）を **Jev（TypeSafe System One）** で配置チェックする Pi 拡張です。
既存のツリーとこれから追加するファイルを Jev に渡し、「その場所・その名前でよいか」を判定します。
合格しない作成は実行前にブロックし、`fail` に書いた文字列をモデルへ返します。

編集内容のチェックは姉妹プラグイン `pi-jev-content-guard` が担当します。併用する場合、`edit` は
`pi-jev-content-guard` だけが、新規 `write` は `pi-jev-content-guard`（内容）とこのプラグイン（配置）の
両方がチェックします。入力も context も異なるため、リクエストは 2 つに分かれます。

## 動作の流れ

1. `write` のツールコールで起動する。既存ファイルの上書きは、既定（`onlyNewFiles: true`）ではそのまま通す
2. 対象ファイルのディレクトリから上位へ `.jev-placement-guard.json` を探し、**最初に見つかった 1 つ**を使う（信頼済みの作業ディレクトリ内のみ）
3. `ignore` にマッチしたファイルはそのまま通す
4. マッチしたルールの checks と context を 1 つにまとめ、ツリーとファイル内容を付けて Jev へ送る
5. すべて合格なら作成を実行。1 つでも不合格ならツールコールを失敗させ、`fail` の文字列を返す

## できること

- 追加するファイルを `login.ts (new)`、作成されるディレクトリを `auth/ (new dir)` としてツリーに示す
- ファイル（glob）ごとにチェック内容を切り替える
- ツリーを `maxTreeEntries` / `maxTreeDepth` / `treeIgnore` で絞る
- `/jev-placement-guard context <file>` で、Jev に送る内容を確認する

## インストール

```bash
npm install                                     # @pi-jev/core の workspace リンクを作る
pi install /path/to/pi-jev/packages/placement-guard  # パッケージとして追加
```

git 経由で入れる場合はモノレポの root から `pi install git:github.com/kurowashi/pi-jev`
（姉妹プラグインの content-guard も同時に入る）。

`@pi-jev/core` を参照するため、ファイル 1 つを `~/.pi/agent/extensions/` へコピーする使い方はできません。

## クイックスタート

1. `/jev-placement-guard init` で `.jev-placement-guard.json` の雛形を作る
2. `context` にディレクトリ構成と命名規則を書き、ルールを書く
3. `/jev-placement-guard check src/features/auth/login.ts` で結果を確認する

`check` は対象が存在しなくても、既に存在していても実行できます。既存ファイルは
「新規作成するつもり」としてツリーから除いて判定するため、配置の見直しにも使えます。

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

## 設定ファイル

`.jev-placement-guard.json` は対象ファイルのディレクトリから上位（ファイルシステム root まで）へ探し、
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
| `onError` | `"allow"` | Jev に接続できないときの挙動。`"block"` で作成を止める |
| `onlyNewFiles` | `true` | 存在しないパスへの `write` だけをチェックする |
| `includeContent` | `true` | ツリーに加えてファイル内容も Jev に送る |
| `maxFileChars` | `40000` | ファイル内容の最大文字数（超えた分は中央を省略） |
| `maxTreeEntries` | `400` | ツリーに含めるエントリ数の上限 |
| `maxTreeDepth` | `5` | ツリーの最大深さ。対象パス上のディレクトリは常にたどる |
| `treeIgnore` | 主要な生成物ディレクトリ | ツリーから隠す glob。指定すると既定値を置き換える |
| `timeoutSeconds` | `20` | 1 リクエストのタイムアウト（秒） |
| `fail` | 自動生成 | 失敗時に返す文字列（全ルール共通の既定値） |
| `context` | なし | すべてのチェックに渡す前提知識（ディレクトリ構成など） |
| `ignore` | なし | チェックしないファイルの glob |
| `includeFileName` | `true` | state に `file: <path> (new)` 行を含める |
| `rules` | `[]` | ルールの配列 |

`treeIgnore` の既定値は `.git`, `node_modules`, `.venv`, `__pycache__`, `dist`, `build`, `target`,
`vendor`, `.next`, `.cache`, `.pi/tasks`, `coverage` などです。

### ルール

| キー | 説明 |
|---|---|
| `name` | 表示名。`{rule}` で参照できる |
| `enabled` | `false` でルールを無効化 |
| `files` | glob または glob の配列。`/` を含まない場合はファイル名にマッチ。省略するとすべてのファイルにマッチ |
| `checks` | 文字列、または `{ "check": "...", "minProbability": 0.8, "negate": true }` の配列 |
| `fail` | このルール専用の失敗メッセージ |
| `context` | このルール専用の前提知識 |
| `minProbability` | チェックの既定しきい値（ルール単位） |
| `negate` | チェックの既定の反転（ルール単位） |

glob は `**`（任意の階層）、`*`（同一階層内）、`?`（1 文字）に対応します。先頭の `!` は除外パターンです。
パターンは設定ファイルのあるディレクトリからの相対パスで判定します。

### `negate`：否定形を肯定形に置き換える

Jev は否定形より肯定形のほうが精度よく答えることがあります。
`negate: true` はチェック文字列を**失敗の状態**として送り、返ってきた確率を反転して判定します。

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

`negate` はルール単位の既定値で、チェック単位に上書きできます。
`minProbability` は反転後も「要件を満たす確率の下限」です。

### `fail` のプレースホルダ

| プレースホルダ | 内容 |
|---|---|
| `{file}` | 作成対象ファイル（作業ディレクトリからの相対パス） |
| `{rule}` | ルール名（未指定なら設定ファイル名） |
| `{checks}` | 失敗したチェックの一覧（確率付き） |
| `{probability}` | 失敗したチェックのうち最も低い合格確率 |

`fail` を書かなければ、失敗したチェックと確率から自動生成します。

## Jev に送られる内容

1 リクエストにつき `state` 文字列を 1 つ送ります。複数ルールは 1 つにまとめます。

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

- `file:` 行は `new` か `overwrite` かを示します（`includeFileName: false` で消せます）。
- `project tree` は作業ディレクトリからの相対表示です。新規ファイルは `login.ts (new)`、
  作成されるディレクトリは `auth/ (new dir)` のように後置で印を付けます。
- 対象ファイルのパスは、上限に達しても**必ず表示**されます。
- ツリーを切り詰めた場合は `note:` 行で Jev に伝えます（`check` / `context` の表示は
  `tree: N entries (truncated)` / `(depth limited)`）。
- `file content` は `includeContent: false` で省略できます。

`/jev-placement-guard context <file>` は **Jev へ接続せず**、同じ内容を表示します
（`<file>` 省略時は採用される設定の `context` だけ）。

````
jev-placement-guard context: src/features/login.ts
config: /repo/.jev-placement-guard.json — 2 rule(s)
enabled: true   onlyNewFiles: true   includeFileName: true

context (from /repo/.jev-placement-guard.json):
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
...
----
````

`/jev-placement-guard check <file>` の結果にも `state sent to Jev:` が付きます（長い state は省略されます）。

## コマンド

| コマンド | 説明 |
|---|---|
| `/jev-placement-guard` | 設定・エンドポイント・キーの状態を表示 |
| `/jev-placement-guard init` | `.jev-placement-guard.json` の雛形を作業ディレクトリに作成 |
| `/jev-placement-guard check <file>` | 作成せずに配置チェックを実行（既存ファイルは「新規」として扱う） |
| `/jev-placement-guard context [<file>]` | 送信される context と state を表示 |
| `/jev-placement-guard on` / `off` | このセッションのチェックを有効化 / 無効化 |

`JEV_PLACEMENT_GUARD_DISABLE=1` で常時無効にできます。

## API キーとエンドポイント

`process.env` を先に見て、無ければ対象ファイルと作業ディレクトリから上位へ `.env` を探します。
使うキーは `apiKeyEnv` → 汎用名 → エンドポイント固有名の順です（`pi-jev-content-guard` と同じ）。

| エンドポイント | 環境変数 | 既定モデル |
|---|---|---|
| TypeSafe（既定） | `SYSTEMONE_API_KEY`, `TYPESAFE_API_KEY` | `jev-1.13.0` |
| OpenRouter | `OPENROUTER_API_KEY` | `typesafe/jev-1.13` |
| OpenCode Zen | `OPENCODE_API_KEY`, `OPENCODE_ZEN_API_KEY` | `jev-1.13` |
| Command Code | `COMMANDCODE_API_KEY` | `typesafe/jev` |

- `SYSTEMONE_ENDPOINT` は最優先で使います。
- 明示した `endpoint` / `SYSTEMONE_ENDPOINT` が無い場合は、キーから自動選択します（TypeSafe → OpenRouter → OpenCode Zen → Command Code）。
- 接続先を固定するには `endpoint` / `model` / `apiKeyEnv` を設定します。

## Jev の容量制限

- 1 リクエストの `state` + 最長の質問は、32k トークン程度に収める必要があります。
- `maxFileChars` と `maxTreeEntries` は文字数・件数の上限で、トークン数は見ていません。巨大なツリーと大きなファイルでは超過し得ます。超過時は HTTP 400 となり、`onError` に従います（既定は作成を通す）。

## セキュリティ上の注意

- プロジェクトのツリー、作成しようとしているファイルの内容、`context` は Jev のエンドポイントへ送信されます。機密情報を含むリポジトリではルールと `treeIgnore` を絞ってください。
- `.jev-placement-guard.json` は作業ディレクトリが信頼されている場合のみ有効です。未信頼のプロジェクトでは警告を表示して無視します。
- 探索はファイルシステム root まで行くため、信頼済みの作業ディレクトリより上にある設定も採用されます。親ディレクトリを共有する環境では注意してください。
- 作業ディレクトリ外を対象にした `write` は、ツリーが無いため警告を出して通過します。
- `onError` の既定は `"allow"` です。Jev が落ちていても作成を通しますが、厳密に止めたい場合は `"block"` を設定してください。

## 制限事項

- フックするのは `write` だけです。`bash` のリダイレクトや `cp` によるファイル作成は対象外です。
- 既存ファイルの上書きは既定でチェックしません。`onlyNewFiles: false` で有効化できますが、チェック文言を配置に限らず調整してください。
- ツリーは `maxTreeEntries` / `maxTreeDepth` で打ち切られます。巨大なリポジトリでは `context` に対象領域の説明を書いてください。
- Jev の回答は確率です。`minProbability` で感度を調整してください（既定 `0.5`）。

## 開発

```bash
npm test        # node:test（モックした Jev エンドポイントで検証）
```

実際の Jev に対する簡易 E2E:

```bash
cd /tmp/jev-tree-e2e   # .jev-placement-guard.json と src/ などを用意
pi -p --no-session --model <provider>/<model> \
  --extension /path/to/pi-jev/packages/placement-guard/src/index.ts \
  "src/ に新しいモジュールを追加して"
```
