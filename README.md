# pi-jev

TypeSafe Jev（System One）で Pi のファイル操作を意味的にチェックする拡張のモノレポです。
編集内容のチェックと、新規ファイルの配置チェックを別プラグインとして提供します。

## パッケージ

| パッケージ | Pi 拡張 | 役割 | 設定ファイル |
|---|---|---|---|
| [`packages/content-guard`](packages/content-guard) | `pi-jev-content-guard` | `edit` / `write` の内容をチェック | `.jev-content-guard.json` |
| [`packages/placement-guard`](packages/placement-guard) | `pi-jev-placement-guard` | 新規 `write` の配置をチェック | `.jev-placement-guard.json` |
| [`packages/core`](packages/core) | （拡張ではない） | 両ガードが使う共有パッケージ | — |

用語:

- パッケージ: npm workspace の配布単位
- Pi 拡張: Pi にインストールして有効化するパッケージ（content-guard と placement-guard）
- ガード: content-guard / placement-guard の総称
- core: 拡張ではない共有パッケージ。config 探索・glob とルール照合・認証・Jev 呼び出し・失敗整形を担う

## インストール（Pi）

モノレポの root から、両方の拡張をまとめて入れる:

```bash
pi install git:github.com/kurowashi/pi-jev
```

ref を固定する場合は `pi install git:github.com/kurowashi/pi-jev@<tag|commit>`。

ローカルの作業コピーで 1 つずつ入れる場合:

```bash
pi install /path/to/pi-jev/packages/content-guard
pi install /path/to/pi-jev/packages/placement-guard
```

ローカルの作業コピーを使う場合は、先に root で `npm install` を実行して workspace リンク
（`@pi-jev/core`）を作成します。git install では不要です。

使い方は各パッケージの README を参照。

## 開発

```bash
npm install          # workspace リンクの作成（必須）
npm run verify       # 完了条件: biome + tsc + 全テスト + カバレッジ閾値
npm test             # 全テスト（ルートの契約テストを含む）
```

設計の判断基準は [DESIGN.md](DESIGN.md)、共通の哲学は [PHILOSOPHY.md](PHILOSOPHY.md)、
制約・変更手順・検証の構成は [AGENTS.md](AGENTS.md) にあります。
