import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { readProfileManifest, resolveProfileDir, writeProfileManifest } from '@deepseek-ai/dsh-app-boot'
import type { ProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { installSpec } from './registry.js'
import type { InstallResult, InstalledEntry, RegistryPlugin, UninstallResult } from './types.js'

const execFileAsync = promisify(execFile)
const NAME = 'dsh-plugin-registry'

interface LoaderEntry {
  id: string
  options?: { name?: string; config?: { path?: string } }
}

export interface LoaderContext {
  loader: {
    entries(): LoaderEntry[]
  }
}

/**
 * 把安装 spec / 依赖 version 归一化为可比形式：
 * `github:owner/repo`、`git+https://github.com/owner/repo(.git)` → `owner/repo`。
 * pnpm 在不同添加方式下会把同一仓库写成不同形态（github:… 或 git+https://…），
 * 精确字符串匹配会漏判已安装状态。
 */
export function normalizeSpec(value: string): string {
  let v = value.trim()
  v = v.replace(/^git\+/, '')
  if (v.startsWith('https://github.com/')) v = v.slice('https://github.com/'.length)
  if (v.startsWith('github:')) v = v.slice('github:'.length)
  v = v.replace(/\.git$/, '').replace(/\/+$/, '')
  return v.toLowerCase()
}

/**
 * 在 profile 依赖中查找 registry 条目对应的已安装依赖。
 * 匹配规则（均以 profile package.json 为唯一事实源，不依赖 loader/HMR）：
 * 1. npm 插件：依赖名 === 插件的 npm 字段；
 * 2. 裸 npm 包名：依赖名 === installSpec；
 * 3. git/github 插件：某依赖的 version 字段与 installSpec 归一化后相等
 *    （pnpm 可能写 `github:owner/repo`，也可能写 `git+https://github.com/owner/repo.git`）。
 */
export function matchInstalledDep(
  plugin: RegistryPlugin,
  deps: Record<string, string>,
): { name: string; spec: string } | null {
  if (plugin.npm && deps[plugin.npm] !== undefined) return { name: plugin.npm, spec: deps[plugin.npm] }
  const spec = installSpec(plugin)
  if (!spec) return null
  if (deps[spec] !== undefined) return { name: spec, spec: deps[spec] }
  const normalized = normalizeSpec(spec)
  for (const [name, version] of Object.entries(deps)) {
    if (version === spec || (normalized && normalizeSpec(version) === normalized)) return { name, spec: version }
  }
  return null
}

/**
 * pnpm add 之后，从依赖 diff 中确定真实包名：github/git spec 会出现在新依赖
 * 的 version 字段；npm 插件则直接按 npm 字段/包名命中。
 */
export function findAddedDependency(
  before: Record<string, string>,
  after: Record<string, string>,
  spec: string,
  plugin: RegistryPlugin,
): string | null {
  const changed = Object.entries(after).filter(([name, version]) => before[name] === undefined || before[name] !== version)
  const normalized = normalizeSpec(spec)
  for (const [name, version] of changed) {
    if (version === spec || (normalized.includes('/') && normalizeSpec(version) === normalized)) return name
  }
  if (plugin.npm && after[plugin.npm] !== undefined) return plugin.npm
  if (after[spec] !== undefined) return spec
  for (const [name] of changed) return name
  return null
}

/**
 * Profile 操作：目录发现、manifest 读写（官方 dsh-app-boot）、pnpm 执行、
 * dsh.profile.bundles 对账（镜像 `dsh plugin add/remove`）、已装状态判定。
 */
export class ProfileStore {
  private dirCache: string | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private ctx: LoaderContext) {}

  /** 发现当前运行 profile 的目录：优先取 loader 中 cordis:include 指向的 cordis.yml 所在目录。 */
  dir(): string {
    if (this.dirCache) return this.dirCache
    for (const entry of this.ctx.loader.entries()) {
      const cfg = entry.options?.config
      if (entry.options?.name !== 'cordis:include' || cfg == null || typeof cfg.path !== 'string') continue
      if (!cfg.path.includes('cordis.yml')) continue
      const configPath = fileURLToPath(new URL(cfg.path))
      this.dirCache = dirname(configPath)
      return this.dirCache
    }
    this.dirCache = resolveProfileDir('web')
    return this.dirCache
  }

  // 读取当前 profile 的持久化清单（官方 dsh-app-boot 封装）。
  manifest(): ProfileManifest {
    return readProfileManifest(NAME, this.dir())
  }

  // 快捷读取 package.json 的 dependencies 字段。
  dependencies(): Record<string, string> {
    return this.manifest().dependencies ?? {}
  }

  // 快捷读取插件层（dsh.profile.bundles）条目。
  bundles(): string[] {
    return this.manifest().dsh?.profile?.bundles ?? []
  }

  /** registry 中所有已安装条目（URL 身份）。 */
  installedEntries(plugins: RegistryPlugin[]): InstalledEntry[] {
    const manifest = readProfileManifest(NAME, this.dir())
    const deps = manifest.dependencies ?? {}
    const bundles = new Set(manifest.dsh?.profile?.bundles ?? [])
    const entries: InstalledEntry[] = []
    for (const p of plugins) {
      const dep = matchInstalledDep(p, deps)
      // 只认持久化状态（deps / bundles），不依赖 loader：保证「已安装」徽标与
      // 卸载行为完全一致（loader 里存在但未持久化的条目不该显示为已安装）。
      const inBundles = [p.npm, p.name, installSpec(p)]
        .filter((n): n is string => typeof n === 'string' && n.length > 0)
        .some((n) => bundles.has(n))
      if (!dep && !inBundles) continue
      const packageName = dep?.name ?? p.npm ?? p.name
      entries.push({ url: p.url, name: p.name, packageName, bundled: dep ? bundles.has(dep.name) : inBundles })
    }
    return entries
  }

  install(plugin: RegistryPlugin): Promise<InstallResult> {
    return this.exclusive(async () => {
      const dir = this.dir()
      const spec = installSpec(plugin)
      const before = readProfileManifest(NAME, dir)
      const beforeDeps = new Set(Object.keys(before.dependencies ?? {}))
      const existing = matchInstalledDep(plugin, before.dependencies ?? {})

      if (existing) {
        return {
          ok: true,
          alreadyInstalled: true,
          url: plugin.url,
          name: plugin.name,
          packageName: existing.name,
          bundled: this.bundles().includes(existing.name),
          profileDir: dir,
          message: `插件 ${existing.name} 已安装，无需重复安装。`,
        }
      }

      await this.pnpm(['add', spec])

      const after = readProfileManifest(NAME, dir)
      const packageName = findAddedDependency(before.dependencies ?? {}, after.dependencies ?? {}, spec, plugin) ?? spec
      this.reconcileBundles(beforeDeps)
      const bundled = this.isBundle(packageName)
      const note = bundled ? '' : '（该包未声明 dsh.bundle，仅作为普通依赖安装，未加入插件层）'

      return {
        ok: true,
        alreadyInstalled: false,
        url: plugin.url,
        name: plugin.name,
        packageName,
        bundled,
        profileDir: dir,
        message: `已安装 ${packageName}，已加入 profile 插件层，HMR 热加载生效（无需重启）。${note}`,
      }
    })
  }

  uninstall(plugin: RegistryPlugin): Promise<UninstallResult> {
    return this.exclusive(async () => {
      const dir = this.dir()
      const before = readProfileManifest(NAME, dir)
      const beforeDeps = new Set(Object.keys(before.dependencies ?? {}))
      const dep = matchInstalledDep(plugin, before.dependencies ?? {})

      if (!dep) {
        // 不在依赖中：可能是仅存在于插件层的陈旧条目，尝试按候选名清理。
        const candidates = [plugin.npm, plugin.name, installSpec(plugin)].filter(
          (n): n is string => typeof n === 'string' && n.length > 0,
        )
        const hit = candidates.find((n) => this.bundles().includes(n))
        if (hit) {
          this.removeFromBundles(hit)
          return {
            ok: true,
            url: plugin.url,
            name: plugin.name,
            packageName: hit,
            profileDir: dir,
            message: `已卸载 ${hit}：profile 依赖中未找到它，已从插件层移除该条目，请手动清理残留依赖。`,
          }
        }
        return {
          ok: false,
          url: plugin.url,
          name: plugin.name,
          packageName: plugin.npm ?? plugin.name,
          profileDir: dir,
          message: `未在 profile 中找到 ${plugin.name} 的已安装依赖，也未见其插件层条目，当前无需卸载。`,
        }
      }

      await this.pnpm(['remove', dep.name])
      this.reconcileBundles(beforeDeps)

      return {
        ok: true,
        url: plugin.url,
        name: plugin.name,
        packageName: dep.name,
        profileDir: dir,
        message: `已卸载 ${dep.name}，已从 profile 插件层移除，HMR 热加载生效（无需重启）。`,
      }
    })
  }

  /** 串行化 pnpm 操作，避免同一 profile 并发安装/卸载竞争。 */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** corepack pnpm 执行（Windows 走 corepack.js，.cmd shim 无法 execFile）。 */
  private async pnpm(args: string[]): Promise<void> {
    const opts = {
      cwd: this.dir(),
      timeout: 240000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      // 关闭 stdin：非交互环境下 pnpm 若试图读 stdin 会永久阻塞（表现为「安装中… 超时」）
      stdio: ['ignore', 'pipe', 'pipe'] as const,
      env: { ...process.env },
    }
    try {
      if (process.platform === 'win32') {
        // Desktop Electron binaries need not share a directory with Node/Corepack.
        // Locate the actual JS entry and pass argv directly: cmd.exe otherwise
        // preserves JSON quotes as literal characters (for example, "add").
        const roots = [dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter)].filter(Boolean)
        const corepackJs = roots
          .map((root) => join(root, 'node_modules', 'corepack', 'dist', 'corepack.js'))
          .find((file) => existsSync(file))
        if (!corepackJs) throw new Error('Corepack JS entry not found beside the runtime or on PATH; install Corepack with Node.js.')
        await execFileAsync(process.execPath, [corepackJs, 'pnpm', ...args], {
          ...opts,
          env: { ...opts.env, ELECTRON_RUN_AS_NODE: '1' },
        })
        return
      }
      await execFileAsync('corepack', ['pnpm', ...args], opts)
    } catch (error) {
      const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; signal?: string }
      const detail = [e.stdout, e.stderr].filter((s) => typeof s === 'string' && s.trim()).join('\n').trim()
      const command = `pnpm ${args.join(' ')}`
      if (e.killed || e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT') {
        throw new Error(`${command} 执行超时（超过 240 秒）。${detail ? `pnpm 输出：\n${detail}` : '未捕获到 pnpm 输出。'}`)
      }
      throw new Error(`${command} 执行失败：${e.message}${detail ? `\npnpm 输出：\n${detail}` : ''}`)
    }
  }

  // 按包名在 profile 的 node_modules 中解析出包目录；找不到返回 null。
  private resolvePackageDir(packageName: string): string | null {
    let req: ReturnType<typeof createRequire>
    try {
      req = createRequire(join(this.dir(), 'package.json'))
    } catch {
      return null
    }
    const searchPaths = req.resolve.paths(packageName)
    if (searchPaths == null) return null
    for (const searchPath of searchPaths) {
      const candidate = join(searchPath, packageName)
      if (existsSync(join(candidate, 'package.json'))) return candidate
    }
    return null
  }

  /** 包是否声明 dsh.bundle（即会作为 profile 插件层加载）。 */
  isBundle(packageName: string): boolean {
    const dir = this.resolvePackageDir(packageName)
    if (!dir) return false
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dsh?: { bundle?: { patch?: unknown } } }
      return pkg.dsh?.bundle?.patch !== undefined
    } catch {
      return false
    }
  }

  /**
   * 镜像官方 `dsh plugin` 的对账逻辑：依赖中声明 dsh.bundle 的包加入插件层；
   * 已移除/不再是 bundle 的依赖条目离开插件层。in-box 模板包不在依赖中，不受影响。
   */
  private reconcileBundles(beforeDeps: Set<string>): void {
    const dir = this.dir()
    const after = readProfileManifest(NAME, dir)
    const dependencies = Object.keys(after.dependencies ?? {})
    const plugins = after.dsh?.profile?.bundles ?? []
    let changed = false

    for (const packageName of dependencies) {
      if (this.isBundle(packageName) && !plugins.includes(packageName)) {
        plugins.push(packageName)
        changed = true
      }
    }

    const dependencySet = new Set(dependencies)
    for (const packageName of [...plugins]) {
      const wasDependency = beforeDeps.has(packageName) || dependencySet.has(packageName)
      const stillBundle = dependencySet.has(packageName) && this.isBundle(packageName)
      if (wasDependency && !stillBundle) {
        plugins.splice(plugins.indexOf(packageName), 1)
        changed = true
      }
    }

    if (!changed) return
    after.dsh = {
      ...after.dsh,
      profile: {
        ...after.dsh?.profile,
        bundles: plugins,
      },
    }
    writeProfileManifest(dir, after)
  }

  private removeFromBundles(packageName: string): boolean {
    const dir = this.dir()
    const manifest = readProfileManifest(NAME, dir)
    const bundles = manifest.dsh?.profile?.bundles
    if (!Array.isArray(bundles) || !bundles.includes(packageName)) return false
    manifest.dsh = {
      ...manifest.dsh,
      profile: {
        ...manifest.dsh?.profile,
        bundles: bundles.filter((name) => name !== packageName),
      },
    }
    writeProfileManifest(dir, manifest)
    return true
  }
}
