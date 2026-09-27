# AGENTS.md — pi-jev で作業するエージェント向けの指示

読者は pi-jev を変更する AI エージェントと開発者です。利用者向けの仕様は root と各パッケージの README に、
設計の判断基準は DESIGN.md と PHILOSOPHY.md(このプラグイン群共通)に書きます。

ここには、壊してはいけない制約と、制約に触れる変更の手順だけを書きます。制約の正はテストで、
下の表はその索引です。実装と表が食い違った場合はテストが正です。検証手段を併記できないものは制約として書かず、
自動テストできない範囲は末尾に分けます。

## 完了条件

`npm run verify`(= `npm run check` + `npm test` + `npm run test:coverage`)が通ること。
フックが通っても CI が通らなければ未完了。CI は同じ `verify` を Node 22.19 / 24 で実行します。
`npm install` で workspace リンク(`@pi-jev/core`)を張っておくこと。

契約テストは `test/contract/`(依存ポリシー・import 境界・フックのみのツール面)と `test/ci/` (各パッケージの npm pack 内容)にあり、
カバレッジは `packages/*/test/` の実行で計測します。
下の表の「検証」列は個別の検証箇所であり、自動検証はすべて `verify` に含まれます。

## 制約

### フック面

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 両ガードともモデル向けツールを登録しない(フック専用) | `test/contract/tool-surface.test.ts` | 各 `packages/*/src/index.ts` |
| 各ガードのコマンドは1つ(`/jev-content-guard` / `/jev-placement-guard`) | `test/contract/tool-surface.test.ts` のコマンド期待値 | 各 `packages/*/src/index.ts` |
| 各ガードのイベントは `session_start` と `tool_call` の2つで、各1ハンドラ | `test/contract/tool-surface.test.ts` の `EXPECTED_EVENTS` | 各 `packages/*/src/index.ts` |

### 依存関係・import

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| パッケージの実行時依存は workspace の `@pi-jev/*` のみ | `test/contract/dependencies.test.ts` | 各 `packages/*/package.json` |
| root の devDependency は allowlist 内のみ | `test/contract/dependencies.test.ts` の `ROOT_DEV_ALLOWED` | root `package.json` |
| peer は Pi 提供パッケージのみ | `test/contract/dependencies.test.ts` の `PI_PACKAGES` | 各 `packages/*/package.json` |
| `engines.node` は各パッケージとも `>=22.19.0` | `test/contract/dependencies.test.ts` | 各 `packages/*/package.json` |
| `src` の import は node builtin・相対 `.ts`・`@pi-jev/core`・Pi 提供パッケージのみ | `test/contract/dependencies.test.ts` の `isAllowed` | `test/contract/dependencies.test.ts` |

### 設定・動作

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 設定は対象ディレクトリから上位へ探し、最初に見つかった1枚だけを使う(マージなし) | `packages/core/test/config.test.ts` + `packages/content-guard/test/jev-content-guard.test.ts` | `packages/core/src/config.ts` の `loadConfig` |
| 未信頼プロジェクトの設定は無視する | `packages/core/test/config.test.ts` | `packages/core/src/config.ts` の `loadConfig` |
| 作業ディレクトリ外のファイルには設定を適用しない | `packages/core/test/config.test.ts` | `packages/core/src/config.ts` の `loadConfig` |
| `rules` は `ignore` が勝つ | `packages/core/test/config.test.ts` | `packages/core/src/match.ts` |
| `enabled: false` のルールはスキップする | `packages/core/test/config.test.ts` | `packages/core/src/match.ts` |
| `files` 省略時は content が非マッチ、placement が全マッチになる | `packages/core/test/config.test.ts` | `packages/core/src/match.ts` の `matchAllWhenNoFiles` |
| Jev の不合格はツールコールをブロックして `fail` を返し、全合格なら通す | `packages/content-guard/test/jev-content-guard.test.ts` + `packages/placement-guard/test/jev-placement-guard.test.ts` | 各 `packages/*/src/index.ts` |
| Jev 接続失敗時は既定で通す(`onError: "allow"`)。`"block"` で止める | `packages/content-guard/test/jev-content-guard.test.ts` + `packages/placement-guard/test/jev-placement-guard.test.ts` | 各 `packages/*/src/index.ts` |
| placement は既定(`onlyNewFiles: true`)で新規 `write` だけをチェックする | `packages/placement-guard/test/jev-placement-guard.test.ts` | `packages/placement-guard/src/index.ts` |
| 認証は環境変数 → `.env` 探索の順に解決する | `packages/core/test/credentials.test.ts` | `packages/core/src/credentials.ts` |
| キーから endpoint を自動選択する(TypeSafe → OpenRouter → OpenCode Zen → Command Code) | `packages/core/test/credentials.test.ts` | `packages/core/src/credentials.ts` |

### コード品質

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| `enum` / `namespace` / parameter properties を使わない | `npx tsc --noEmit` | `tsconfig.json` の `erasableSyntaxOnly` |
| 型は `any` なし、非null断言なし、浮いた Promise なし | `npx biome check .` | `biome.jsonc` の `suspicious` / `nursery` |
| `console` を使わない | `npx biome check .` | `biome.jsonc` |
| 認知複雑度は 12 以下 | `npx biome check .` | `biome.jsonc` の `noExcessiveCognitiveComplexity` |
| 相対 import は `.ts` 拡張子付き、パスエイリアスなし | `npx tsc --noEmit` + Node 実行 | `tsconfig.json` |

### 配布・ビルド

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 各パッケージの配布物は `src/` と README(あれば)のみ | `test/ci/tarball.test.ts` | 各 `packages/*/package.json` の `files` |
| ビルド工程を持たない(TS を直接配布) | `test/ci/tarball.test.ts` | 各 `packages/*/package.json`(`build` script なし、`pi.extensions` が `./src/index.ts`) |

## 変更時の手順

- パッケージを増やす場合は `test/contract/dependencies.test.ts` と `test/ci/tarball.test.ts` の `PACKAGE_DIRS` を更新し、
  拡張なら root `package.json` の `pi.extensions` にも追加する。
- `packages/core` の共有配管を変える場合は両ガードのテストを実行する。
  ガードごとの差は `FLAVOR` と設定の差し込み口で吸収し、core にガード固有の分岐を足さない。
- 依存を追加する場合は root の devDependency のみ可能(`ROOT_DEV_ALLOWED` の更新とコミットメッセージの理由をセットで行う)。
  パッケージの実行時依存は workspace の `@pi-jev/*` のみ。
- root の `.jev-content-guard.json` / `.jev-placement-guard.json` はこのリポジトリ自身に適用する検証設定です。
  編集すると以後のチェック内容が変わります。
- 自動テストにできない設計規約の正は DESIGN.md。ここには重複して書かない。
- 決定の記録は `docs/adr/` に置く(1決定 = 1ファイル、`NNNN-<topic>.md`)。追加するのは、
  却下した代替を再提案されうる決定、機能や振る舞いを削除・置き換える決定、DESIGN.md / PHILOSOPHY.md に触れる決定のときだけ。
  却下案は結果ではなく理由を書く。
- ツール・コマンド・設定・公開の振る舞いを変える前に `docs/adr/` を読み、却下済みの代替を再提案しない。
  決定が変わったら同じコミットで状態を更新する(採用 → 廃止)。
- フックの有効化は `npx lefthook install` を手動で行います(`package.json` の lifecycle script には置きません:
  `pi install git:...` は `npm install --omit=dev` を実行するため、
  devDependency の lefthook が無い状態で script が走るとインストールごと失敗します)。
- カバレッジの数値は契約テストの影響を受けます。root の契約テストは jiti 経由で `src` をもう一度ロードするため、
  同じファイルが2実体として数えられます。

## 手動確認項目(自動検証の対象外)

Jev API はモックでテストしているため、実際の Jev との接続はここで確認します。前提:
Jev の API キー(環境変数または `.env`)を用意し、チェック対象のリポジトリで作業します。

1. content-guard: 実 Jev で不合格になる `edit` がブロックされ `fail` 文言が返ること。
   合格する `edit` は通ること。
2. placement-guard: 配置ルールに違反する新規 `write` がブロックされること。
   既存ファイルの上書きは既定で通ること。
3. 併用時、新規 `write` が内容と配置の2リクエストになること。
4. Jev への接続を失敗させた状態で、`onError: "block"` なら `edit` / `write` が止まり、
   既定の `"allow"` なら通ること。
5. 環境変数 → `.env` の順に解決し、キーの種類に応じて endpoint が自動選択されること。
6. TUI で各ガードの `init` / `check` / `context` / `on` / `off` が動くこと。
7. 未信頼プロジェクトでは設定が無視されること。
