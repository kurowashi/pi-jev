# pi-jev

Pi がファイルを書き換える前に、TypeSafe Jev で規約違反を検査して止める拡張です。
違反した内容はモデルのコンテキストに入る前にブロックされ、修正の指示だけが返ります。

## 2 つの拡張

検査の対象ごとに別の拡張として提供します。必要な方だけを入れられます。

| 拡張 | 検査対象 | 検査するツール | 詳細 |
|---|---|---|---|
| `pi-jev-content-guard` | ファイルの内容 | `edit` / `write` | [README](packages/content-guard/README.md) |
| `pi-jev-placement-guard` | 新規ファイルの配置 | `write`（新規作成のみ） | [README](packages/placement-guard/README.md) |

両方を入れた場合、新規ファイルの `write` は内容と配置の 2 回検査されます。

## インストール

```bash
pi install git:github.com/kurowashi/pi-jev
```

両方の拡張がまとめて入ります。片方だけ入れる場合は、ローカルのパッケージを指定します。

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

## 検査が失敗したとき

失敗した検査は、設定の `fail` 文字列をモデルに返します。ツールは実行されません。
Jev に接続できないときの挙動は `onError` で決まります（既定は通す）。

## 設定

設定は拡張ごとに 1 ファイルです。

| 拡張 | 設定ファイル |
|---|---|
| `pi-jev-content-guard` | `.jev-content-guard.json` |
| `pi-jev-placement-guard` | `.jev-placement-guard.json` |

設定の内容、検査ルールの書き方、API キーの解決順は各拡張の README を参照してください。
