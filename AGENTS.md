# AGENTS.md — pi-jev

読者: pi-jev を変更するエージェントと開発者。利用者向けの仕様は root と各パッケージの README、設計判断は DESIGN.md。
共通の検証と規則はルートの `AGENTS.md` にある。

`npm install` で workspace リンク（`@pi-jev/core`）を張っておくこと。

## 壊してはいけない制約

- 両ガードともモデル向けのツールを登録しない（フック専用）。各ガードのコマンドは1つ（`/jev-content-guard` / `/jev-placement-guard`）。各ガードのイベントは `session_start` と `tool_call` の2つで各1ハンドラ（`test/contract/tool-surface.test.ts`）。
- パッケージの実行時依存は workspace の `@pi-jev/*` だけ。`engines.node` は各パッケージとも `>=22.19.0`（`test/contract/dependencies.test.ts`）。
- 設定は対象ディレクトリから上位へ探し、最初に見つかった1枚だけを使う（マージしない）。未信頼プロジェクトの設定は無視する。作業ディレクトリ外のファイルには設定を適用しない（`packages/core/test/config.test.ts`）。
- `rules` は `ignore` が勝つ。`enabled: false` のルールはスキップする。`files` 省略時は content が非マッチ、placement が全マッチになる（`packages/core/test/config.test.ts`）。
- Jev の不合格はツールコールをブロックして `fail` を返し、全合格なら通す。Jev 接続失敗時は既定で通す（`onError: "allow"`）。`"block"` で止める（`packages/content-guard/test/jev-content-guard.test.ts`、`packages/placement-guard/test/jev-placement-guard.test.ts`）。
- placement は既定（`onlyNewFiles: true`）で新規 `write` だけをチェックする（`packages/placement-guard/test/jev-placement-guard.test.ts`）。
- 認証は環境変数 → `.env` 探索の順に解決する。キーから endpoint を自動選択する（TypeSafe → OpenRouter → OpenCode Zen → Command Code）（`packages/core/test/credentials.test.ts`）。
- `/jev-content-guard` と `/jev-placement-guard` は解決済みの設定を表示する（`packages/core/test/command.test.ts`）。

## 変更手順

- パッケージを増やすときは、`test/contract/dependencies.test.ts` と `test/ci/tarball.test.ts` の `PACKAGE_DIRS` を更新する。拡張なら root `package.json` の `pi.extensions` にも追加する。
- `packages/core` の共有配管を変えるときは、両ガードのテストを実行する。ガードごとの差は `FLAVOR` と設定の差し込み口で吸収し、core にガード固有の分岐を足さない。
- root の devDependency を追加するときは `ROOT_DEV_ALLOWED` を更新し、コミットメッセージに理由を書く。
- root の `.jev-content-guard.json` / `.jev-placement-guard.json` は、このリポジトリ自身に適用する検証設定である。編集すると以後のチェック内容が変わる。
- 自動テストできない設計規約の正は DESIGN.md。ここには重複して書かない。
- 手動で確認する項目は [docs/manual-checks.md](docs/manual-checks.md) に書く。
