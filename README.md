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
`npm run verify` を Node 22.19 / 24 で実行する。

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

## 開発ルール

- ビルド不要（jiti / Node の type stripping で直接実行）
- 依存ゼロ。erasable 構文のみ（`enum` / `namespace` / decorator 禁止、型 import は `import type`、相対 import は `.ts` 拡張子を明示）
- `packages/core` は配管のみ: config 探索、glob とルール照合、認証、Jev 呼び出し、失敗整形、コマンド骨格、小物。ポリシーを持たず、Pi には依存しない（型 import のみ可）
- 設定は探索で最初に見つかった 1 枚のみを使う（階層間のマージやユーザー共通設定は持たない）
- `packages/*-guard` は意味のみ: フック条件、state 文書、プロンプト、設定キー、init テンプレート、コマンド出力。配管を再実装しない
- **共有しない**: state builder（`buildStateDocument` / `buildPlacementState`）、フック本体、init テンプレート、help/status/context 本文。
  差は `configName` / `state` / `describeState` / `subject` の小さな差し込み口で吸収し、core の中を分岐させない
- `npm install` は必須（workspace リンクが `@pi-jev/core` の解決経路。無いと拡張のロードに失敗する）
- フックの有効化は `npx lefthook install` を手動で実行する（`package.json` の lifecycle script には置かない: `pi install git:...` は `npm install --omit=dev` を実行するため、devDependency の lefthook が無い状態で script が走るとインストールごと失敗する）
