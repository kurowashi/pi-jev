# pi-jev

TypeSafe Jev（System One）で Pi のファイル操作を意味的にチェックする拡張のモノレポです。
編集内容のチェックと、新規ファイルの配置チェックを別プラグインとして提供します。

## パッケージ

| パッケージ | Pi 拡張 | 役割 | 設定ファイル |
|---|---|---|---|
| [`packages/content-guard`](packages/content-guard) | `pi-jev-content-guard` | `edit` / `write` の内容をチェック | `.jev-content-guard.json` |
| [`packages/placement-guard`](packages/placement-guard) | `pi-jev-placement-guard` | 新規 `write` の配置をチェック | `.jev-placement-guard.json` |
| [`packages/core`](packages/core) | （拡張ではない） | 共有する配管（config 探索・glob・ルール・認証・Jev 呼び出し・失敗整形） | — |

## セットアップ

```bash
npm install          # workspace リンクの作成（必須）
npm run verify       # 完了条件: biome + tsc + 全テスト + カバレッジ閾値
npm test             # 全テスト（ルートの契約テストを含む）
```

契約テストは `test/contract/`（workspace 依存ポリシー・import 境界・フックのみのツール面）と
`test/ci/`（各パッケージの npm pack 内容）にある。カバレッジ閾値は `packages/*/test/` の
実行で計測する。ローカルの git フックは [lefthook](lefthook.yml) が管理し、CI は同じ
`npm run verify` を Node 22.19 / 24 で実行する。フックの有効化は `npx lefthook install` を
手動で行う（`prepare` script は git インストールの `npm install --omit=dev` で失敗するため置かない）。

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

使い方は各パッケージの README を参照。git install の入口は root の `package.json` の
`pi.extensions`（`packages/core` は拡張ではないので列挙しない）。

## 開発

設計の判断基準は [DESIGN.md](DESIGN.md)、共通の哲学は [PHILOSOPHY.md](PHILOSOPHY.md)、
検証可能な制約と変更手順は [AGENTS.md](AGENTS.md) にあります。
