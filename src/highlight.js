/**
 * 极简语法高亮。
 *
 * 只做**有把握**的那几类：注释、字符串、数字、关键字。不做"大概齐"的正则
 * 猜测——把代码高亮错比不高亮难看得多。语言不认识就返回纯色文本行。
 * pi-tui 只要配置了 highlightCode 就会直接遍历返回值，不接受 undefined。
 *
 * 接在 MarkdownTheme.highlightCode 上，见 theme.js。
 */

/** 行注释起始符。 */
const LINE_COMMENT = {
  js: '//',
  ts: '//',
  jsx: '//',
  tsx: '//',
  json: undefined,
  java: '//',
  c: '//',
  cpp: '//',
  h: '//',
  go: '//',
  rust: '//',
  sql: '--',
  sh: '#',
  bash: '#',
  zsh: '#',
  py: '#',
  python: '#',
  rb: '#',
  ruby: '#',
  yaml: '#',
  yml: '#',
  toml: '#',
  ini: '#',
  make: '#',
}

/** 块注释定界符。 */
const BLOCK_COMMENT = {
  js: ['/*', '*/'],
  ts: ['/*', '*/'],
  jsx: ['/*', '*/'],
  tsx: ['/*', '*/'],
  java: ['/*', '*/'],
  c: ['/*', '*/'],
  cpp: ['/*', '*/'],
  h: ['/*', '*/'],
  go: ['/*', '*/'],
  rust: ['/*', '*/'],
  css: ['/*', '*/'],
  sql: ['/*', '*/'],
  py: ['"""', '"""'],
  python: ['"""', '"""'],
}

/** 各语言族的关键字。 */
const KEYWORDS = {
  js: 'const let var function return if else for while do switch case break continue class extends new this super import export from default async await try catch finally throw typeof instanceof null undefined true false of in delete void yield static get set'.split(' '),
  py: 'def class return if elif else for while break continue import from as try except finally raise with lambda yield global nonlocal pass None True False and or not is in assert del async await'.split(' '),
  rust: 'fn let mut const static struct enum impl trait pub use mod crate self super return if else match loop while for in break continue where async await move ref dyn box unsafe as type'.split(' '),
  go: 'func var const type struct interface map chan package import return if else for range switch case break continue go defer select nil true false make new'.split(' '),
  sh: 'if then else elif fi for while do done case esac function return export local readonly declare source echo exit set unset trap'.split(' '),
  sql: 'select from where insert into values update set delete create table drop alter add index join left right inner outer on group by order having limit offset union all as and or not null distinct count sum avg min max'.split(' '),
  other: 'if else for while return break continue class function const let var new import export try catch throw true false null'.split(' '),
}

/** 语言标识 → 关键字族。 */
function keywordFamily(lang) {
  if (['js', 'ts', 'jsx', 'tsx', 'json'].includes(lang)) return 'js'
  if (['py', 'python'].includes(lang)) return 'py'
  if (['rs', 'rust'].includes(lang)) return 'rust'
  if (['go', 'golang'].includes(lang)) return 'go'
  if (['sh', 'bash', 'zsh', 'shell', 'console'].includes(lang)) return 'sh'
  if (['sql'].includes(lang)) return 'sql'
  if (['c', 'cpp', 'h', 'hpp', 'java', 'cs', 'kt', 'swift', 'php', 'rb', 'ruby'].includes(lang)) return 'other'
  return undefined
}

/**
 * 高亮一段代码。
 *
 * @param {(text:string)=>string} code - codeBlock 用的配色函数
 * @param {(text:string)=>string} comment
 * @param {(text:string)=>string} string_
 * @param {(text:string)=>string} number
 * @param {(text:string)=>string} keyword
 * @returns {(codeText:string, lang?:string)=>string[]}
 */
export function createHighlighter({ code, comment, string: stringFn, number, keyword }) {
  return function highlight(codeText, lang) {
    const normalized = String(lang ?? '').toLowerCase()
    const family = keywordFamily(normalized)
    // 包括流式过程中尚未输入语言名的围栏，都必须满足 string[] 契约。
    if (family === undefined) return String(codeText ?? '').split('\n').map(line => code(line))

    const keywords = new Set(KEYWORDS[family])
    const lineComment = LINE_COMMENT[normalized]
    const block = BLOCK_COMMENT[normalized]
    const lines = String(codeText ?? '').split('\n')
    const out = []
    let inBlock = false

    for (const line of lines) {
      let rest = line
      let painted = ''

      while (rest !== '') {
        if (inBlock) {
          const end = rest.indexOf(block[1])
          if (end === -1) {
            painted += comment(rest)
            rest = ''
          } else {
            painted += comment(rest.slice(0, end + block[1].length))
            rest = rest.slice(end + block[1].length)
            inBlock = false
          }
          continue
        }

        if (block !== undefined) {
          const start = rest.indexOf(block[0])
          if (start === 0) {
            inBlock = true
            continue
          }
        }

        if (lineComment !== undefined) {
          const at = rest.indexOf(lineComment)
          if (at === 0) {
            painted += comment(rest)
            rest = ''
            continue
          }
          if (at > 0) {
            painted += paintTokens(rest.slice(0, at), { keywords, code, stringFn, number, keyword })
            painted += comment(rest.slice(at))
            rest = ''
            continue
          }
        }

        painted += paintTokens(rest, { keywords, code, stringFn, number, keyword })
        rest = ''
      }

      out.push(painted)
    }

    return out
  }
}

/** 对一段不含注释的文本做词法着色。 */
function paintTokens(text, { keywords, code, stringFn, number, keyword }) {
  // 一次扫描，用捕获组区分：字符串 / 数字 / 标识符 / 其余。
  const pattern = /("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?)|(\b\d[\d_.]*\b)|([A-Za-z_$][A-Za-z0-9_$]*)|([\s\S])/g
  let out = ''
  let match
  while ((match = pattern.exec(text)) !== null) {
    if (match[1] !== undefined) out += stringFn(match[1])
    else if (match[2] !== undefined) out += number(match[2])
    else if (match[3] !== undefined) out += keywords.has(match[3]) ? keyword(match[3]) : code(match[3])
    else out += code(match[4])
  }
  return out
}
