# smartLogger
# smartLogger

軽量で設定しやすい Node.js 向けロガー。タイムスタンプ・ラベル・色分けを自動で付与し、ファイルローテーション、リモートバッチ送信、JSON 出力などの便利な機能を備えます。

## 目次
- Quick Start
- インストール
- CommonJS / ESM の使用例
- API 参照（主要オプション）
- Time zone の注意点
- Publish 前チェックリスト
- PowerShell での実行例

## Quick Start

インストール（プロジェクトに追加）:

```powershell
npm install smartlogger
```

CommonJS での使い方:

```js
const SmartLogger = require('smartlogger');
const logger = new SmartLogger({ level: 'info', label: 'MyApp' });
logger.info('hello world');
```

ESM（import）での使い方:

```js
import SmartLogger from 'smartlogger';
const logger = new SmartLogger({ label: 'ESM' });
logger.info('hello esm');
```

## API 参照（主要オプション）

- level: 'error'|'warn'|'info'|'debug' — ログ出力レベル（デフォルト: 'info'）
- env: 'production'|'development' — production では debug を抑制
- label: string — ログ行に付与されるラベル
- colors: boolean — ANSI カラーのオン/オフ（デフォルト: true）
- json: boolean — JSON 出力モード（監査や ELK 送信用）
- file: string — ログファイルのパス（省略するとコンソール出力のみ）
- rotation: { size: number, maxFiles?: number } — サイズベースのローテーション（file 必須）
- remote: { url: string, intervalMs?: number, batchSize?: number, headers?: Record<string,string>, timeoutMs?: number, maxBuffer?: number }
- timeZone?: string — タイムスタンプの出力タイムゾーン（例: 'Asia/Tokyo'）。未指定時は UTC ISO 文字列を使用。
- remoteReliable?: boolean — リモート送信失敗時のディスク永続化を有効化
- remoteQueuePath?: string — 永続化キューのパス
- remoteGzip?: boolean — 送信時に gzip 圧縮を行う

主要メソッド:

- info(msg, ...ctx)
- warn(msg, ...ctx)
- error(msg|Error, ...ctx)
- debug(msg, ...ctx)
- log(level, msg, ...ctx)
- child(overrides) — 子ロガーを生成
- setLevel(level)
- flushRemote(): Promise<void> — バッファの即時送信
- close() — ストリームやタイマーを閉じる

## Time zone の注意点

`timeZone` オプションは IANA タイムゾーン文字列（例: 'Asia/Tokyo'）を受け付けます。Node.js のビルドに依存して ICU サポートが必要なため、環境によっては未対応または挙動が異なることがあります。サポートされない場合は自動的に UTC の ISO 文字列にフォールバックします。

## Publish 前チェックリスト

ローカルで以下を実行して最終確認してください（PowerShell 例）:

```powershell
npm ci
npm run build
npm test
```

pack を確認する:

```powershell
npm pack --dry-run
```

パブリッシュ:

```powershell
npm publish --access public
```

（注）公開前に `package.json` の `name` と `version`、`repository`、`keywords`、`files` をチェックしてください。

## PowerShell 実行例（デバッグ）

ビルドとテストを一度に実行する:

```powershell
npm run build; npm test
```

ESM デモ（ローカル）:

```powershell
node test/demo-esm-run.mjs
```

## FAQ

Q: bun で動きますか?

A: bun は高速なランタイムですが、環境差があるため動作検証が必要です。commonjs モジュールとして動く可能性は高いですが、`fs` や `Intl` の挙動は環境毎に異なります。bun でのテストを推奨します。

Q: 永続化キューは安全ですか?

A: 現状は簡易的な JSONL ファイルへの追記／読み取りで永続化しています。高負荷時や複数プロセスでの同時アクセスには追加のロックやトランザクション制御が必要です。

---

この README はリリース前にさらに整備できます（例: API の詳細な型定義、追加の使用例、ベストプラクティス）。次に追加してほしいセクションがあれば教えてください。
