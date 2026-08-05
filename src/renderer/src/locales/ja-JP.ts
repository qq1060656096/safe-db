import { createLocale } from './createLocale'

export default createLocale({
  common: { add: '追加', save: '保存', cancel: 'キャンセル', delete: '削除', edit: '編集', refresh: '更新', clear: 'クリア', search: '検索', export: 'エクスポート', apply: '適用', remove: '除去', yes: 'はい', no: 'いいえ', rows: '{count} 行', totalRows: '全 {count} 行', totalItems: '全 {count} 件', saved: '保存しました', deleted: '削除しました', copied: 'コピーしました', close: '閉じる', language: '言語' },
  app: { emptyHint: '左側のテーブルをダブルクリックするか、接続を右クリックしてクエリを作成してください', menu: 'メニュー', newWindow: '新しいウィンドウ（Cmd/Ctrl+Shift+N）' },
  layout: { showLeft: '左サイドバーを表示', hideLeft: '左サイドバーを非表示', showRight: '右サイドバーを表示', hideRight: '右サイドバーを非表示' },
  tabs: { close: '閉じる', closeLeft: '左のタブを閉じる', closeRight: '右のタブを閉じる', closeOthers: '他のタブを閉じる', closeAll: 'すべてのタブを閉じる' },
  panel: { details: 'オブジェクトの詳細', noSelection: 'タブを開くと詳細が表示されます', type: 'タイプ', connection: '接続', database: 'データベース', schema: 'スキーマ', table: 'テーブル', routine: 'メソッド', routineType: 'メソッドタイプ', permission: '権限モード', ddl: 'DDL を表示', copyDdl: 'DDL をコピー', tabTypes: { query: 'SQL クエリ', routine: 'メソッド', table: 'テーブルデータ', structure: 'テーブル構造', audit: '操作ログ' } },
  permission: { readonly: '読み取り専用', approval: '承認', full: 'フルアクセス', readonlyMode: '読み取り専用モード', approvalMode: '承認モード', readonlyHelp: 'SELECT / SHOW / EXPLAIN のみ許可され、書き込みはブロックされます。', approvalHelp: 'INSERT / UPDATE / DELETE / DDL には確認が必要です。', fullHelp: 'すべての文を直ちに実行します。' },
  sidebar: { connections: '接続', newConnection: '新規', connect: '接続', newQuery: '新しいクエリ', savedQueries: 'クエリ', connectionManagement: '接続管理', importConnections: '接続をインポート', exportConnections: '接続をエクスポート', auditLog: '操作ログ', editConnection: '接続を編集', disconnect: '切断', deleteConnection: '接続を削除', newTable: '新しいテーブル', openTable: 'テーブルを開く', designTable: 'テーブルを設計', searchPlaceholder: 'クエリ / テーブル / ビュー / メソッドを検索', objectGroups: { tables: 'テーブル', views: 'ビュー', routines: 'メソッド' }, routineTypes: { function: '関数', procedure: 'プロシージャ' } },
  connection: { newTitle: '新しい接続', editTitle: '接続を編集', generalTab: '一般', databaseType: '接続タイプ', name: '接続名', permissionMode: '権限モード', host: 'ホスト', port: 'ポート', user: 'ユーザー名', password: 'パスワード', defaultDatabase: '既定のデータベース', databaseFile: 'データベースファイル', choose: '選択', sshTunnel: 'SSH トンネル', enable: '有効化', test: '接続テスト', testSuccess: '接続に成功しました' },
  approval: { title: '操作の承認', confirm: '確認して実行', write: 'データ変更', ddl: 'スキーマ変更', database: 'データベース：{name}' },
  query: { run: '実行', saveQuery: 'クエリを保存', queryName: 'クエリ名', database: 'データベース', selectDatabase: 'データベースを選択', affectedRows: '影響を受けた行：{count}', exportCsv: 'CSV をエクスポート', exportJson: 'JSON をエクスポート', copy: 'コピー', failed: '実行に失敗しました', noResult: '完了しました（結果セットなし）', canceled: '実行をキャンセルしました' },
  grid: { filter: 'フィルター', addRow: '行を追加', deleteRow: '行を削除', discard: '変更を破棄', saveCount: '保存 ({count})', operator: '演算子', value: '値', primaryKey: '主キー' },
  structure: { tableName: 'テーブル名', newTableName: '新しいテーブル名', columns: '列 ({count})', indexes: 'インデックス ({count})', addColumn: '列を追加', createTable: 'テーブルを作成', columnName: '列名', type: 'タイプ', nullable: 'Null 許可', primary: '主キー', autoIncrement: '自動増分', defaultValue: '既定値', comment: 'コメント', indexName: 'インデックス名', indexColumns: '列', unique: '一意' },
  audit: { connection: '接続', connectionType: '接続タイプ', result: '結果', time: '時刻', database: 'データベース', type: 'タイプ', success: '成功', error: '失敗', blocked: 'ブロック済み' }
})
