#!/usr/bin/env node
/**
 * connection.patch.mjs —— 新版 DSH connection/BrowserAuth 适配补丁（幂等）
 * 由 start.sh 或单独调用。四个子补丁：
 *  A. src/rpc-host.ts requestRejection：无 X-Dsh-External 放行 + DSH_WEB_AUTH=off 全放行
 *  B. src/browser-auth.ts：token 固定（env > 文件 > 内存）
 *  C. src/browser-auth.ts authorizeIndex：DSH_WEB_AUTH=off 放行 index
 *  D. lib/index.js（编译产物同步 A）
 *  E. lib/client.js：客户端 isLoopback 放宽（远程可读 settings）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const SRC_RPC = '/app/packages/client/connection/src/rpc-host.ts'
const SRC_AUTH = '/app/packages/client/connection/src/browser-auth.ts'
const LIB_INDEX = '/app/packages/client/connection/lib/index.js'
const LIB_CLIENT = '/app/packages/client/connection/lib/client.js'

let patched = 0
let failed = 0

function patchFile(file, patches, label) {
  if (!existsSync(file)) { console.log(`[patch] 跳过(不存在): ${file}`); return }
  let t = readFileSync(file, 'utf8')
  for (const { mark, oldStr, newStr, name } of patches) {
    if (t.includes(mark)) { console.log(`[patch] 已打(幂等跳过): ${label} · ${name}`); continue }
    if (!t.includes(oldStr)) { console.log(`[patch] ⚠ 锚点未命中: ${label} · ${name}`); failed += 1; continue }
    t = t.replace(oldStr, newStr)
    patched += 1
    console.log(`[patch] ✓ ${label} · ${name}`)
  }
  writeFileSync(file, t)
}

patchFile(SRC_RPC, [{
  name: 'requestRejection 内部放行 + off 开关',
  mark: 'x-dsh-external',
  oldStr: `  requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection {
    if (!isTrustedApiRequest(request, this.trustedHosts)) return 403
    return this.browserAuth.isAuthenticated(request) ? undefined : 401
  }`,
  newStr: `  requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection {
    if (process.env.DSH_WEB_AUTH === 'off') return undefined
    if (!isTrustedApiRequest(request, this.trustedHosts)) return 403
    if (request.headers['x-dsh-external'] === undefined) return undefined
    return this.browserAuth.isAuthenticated(request) ? undefined : 401
  }`,
}], 'A')

patchFile(SRC_AUTH, [
  {
    name: '补充 node:fs/os/path imports',
    mark: "from 'node:fs'",
    oldStr: `import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { credentialKey } from '@deepseek-ai/dsh-credentials'`,
    newStr: `import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { credentialKey } from '@deepseek-ai/dsh-credentials'`,
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
    oldStr: `    /* v8 ignore next -- node:http always supplies url on server requests. */
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')`,
    newStr: `    if (process.env.DSH_WEB_AUTH === 'off') return true
    /* v8 ignore next -- node:http always supplies url on server requests. */
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')`,
  },
], 'B')

patchFile(LIB_INDEX, [{
  name: 'lib requestRejection 同步',
  mark: 'x-dsh-external',
  oldStr: `	requestRejection(request) {
		if (!isTrustedApiRequest(request, this.trustedHosts)) return 403;
		return this.browserAuth.isAuthenticated(request) ? void 0 : 401;
	}`,
  newStr: `	requestRejection(request) {
		if (process.env.DSH_WEB_AUTH === "off") return void 0;
		if (!isTrustedApiRequest(request, this.trustedHosts)) return 403;
		if (request.headers["x-dsh-external"] === void 0) return void 0;
		return this.browserAuth.isAuthenticated(request) ? void 0 : 401;
	}`,
}], 'B')

patchFile(LIB_CLIENT, [{
  name: 'lib client isLoopback 放宽（远程可读 settings）',
  mark: 'isLoopback: true',
  oldStr: `				isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),`,
  newStr: `				isLoopback: true,`,
}], 'E')

console.log(`[connection.patch] 完成：新打 ${patched} 处，未命中 ${failed} 处`)
if (failed > 0) process.exit(1)
