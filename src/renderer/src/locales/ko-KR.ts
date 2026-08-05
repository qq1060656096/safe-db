import { createLocale } from './createLocale'

export default createLocale({
  common: { add: '추가', save: '저장', cancel: '취소', delete: '삭제', edit: '편집', refresh: '새로 고침', clear: '지우기', search: '검색', export: '내보내기', apply: '적용', remove: '제거', yes: '예', no: '아니요', rows: '{count}행', totalRows: '총 {count}행', totalItems: '총 {count}개', saved: '저장됨', deleted: '삭제됨', copied: '복사됨', close: '닫기', language: '언어' },
  app: { emptyHint: '왼쪽에서 테이블을 두 번 클릭하거나 연결을 오른쪽 클릭해 쿼리를 만드세요', menu: '메뉴', newWindow: '새 창(Cmd/Ctrl+Shift+N)' },
  layout: { showLeft: '왼쪽 사이드바 표시', hideLeft: '왼쪽 사이드바 숨기기', showRight: '오른쪽 사이드바 표시', hideRight: '오른쪽 사이드바 숨기기' },
  tabs: { close: '닫기', closeLeft: '왼쪽 탭 닫기', closeRight: '오른쪽 탭 닫기', closeOthers: '다른 탭 닫기', closeAll: '모든 탭 닫기' },
  panel: { details: '개체 세부 정보', noSelection: '탭을 열어 세부 정보를 확인하세요', type: '유형', connection: '연결', database: '데이터베이스', schema: '스키마', table: '테이블', routine: '메서드', routineType: '메서드 유형', permission: '권한 모드', ddl: 'DDL 보기', copyDdl: 'DDL 복사', tabTypes: { query: 'SQL 쿼리', routine: '메서드', table: '테이블 데이터', structure: '테이블 구조', audit: '작업 로그' } },
  permission: { readonly: '읽기 전용', approval: '승인', full: '전체 접근', readonlyMode: '읽기 전용 모드', approvalMode: '승인 모드', readonlyHelp: 'SELECT / SHOW / EXPLAIN만 허용되며 쓰기는 차단됩니다.', approvalHelp: 'INSERT / UPDATE / DELETE / DDL은 확인이 필요합니다.', fullHelp: '모든 문을 즉시 실행합니다.' },
  sidebar: { connections: '연결', newConnection: '새로 만들기', connect: '연결', newQuery: '새 쿼리', savedQueries: '쿼리', connectionManagement: '연결 관리', importConnections: '연결 가져오기', exportConnections: '연결 내보내기', auditLog: '작업 로그', editConnection: '연결 편집', disconnect: '연결 끊기', deleteConnection: '연결 삭제', newTable: '새 테이블', openTable: '테이블 열기', designTable: '테이블 설계', searchPlaceholder: '쿼리 / 테이블 / 뷰 / 메서드 검색', objectGroups: { tables: '테이블', views: '뷰', routines: '메서드' }, routineTypes: { function: '함수', procedure: '프로시저' } },
  connection: { newTitle: '새 연결', editTitle: '연결 편집', generalTab: '일반', databaseType: '연결 유형', name: '연결 이름', permissionMode: '권한 모드', host: '호스트', port: '포트', user: '사용자 이름', password: '비밀번호', defaultDatabase: '기본 데이터베이스', databaseFile: '데이터베이스 파일', choose: '선택', sshTunnel: 'SSH 터널', enable: '사용', test: '연결 테스트', testSuccess: '연결 성공' },
  approval: { title: '작업 승인', confirm: '확인 및 실행', write: '데이터 변경', ddl: '스키마 변경', database: '데이터베이스: {name}' },
  query: { run: '실행', saveQuery: '쿼리 저장', queryName: '쿼리 이름', database: '데이터베이스', selectDatabase: '데이터베이스 선택', affectedRows: '영향받은 행: {count}', exportCsv: 'CSV 내보내기', exportJson: 'JSON 내보내기', copy: '복사', failed: '실행 실패', noResult: '결과 집합 없이 완료됨', canceled: '실행 취소됨' },
  grid: { filter: '필터', addRow: '행 추가', deleteRow: '행 삭제', discard: '변경 취소', saveCount: '저장 ({count})', operator: '연산자', value: '값', primaryKey: '기본 키' },
  structure: { tableName: '테이블 이름', newTableName: '새 테이블 이름', columns: '열 ({count})', indexes: '인덱스 ({count})', addColumn: '열 추가', createTable: '테이블 만들기', columnName: '열 이름', type: '유형', nullable: 'Null 허용', primary: '기본 키', autoIncrement: '자동 증가', defaultValue: '기본값', comment: '설명', indexName: '인덱스 이름', indexColumns: '열', unique: '고유' },
  audit: { connection: '연결', connectionType: '연결 유형', result: '결과', time: '시간', database: '데이터베이스', type: '유형', success: '성공', error: '실패', blocked: '차단됨' }
})
