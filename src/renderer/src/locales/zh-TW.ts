import { createLocale } from './createLocale'

export default createLocale({
  common: { add: '新增', save: '儲存', cancel: '取消', delete: '刪除', edit: '編輯', refresh: '重新整理', clear: '清除', search: '搜尋', export: '匯出', apply: '套用', remove: '移除', yes: '是', no: '否', rows: '{count} 列', totalRows: '共 {count} 列', totalItems: '共 {count} 項', saved: '已儲存', deleted: '已刪除', copied: '已複製', close: '關閉', language: '語言' },
  app: { emptyHint: '在左側按兩下資料表，或在連線上按右鍵建立查詢', menu: '選單', newWindow: '新增視窗（Cmd/Ctrl+Shift+N）' },
  layout: { showLeft: '顯示左側欄', hideLeft: '隱藏左側欄', showRight: '顯示右側欄', hideRight: '隱藏右側欄' },
  tabs: { close: '關閉', closeLeft: '關閉左側分頁', closeRight: '關閉右側分頁', closeOthers: '關閉其他分頁', closeAll: '關閉全部分頁' },
  panel: { details: '物件詳細資料', noSelection: '開啟分頁以查看詳細資料', type: '類型', connection: '連線', database: '資料庫', schema: 'Schema', table: '資料表', routine: '方法', routineType: '方法類型', permission: '權限模式', ddl: '檢視 DDL', copyDdl: '複製 DDL', tabTypes: { query: 'SQL 查詢', routine: '方法', table: '資料表資料', structure: '資料表結構', audit: '操作記錄' } },
  permission: { readonly: '唯讀', approval: '審批', full: '完整存取', readonlyMode: '唯讀模式', approvalMode: '審批模式', readonlyHelp: '僅允許 SELECT / SHOW / EXPLAIN，寫入操作將被封鎖。', approvalHelp: 'INSERT / UPDATE / DELETE / DDL 需要確認。', fullHelp: '所有陳述式將立即執行。' },
  sidebar: { connections: '連線', newConnection: '新增', connect: '連線', newQuery: '新增查詢', savedQueries: '查詢', connectionManagement: '連線管理', importConnections: '匯入連線', exportConnections: '匯出連線', auditLog: '操作記錄', editConnection: '編輯連線', copyConnection: '複製連線', connectionCopyName: '{name} - 副本', connectionCopied: '已複製連線「{name}」', copyConnectionFailed: '複製連線失敗：{error}', disconnect: '中斷連線', deleteConnection: '刪除連線', newTable: '新增資料表', openTable: '開啟資料表', designTable: '設計資料表', searchPlaceholder: '搜尋查詢 / 資料表 / 檢視表 / 方法', objectGroups: { tables: '資料表', views: '檢視表', routines: '方法' }, routineTypes: { function: '函數', procedure: '預存程序' } },
  connection: { newTitle: '新增連線', editTitle: '編輯連線', generalTab: '一般', databaseType: '連線類型', name: '連線名稱', permissionMode: '權限模式', host: '主機', port: '連接埠', user: '使用者名稱', password: '密碼', defaultDatabase: '預設資料庫', databaseFile: '資料庫檔案', choose: '選擇', sshTunnel: 'SSH 通道', enable: '啟用', test: '測試連線', testSuccess: '連線成功' },
  approval: { title: '操作審批', confirm: '確認並執行', write: '資料變更', ddl: '結構變更', database: '資料庫：{name}' },
  query: { run: '執行', saveQuery: '儲存查詢', queryName: '查詢名稱', database: '資料庫', selectDatabase: '選擇資料庫', affectedRows: '受影響列數：{count}', exportCsv: '匯出 CSV', exportJson: '匯出 JSON', copy: '複製', failed: '執行失敗', noResult: '執行完成，沒有結果集', canceled: '已取消執行' },
  grid: { filter: '篩選', addRow: '新增列', deleteRow: '刪除列', discard: '放棄變更', saveCount: '儲存 ({count})', operator: '運算子', value: '值', primaryKey: '主鍵' },
  structure: { tableName: '資料表名稱', newTableName: '新資料表名稱', columns: '欄位 ({count})', indexes: '索引 ({count})', addColumn: '新增欄位', createTable: '建立資料表', columnName: '欄位名稱', type: '類型', nullable: '可為 Null', primary: '主鍵', autoIncrement: '自動遞增', defaultValue: '預設值', comment: '註解', indexName: '索引名稱', indexColumns: '欄位', unique: '唯一' },
  audit: { connection: '連線', connectionType: '連線類型', result: '結果', time: '時間', database: '資料庫', type: '類型', success: '成功', error: '失敗', blocked: '已封鎖' }
})
