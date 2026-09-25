# pi-jev

TypeSafe Jev（System One）で Pi のファイル操作を意味的にチェックする拡張のモノレポです。
編集内容のチェックと、新規ファイルの配置チェックを別プラグインとして提供します。

## パッケージ

| パッケージ | Pi 拡張 | 役割 | 設定ファイル |
|---|---|---|---|
| [`packages/guard`](packages/guard) | `pi-jev-guard` | `edit` / `write` の内容をチェック | `.jev-guard.json` |
| [`packages/tree-guard`](packages/tree-guard) | `pi-jev-tree-guard` | 新規 `write` の配置をチェック | `.jev-tree-guard.json` |
| [`packages/core`](packages/core) | （拡張ではない） | 共有する配管（config 探索・glob・ルール・認証・Jev 呼び出し・失敗整形） | — |

## セットアップ

```bash
npm install   # workspace リンクの作成（必須）
npm test      # 全パッケージのテスト
```

## インストール（Pi）

```bash
pi install /path/to/pi-jev/packages/guard
pi install /path/to/pi-jev/packages/tree-guard
```

使い方は各パッケージの README を参照してください。

## 開発ルール

- ビルド不要（jiti / Node の type stripping で直接実行）
- 依存ゼロ。erasable 構文のみ（`enum` / `namespace` / decorator 禁止、型 import は `import type`、相対 import は `.ts` 拡張子を明示）
- `packages/core` は配管のみ: config 探索とマージ、glob とルール照合、認証、Jev 呼び出し、失敗整形、コマンド骨格、小物。ポリシーを持たず、Pi には依存しない（型 import のみ可）
- `packages/*-guard` は意味のみ: フック条件、state 文書、プロンプト、設定キー、init テンプレート、コマンド出力。配管を再実装しない
- **共有しない**: state builder（`buildStateDocument` / `buildPlacementState`）、フック本体、init テンプレート、help/status/context 本文。
  差は `configName` / `state` / `describeState` / `subject` の小さな差し込み口で吸収し、core の中を分岐させない
- `npm install` は必須（workspace リンクが `@pi-jev/core` の解決経路。無いと拡張のロードに失敗する）
