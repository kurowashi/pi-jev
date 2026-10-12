# pi-jev-content-guard

Pi の `edit` / `write` で書き込む内容を、TypeSafe Jev で検査する拡張です。
規約に反する内容は書き込み前にブロックされ、修正すべき理由がモデルに返ります。

## できること

- ファイルの種類ごとに規約を書き、書き込み内容を検査する（例: `any` を使わない、公開関数に戻り値の型を書く）
- Jev が各規約を yes / no で判定し、確率のしきい値で合否を決める
- 1 回の編集で該当するルールをまとめて 1 回の Jev リクエストで検査する
- 検査せずに、Jev に送られる文脈と内容を確認する

## 動作

1. `edit` / `write` の実行前に、対象ファイルに適用される設定ファイルを探す
2. 対象ファイルに該当するルールの検査項目を 1 つのリクエストにまとめ、Jev に送る
3. 全項目が合格なら実行する。1 つでも不合格なら実行せず、`fail` の文字列をモデルに返す

検査対象は `edit` と `write` だけです。`bash` などで行われたファイル変更は検査しません。

## インストール

```bash
pi install git:github.com/kurowashi/pi-jev
```

この方法では、姉妹拡張の [placement-guard](../placement-guard/README.md) も同時に入ります。
content-guard だけを入れる場合は、ローカルのリポジトリを指定します。

```bash
cd /path/to/pi-jev && npm install   # 初回のみ（@pi-jev/core のリンクを作る）
pi install /path/to/pi-jev/packages/content-guard
```

## クイックスタート

1. `/jev-content-guard init` で `.jev-content-guard.json` の雛形を作る
2. `rules` の `checks` をプロジェクトの規約に書き換える
3. `/jev-content-guard check src/index.ts` で判定を確かめる

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

設定は `.jev-content-guard.json` の 1 ファイルです。

### 探索と信頼

- 対象ファイルのディレクトリから親へ順にたどり、最初に見つかった 1 つだけを使います。複数の設定はマージしません。
- ユーザー共通の設定はありません。共通にしたい規約はリポジトリのルートなど祖先のディレクトリに置きます。
- 未信頼のプロジェクトでは設定を読みません。`/trust` で信頼してください。
- 作業ディレクトリの外のファイルには、設定を適用しません。

### トップレベルの項目

| キー | 既定値 | 内容 |
|---|---|---|
| `enabled` | `true` | `false` で検査を無効化 |
| `endpoint` | 自動 | Jev の URL。[API キーとエンドポイント](#api-キーとエンドポイント)を参照 |
| `model` | 自動 | 使うモデル名 |
| `apiKeyEnv` | 自動 | API キーを読む環境変数名。最初に探す |
| `minProbability` | `0.5` | 合格に必要な確率のしきい値 |
| `onError` | `"allow"` | Jev を使えないときの扱い。[失敗時の挙動](#失敗時の挙動)を参照 |
| `scope` | `"change"` | `edit` の検査範囲（`edit` の既定）。[検査範囲](#検査範囲scope)を参照 |
| `includeFileName` | `true` | Jev に対象ファイルのパスを送る |
| `maxFileChars` | `40000` | Jev に送るファイル内容の最大文字数 |
| `timeoutSeconds` | `20` | 1 リクエストの待ち時間（秒） |
| `fail` | 自動生成 | 不合格時にモデルへ返す文面。ルールの `fail` がない場合に使う |
| `context` | なし | すべての検査に渡す前提知識 |
| `ignore` | なし | 検査しないファイルのパターン。[ignore](#ignore検査しないファイル) を参照 |
| `rules` | `[]` | ルールの配列 |

### ルールの項目

| キー | 内容 |
|---|---|
| `name` | 表示名。`{rule}` で参照できる。省略時は設定ファイル名 |
| `enabled` | `false` でルールを無効化 |
| `files` | 対象ファイルのパターン（文字列または配列）。省略するとどのファイルにも一致しない |
| `checks` | 検査項目の配列。[検査項目](#検査項目checks) を参照 |
| `fail` | このルール専用の失敗文面 |
| `context` | このルール専用の前提知識。トップレベルの `context` の後に続けて送られる |
| `minProbability` | このルールの検査項目の既定しきい値 |
| `negate` | このルールの検査項目の既定の反転 |

`files` のパターンは次のとおりです。

- `**` は任意の階層、`*` は同じ階層内の任意の文字列、`?` は 1 文字に一致します。
- `/` を含まないパターンはファイル名に一致します（例: `*.ts` はどの階層の `.ts` にも一致）。
- `/` を含むパターンは設定ファイルのあるディレクトリからの相対パスに一致します。
- 先頭の `!` は除外です。除外だけでは一致しません。肯定のパターンが 1 つ以上必要です。

### 検査項目（checks）

検査項目は文字列か、オブジェクトで指定します。

```json
"checks": [
  "文字列で書いた検査項目",
  { "check": "しきい値と反転を個別に指定する項目", "minProbability": 0.8, "negate": true }
]
```

`minProbability` と `negate` は、検査項目 > ルール > トップレベルの順で上書きされます。

#### negate: 失敗の状態を書く

Jev は否定の文より肯定の文に精度よく答えることがあります。`negate: true` のときは、検査項目を**失敗の状態**として Jev に送り、返ってきた確率を反転して判定します。

```json
{
  "name": "Quality",
  "files": ["**/*.ts"],
  "negate": true,
  "checks": ["コードが汚い", "不要な複雑さがある"]
}
```

この例では、「コードが汚い」と Jev が答える確率が 0.5 以下のとき合格です。表示には `[negated]` が付きます。

### ignore：検査しないファイル

`ignore` に一致したファイルは検査されず、Jev へのリクエストも送られません。

```json
{
  "ignore": ["**/__init__.py", "**/generated/**", "*.min.js"],
  "rules": [{ "files": "**/*.py", "checks": ["print を使っていない"] }]
}
```

- 文字列 1 つでも配列でも指定できます。`files` と同じパターン規則です。
- `!` で除外を打ち消せます。例: `["*.py", "!keep.py"]` では `keep.py` だけが検査されます。

### fail：不合格時の文面

不合格時にモデルへ返す文面です。使う文面は次の順で決まります。

1. ルールの `fail`
2. トップレベルの `fail`
3. どちらもなければ、失敗した検査項目と確率から自動生成

| プレースホルダ | 内容 |
|---|---|
| `{file}` | 編集したファイル（作業ディレクトリからの相対パス） |
| `{rule}` | ルール名 |
| `{checks}` | 失敗した検査項目の一覧（確率付き） |
| `{probability}` | 失敗した検査項目のうち、最も低い合格確率 |

## 検査範囲（scope）

`scope` は `edit` で Jev に送る内容を決めます。

| 値 | Jev に送る内容 |
|---|---|
| `"change"` | 変更箇所（before / after）だけ |
| `"file"` | 編集後のファイル全体 |
| `"both"` | 編集後のファイル全体と変更箇所 |

- `write` は常にファイル全体を送ります。`scope` は無視されます。
- `file` と `both` は、編集後のファイルを予測して作ります。予測できないとき（一致する箇所が無い、複数ある、編集が重なる）は、変更箇所だけを送ります。
- 予測したファイルが `maxFileChars` を超えたとき、`file` は変更箇所だけに切り替えます。`both` はファイル全体を切り詰めて変更箇所と一緒に送ります。

## コマンド

| コマンド | 内容 |
|---|---|
| `/jev-content-guard` | 解決済みの設定、接続先、キーの出所を表示 |
| `/jev-content-guard init` | 作業ディレクトリに雛形を作成。既存の設定は上書きしない |
| `/jev-content-guard check <file>` | ファイルを変更せずに検査し、各項目の合否と確率を表示 |
| `/jev-content-guard context [<file>]` | Jev に接続せず、送られる文脈と内容を表示 |
| `/jev-content-guard on` / `off` | このセッションの検査を有効化 / 無効化 |

環境変数 `JEV_CONTENT_GUARD_DISABLE=1` を設定すると、検査を常に無効にできます。
`on` / `off` はセッションごとに初期状態へ戻ります。

## API キーとエンドポイント

### 接続先

接続先は次の順で決まります。

1. 設定ファイルの `endpoint`
2. 環境変数 `SYSTEMONE_ENDPOINT`
3. API キーから自動選択（TypeSafe → OpenRouter → OpenCode Zen → Command Code。キーが無ければ TypeSafe）

| 接続先 | キーの環境変数（探す順） | 既定モデル |
|---|---|---|
| TypeSafe（既定） | `SYSTEMONE_API_KEY`、`TYPESAFE_API_KEY` | `jev-1.13.0` |
| OpenRouter | `OPENROUTER_API_KEY` | `typesafe/jev-1.13` |
| OpenCode Zen | `OPENCODE_API_KEY`、`OPENCODE_ZEN_API_KEY` | `jev-1.13` |
| Command Code | `COMMANDCODE_API_KEY` | `typesafe/jev` |

既定モデルは接続先の URL で決まります。上の表にない URL を指定したときは `jev-1.13.0` を使います。

### キーの探し方

1. 設定ファイルの `apiKeyEnv` で指定した環境変数
2. `SYSTEMONE_API_KEY`
3. 接続先に対応するキー（上の表）

環境変数を先に探し、無ければ対象ファイルのディレクトリと作業ディレクトリから親へ `.env` を探します。

接続先を固定する例:

```json
{
  "endpoint": "https://openrouter.ai/api/alpha/decisions",
  "model": "typesafe/jev-1.13",
  "apiKeyEnv": "OPENROUTER_API_KEY"
}
```

## 失敗時の挙動

| 状況 | 挙動 |
|---|---|
| 検査項目が 1 つでも不合格 | 実行せず、`fail` の文面をモデルに返す |
| Jev に接続できない、タイムアウト、応答が不正、キーが無い | `onError` に従う |
| 設定ファイルが読めない、JSON が壊れている | 警告を表示し、その設定を無視する（検査しない） |
| 設定ファイルが未信頼のプロジェクトにある | 警告を表示し、その設定を無視する（検査しない） |
| 作業ディレクトリの外のファイルを編集する | 設定を適用せず、検査しない |

`onError` の値は次のとおりです。

- `"allow"`（既定）: 警告を 1 回表示し、編集を実行する
- `"block"`: 編集を実行せず、理由をモデルに返す

## Jev に送られる内容

1 回の編集につき、次の内容を Jev の接続先へ送ります。

- 対象ファイルのパス（作業ディレクトリからの相対パス。`includeFileName: false` で送らない）
- 編集後のファイル全体、または変更箇所（[検査範囲](#検査範囲scope)のとおり）
- `context` と、該当するルールの `context`
- 該当するルールの検査項目

機密情報を含むファイルは `ignore` で検査対象から外してください。

## 制限事項

- 検査するのは `edit` と `write` だけです。`bash` などによる変更は対象外です。
- 判定は確率です。誤判定があるときは `minProbability` を調整してください。
- `maxFileChars` は文字数で数えます。トークン数は見ていません。日本語を多く含むファイルでは Jev の上限を超えることがあります。超えると HTTP 400 となり、`onError` に従います。
- [pi-jev-placement-guard](../placement-guard/README.md) を併用すると、新規ファイルの `write` は内容と配置の 2 回の Jev リクエストになります。
