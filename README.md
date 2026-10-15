# MadoBakoCode

ブラウザだけで HTML / CSS / JS（と画像・動画・音声）を書いて実行できる、バックエンド不要のエディター兼プレビューアプリです。
ファイルは端末内の IndexedDB に保存され、再訪時に前回の状態へ戻ります。

## 仕組み（概要）

- プレビューは Service Worker（`sw.js`）が `__preview__/` 配下のリクエストを IndexedDB から返し、iframe で表示します。相対パス、`fetch('data.json')`、ES Modules、動画のシーク（Range）がそのまま動きます。
- 相対パスのみ対応です（`/` 始まりの絶対パスは非対応）。外部 CDN の読み込みは可能です。
- プレビュー中の `console.*` / エラーは、下部のコンソール（⌨）に表示されます。
- 書き出し・取り込みは ZIP のみです。

## ファイル構成

```
madobakocode/
├─ index.html              アプリ本体の HTML
├─ vite.config.js          base: './'（サブディレクトリ配信対応）
├─ package.json
├─ public/
│  ├─ sw.js                Service Worker（プレビュー配信 + アプリのオフライン起動）
│  ├─ manifest.webmanifest PWA 設定
│  ├─ icon.svg             アイコン原本（窓から箱入りコードをのぞく図）
│  ├─ apple-touch-icon.png iOS ホーム画面用（180x180）
│  └─ icon-192.png / icon-512.png / icon-maskable-512.png  PWA 用 PNG
└─ src/
   ├─ main.ts              アプリ本体（UI・保存・エディター・ZIP）
   └─ style.css
```

## アイコンについて

`public/icon.svg` が原本です。iOS（ホーム画面に追加）は SVG を使えないため、PNG を別に用意し、`index.html` の `apple-touch-icon` と `manifest.webmanifest` から参照しています。
デザインを変える場合は SVG を編集し、PNG（180 / 192 / 512px）を書き出し直してください。PNG 側は角丸なしの全面塗りです（iOS が角丸を適用します）。

## 必要な環境

- Node.js 18 以上（ビルド時のみ。動作確認していません）
- 実行側のブラウザ: Service Worker と IndexedDB が使えるもの（Safari / Chrome / Firefox / Edge）。
  HTTPS、または `localhost` で配信してください。

## ビルド

```
npm install
npm run build
```

## ビルド後に何ができるか

`dist/` フォルダが生成されます。中身はすべて静的ファイルで、`sw.js` と `manifest.webmanifest` も含まれます。
`dist/` を任意の静的ホスティング（HTTPS）に置けば、そのまま動作します。サーバー側の処理は不要です。

ローカル確認は `npm run preview`（`localhost` では HTTPS 不要）で行えます。

初回アクセス後はアプリ本体がキャッシュされ、オフラインでも開けます（ユーザーのファイルは常に端末内の IndexedDB にあります）。

## 使い方メモ

- 選択: ファイル行の長押し（PC は Ctrl/Shift+クリック）で複数選択が始まり、チェックボックスが出ます。
- 移動: 行頭の `⠿` をドラッグして、フォルダや空白部分（Root）へドロップします。
- `Del` `^A` `^X` `^C` `^V`: エディターにフォーカスがあればテキスト操作、ファイル一覧にフォーカスがあればファイル操作です。
- 全画面: プレビュー時の `⛶`。右上の `✕` で戻ります。
- `Rst` は全削除して初期状態へ、`Imp` は ZIP 取り込み（全置換）、`Exp` は ZIP 書き出しです。

## 制限事項

- Safari はサイトを一定期間使わないと保存データを消すことがあります。ホーム画面への追加や ZIP バックアップを推奨します（仕様は要確認）。
- JS の `fetch` による外部サイトへのアクセスは、相手側の CORS 設定に依存します。
- 作成できる新規ファイルはテキスト系のみです。画像・動画・音声はアップロードで追加します。
