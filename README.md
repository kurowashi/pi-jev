# pi-jev

Pi がファイルを書き換える前に、TypeSafe Jev で規約違反を検査して止める拡張です。
違反した内容はモデルのコンテキストに入る前にブロックされ、修正の指示だけが返ります。

このリポジトリには 2 つの拡張が入っています。検査の対象ごとに別の拡張なので、必要な方だけを入れられます。

| 拡張 | 検査対象 | 検査するツール | 詳細 |
|---|---|---|---|
| `pi-jev-content-guard` | ファイルの内容 | `edit` / `write` | [README](packages/content-guard/README.md) |
| `pi-jev-placement-guard` | 新規ファイルの配置 | `write`（新規作成のみ） | [README](packages/placement-guard/README.md) |

両方を入れた場合、新規ファイルの `write` は内容と配置の 2 回検査されます。

## インストール

両方の拡張をまとめて入れます。

```bash
pi install git:github.com/kurowashi/pi-jev
```

タグまたはコミットに固定する場合は `pi install git:github.com/kurowashi/pi-jev@<tag|commit>` を使います。

片方だけ入れる場合は、ローカルのパッケージを指定します。

```bash
npm install                                            # 初回のみ（@pi-jev/core のリンクを作る）
pi install /path/to/pi-jev/packages/content-guard
```

## 使い方

1. Jev の API キーを環境変数または `.env` に設定します。
2. 検査したいディレクトリに設定ファイルを作ります（`/jev-content-guard init` で雛形を作成）。
3. Pi で `edit` / `write` を実行すると、規約違反があれば実行前に止まります。

判定が意図通りか確認するには、ファイルを変更せずに検査できます。

```
/jev-content-guard check src/index.ts
```

## 設定

設定は拡張ごとに 1 ファイルです。

| 拡張 | 設定ファイル |
|---|---|
| `pi-jev-content-guard` | `.jev-content-guard.json` |
| `pi-jev-placement-guard` | `.jev-placement-guard.json` |

設定の内容、検査ルールの書き方、API キーの解決順は各拡張の README を参照してください。

## コマンド

| コマンド | 内容 |
|---|---|
| `/jev-content-guard` | 解決済みの設定・接続先・キーの出所を表示する。`init`（雛形作成）、`check <file>`（dry-run）、`context [<file>]`（送られる文脈の表示）、`on` / `off`（このセッションの有効・無効）を持つ |
| `/jev-placement-guard` | 同じ構成。対象は配置の検査。`init`、`check <file>`、`context [<file>]`、`on` / `off` を持つ |

各サブコマンドの詳細は、各拡張の README の[コマンド](packages/content-guard/README.md#コマンド)節を参照してください。

## 仕組み

検査が失敗したとき、拡張は設定の `fail` 文字列をモデルに返し、ツールは実行されません。
Jev に接続できないとき（キーが無い、タイムアウト、応答が不正）の挙動は `onError` で決まります。既定は `allow`（通す）です。

## 制限

- 検査は `edit` と `write` だけが対象です。`bash` などによる変更は検査されません。
- 判定は確率です。誤判定があるときは `minProbability` を調整してください。
- ファイルの上限は文字数で数えます。トークン数は見ていません。超えると Jev が HTTP 400 を返し、`onError` に従います。
- 各拡張の制限は、各拡張の README の制限事項節に書いています（[content-guard](packages/content-guard/README.md#制限事項)・[placement-guard](packages/placement-guard/README.md#制限事項)）。

## ライセンス

[MIT](LICENSE)
