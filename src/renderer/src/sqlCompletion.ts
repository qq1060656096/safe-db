import {
  autocompletion,
  ifNotIn,
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionSource
} from '@codemirror/autocomplete'
import {
  MySQL,
  MSSQL,
  PostgreSQL,
  SQLite,
  StandardSQL,
  sql,
  type SQLConfig,
  type SQLDialect,
  type SQLNamespace
} from '@codemirror/lang-sql'
import type { Extension } from '@codemirror/state'
import type { DbType } from '../../shared/types'

export interface SqlCompletionColumn {
  name: string
  dataType: string
  isPrimaryKey?: boolean
  comment?: string
}

export interface SqlCompletionTable {
  name: string
  type: 'table' | 'view'
  database?: string
  schema?: string
  comment?: string
  columns: SqlCompletionColumn[]
}

export interface SqlCompletionCatalog {
  dbType?: DbType
  database?: string
  defaultSchema?: string
  databases?: string[]
  tables: SqlCompletionTable[]
  loadColumns?: (table: SqlCompletionTable) => Promise<SqlCompletionColumn[]>
}

interface FunctionSpec {
  label: string
  signature: string
  snippet: string
}

interface RedisCommandSpec {
  label: string
  syntax: string
  snippet: string
  description: string
}

const redisCommands: RedisCommandSpec[] = [
  { label: 'PING', syntax: 'PING [message]', snippet: 'PING', description: '测试服务器连接' },
  { label: 'ECHO', syntax: 'ECHO message', snippet: 'ECHO ${message}', description: '回显消息' },
  { label: 'GET', syntax: 'GET key', snippet: 'GET ${key}', description: '读取字符串值' },
  { label: 'SET', syntax: 'SET key value [NX|XX] [EX seconds|PX milliseconds]', snippet: 'SET ${key} ${value}', description: '设置字符串值' },
  { label: 'GETDEL', syntax: 'GETDEL key', snippet: 'GETDEL ${key}', description: '读取并删除字符串值' },
  { label: 'GETEX', syntax: 'GETEX key [EX seconds|PX milliseconds|PERSIST]', snippet: 'GETEX ${key}', description: '读取字符串值并设置过期时间' },
  { label: 'GETRANGE', syntax: 'GETRANGE key start end', snippet: 'GETRANGE ${key} ${start} ${end}', description: '读取字符串片段' },
  { label: 'SETRANGE', syntax: 'SETRANGE key offset value', snippet: 'SETRANGE ${key} ${offset} ${value}', description: '覆写字符串片段' },
  { label: 'APPEND', syntax: 'APPEND key value', snippet: 'APPEND ${key} ${value}', description: '追加字符串值' },
  { label: 'STRLEN', syntax: 'STRLEN key', snippet: 'STRLEN ${key}', description: '返回字符串长度' },
  { label: 'MGET', syntax: 'MGET key [key ...]', snippet: 'MGET ${key}', description: '批量读取字符串值' },
  { label: 'MSET', syntax: 'MSET key value [key value ...]', snippet: 'MSET ${key} ${value}', description: '批量设置字符串值' },
  { label: 'MSETNX', syntax: 'MSETNX key value [key value ...]', snippet: 'MSETNX ${key} ${value}', description: '仅在键均不存在时批量设置' },
  { label: 'INCR', syntax: 'INCR key', snippet: 'INCR ${key}', description: '将整数值加一' },
  { label: 'INCRBY', syntax: 'INCRBY key increment', snippet: 'INCRBY ${key} ${increment}', description: '增加整数值' },
  { label: 'INCRBYFLOAT', syntax: 'INCRBYFLOAT key increment', snippet: 'INCRBYFLOAT ${key} ${increment}', description: '增加浮点值' },
  { label: 'DECR', syntax: 'DECR key', snippet: 'DECR ${key}', description: '将整数值减一' },
  { label: 'DECRBY', syntax: 'DECRBY key decrement', snippet: 'DECRBY ${key} ${decrement}', description: '减少整数值' },
  { label: 'DEL', syntax: 'DEL key [key ...]', snippet: 'DEL ${key}', description: '删除一个或多个键' },
  { label: 'UNLINK', syntax: 'UNLINK key [key ...]', snippet: 'UNLINK ${key}', description: '异步删除一个或多个键' },
  { label: 'EXISTS', syntax: 'EXISTS key [key ...]', snippet: 'EXISTS ${key}', description: '检查键是否存在' },
  { label: 'TYPE', syntax: 'TYPE key', snippet: 'TYPE ${key}', description: '返回键的数据类型' },
  { label: 'TTL', syntax: 'TTL key', snippet: 'TTL ${key}', description: '返回键的剩余秒数' },
  { label: 'PTTL', syntax: 'PTTL key', snippet: 'PTTL ${key}', description: '返回键的剩余毫秒数' },
  { label: 'EXPIRE', syntax: 'EXPIRE key seconds [NX|XX|GT|LT]', snippet: 'EXPIRE ${key} ${seconds}', description: '设置键的秒级过期时间' },
  { label: 'PEXPIRE', syntax: 'PEXPIRE key milliseconds [NX|XX|GT|LT]', snippet: 'PEXPIRE ${key} ${milliseconds}', description: '设置键的毫秒级过期时间' },
  { label: 'EXPIREAT', syntax: 'EXPIREAT key unix-time-seconds [NX|XX|GT|LT]', snippet: 'EXPIREAT ${key} ${timestamp}', description: '按时间戳设置过期时间' },
  { label: 'PERSIST', syntax: 'PERSIST key', snippet: 'PERSIST ${key}', description: '移除键的过期时间' },
  { label: 'RENAME', syntax: 'RENAME key newkey', snippet: 'RENAME ${key} ${newkey}', description: '重命名键' },
  { label: 'RENAMENX', syntax: 'RENAMENX key newkey', snippet: 'RENAMENX ${key} ${newkey}', description: '仅在新键不存在时重命名' },
  { label: 'COPY', syntax: 'COPY source destination [DB database] [REPLACE]', snippet: 'COPY ${source} ${destination}', description: '复制键' },
  { label: 'DUMP', syntax: 'DUMP key', snippet: 'DUMP ${key}', description: '序列化键的值' },
  { label: 'KEYS', syntax: 'KEYS pattern', snippet: 'KEYS ${pattern}', description: '按模式查找键' },
  { label: 'SCAN', syntax: 'SCAN cursor [MATCH pattern] [COUNT count] [TYPE type]', snippet: 'SCAN 0 MATCH ${pattern} COUNT 100', description: '渐进式遍历键' },
  { label: 'RANDOMKEY', syntax: 'RANDOMKEY', snippet: 'RANDOMKEY', description: '返回随机键' },
  { label: 'HGET', syntax: 'HGET key field', snippet: 'HGET ${key} ${field}', description: '读取哈希字段' },
  { label: 'HSET', syntax: 'HSET key field value [field value ...]', snippet: 'HSET ${key} ${field} ${value}', description: '设置哈希字段' },
  { label: 'HSETNX', syntax: 'HSETNX key field value', snippet: 'HSETNX ${key} ${field} ${value}', description: '仅在字段不存在时设置' },
  { label: 'HMGET', syntax: 'HMGET key field [field ...]', snippet: 'HMGET ${key} ${field}', description: '批量读取哈希字段' },
  { label: 'HGETALL', syntax: 'HGETALL key', snippet: 'HGETALL ${key}', description: '读取全部哈希字段' },
  { label: 'HDEL', syntax: 'HDEL key field [field ...]', snippet: 'HDEL ${key} ${field}', description: '删除哈希字段' },
  { label: 'HEXISTS', syntax: 'HEXISTS key field', snippet: 'HEXISTS ${key} ${field}', description: '检查哈希字段是否存在' },
  { label: 'HLEN', syntax: 'HLEN key', snippet: 'HLEN ${key}', description: '返回哈希字段数量' },
  { label: 'HKEYS', syntax: 'HKEYS key', snippet: 'HKEYS ${key}', description: '返回全部哈希字段名' },
  { label: 'HVALS', syntax: 'HVALS key', snippet: 'HVALS ${key}', description: '返回全部哈希值' },
  { label: 'HINCRBY', syntax: 'HINCRBY key field increment', snippet: 'HINCRBY ${key} ${field} ${increment}', description: '增加哈希整数值' },
  { label: 'HINCRBYFLOAT', syntax: 'HINCRBYFLOAT key field increment', snippet: 'HINCRBYFLOAT ${key} ${field} ${increment}', description: '增加哈希浮点值' },
  { label: 'HSCAN', syntax: 'HSCAN key cursor [MATCH pattern] [COUNT count]', snippet: 'HSCAN ${key} 0', description: '渐进式遍历哈希字段' },
  { label: 'LPUSH', syntax: 'LPUSH key element [element ...]', snippet: 'LPUSH ${key} ${element}', description: '从左侧插入列表元素' },
  { label: 'RPUSH', syntax: 'RPUSH key element [element ...]', snippet: 'RPUSH ${key} ${element}', description: '从右侧插入列表元素' },
  { label: 'LPOP', syntax: 'LPOP key [count]', snippet: 'LPOP ${key}', description: '移除并返回左侧列表元素' },
  { label: 'RPOP', syntax: 'RPOP key [count]', snippet: 'RPOP ${key}', description: '移除并返回右侧列表元素' },
  { label: 'LLEN', syntax: 'LLEN key', snippet: 'LLEN ${key}', description: '返回列表长度' },
  { label: 'LRANGE', syntax: 'LRANGE key start stop', snippet: 'LRANGE ${key} ${start} ${stop}', description: '返回列表范围' },
  { label: 'LINDEX', syntax: 'LINDEX key index', snippet: 'LINDEX ${key} ${index}', description: '读取列表元素' },
  { label: 'LSET', syntax: 'LSET key index element', snippet: 'LSET ${key} ${index} ${element}', description: '设置列表元素' },
  { label: 'LTRIM', syntax: 'LTRIM key start stop', snippet: 'LTRIM ${key} ${start} ${stop}', description: '裁剪列表' },
  { label: 'LREM', syntax: 'LREM key count element', snippet: 'LREM ${key} ${count} ${element}', description: '删除匹配的列表元素' },
  { label: 'LMOVE', syntax: 'LMOVE source destination LEFT|RIGHT LEFT|RIGHT', snippet: 'LMOVE ${source} ${destination} ${LEFT} ${RIGHT}', description: '在列表之间移动元素' },
  { label: 'SADD', syntax: 'SADD key member [member ...]', snippet: 'SADD ${key} ${member}', description: '添加集合成员' },
  { label: 'SREM', syntax: 'SREM key member [member ...]', snippet: 'SREM ${key} ${member}', description: '删除集合成员' },
  { label: 'SMEMBERS', syntax: 'SMEMBERS key', snippet: 'SMEMBERS ${key}', description: '返回全部集合成员' },
  { label: 'SISMEMBER', syntax: 'SISMEMBER key member', snippet: 'SISMEMBER ${key} ${member}', description: '检查集合成员' },
  { label: 'SMISMEMBER', syntax: 'SMISMEMBER key member [member ...]', snippet: 'SMISMEMBER ${key} ${member}', description: '批量检查集合成员' },
  { label: 'SCARD', syntax: 'SCARD key', snippet: 'SCARD ${key}', description: '返回集合成员数' },
  { label: 'SPOP', syntax: 'SPOP key [count]', snippet: 'SPOP ${key}', description: '移除并返回随机集合成员' },
  { label: 'SRANDMEMBER', syntax: 'SRANDMEMBER key [count]', snippet: 'SRANDMEMBER ${key}', description: '返回随机集合成员' },
  { label: 'SMOVE', syntax: 'SMOVE source destination member', snippet: 'SMOVE ${source} ${destination} ${member}', description: '在集合之间移动成员' },
  { label: 'SUNION', syntax: 'SUNION key [key ...]', snippet: 'SUNION ${key}', description: '返回集合并集' },
  { label: 'SINTER', syntax: 'SINTER key [key ...]', snippet: 'SINTER ${key}', description: '返回集合交集' },
  { label: 'SDIFF', syntax: 'SDIFF key [key ...]', snippet: 'SDIFF ${key}', description: '返回集合差集' },
  { label: 'SSCAN', syntax: 'SSCAN key cursor [MATCH pattern] [COUNT count]', snippet: 'SSCAN ${key} 0', description: '渐进式遍历集合成员' },
  { label: 'ZADD', syntax: 'ZADD key [NX|XX] [GT|LT] [CH] score member', snippet: 'ZADD ${key} ${score} ${member}', description: '添加有序集合成员' },
  { label: 'ZREM', syntax: 'ZREM key member [member ...]', snippet: 'ZREM ${key} ${member}', description: '删除有序集合成员' },
  { label: 'ZSCORE', syntax: 'ZSCORE key member', snippet: 'ZSCORE ${key} ${member}', description: '返回成员分数' },
  { label: 'ZMSCORE', syntax: 'ZMSCORE key member [member ...]', snippet: 'ZMSCORE ${key} ${member}', description: '批量返回成员分数' },
  { label: 'ZINCRBY', syntax: 'ZINCRBY key increment member', snippet: 'ZINCRBY ${key} ${increment} ${member}', description: '增加成员分数' },
  { label: 'ZCARD', syntax: 'ZCARD key', snippet: 'ZCARD ${key}', description: '返回有序集合成员数' },
  { label: 'ZCOUNT', syntax: 'ZCOUNT key min max', snippet: 'ZCOUNT ${key} ${min} ${max}', description: '统计分数区间内的成员' },
  { label: 'ZRANGE', syntax: 'ZRANGE key start stop [BYSCORE|BYLEX] [REV] [LIMIT offset count] [WITHSCORES]', snippet: 'ZRANGE ${key} ${start} ${stop}', description: '返回有序集合范围' },
  { label: 'ZRANK', syntax: 'ZRANK key member [WITHSCORE]', snippet: 'ZRANK ${key} ${member}', description: '返回成员升序排名' },
  { label: 'ZREVRANK', syntax: 'ZREVRANK key member [WITHSCORE]', snippet: 'ZREVRANK ${key} ${member}', description: '返回成员降序排名' },
  { label: 'ZPOPMIN', syntax: 'ZPOPMIN key [count]', snippet: 'ZPOPMIN ${key}', description: '移除并返回最低分成员' },
  { label: 'ZPOPMAX', syntax: 'ZPOPMAX key [count]', snippet: 'ZPOPMAX ${key}', description: '移除并返回最高分成员' },
  { label: 'ZSCAN', syntax: 'ZSCAN key cursor [MATCH pattern] [COUNT count]', snippet: 'ZSCAN ${key} 0', description: '渐进式遍历有序集合成员' },
  { label: 'XADD', syntax: 'XADD key * field value [field value ...]', snippet: 'XADD ${key} * ${field} ${value}', description: '添加流消息' },
  { label: 'XLEN', syntax: 'XLEN key', snippet: 'XLEN ${key}', description: '返回流消息数' },
  { label: 'XRANGE', syntax: 'XRANGE key start end [COUNT count]', snippet: 'XRANGE ${key} - +', description: '正序读取流消息' },
  { label: 'XREVRANGE', syntax: 'XREVRANGE key end start [COUNT count]', snippet: 'XREVRANGE ${key} + -', description: '倒序读取流消息' },
  { label: 'XDEL', syntax: 'XDEL key id [id ...]', snippet: 'XDEL ${key} ${id}', description: '删除流消息' },
  { label: 'XTRIM', syntax: 'XTRIM key MAXLEN|MINID threshold', snippet: 'XTRIM ${key} MAXLEN ${count}', description: '裁剪流消息' },
  { label: 'XINFO', syntax: 'XINFO STREAM key', snippet: 'XINFO STREAM ${key}', description: '查看流信息' },
  { label: 'PFADD', syntax: 'PFADD key element [element ...]', snippet: 'PFADD ${key} ${element}', description: '添加 HyperLogLog 元素' },
  { label: 'PFCOUNT', syntax: 'PFCOUNT key [key ...]', snippet: 'PFCOUNT ${key}', description: '估算唯一元素数量' },
  { label: 'BITCOUNT', syntax: 'BITCOUNT key [start end]', snippet: 'BITCOUNT ${key}', description: '统计字符串中的置位数' },
  { label: 'GETBIT', syntax: 'GETBIT key offset', snippet: 'GETBIT ${key} ${offset}', description: '读取位值' },
  { label: 'SETBIT', syntax: 'SETBIT key offset value', snippet: 'SETBIT ${key} ${offset} ${value}', description: '设置位值' },
  { label: 'GEOADD', syntax: 'GEOADD key longitude latitude member', snippet: 'GEOADD ${key} ${longitude} ${latitude} ${member}', description: '添加地理位置' },
  { label: 'GEODIST', syntax: 'GEODIST key member1 member2 [unit]', snippet: 'GEODIST ${key} ${member1} ${member2}', description: '计算地理位置距离' },
  { label: 'GEOSEARCH', syntax: 'GEOSEARCH key FROMMEMBER member BYRADIUS radius unit', snippet: 'GEOSEARCH ${key} FROMMEMBER ${member} BYRADIUS ${radius} km', description: '搜索地理位置' },
  { label: 'INFO', syntax: 'INFO [section]', snippet: 'INFO', description: '查看服务器信息' },
  { label: 'DBSIZE', syntax: 'DBSIZE', snippet: 'DBSIZE', description: '返回当前数据库的键数量' },
  { label: 'TIME', syntax: 'TIME', snippet: 'TIME', description: '返回服务器时间' }
]

const commonFunctions: FunctionSpec[] = [
  { label: 'COUNT', signature: 'COUNT(expression)', snippet: 'COUNT(${expression})' },
  { label: 'SUM', signature: 'SUM(expression)', snippet: 'SUM(${expression})' },
  { label: 'AVG', signature: 'AVG(expression)', snippet: 'AVG(${expression})' },
  { label: 'MIN', signature: 'MIN(expression)', snippet: 'MIN(${expression})' },
  { label: 'MAX', signature: 'MAX(expression)', snippet: 'MAX(${expression})' },
  { label: 'COALESCE', signature: 'COALESCE(value, ...)', snippet: 'COALESCE(${value}, ${fallback})' },
  { label: 'NULLIF', signature: 'NULLIF(value1, value2)', snippet: 'NULLIF(${value1}, ${value2})' },
  { label: 'CAST', signature: 'CAST(expression AS type)', snippet: 'CAST(${expression} AS ${type})' },
  { label: 'LOWER', signature: 'LOWER(text)', snippet: 'LOWER(${text})' },
  { label: 'UPPER', signature: 'UPPER(text)', snippet: 'UPPER(${text})' },
  { label: 'LENGTH', signature: 'LENGTH(text)', snippet: 'LENGTH(${text})' },
  { label: 'SUBSTRING', signature: 'SUBSTRING(text, start, length)', snippet: 'SUBSTRING(${text}, ${start}, ${length})' },
  { label: 'TRIM', signature: 'TRIM(text)', snippet: 'TRIM(${text})' },
  { label: 'ROUND', signature: 'ROUND(number, digits)', snippet: 'ROUND(${number}, ${digits})' },
  { label: 'ABS', signature: 'ABS(number)', snippet: 'ABS(${number})' }
]

const functionsByDialect: Record<DbType, FunctionSpec[]> = {
  mysql: [
    { label: 'CONCAT', signature: 'CONCAT(value, ...)', snippet: 'CONCAT(${value1}, ${value2})' },
    { label: 'CONCAT_WS', signature: 'CONCAT_WS(separator, value, ...)', snippet: 'CONCAT_WS(${separator}, ${value1}, ${value2})' },
    { label: 'GROUP_CONCAT', signature: 'GROUP_CONCAT(expression)', snippet: 'GROUP_CONCAT(${expression})' },
    { label: 'IFNULL', signature: 'IFNULL(value, fallback)', snippet: 'IFNULL(${value}, ${fallback})' },
    { label: 'DATE_FORMAT', signature: 'DATE_FORMAT(date, format)', snippet: 'DATE_FORMAT(${date}, ${format})' },
    { label: 'STR_TO_DATE', signature: 'STR_TO_DATE(text, format)', snippet: 'STR_TO_DATE(${text}, ${format})' },
    { label: 'NOW', signature: 'NOW()', snippet: 'NOW()' },
    { label: 'CURDATE', signature: 'CURDATE()', snippet: 'CURDATE()' },
    { label: 'DATEDIFF', signature: 'DATEDIFF(date1, date2)', snippet: 'DATEDIFF(${date1}, ${date2})' },
    { label: 'DATE_ADD', signature: 'DATE_ADD(date, INTERVAL value unit)', snippet: 'DATE_ADD(${date}, INTERVAL ${value} ${unit})' },
    { label: 'DATE_SUB', signature: 'DATE_SUB(date, INTERVAL value unit)', snippet: 'DATE_SUB(${date}, INTERVAL ${value} ${unit})' },
    { label: 'UNIX_TIMESTAMP', signature: 'UNIX_TIMESTAMP(date)', snippet: 'UNIX_TIMESTAMP(${date})' },
    { label: 'FROM_UNIXTIME', signature: 'FROM_UNIXTIME(timestamp)', snippet: 'FROM_UNIXTIME(${timestamp})' },
    { label: 'JSON_EXTRACT', signature: 'JSON_EXTRACT(json, path)', snippet: 'JSON_EXTRACT(${json}, ${path})' },
    { label: 'JSON_UNQUOTE', signature: 'JSON_UNQUOTE(json)', snippet: 'JSON_UNQUOTE(${json})' },
    { label: 'JSON_OBJECT', signature: 'JSON_OBJECT(key, value, ...)', snippet: 'JSON_OBJECT(${key}, ${value})' },
    { label: 'FIND_IN_SET', signature: 'FIND_IN_SET(value, list)', snippet: 'FIND_IN_SET(${value}, ${list})' }
  ],
  postgres: [
    { label: 'STRING_AGG', signature: 'STRING_AGG(value, delimiter)', snippet: 'STRING_AGG(${value}, ${delimiter})' },
    { label: 'ARRAY_AGG', signature: 'ARRAY_AGG(expression)', snippet: 'ARRAY_AGG(${expression})' },
    { label: 'JSON_AGG', signature: 'JSON_AGG(expression)', snippet: 'JSON_AGG(${expression})' },
    { label: 'JSONB_AGG', signature: 'JSONB_AGG(expression)', snippet: 'JSONB_AGG(${expression})' },
    { label: 'JSON_BUILD_OBJECT', signature: 'JSON_BUILD_OBJECT(key, value, ...)', snippet: 'JSON_BUILD_OBJECT(${key}, ${value})' },
    { label: 'TO_CHAR', signature: 'TO_CHAR(value, format)', snippet: 'TO_CHAR(${value}, ${format})' },
    { label: 'TO_DATE', signature: 'TO_DATE(text, format)', snippet: 'TO_DATE(${text}, ${format})' },
    { label: 'NOW', signature: 'NOW()', snippet: 'NOW()' },
    { label: 'DATE_TRUNC', signature: 'DATE_TRUNC(field, source)', snippet: 'DATE_TRUNC(${field}, ${source})' },
    { label: 'AGE', signature: 'AGE(timestamp)', snippet: 'AGE(${timestamp})' },
    { label: 'GENERATE_SERIES', signature: 'GENERATE_SERIES(start, stop, step)', snippet: 'GENERATE_SERIES(${start}, ${stop}, ${step})' },
    { label: 'UNNEST', signature: 'UNNEST(array)', snippet: 'UNNEST(${array})' },
    { label: 'REGEXP_REPLACE', signature: 'REGEXP_REPLACE(text, pattern, replacement)', snippet: 'REGEXP_REPLACE(${text}, ${pattern}, ${replacement})' },
    { label: 'SPLIT_PART', signature: 'SPLIT_PART(text, delimiter, field)', snippet: 'SPLIT_PART(${text}, ${delimiter}, ${field})' },
    { label: 'PG_TYPEOF', signature: 'PG_TYPEOF(value)', snippet: 'PG_TYPEOF(${value})' }
  ],
  sqlite: [
    { label: 'GROUP_CONCAT', signature: 'GROUP_CONCAT(expression, separator)', snippet: 'GROUP_CONCAT(${expression}, ${separator})' },
    { label: 'TOTAL', signature: 'TOTAL(expression)', snippet: 'TOTAL(${expression})' },
    { label: 'IFNULL', signature: 'IFNULL(value, fallback)', snippet: 'IFNULL(${value}, ${fallback})' },
    { label: 'IIF', signature: 'IIF(condition, trueValue, falseValue)', snippet: 'IIF(${condition}, ${trueValue}, ${falseValue})' },
    { label: 'PRINTF', signature: 'PRINTF(format, ...)', snippet: 'PRINTF(${format}, ${value})' },
    { label: 'INSTR', signature: 'INSTR(text, substring)', snippet: 'INSTR(${text}, ${substring})' },
    { label: 'REPLACE', signature: 'REPLACE(text, search, replacement)', snippet: 'REPLACE(${text}, ${search}, ${replacement})' },
    { label: 'SUBSTR', signature: 'SUBSTR(text, start, length)', snippet: 'SUBSTR(${text}, ${start}, ${length})' },
    { label: 'RANDOM', signature: 'RANDOM()', snippet: 'RANDOM()' },
    { label: 'DATE', signature: 'DATE(value, modifier, ...)', snippet: 'DATE(${value})' },
    { label: 'TIME', signature: 'TIME(value, modifier, ...)', snippet: 'TIME(${value})' },
    { label: 'DATETIME', signature: 'DATETIME(value, modifier, ...)', snippet: 'DATETIME(${value})' },
    { label: 'JULIANDAY', signature: 'JULIANDAY(value)', snippet: 'JULIANDAY(${value})' },
    { label: 'STRFTIME', signature: 'STRFTIME(format, value)', snippet: 'STRFTIME(${format}, ${value})' },
    { label: 'JSON_EXTRACT', signature: 'JSON_EXTRACT(json, path)', snippet: 'JSON_EXTRACT(${json}, ${path})' },
    { label: 'JSON_OBJECT', signature: 'JSON_OBJECT(key, value, ...)', snippet: 'JSON_OBJECT(${key}, ${value})' },
    { label: 'TYPEOF', signature: 'TYPEOF(value)', snippet: 'TYPEOF(${value})' }
  ],
  sqlserver: [
    { label: 'ISNULL', signature: 'ISNULL(value, replacement)', snippet: 'ISNULL(${value}, ${replacement})' },
    { label: 'GETDATE', signature: 'GETDATE()', snippet: 'GETDATE()' },
    { label: 'DATEADD', signature: 'DATEADD(datepart, number, date)', snippet: 'DATEADD(${datepart}, ${number}, ${date})' },
    { label: 'DATEDIFF', signature: 'DATEDIFF(datepart, start, end)', snippet: 'DATEDIFF(${datepart}, ${start}, ${end})' },
    { label: 'STRING_AGG', signature: 'STRING_AGG(value, separator)', snippet: 'STRING_AGG(${value}, ${separator})' },
    { label: 'JSON_VALUE', signature: 'JSON_VALUE(expression, path)', snippet: 'JSON_VALUE(${expression}, ${path})' }
  ],
  mongodb: [],
  redis: [],
  qdrant: []
}

function dialectFor(type?: DbType): SQLDialect {
  if (type === 'mysql') return MySQL
  if (type === 'postgres') return PostgreSQL
  if (type === 'sqlite') return SQLite
  if (type === 'sqlserver') return MSSQL
  return StandardSQL
}

function columnCompletion(column: SqlCompletionColumn): Completion {
  const detail = [column.dataType, column.isPrimaryKey ? 'PK' : ''].filter(Boolean).join(' · ')
  return {
    label: column.name,
    type: 'property',
    detail,
    info: column.comment
  }
}

function tableNamespace(table: SqlCompletionTable): SQLNamespace {
  return {
    self: {
      label: table.name,
      type: table.type === 'view' ? 'interface' : 'class',
      detail: table.type,
      info: table.comment,
      boost: 2
    },
    children: table.columns.map(columnCompletion)
  }
}

function databaseNamespace(name: string, children: Record<string, SQLNamespace>): SQLNamespace {
  return {
    self: { label: name, type: 'namespace', detail: 'database' },
    children
  }
}

function schemaNamespace(name: string, children: Record<string, SQLNamespace>): SQLNamespace {
  return {
    self: { label: name, type: 'namespace', detail: 'schema' },
    children
  }
}

function buildSchema(catalog: SqlCompletionCatalog): Pick<SQLConfig, 'schema' | 'defaultSchema'> {
  const root: Record<string, SQLNamespace> = Object.create(null)

  if (catalog.dbType === 'postgres' || catalog.dbType === 'sqlserver') {
    const schemas = new Map<string, Record<string, SQLNamespace>>()
    for (const table of catalog.tables) {
      const schemaName = table.schema ?? (catalog.dbType === 'sqlserver' ? 'dbo' : 'public')
      const tables = schemas.get(schemaName) ?? Object.create(null) as Record<string, SQLNamespace>
      tables[table.name] = tableNamespace(table)
      schemas.set(schemaName, tables)
    }
    for (const [name, tables] of schemas) root[name] = schemaNamespace(name, tables)
    return { schema: root, defaultSchema: catalog.defaultSchema ?? (catalog.dbType === 'sqlserver' ? 'dbo' : 'public') }
  }

  const databases = new Map<string, Record<string, SQLNamespace>>()
  for (const name of catalog.databases ?? []) databases.set(name, Object.create(null) as Record<string, SQLNamespace>)
  for (const table of catalog.tables) {
    const database = table.database ?? catalog.database
    if (!database) {
      root[table.name] = tableNamespace(table)
      continue
    }
    const tables = databases.get(database) ?? Object.create(null) as Record<string, SQLNamespace>
    tables[table.name] = tableNamespace(table)
    databases.set(database, tables)
  }
  for (const [name, tables] of databases) root[name] = databaseNamespace(name, tables)
  return { schema: root, defaultSchema: catalog.database }
}

function identifierParts(value: string): string[] {
  return value
    .match(/`[^`]+`|"[^"]+"|\[[^\]]+\]|[A-Za-z_][\w$]*/g)
    ?.map((part) => part.replace(/^([`"\[])(.*)[`"\]]$/, '$2')) ?? []
}

function statementAt(doc: string, position: number): string {
  const start = doc.lastIndexOf(';', Math.max(0, position - 1)) + 1
  const nextEnd = doc.indexOf(';', position)
  return doc.slice(start, nextEnd === -1 ? doc.length : nextEnd)
}

interface RelationReference {
  table: SqlCompletionTable
  alias?: string
}

const aliasStopWords = new Set([
  'where', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'on', 'group', 'order',
  'having', 'limit', 'offset', 'union', 'set', 'values', 'returning'
])

function relationReferences(doc: string, position: number, catalog: SqlCompletionCatalog): RelationReference[] {
  const statement = statementAt(doc, position)
  const identifier = '(?:`[^`]+`|"[^"]+"|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)'
  const relation = new RegExp(`\\b(?:from|join|update|into)\\s+(${identifier}(?:\\s*\\.\\s*${identifier}){0,2})(?:\\s+(?:as\\s+)?(${identifier}))?`, 'gi')
  const result = new Map<string, RelationReference>()

  for (const match of statement.matchAll(relation)) {
    const parts = identifierParts(match[1])
    const tableName = parts.at(-1)?.toLowerCase()
    const qualifier = parts.at(-2)?.toLowerCase()
    const rawAlias = match[2] ? identifierParts(match[2])[0] : undefined
    const alias = rawAlias && !aliasStopWords.has(rawAlias.toLowerCase()) ? rawAlias : undefined
    if (!tableName) continue
    for (const table of catalog.tables) {
      if (table.name.toLowerCase() !== tableName) continue
      if (qualifier && table.schema?.toLowerCase() !== qualifier && table.database?.toLowerCase() !== qualifier) continue
      result.set(`${table.database ?? ''}.${table.schema ?? ''}.${table.name}`, { table, alias })
    }
  }
  return [...result.values()]
}

async function columnsForTable(catalog: SqlCompletionCatalog, table: SqlCompletionTable): Promise<SqlCompletionColumn[]> {
  if (table.columns.length) return table.columns
  return catalog.loadColumns ? catalog.loadColumns(table) : []
}

async function contextualColumnCompletions(context: CompletionContext, catalog: SqlCompletionCatalog): Promise<Completion[]> {
  const found = new Map<string, { column: SqlCompletionColumn; tables: string[] }>()
  const references = relationReferences(context.state.doc.toString(), context.pos, catalog)
  const columns = await Promise.all(references.map(({ table }) => columnsForTable(catalog, table)))
  for (let index = 0; index < references.length; index++) {
    const table = references[index].table
    for (const column of columns[index]) {
      const key = column.name.toLowerCase()
      const existing = found.get(key)
      if (existing) existing.tables.push(table.name)
      else found.set(key, { column, tables: [table.name] })
    }
  }
  return [...found.values()].map(({ column, tables }) => ({
    ...columnCompletion(column),
    detail: `${[...new Set(tables)].join(', ')} · ${column.dataType}`,
    boost: 1
  }))
}

function parentPath(context: CompletionContext, from: number): string[] {
  const before = context.state.sliceDoc(0, from)
  const identifier = '(?:`[^`]+`|"[^"]+"|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)'
  const match = before.match(new RegExp(`(${identifier}(?:\\s*\\.\\s*${identifier})*)\\s*\\.\\s*$`))
  return match ? identifierParts(match[1]) : []
}

function tableForPath(context: CompletionContext, catalog: SqlCompletionCatalog, parents: string[]): SqlCompletionTable | undefined {
  const last = parents.at(-1)?.toLowerCase()
  if (!last) return undefined
  const references = relationReferences(context.state.doc.toString(), context.pos, catalog)
  if (parents.length === 1) {
    const aliased = references.find(({ alias }) => alias?.toLowerCase() === last)
    if (aliased) return aliased.table
  }
  const qualifier = parents.at(-2)?.toLowerCase()
  return catalog.tables.find((table) => {
    if (table.name.toLowerCase() !== last) return false
    if (qualifier && table.schema?.toLowerCase() !== qualifier && table.database?.toLowerCase() !== qualifier) return false
    if (!qualifier && catalog.database && table.database && table.database !== catalog.database) return false
    return true
  })
}

function isRelationPosition(context: CompletionContext, from: number): boolean {
  const before = statementAt(context.state.sliceDoc(0, from), from)
  return /\b(?:from|join|update|into)\s*$/i.test(before)
}

function functionCompletions(type?: DbType): Completion[] {
  const dialectFunctions = type ? functionsByDialect[type] : []
  const unique = new Map<string, FunctionSpec>()
  for (const item of [...commonFunctions, ...dialectFunctions]) unique.set(item.label, item)
  return [...unique.values()].map((item) => snippetCompletion(item.snippet, {
    label: item.label,
    type: 'function',
    detail: item.signature,
    boost: 1
  }))
}

function supplementalCompletionSource(catalog: SqlCompletionCatalog): CompletionSource {
  const functions = functionCompletions(catalog.dbType)
  const source: CompletionSource = async (context) => {
    const word = context.matchBefore(/[A-Za-z_][\w$]*$/)
    const from = word?.from ?? context.pos
    const parents = parentPath(context, from)
    if (!word && !context.explicit && !parents.length) return null
    if (parents.length) {
      const table = tableForPath(context, catalog, parents)
      if (!table) return null
      return {
        from,
        options: (await columnsForTable(catalog, table)).map(columnCompletion),
        validFor: /^[\w$]*$/
      }
    }
    const columns = await contextualColumnCompletions(context, catalog)
    return {
      from,
      options: [...columns, ...(isRelationPosition(context, from) ? [] : functions)],
      validFor: /^[\w$]*$/
    }
  }
  return ifNotIn(['QuotedIdentifier', 'String', 'LineComment', 'BlockComment'], source)
}

const redisMultiKeyCommands = new Set([
  'DEL', 'EXISTS', 'MGET', 'PFCOUNT', 'SDIFF', 'SINTER', 'SUNION', 'TOUCH', 'UNLINK'
])
const redisTwoKeyCommands = new Set(['COPY', 'LMOVE', 'RENAME', 'RENAMENX', 'RPOPLPUSH', 'SMOVE'])
const redisNoKeyCommands = new Set(['DBSIZE', 'ECHO', 'INFO', 'KEYS', 'PING', 'RANDOMKEY', 'SCAN', 'TIME'])

function redisArguments(value: string): string[] {
  const result: string[] = []
  let current = ''
  let quote = ''
  let escaped = false
  let started = false
  for (const character of value) {
    if (escaped) {
      current += character
      escaped = false
      started = true
    } else if (character === '\\') {
      escaped = true
      started = true
    } else if (quote) {
      if (character === quote) quote = ''
      else current += character
      started = true
    } else if (character === '"' || character === "'") {
      quote = character
      started = true
    } else if (/\s/.test(character)) {
      if (started) {
        result.push(current)
        current = ''
        started = false
      }
    } else {
      current += character
      started = true
    }
  }
  if (started) result.push(current)
  return result
}

function redisKeyPosition(command: string, argumentIndex: number): boolean {
  if (redisNoKeyCommands.has(command)) return false
  if (redisMultiKeyCommands.has(command)) return argumentIndex >= 1
  if (redisTwoKeyCommands.has(command)) return argumentIndex === 1 || argumentIndex === 2
  if (command === 'MSET' || command === 'MSETNX') return argumentIndex >= 1 && argumentIndex % 2 === 1
  if (command === 'XINFO') return argumentIndex === 2
  return argumentIndex === 1
}

function redisKeyApply(key: string): string {
  return /\s|["'\\]/.test(key) ? JSON.stringify(key) : key
}

function redisCompletionSource(catalog: SqlCompletionCatalog): CompletionSource {
  const commands = redisCommands.map((command) => snippetCompletion(command.snippet, {
    label: command.label,
    type: 'keyword',
    detail: command.syntax,
    info: command.description
  }))
  const keys = catalog.tables.map((table): Completion => ({
    label: table.name,
    apply: redisKeyApply(table.name),
    type: 'property',
    detail: table.comment ?? 'Redis key',
    boost: 1
  }))

  return (context) => {
    const line = context.state.doc.lineAt(context.pos)
    const before = line.text.slice(0, context.pos - line.from)
    if (/^\s*#/.test(before)) return null
    const commandMatch = before.match(/^\s*([^\s]*)/)
    const commandText = commandMatch?.[1] ?? ''
    const commandFrom = line.from + (commandMatch?.[0].length ?? 0) - commandText.length
    const afterCommand = before.slice(commandMatch?.[0].length ?? 0)

    if (!commandText || !afterCommand) {
      if (!context.explicit && !commandText) return null
      return { from: commandFrom, options: commands, validFor: /^[A-Za-z]*$/ }
    }

    const word = context.matchBefore(/[^\s"']*$/)
    if (!word || (!context.explicit && !word.text)) return null
    const argumentsBeforeCursor = redisArguments(afterCommand)
    const argumentIndex = /\s$/.test(afterCommand) ? argumentsBeforeCursor.length + 1 : argumentsBeforeCursor.length
    if (!redisKeyPosition(commandText.toUpperCase(), argumentIndex)) return null
    return { from: word.from, options: keys, validFor: /^[^\s"']*$/ }
  }
}

export function sqlCompletionExtension(catalog: SqlCompletionCatalog): Extension {
  if (catalog.dbType === 'mongodb' || catalog.dbType === 'qdrant') return []
  if (catalog.dbType === 'redis') return autocompletion({ override: [redisCompletionSource(catalog)] })
  const dialect = dialectFor(catalog.dbType)
  const schema = buildSchema(catalog)
  return [
    sql({
      dialect,
      ...schema,
      keywordCompletion: (label, type) => ({
        label,
        type,
        detail: type === 'type' ? 'type' : type === 'keyword' ? 'keyword' : 'builtin',
        boost: type === 'keyword' ? -1 : 0
      })
    }),
    dialect.language.data.of({ autocomplete: supplementalCompletionSource(catalog) })
  ]
}
