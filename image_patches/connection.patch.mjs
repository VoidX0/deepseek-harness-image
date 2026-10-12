#!/usr/bin/env node
/**
 * connection.patch.mjs —— DSH connection/BrowserAuth 适配补丁（幂等）
 * 由 run.sh 在容器启动时执行。子补丁：
 *  A. src/rpc-host.ts requestRejection：无 X-Dsh-External 放行 + DSH_WEB_AUTH=off 全放行
 *  B. src/browser-auth.ts：node:fs/os/path imports、token 固定（env > 文件 > 内存）、authorizeIndex off 开关
 *  D. lib/index.js：编译产物同步 A
 *  E. lib/client.js：客户端 isLoopback 放宽（远程可读 settings）
 *
 * ── 2026-10 适配 DSH 0.2.x ──────────────────────────────────────────────
 * 上游 0.2.x 把 HostConnectionService.requestRejection 从
 *     requestRejection(request) {
 *       if (!isTrustedApiRequest(request, this.trustedHosts)) return 403
 *       return this.browserAuth.isAuthenticated(request) ? undefined : 401
 *     }
 * 改成了带 webServer carrier 的版本（isTrustedApiRequest/isAuthenticated 都多了参数），
 * 于是「整段函数体」的锚点必然失配，DSH_WEB_AUTH=off 没装上 → /api 全部 401
 * （含 /api/remote.mux 的 WebSocket upgrade）→ 页面能开、但一直 “connection lost”。
 *
 * 现在对这类「函数签名 + 插入若干行」的补丁统一改用 **签名正则锚点**：只要函数签名还在，
 * 函数体怎么重构都能命中；同时兼容 0.1.x（两版签名一致）。只有 B2/E 这两处整体替换
 * 仍需精确锚点（它们在 0.2.1 已验证仍能命中）。
 * ───────────────────────────────────────────────────────────────────────
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const SRC_RPC = '/app/packages/client/connection/src/rpc-host.ts'
const SRC_AUTH = '/app/packages/client/connection/src/browser-auth.ts'
const LIB_INDEX = '/app/packages/client/connection/lib/index.js'
const LIB_CLIENT = '/app/packages/client/connection/lib/client.js'

let patched = 0
let failed = 0

/**
 * 依次应用若干子补丁。每条规则二选一：
 *   - match + insert：正则锚点，插入新行（用 $1 保留签名行）；
 *   - oldStr + newStr：精确整段替换。
 * mark 为幂等标记：已存在则跳过。
 */
function patchFile(file, patches, label) {
  if (!existsSync(file)) { console.log(`[patch] 跳过(不存在): ${file}`); return }
  let t = readFileSync(file, 'utf8')
  let changed = false
  for (const { mark, name, match, insert, oldStr, newStr } of patches) {
    if (t.includes(mark)) { console.log(`[patch] 已打(幂等跳过): ${label} · ${name}`); continue }
    if (match !== undefined) {
      if (!match.test(t)) { console.log(`[patch] ⚠ 锚点未命中: ${label} · ${name}`); failed += 1; continue }
      t = t.replace(match, insert)
    } else {
      if (!t.includes(oldStr)) { console.log(`[patch] ⚠ 锚点未命中: ${label} · ${name}`); failed += 1; continue }
      t = t.replace(oldStr, newStr)
    }
    changed = true
    patched += 1
    console.log(`[patch] ✓ ${label} · ${name}`)
  }
  if (changed) writeFileSync(file, t)
}

// ── A. 源码：/api 的 Host 围栏 + 浏览器鉴权（tsx 直接跑 src，这是实际生效的一份）
patchFile(SRC_RPC, [{
  name: 'requestRejection 内部放行 + off 开关',
  mark: "DSH_WEB_AUTH === 'off'",
  // 锚点只认函数签名：0.1.x / 0.2.x 相同，函数体重构不影响
  match: /(requestRejection\(request: ConnectionTrustRequest\): ConnectionRequestRejection \{\r?\n)/,
  insert: "$1"
    + "    if (process.env.DSH_WEB_AUTH === 'off') return undefined\n"
    + "    if (request.headers['x-dsh-external'] === undefined) return undefined\n",
}], 'A')

// ── B. 源码：BrowserAuth
patchFile(SRC_AUTH, [
  {
    name: '补充 node:fs/os/path imports',
    mark: "from 'node:fs'",
    // 锚点只认 node:crypto 的 import 行，import 列表变化也能命中
    match: /(^import [^\n]*from 'node:crypto'\r?\n)/m,
    insert: "$1"
      + "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'\n"
      + "import { homedir } from 'node:os'\n"
      + "import { dirname, join } from 'node:path'\n",
  },
  {
    name: 'processLaunchToken 固定（env > 文件 > 内存）',
    mark: 'readFileSync(storePath',
    oldStr: `function processLaunchToken(owner: object): string {
  const existing = PROCESS_LAUNCH_TOKENS.get(owner)
  if (existing !== undefined) return existing
  const created = encodeBase64Url(randomBytes(SECRET_BYTES))
  PROCESS_LAUNCH_TOKENS.set(owner, created)
  return created
}`,
    newStr: `function processLaunchToken(owner: object): string {
  const env = process.env.DSH_LAUNCH_TOKEN
  if (env !== undefined && env !== '') return env
  const storePath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'auth', 'launch-token')
  try {
    const existing = readFileSync(storePath, 'utf8').trim()
    if (existing !== '') return existing
  } catch { /* not persisted yet */ }
  const existing = PROCESS_LAUNCH_TOKENS.get(owner)
  if (existing !== undefined) return existing
  const created = encodeBase64Url(randomBytes(SECRET_BYTES))
  PROCESS_LAUNCH_TOKENS.set(owner, created)
  try {
    mkdirSync(dirname(storePath), { recursive: true })
    writeFileSync(storePath, created, 'utf8')
  } catch { /* persistence is best-effort */ }
  return created
}`,
  },
  {
    name: 'authorizeIndex off 开关',
    mark: "DSH_WEB_AUTH === 'off'",
    // 兼容 0.1.x 与 0.2.x（后者多了 secure = false 参数）
    match: /(authorizeIndex\(req: ConnectionIndexRequest, res: ConnectionIndexResponse(?:, secure = false)?\): boolean \{\r?\n)/,
    insert: "$1    if (process.env.DSH_WEB_AUTH === 'off') return true\n",
  },
], 'B')

// ── D. 编译产物：与 A 同步（package.json main 指向 lib/index.js，保险起见）
patchFile(LIB_INDEX, [{
  name: 'lib requestRejection 同步',
  mark: 'DSH_WEB_AUTH === "off"',
  match: /(\t*requestRejection\(request\) \{\r?\n)/,
  insert: '$1'
    + '\t\tif (process.env.DSH_WEB_AUTH === "off") return void 0;\n'
    + '\t\tif (request.headers["x-dsh-external"] === void 0) return void 0;\n',
}], 'D')

// ── E. 浏览器产物：远程（非 loopback）访问也能读 settings
patchFile(LIB_CLIENT, [{
  name: 'lib client isLoopback 放宽（远程可读 settings）',
  mark: 'isLoopback: true',
  oldStr: `				isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),`,
  newStr: `				isLoopback: true,`,
}], 'E')

console.log(`[connection.patch] 完成：新打 ${patched} 处，未命中 ${failed} 处`)
if (failed > 0) process.exit(1)
