export const SUPPORTED_HELP_LOCALES = [
  'zh-CN',
  'zh-TW',
  'en-US',
  'ja-JP',
  'ko-KR',
  'de-DE',
  'fr-FR',
  'es-ES',
  'pt-BR',
  'ru-RU'
]

const COMMANDS = [
  'capabilities',
  'connection list',
  'database list',
  'object list',
  'object ddl',
  'table describe',
  'sql check',
  'sql run',
  'request get',
  'request wait'
]

const COMMAND_USAGE = {
  capabilities: 'safedb capabilities',
  'connection list': 'safedb connection list',
  'database list': 'safedb database list --connection <connection-id-or-exact-name>',
  'object list': 'safedb object list --connection <connection-id-or-exact-name> [--database <database>]',
  'object ddl': 'safedb object ddl --connection <connection-id-or-exact-name> [--database <database>] [--schema <schema>] --name <object-name>',
  'table describe': 'safedb table describe --connection <connection-id-or-exact-name> [--database <database>] [--schema <schema>] --table <table> [--table <table> ...]',
  'sql check': 'safedb sql check --connection <connection-id-or-exact-name> [--database <database>] (--stdin | --file <sql-file>)',
  'sql run': 'safedb sql run --connection <connection-id-or-exact-name> [--database <database>] (--stdin | --file <sql-file>)',
  'request get': 'safedb request get <request-id>\n  safedb request get --id <request-id>',
  'request wait': 'safedb request wait <request-id> [--timeout <0-60>]\n  safedb request wait --id <request-id> [--timeout <0-60>]'
}

const EN_US = {
  title: 'safe db AI Agent CLI',
  usage: 'Usage',
  commands: 'Commands',
  help: 'Help',
  output: 'Output',
  language: 'Help language',
  notes: 'Notes',
  examples: 'Examples',
  descriptions: {
    capabilities: 'Show the protocol version and service capabilities',
    'connection list': 'List connections saved in safe db',
    'database list': 'List databases available through a connection',
    'object list': 'List tables, views, functions, and procedures',
    'object ddl': 'Show the DDL of a table or view',
    'table describe': 'Describe one or more tables',
    'sql check': 'Classify and validate SQL without executing it',
    'sql run': 'Execute SQL',
    'request get': 'Get the status of an approval request',
    'request wait': 'Wait for an approval request result'
  },
  details: {
    capabilities: 'Returns the protocol version, database types, supported methods, and request limits.',
    'connection list': 'Lists connection IDs, names, database types, default databases, permission modes, and SSH status. Credentials are never returned.',
    tableRepeat: '--table may be repeated. A request can contain up to 20 distinct tables.',
    tableSchema: 'For multiple schemas, use names such as --table public.users --table sales.orders.',
    sqlCheck: 'Only splits, classifies, and checks SQL permissions. It does not execute SQL.'
  },
  outputOptions: {
    json: 'Single-line JSON (default; for agents and scripts)',
    pretty: 'Indented JSON (for inspecting the complete response)',
    human: 'Tables and summaries (for people)',
    alias: 'Short form of --format human'
  },
  languageOption: 'Select the help language',
  languageAuto: 'Without --lang, SAFE_DB_LANG and then the system locale are used.',
  supported: 'Supported',
  unknown: 'Unknown help topic'
}

const LOCALES = {
  'en-US': EN_US,
  'zh-CN': {
    title: 'safe db AI Agent CLI', usage: '用法', commands: '命令', help: '帮助', output: '输出', language: '帮助语言', notes: '说明', examples: '示例',
    descriptions: {
      capabilities: '查看协议版本和服务能力', 'connection list': '列出 safe db 已保存的连接', 'database list': '列出连接下的数据库', 'object list': '列出表、视图、函数和存储过程', 'object ddl': '查看表或视图的 DDL', 'table describe': '查看单个或多个表的结构', 'sql check': '分类并检查 SQL，不执行', 'sql run': '执行 SQL', 'request get': '查询审批请求状态', 'request wait': '等待审批请求结果'
    },
    details: {
      capabilities: '返回协议版本、数据库类型、支持的方法和请求限制。', 'connection list': '列出连接 ID、名称、数据库类型、默认数据库、权限模式和 SSH 状态；不返回凭据。', tableRepeat: '--table 可以重复，单次最多查询 20 个不同表。', tableSchema: '跨 Schema 时可写成 --table public.users --table sales.orders。', sqlCheck: '只进行 SQL 拆分、风险分类和权限判断，不执行 SQL。'
    },
    outputOptions: { json: '单行 JSON（默认，适合 Agent 和脚本）', pretty: '缩进 JSON（适合查看完整响应）', human: '表格和摘要（适合人阅读）', alias: '--format human 的简写' },
    languageOption: '选择帮助文本的语言', languageAuto: '未指定 --lang 时，依次使用 SAFE_DB_LANG 和系统语言。', supported: '支持', unknown: '未知帮助主题'
  },
  'zh-TW': {
    title: 'safe db AI Agent CLI', usage: '用法', commands: '指令', help: '說明', output: '輸出', language: '說明語言', notes: '說明', examples: '範例',
    descriptions: {
      capabilities: '檢視協定版本與服務能力', 'connection list': '列出 safe db 已儲存的連線', 'database list': '列出連線下的資料庫', 'object list': '列出資料表、檢視、函式與儲存過程', 'object ddl': '檢視資料表或檢視的 DDL', 'table describe': '檢視一個或多個資料表的結構', 'sql check': '分類並檢查 SQL，不執行', 'sql run': '執行 SQL', 'request get': '查詢審批請求狀態', 'request wait': '等待審批請求結果'
    },
    details: {
      capabilities: '回傳協定版本、資料庫類型、支援方法與請求限制。', 'connection list': '列出連線 ID、名稱、資料庫類型、預設資料庫、權限模式與 SSH 狀態；不回傳憑證。', tableRepeat: '--table 可重複使用，單次最多查詢 20 個不同資料表。', tableSchema: '跨 Schema 時可使用 --table public.users --table sales.orders。', sqlCheck: '僅進行 SQL 分割、風險分類與權限判斷，不執行 SQL。'
    },
    outputOptions: { json: '單行 JSON（預設，適合 Agent 與腳本）', pretty: '縮排 JSON（適合檢視完整回應）', human: '表格與摘要（適合人閱讀）', alias: '--format human 的簡寫' },
    languageOption: '選擇說明文字的語言', languageAuto: '未指定 --lang 時，依序使用 SAFE_DB_LANG 與系統語言。', supported: '支援', unknown: '未知說明主題'
  },
  'ja-JP': {
    title: 'safe db AI Agent CLI', usage: '使用方法', commands: 'コマンド', help: 'ヘルプ', output: '出力', language: 'ヘルプの言語', notes: '注意', examples: '例',
    descriptions: {
      capabilities: 'プロトコルバージョンとサービス機能を表示', 'connection list': 'safe db に保存された接続を一覧表示', 'database list': '接続先のデータベースを一覧表示', 'object list': 'テーブル、ビュー、関数、プロシージャを一覧表示', 'object ddl': 'テーブルまたはビューの DDL を表示', 'table describe': '1 つまたは複数のテーブル構造を表示', 'sql check': 'SQL を分類・検査（実行はしない）', 'sql run': 'SQL を実行', 'request get': '承認リクエストの状態を取得', 'request wait': '承認リクエストの結果を待機'
    },
    details: {
      capabilities: 'プロトコルバージョン、DB 種類、対応メソッド、リクエスト制限を返します。', 'connection list': '接続 ID、名前、DB 種類、既定 DB、権限モード、SSH 状態を表示します。認証情報は返しません。', tableRepeat: '--table は繰り返し指定でき、1 回に最大 20 個の異なるテーブルを照会できます。', tableSchema: '複数 Schema では --table public.users --table sales.orders のように指定します。', sqlCheck: 'SQL の分割、リスク分類、権限確認だけを行い、SQL は実行しません。'
    },
    outputOptions: { json: '1 行 JSON（既定、Agent/スクリプト向け）', pretty: 'インデント済み JSON（完全な応答の確認用）', human: '表と要約（人間向け）', alias: '--format human の短縮形' },
    languageOption: 'ヘルプの表示言語を選択', languageAuto: '--lang 未指定時は SAFE_DB_LANG、次にシステムロケールを使用します。', supported: '対応言語', unknown: '不明なヘルプトピック'
  },
  'ko-KR': {
    title: 'safe db AI Agent CLI', usage: '사용법', commands: '명령', help: '도움말', output: '출력', language: '도움말 언어', notes: '참고', examples: '예제',
    descriptions: {
      capabilities: '프로토콜 버전과 서비스 기능 표시', 'connection list': 'safe db에 저장된 연결 목록 표시', 'database list': '연결의 데이터베이스 목록 표시', 'object list': '테이블, 뷰, 함수, 프로시저 목록 표시', 'object ddl': '테이블 또는 뷰의 DDL 표시', 'table describe': '하나 이상의 테이블 구조 표시', 'sql check': 'SQL을 분류하고 검사(실행하지 않음)', 'sql run': 'SQL 실행', 'request get': '승인 요청 상태 조회', 'request wait': '승인 요청 결과 대기'
    },
    details: {
      capabilities: '프로토콜 버전, DB 유형, 지원 메서드 및 요청 제한을 반환합니다.', 'connection list': '연결 ID, 이름, DB 유형, 기본 DB, 권한 모드, SSH 상태를 표시하며 인증 정보는 반환하지 않습니다.', tableRepeat: '--table은 반복해서 사용할 수 있고 한 요청에 최대 20개의 서로 다른 테이블을 지정할 수 있습니다.', tableSchema: '여러 Schema에서는 --table public.users --table sales.orders와 같이 사용합니다.', sqlCheck: 'SQL 분할, 위험 분류, 권한 판단만 수행하며 SQL은 실행하지 않습니다.'
    },
    outputOptions: { json: '한 줄 JSON(기본값, Agent 및 스크립트용)', pretty: '들여쓴 JSON(전체 응답 확인용)', human: '표와 요약(사용자용)', alias: '--format human의 축약형' },
    languageOption: '도움말 언어 선택', languageAuto: '--lang을 생략하면 SAFE_DB_LANG 다음으로 시스템 로케일을 사용합니다.', supported: '지원', unknown: '알 수 없는 도움말 항목'
  },
  'de-DE': {
    title: 'safe db AI Agent CLI', usage: 'Verwendung', commands: 'Befehle', help: 'Hilfe', output: 'Ausgabe', language: 'Hilfesprache', notes: 'Hinweise', examples: 'Beispiele',
    descriptions: {
      capabilities: 'Protokollversion und Dienstfunktionen anzeigen', 'connection list': 'In safe db gespeicherte Verbindungen auflisten', 'database list': 'Datenbanken einer Verbindung auflisten', 'object list': 'Tabellen, Views, Funktionen und Prozeduren auflisten', 'object ddl': 'DDL einer Tabelle oder View anzeigen', 'table describe': 'Struktur einer oder mehrerer Tabellen anzeigen', 'sql check': 'SQL klassifizieren und prüfen, ohne es auszuführen', 'sql run': 'SQL ausführen', 'request get': 'Status einer Genehmigungsanfrage abrufen', 'request wait': 'Auf das Ergebnis einer Genehmigungsanfrage warten'
    },
    details: {
      capabilities: 'Gibt Protokollversion, Datenbanktypen, unterstützte Methoden und Anfragelimits zurück.', 'connection list': 'Listet Verbindungs-ID, Name, Datenbanktyp, Standarddatenbank, Berechtigungsmodus und SSH-Status auf. Zugangsdaten werden nie ausgegeben.', tableRepeat: '--table kann wiederholt werden. Pro Anfrage sind bis zu 20 verschiedene Tabellen möglich.', tableSchema: 'Für mehrere Schemas z. B. --table public.users --table sales.orders verwenden.', sqlCheck: 'Teilt und klassifiziert SQL und prüft Berechtigungen, führt SQL aber nicht aus.'
    },
    outputOptions: { json: 'Einzeiliges JSON (Standard; für Agents und Skripte)', pretty: 'Eingerücktes JSON (vollständige Antwort)', human: 'Tabellen und Zusammenfassungen (für Menschen)', alias: 'Kurzform von --format human' },
    languageOption: 'Sprache der Hilfe auswählen', languageAuto: 'Ohne --lang werden SAFE_DB_LANG und danach die Systemsprache verwendet.', supported: 'Unterstützt', unknown: 'Unbekanntes Hilfethema'
  },
  'fr-FR': {
    title: 'safe db AI Agent CLI', usage: 'Utilisation', commands: 'Commandes', help: 'Aide', output: 'Sortie', language: "Langue de l'aide", notes: 'Remarques', examples: 'Exemples',
    descriptions: {
      capabilities: 'Afficher la version du protocole et les capacités du service', 'connection list': 'Lister les connexions enregistrées dans safe db', 'database list': "Lister les bases de données d'une connexion", 'object list': 'Lister les tables, vues, fonctions et procédures', 'object ddl': "Afficher le DDL d'une table ou d'une vue", 'table describe': 'Décrire une ou plusieurs tables', 'sql check': "Classifier et vérifier le SQL sans l'exécuter", 'sql run': 'Exécuter du SQL', 'request get': "Obtenir l'état d'une demande d'approbation", 'request wait': "Attendre le résultat d'une demande d'approbation"
    },
    details: {
      capabilities: 'Renvoie la version du protocole, les types de base, les méthodes prises en charge et les limites.', 'connection list': 'Liste les identifiants, noms, types de base, bases par défaut, modes de permission et états SSH. Les identifiants secrets ne sont jamais renvoyés.', tableRepeat: '--table peut être répété. Une requête accepte au maximum 20 tables distinctes.', tableSchema: 'Pour plusieurs schémas, utilisez --table public.users --table sales.orders.', sqlCheck: "Découpe et classifie le SQL puis vérifie les permissions, sans l'exécuter."
    },
    outputOptions: { json: 'JSON sur une ligne (par défaut ; agents et scripts)', pretty: 'JSON indenté (réponse complète)', human: 'Tableaux et résumés (lecture humaine)', alias: 'Forme courte de --format human' },
    languageOption: "Choisir la langue de l'aide", languageAuto: 'Sans --lang, SAFE_DB_LANG puis la langue du système sont utilisés.', supported: 'Langues prises en charge', unknown: "Rubrique d'aide inconnue"
  },
  'es-ES': {
    title: 'safe db AI Agent CLI', usage: 'Uso', commands: 'Comandos', help: 'Ayuda', output: 'Salida', language: 'Idioma de la ayuda', notes: 'Notas', examples: 'Ejemplos',
    descriptions: {
      capabilities: 'Mostrar la versión del protocolo y las capacidades del servicio', 'connection list': 'Listar las conexiones guardadas en safe db', 'database list': 'Listar las bases de datos de una conexión', 'object list': 'Listar tablas, vistas, funciones y procedimientos', 'object ddl': 'Mostrar el DDL de una tabla o vista', 'table describe': 'Describir una o varias tablas', 'sql check': 'Clasificar y comprobar SQL sin ejecutarlo', 'sql run': 'Ejecutar SQL', 'request get': 'Consultar el estado de una solicitud de aprobación', 'request wait': 'Esperar el resultado de una solicitud de aprobación'
    },
    details: {
      capabilities: 'Devuelve la versión del protocolo, los tipos de base de datos, los métodos admitidos y los límites.', 'connection list': 'Lista ID, nombres, tipos de base, bases predeterminadas, modos de permisos y estado SSH. Nunca devuelve credenciales.', tableRepeat: '--table puede repetirse. Cada solicitud admite hasta 20 tablas distintas.', tableSchema: 'Para varios esquemas, use --table public.users --table sales.orders.', sqlCheck: 'Solo divide y clasifica el SQL y comprueba permisos; no ejecuta el SQL.'
    },
    outputOptions: { json: 'JSON de una línea (predeterminado; agentes y scripts)', pretty: 'JSON con sangría (respuesta completa)', human: 'Tablas y resúmenes (para personas)', alias: 'Forma abreviada de --format human' },
    languageOption: 'Seleccionar el idioma de la ayuda', languageAuto: 'Sin --lang se usan SAFE_DB_LANG y después la configuración regional del sistema.', supported: 'Compatibles', unknown: 'Tema de ayuda desconocido'
  },
  'pt-BR': {
    title: 'safe db AI Agent CLI', usage: 'Uso', commands: 'Comandos', help: 'Ajuda', output: 'Saída', language: 'Idioma da ajuda', notes: 'Observações', examples: 'Exemplos',
    descriptions: {
      capabilities: 'Mostrar a versão do protocolo e os recursos do serviço', 'connection list': 'Listar conexões salvas no safe db', 'database list': 'Listar bancos de dados de uma conexão', 'object list': 'Listar tabelas, views, funções e procedimentos', 'object ddl': 'Mostrar o DDL de uma tabela ou view', 'table describe': 'Descrever uma ou mais tabelas', 'sql check': 'Classificar e verificar SQL sem executá-lo', 'sql run': 'Executar SQL', 'request get': 'Consultar o status de uma solicitação de aprovação', 'request wait': 'Aguardar o resultado de uma solicitação de aprovação'
    },
    details: {
      capabilities: 'Retorna a versão do protocolo, os tipos de banco, os métodos compatíveis e os limites.', 'connection list': 'Lista IDs, nomes, tipos de banco, bancos padrão, modos de permissão e status SSH. Credenciais nunca são retornadas.', tableRepeat: '--table pode ser repetido. Cada solicitação aceita até 20 tabelas distintas.', tableSchema: 'Para vários schemas, use --table public.users --table sales.orders.', sqlCheck: 'Apenas divide e classifica o SQL e verifica permissões; não executa o SQL.'
    },
    outputOptions: { json: 'JSON em uma linha (padrão; agentes e scripts)', pretty: 'JSON indentado (resposta completa)', human: 'Tabelas e resumos (para pessoas)', alias: 'Forma curta de --format human' },
    languageOption: 'Selecionar o idioma da ajuda', languageAuto: 'Sem --lang, SAFE_DB_LANG e depois a localidade do sistema são usadas.', supported: 'Compatíveis', unknown: 'Tópico de ajuda desconhecido'
  },
  'ru-RU': {
    title: 'safe db AI Agent CLI', usage: 'Использование', commands: 'Команды', help: 'Справка', output: 'Вывод', language: 'Язык справки', notes: 'Примечания', examples: 'Примеры',
    descriptions: {
      capabilities: 'Показать версию протокола и возможности сервиса', 'connection list': 'Показать сохранённые в safe db подключения', 'database list': 'Показать базы данных подключения', 'object list': 'Показать таблицы, представления, функции и процедуры', 'object ddl': 'Показать DDL таблицы или представления', 'table describe': 'Описать одну или несколько таблиц', 'sql check': 'Классифицировать и проверить SQL без выполнения', 'sql run': 'Выполнить SQL', 'request get': 'Получить статус запроса на согласование', 'request wait': 'Ожидать результат запроса на согласование'
    },
    details: {
      capabilities: 'Возвращает версию протокола, типы БД, методы и лимиты запросов.', 'connection list': 'Показывает ID, имя, тип БД, БД по умолчанию, режим доступа и SSH. Учётные данные не возвращаются.', tableRepeat: '--table можно повторять. В одном запросе до 20 разных таблиц.', tableSchema: 'Для разных Schema используйте --table public.users --table sales.orders.', sqlCheck: 'Только разбивает и классифицирует SQL и проверяет права; SQL не выполняется.'
    },
    outputOptions: { json: 'JSON в одну строку (по умолчанию; для агентов и скриптов)', pretty: 'JSON с отступами (полный ответ)', human: 'Таблицы и сводки (для людей)', alias: 'Краткая форма --format human' },
    languageOption: 'Выбрать язык справки', languageAuto: 'Без --lang используется SAFE_DB_LANG, затем системная локаль.', supported: 'Поддерживаются', unknown: 'Неизвестная тема справки'
  }
}

function mergeLocale(locale) {
  const selected = LOCALES[locale] ?? EN_US
  return {
    ...EN_US,
    ...selected,
    descriptions: { ...EN_US.descriptions, ...selected.descriptions },
    details: { ...EN_US.details, ...selected.details },
    outputOptions: { ...EN_US.outputOptions, ...selected.outputOptions }
  }
}

function normalizeLocale(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const normalized = value.trim().replace(/_/g, '-').split('.')[0].toLowerCase()
  if (normalized === 'zh-tw' || normalized === 'zh-hk' || normalized === 'zh-mo' || normalized.startsWith('zh-hant')) return 'zh-TW'
  if (normalized === 'zh' || normalized === 'zh-cn' || normalized === 'zh-sg' || normalized.startsWith('zh-hans')) return 'zh-CN'
  const byLanguage = {
    en: 'en-US', ja: 'ja-JP', ko: 'ko-KR', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', pt: 'pt-BR', ru: 'ru-RU'
  }
  return byLanguage[normalized.slice(0, 2)]
}

function optionValue(args, option) {
  const index = args.lastIndexOf(option)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`)
  return value
}

function localeCandidates(env) {
  return [
    env.SAFE_DB_LANG,
    ...(env.LANGUAGE?.split(':') ?? []),
    env.LC_ALL,
    env.LC_MESSAGES,
    env.LANG,
    Intl.DateTimeFormat().resolvedOptions().locale
  ]
}

export function resolveHelpLocale(rawArgs, env = process.env) {
  const explicit = optionValue(rawArgs, '--lang')
  if (explicit !== undefined) {
    const locale = normalizeLocale(explicit)
    if (!locale) {
      throw new Error(`Unsupported help locale "${explicit}". Supported: ${SUPPORTED_HELP_LOCALES.join(', ')}`)
    }
    return locale
  }
  for (const candidate of localeCandidates(env)) {
    const locale = normalizeLocale(candidate)
    if (locale) return locale
  }
  return 'zh-CN'
}

function helpArguments(rawArgs) {
  const result = []
  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index]
    if (arg === '--format' || arg === '--lang') {
      index += 1
      continue
    }
    if (arg === '--help' || arg === '-h' || arg === '--human') continue
    result.push(arg)
  }
  return result
}

export function isHelpRequest(rawArgs) {
  return rawArgs.length === 0 || rawArgs.includes('--help') || rawArgs.includes('-h') || helpArguments(rawArgs)[0] === 'help'
}

function outputHelp(messages) {
  return `${messages.output}:
  --format json       ${messages.outputOptions.json}
  --format pretty     ${messages.outputOptions.pretty}
  --format human      ${messages.outputOptions.human}
  --human             ${messages.outputOptions.alias}`
}

function languageHelp(messages) {
  return `${messages.language}:
  --lang <locale>     ${messages.languageOption}
  SAFE_DB_LANG        ${messages.languageAuto}
  ${messages.supported}: ${SUPPORTED_HELP_LOCALES.join(', ')}`
}

function rootHelp(messages) {
  const commandLines = COMMANDS.map((command) => `  ${command.padEnd(18)} ${messages.descriptions[command]}`)
  return `${messages.title}

${messages.usage}:
  safedb <command> [options]
  safedb help [command]

${messages.commands}:
${commandLines.join('\n')}

${messages.help}:
  safedb --help
  safedb --help --lang en-US
  safedb help table describe
  safedb sql run --help`
}

function commandHelp(command, messages) {
  const parts = [
    `${messages.usage}:\n  ${COMMAND_USAGE[command]}`,
    messages.descriptions[command]
  ]
  if (command === 'capabilities' || command === 'connection list') parts.push(messages.details[command])
  if (command === 'table describe') {
    parts.push(`${messages.notes}:\n  ${messages.details.tableRepeat}\n  ${messages.details.tableSchema}`)
  }
  if (command === 'sql check') parts.push(messages.details.sqlCheck)
  if (command === 'sql run') {
    parts.push(`${messages.examples}:
  safedb sql run --connection conn_01 --database app --file query.sql
  printf '%s' 'SELECT 1' | safedb sql run --connection conn_01 --stdin`)
  }
  return parts.join('\n\n')
}

export function helpText(rawArgs, locale) {
  const messages = mergeLocale(locale)
  const args = helpArguments(rawArgs)
  if (args[0] === 'help') args.shift()
  const topic = args.filter((arg) => !arg.startsWith('-')).slice(0, 2).join(' ')
  const footer = `${outputHelp(messages)}\n\n${languageHelp(messages)}`
  if (!topic) return `${rootHelp(messages)}\n\n${footer}`
  if (COMMANDS.includes(topic)) return `${commandHelp(topic, messages)}\n\n${footer}`
  const related = COMMANDS.filter((command) => command.startsWith(topic + ' '))
  if (related.length > 0) {
    return `${related.map((command) => `${command}\n${commandHelp(command, messages)}`).join('\n\n')}\n\n${footer}`
  }
  return `${rootHelp(messages)}\n\n${footer}\n\n${messages.unknown}: ${topic}`
}
