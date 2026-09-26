# AGENTS.md — pi-jev で作業するエージェント向けの指示

読者は pi-jev を変更する AI エージェントと開発者です。利用者向けの仕様は root と各パッケージの
README に、設計の判断基準は DESIGN.md と PHILOSOPHY.md(このプラグイン群共通)に書きます。

ここには、壊してはいけない制約と、制約に触れる変更の手順だけを書きます。制約の正はテストで、
下表はその索引です。実装と表が食い違った場合はテストが正です。検証手段を併記できないものは
制約として書かず、自動テストできない範囲は末尾に分けます。

## 完了条件

`npm run verify`(= `npm run check` + `npm test` + `npm run test:coverage`)が通ること。
フックが通っても CI が通らなければ未完了。`npm install` で workspace リンク(`@pi-jev/core`)を
張っておくこと。下表の「検証」列は個別の検証箇所であり、自動検証はすべて `verify` に含まれます。

## 制約

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 両ガードともモデル向けツールを登録しない(フック専用) | `test/contract/tool-surface.test.ts` | 各 `packages/*/src/index.ts` |
| 各ガードのコマンドは1つ(`/jev-content-guard` / `/jev-placement-guard`) | `test/contract/tool-surface.test.ts` | 同ファイルのコマンド期待値 |
| 各ガードのイベントは `session_start` と `tool_call` の2つで、各1ハンドラ | `test/contract/tool-surface.test.ts` | 同ファイルの `EXPECTED_EVENTS` |
| root の devDependency は allowlist 内のみ | `test/contract/dependencies.test.ts` | 同ファイルの `ROOT_DEV_ALLOWED` |
| パッケージの実行時依存は workspace の `@pi-jev/*` のみ | `test/contract/dependencies.test.ts` | 各 `packages/*/package.json` |
| peer は Pi 提供パッケージのみ、`engines.node` は各パッケージとも `>=22.19.0` | `test/contract/dependencies.test.ts` | 同ファイルの `PI_PACKAGES`、各 `packages/*/package.json` |
| `src` の import は node builtin・相対 `.ts`・`@pi-jev/core`・Pi 提供パッケージのみ | `test/contract/dependencies.test.ts` | 同ファイルの `isAllowed` |
| 各パッケージの配布物は `src/` と README(あれば)のみ | `test/ci/tarball.test.ts` | 各 `packages/*/package.json` の `files` |
| 設定は対象ディレクトリから上位へ探し、最初に見つかった1枚だけを使う(マージなし) | `packages/core/test/config.test.ts` + `packages/content-guard/test/jev-content-guard.test.ts` | `packages/core/src/config.ts` の `loadConfig` |
| 未信頼プロジェクトの設定は無視し、作業ディレクトリ外のファイルには適用しない | `packages/core/test/config.test.ts` | 同ファイルの `loadConfig` |
| `rules` は `ignore` が勝ち、`enabled: false` はスキップする。`files` 省略時の意味はガードごとに異なる(content は非マッチ、placement は全マッチ) | `packages/core/test/config.test.ts` | `packages/core/src/match.ts` の `matchAllWhenNoFiles` |
| Jev の不合格はツールコールをブロックして `fail` を返し、全合格なら通す | `packages/content-guard/test/jev-content-guard.test.ts` + `packages/placement-guard/test/jev-placement-guard.test.ts` | 各 `packages/*/src/index.ts` |
| Jev 接続失敗時は既定で通す(`onError: "allow"`)。`"block"` で止める | 各ガードのテスト | 同 |
| placement は既定(`onlyNewFiles: true`)で新規 `write` だけをチェックする | `packages/placement-guard/test/jev-placement-guard.test.ts` | `packages/placement-guard/src/index.ts` |
| 認証は環境変数 → `.env` 探索の順、キーから endpoint を自動選択する(TypeSafe → OpenRouter → OpenCode Zen → Command Code) | `packages/core/test/credentials.test.ts` | `packages/core/src/credentials.ts` |
| `enum` / `namespace` / parameter properties を使わない | `npx tsc --noEmit` | `tsconfig.json` の `erasableSyntaxOnly` |
| 型は `any` なし、非null断言なし、浮いた Promise なし | `npx biome check .` | `biome.jsonc` の `suspicious` / `nursery` |
| `console` を使わない | `npx biome check .` | `biome.jsonc` |
| 認知複雑度は 12 以下 | `npx biome check .` | `biome.jsonc` の `noExcessiveCognitiveComplexity` |
| 相対 import は `.ts` 拡張子付き、パスエイリアスなし | `npx tsc --noEmit` + Node 実行 | `tsconfig.json` |
| ビルド工程を持たない(TS を直接配布) | `test/ci/tarball.test.ts` | 各 `packages/*/package.json`(`build` script なし、`pi.extensions` が `./src/index.ts`) |

## 変更時の手順

- パッケージを増やす場合は `test/contract/dependencies.test.ts` と `test/ci/tarball.test.ts` の
  `PACKAGE_DIRS` を更新し、拡張なら root `package.json` の `pi.extensions` にも追加する。
- `packages/core` の共有配管を変える場合は両ガードのテストを実行する。ガードごとの差は
  `FLAVOR` と設定の差し込み口で吸収し、core にガード固有の分岐を足さない。
- 依存を追加する場合は root の devDependency のみ可能(`ROOT_DEV_ALLOWED` の更新と
  コミットメッセージの理由をセットで行う)。パッケージの実行時依存は workspace の
  `@pi-jev/*` のみ。
- root の `.jev-content-guard.json` / `.jev-placement-guard.json` はこのリポジトリ自身への
  適用設定(dogfooding)であり、編集すると以後のチェック内容が変わる。
- 自動テストにできない設計規約の正は DESIGN.md とする。ここには重複して書かない。
- カバレッジは `packages/*/test` で計測する(`package.json` の `test:coverage`)。root の
  契約テストは jiti 経由で `src` をもう一度ロードするため、同じファイルが2実体として数えられる。

## 手動スモークテスト(自動検証の対象外)

Jev API はモックでテストしているため、実際の Jev との接続はここで確認する:

1. content-guard: 実 Jev で不合格になる `edit` がブロックされ `fail` 文言が返ること。合格する
   `edit` は通ること。
2. placement-guard: 配置が悪い新規 `write` がブロックされること。既存ファイルの上書きは既定で
   通ること。
3. 併用時、新規 `write` が内容と配置の2リクエストになること。
4. `onError: "block"` で Jev を落とすと `edit` / `write` が止まり、既定の `"allow"` では通ること。
5. 環境変数と `.env` の探索順、キーからの endpoint 自動選択が期待どおりであること。
6. TUI で各ガードの `init` / `check` / `context` / `on` / `off` が動くこと。
7. 未信頼プロジェクトでは設定が無視されること。
