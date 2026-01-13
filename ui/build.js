// Copyright (C) 2021 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict';

/**
 * @fileoverview Perfetto UI 与 Chrome 扩展构建脚本
 * 核心功能：
 * 1. 处理全量 UI 和 Chrome 扩展的构建流程（生产环境构建为串行执行所有任务）
 * 2. 启动带热重载的 HTTP 开发服务器
 * 3. 支持 watch 模式：基于 fs.watch 监听文件变化，联动 tsc --watch 和 rollup --watch 实现增量构建
 * 设计初衷：
 * - 手写脚本而非传统构建系统，以保证增量构建速度（编辑-重载周期控制在秒级）
 * - 兼容支持 --watch 模式的工具（tsc/rollup）和基于 fs.watch 的文件变更触发规则
 * 构建目录结构：
 * out/xxx/          (outDir)        - 构建根目录（包含 ninja/wasm 和 UI 产物）
 *   ui/             (outUiDir)      - UI 专属目录（当前脚本所有输出）
 *    tsc/           (outTscDir)     - TS 编译为 JS 的产物目录
 *      gen/         (outGenDir)     - 自动生成的 TS/JS 文件（如 proto 编译产物）
 *    dist/          (outDistRootDir)- 根目录仅包含 index.html 和 service_worker.js
 *      v1.2/        (outDistDir)    - JS 打包产物和静态资源
 *    chrome_extension/              - Chrome 扩展产物
 */

// 引入核心依赖
const argparse = require('argparse'); // 命令行参数解析
const childProcess = require('child_process'); // 子进程管理
const crypto = require('crypto'); // 加密模块（当前未直接使用，预留/潜在依赖）
const fs = require('fs'); // 文件系统操作
const http = require('http'); // HTTP 服务器
const path = require('path'); // 路径处理
const pjoin = path.join; // 路径拼接快捷方法

/**
 * 全局常量定义
 * @constant {string} ROOT_DIR - 代码仓库根目录
 * @constant {string} VERSION_SCRIPT - 生成版本信息的脚本路径
 * @constant {string} GEN_IMPORTS_SCRIPT - 生成 UI 导入文件的脚本路径
 */
const ROOT_DIR = path.dirname(__dirname);  // 仓库根目录
const VERSION_SCRIPT = pjoin(ROOT_DIR, 'tools/write_version_header.py'); // 版本信息生成脚本
const GEN_IMPORTS_SCRIPT = pjoin(ROOT_DIR, 'tools/gen_ui_imports'); // UI 导入文件生成脚本

/**
 * 全局配置对象
 * 存储构建相关的所有配置项，包括命令行参数、目录路径、功能开关等
 * @type {Object}
 * @property {string} minifyJs - JS 压缩模式：''/preserve_comments/all
 * @property {boolean} watch - 是否开启 watch 模式（监听文件变化）
 * @property {boolean} verbose - 是否开启详细日志
 * @property {boolean} debug - 是否调试模式（影响 wasm 构建等）
 * @property {boolean} bigtrace - 是否构建 bigtrace 产物
 * @property {boolean} startHttpServer - 是否启动 HTTP 开发服务器
 * @property {string} httpServerListenHost - HTTP 服务器监听主机
 * @property {number} httpServerListenPort - HTTP 服务器监听端口
 * @property {boolean} onlyWasmMemory64 - 是否仅构建 64 位内存版本的 wasm
 * @property {string[]} wasmModules - 需要构建的 wasm 模块列表
 * @property {boolean} crossOriginIsolation - 是否开启跨源隔离
 * @property {string} testFilter - Jest 测试过滤正则
 * @property {boolean} noOverrideGnArgs - 是否覆盖 GN 构建参数
 * @property {string} outDir - 构建根目录
 * @property {string} version - 版本号（从 CHANGELOG + git 派生）
 * @property {string} outUiDir - UI 产物根目录
 * @property {string} outUiTestArtifactsDir - UI 测试产物目录
 * @property {string} outDistRootDir - dist 根目录（存放 index.html 等）
 * @property {string} outTscDir - TS 编译产物目录
 * @property {string} outGenDir - 自动生成文件目录
 * @property {string} outDistDir - 带版本号的 dist 目录（存放 JS/静态资源）
 * @property {string} outExtDir - Chrome 扩展产物目录
 * @property {string} outBigtraceDistDir - bigtrace 专属 dist 目录
 * @property {string} outOpenPerfettoTraceDistDir - open_perfetto_trace 专属 dist 目录
 */
const cfg = {
  minifyJs: '',
  watch: false,
  verbose: false,
  debug: false,
  bigtrace: false,
  startHttpServer: false,
  httpServerListenHost: '127.0.0.1',
  httpServerListenPort: 10000,
  onlyWasmMemory64: false,
  wasmModules: [],
  crossOriginIsolation: false,
  testFilter: '',
  noOverrideGnArgs: false,

  // 以下字段会在 main() 中根据命令行参数更新
  outDir: pjoin(ROOT_DIR, 'out/ui'),
  version: '',
  outUiDir: '',
  outUiTestArtifactsDir: '',
  outDistRootDir: '',
  outTscDir: '',
  outGenDir: '',
  outDistDir: '',
  outExtDir: '',
  outBigtraceDistDir: '',
  outOpenPerfettoTraceDistDir: '',
};

/**
 * 文件变更规则映射
 * 键：正则表达式（匹配文件路径）
 * 值：触发的处理函数
 * @type {Array<{r: RegExp, f: Function}>}
 */
const RULES = [
  {r: /ui\/src\/assets\/index.html/, f: copyIndexHtml}, // 复制主页面 HTML
  {r: /ui\/src\/assets\/bigtrace.html/, f: copyBigtraceHtml}, // 复制 bigtrace 页面 HTML
  {r: /ui\/src\/open_perfetto_trace\/index.html/, f: copyOpenPerfettoTraceHtml}, // 复制 open_perfetto_trace 页面 HTML
  {r: /ui\/src\/assets\/((.*)[.]png)/, f: copyAssets}, // 复制 PNG 静态资源
  {r: /buildtools\/typefaces\/(.+[.]woff2)/, f: copyAssets}, // 复制字体文件
  {r: /buildtools\/catapult_trace_viewer\/(.+(js|html))/, f: copyAssets}, // 复制 catapult 相关资源
  {r: /ui\/src\/assets\/.+[.]scss|ui\/src\/(?:plugins|core_plugins)\/.+[.]scss/, f: compileScss}, // 编译 SCSS 为 CSS
  {r: /ui\/src\/chrome_extension\/.*/, f: copyExtensionAssets}, // 复制 Chrome 扩展资源
  {r: /.*\/dist\/.+\/(?!manifest\.json).*/, f: genServiceWorkerManifestJson}, // 生成 ServiceWorker 清单
  {r: /.*\/dist\/.*[.](js|html|css|wasm)$/, f: notifyLiveServer}, // 通知热重载服务器文件变更
];

/**
 * 任务队列相关变量
 * @type {Array<Function>} tasks - 待执行的构建任务队列
 * @type {number} tasksTot - 总任务数
 * @type {number} tasksRan - 已执行任务数
 * @type {Array<any>} httpWatches - HTTP 服务器监听的文件变更列表
 * @type {number} tStart - 构建开始时间戳
 * @type {Array<childProcess.ChildProcess>} subprocesses - 子进程列表（用于退出时清理）
 */
const tasks = [];
let tasksTot = 0;
let tasksRan = 0;
const httpWatches = [];
const tStart = performance.now();
const subprocesses = [];

/**
 * 脚本入口函数
 * 核心流程：
 * 1. 解析命令行参数
 * 2. 初始化构建目录
 * 3. 注册 SIGINT 信号处理（清理子进程）
 * 4. 检查构建依赖
 * 5. 入队构建任务（Wasm、TS 编译、资源复制、Proto 编译等）
 * 6. 等待首次构建完成（watch 模式）
 * 7. 启动 HTTP 服务器（若指定）
 * 8. 运行单元测试（若指定）
 * @async
 * @returns {Promise<void>}
 */
async function main() {
  // 1. 初始化命令行参数解析器
  const parser = new argparse.ArgumentParser();
  parser.add_argument('--out', {help: '输出目录（覆盖默认 out/ui）'});
  parser.add_argument('--minify-js', {
    help: 'JS 压缩模式',
    choices: ['preserve_comments', 'all'], // 保留注释 / 全量压缩
  });
  parser.add_argument('--watch', '-w', {action: 'store_true', help: '开启 watch 模式（监听文件变化）'});
  parser.add_argument('--serve', '-s', {action: 'store_true', help: '启动 HTTP 开发服务器'});
  parser.add_argument('--serve-host', {help: 'HTTP 服务器绑定主机（默认 127.0.0.1）'});
  parser.add_argument('--serve-port', {help: 'HTTP 服务器绑定端口（默认 10000）', type: 'int'});
  parser.add_argument('--verbose', '-v', {action: 'store_true', help: '开启详细日志输出'});
  parser.add_argument('--no-build', '-n', {action: 'store_true', help: '跳过构建流程（仅启动服务器/测试）'});
  parser.add_argument('--no-wasm', '-W', {action: 'store_true', help: '跳过 Wasm 模块构建'});
  parser.add_argument('--only-wasm-memory64', {action: 'store_true', help: '仅构建 64 位内存版本的 Wasm'});
  parser.add_argument('--run-unittests', '-t', {action: 'store_true', help: '运行 Jest 单元测试'});
  parser.add_argument('--debug', '-d', {action: 'store_true', help: '调试模式（影响 Wasm 构建等）'});
  parser.add_argument('--bigtrace', {action: 'store_true', help: '构建 bigtrace 专属产物'});
  parser.add_argument('--open-perfetto-trace', {action: 'store_true', help: '构建 open_perfetto_trace 专属产物'});
  parser.add_argument('--interactive', '-i', {action: 'store_true', help: '交互式测试模式'});
  parser.add_argument('--rebaseline', '-r', {action: 'store_true', help: '重新生成测试基准'});
  parser.add_argument('--no-depscheck', {action: 'store_true', help: '跳过构建依赖检查'});
  parser.add_argument('--cross-origin-isolation', {action: 'store_true', help: '开启跨源隔离'});
  parser.add_argument('--test-filter', '-f', {
    help: 'Jest 测试过滤正则（如 \'chrome_render\'）',
  });
  parser.add_argument('--no-override-gn-args', {action: 'store_true', help: '不覆盖 GN 构建参数'});

  // 解析命令行参数
  const args = parser.parse_args();
  const clean = !args.no_build; // 是否执行清理/全量构建
  // 2. 初始化构建目录（确保目录存在，clean 模式下清空）
  cfg.outDir = path.resolve(ensureDir(args.out || cfg.outDir));
  cfg.outUiDir = ensureDir(pjoin(cfg.outDir, 'ui'), clean);
  cfg.outUiTestArtifactsDir = ensureDir(pjoin(cfg.outDir, 'ui-test-artifacts'));
  cfg.outExtDir = ensureDir(pjoin(cfg.outUiDir, 'chrome_extension'));
  cfg.outDistRootDir = ensureDir(pjoin(cfg.outUiDir, 'dist'));
  
  // 获取版本号（从版本脚本中读取）
  const proc = exec('python3', [VERSION_SCRIPT, '--stdout'], {stdout: 'pipe'});
  cfg.version = proc.stdout.toString().trim();
  cfg.outDistDir = ensureDir(pjoin(cfg.outDistRootDir, cfg.version));
  cfg.outTscDir = ensureDir(pjoin(cfg.outUiDir, 'tsc'));
  cfg.outGenDir = ensureDir(pjoin(cfg.outUiDir, 'tsc/gen'));
  
  // 同步命令行参数到全局配置
  cfg.testFilter = args.test_filter || '';
  cfg.watch = !!args.watch;
  cfg.verbose = !!args.verbose;
  cfg.debug = !!args.debug;
  cfg.bigtrace = !!args.bigtrace;
  cfg.openPerfettoTrace = !!args.open_perfetto_trace;
  cfg.startHttpServer = args.serve;
  cfg.noOverrideGnArgs = !!args.no_override_gn_args;
  if (args.minify_js) {
    cfg.minifyJs = args.minify_js;
  }
  // 初始化 bigtrace/open_perfetto_trace 专属目录
  if (args.bigtrace) {
    cfg.outBigtraceDistDir = ensureDir(pjoin(cfg.outDistDir, 'bigtrace'));
  }
  if (cfg.openPerfettoTrace) {
    cfg.outOpenPerfettoTraceDistDir = ensureDir(pjoin(cfg.outDistRootDir,
                                                      'open_perfetto_trace'));
  }
  // 同步 HTTP 服务器配置
  if (args.serve_host) {
    cfg.httpServerListenHost = args.serve_host;
  }
  if (args.serve_port) {
    cfg.httpServerListenPort = args.serve_port;
  }
  // 测试相关环境变量
  if (args.interactive) {
    process.env.PERFETTO_UI_TESTS_INTERACTIVE = '1';
  }
  if (args.rebaseline) {
    process.env.PERFETTO_UI_TESTS_REBASELINE = '1';
  }
  // 跨源隔离配置
  if (args.cross_origin_isolation) {
    cfg.crossOriginIsolation = true;
  }
  // Wasm 模块配置
  cfg.onlyWasmMemory64 = !!args.only_wasm_memory64;
  cfg.wasmModules = ['traceconv', 'trace_config_utils', 'trace_processor_memory64'];
  if (!cfg.onlyWasmMemory64) {
    cfg.wasmModules.push('trace_processor'); // 非 64 位模式添加基础 trace_processor
  }

  // 3. 注册 SIGINT 信号处理（Ctrl+C）：清理子进程并退出
  process.on('SIGINT', () => {
    console.log('\nSIGINT received. Killing all child processes and exiting');
    for (const proc of subprocesses) {
      if (proc) proc.kill('SIGKILL');
    }
    process.kill(0, 'SIGKILL');  // 终止整个进程组
    process.exit(130);  // 与 bash 处理 SIGINT 一致的退出码
  });

  // 4. 检查构建依赖（默认执行）
  if (!args.no_depscheck) {
    const installBuildDeps = pjoin(ROOT_DIR, 'tools/install-build-deps');
    const checkDepsPath = pjoin(cfg.outDir, '.check_deps');
    let args = [installBuildDeps, `--check-only=${checkDepsPath}`, '--ui'];

    // Mac ARM64 架构适配
    if (process.platform === 'darwin') {
      const result = childProcess.spawnSync('arch', ['-arm64', 'true']);
      const isArm64Capable = result.status === 0;
      if (isArm64Capable) {
        const archArgs = [
          'arch',
          '-arch',
          'arm64',
        ];
        args = archArgs.concat(args);
      }
    }
    const cmd = args.shift();
    exec(cmd, args);
  }

  // 切换工作目录到构建根目录
  console.log('Entering', cfg.outDir);
  process.chdir(cfg.outDir);

  // 入队空任务（兼容 --no-build --serve 模式：确保任务队列有初始任务）
  addTask(() => {});

  // 5. 入队核心构建任务（非 --no-build 模式）
  if (!args.no_build) {
    updateSymlinks();  // 更新符号链接（ui/out -> out/xxx/ui 等）

    buildWasm(args.no_wasm); // 构建 Wasm 模块
    generateImports('ui/src/core_plugins', 'all_core_plugins'); // 生成核心插件导入文件
    generateImports('ui/src/plugins', 'all_plugins'); // 生成普通插件导入文件
    // 扫描静态资源目录并触发对应处理规则
    scanDir('ui/src/assets');
    scanDir('ui/src/plugins', /[.]scss$/);
    scanDir('ui/src/core_plugins', /[.]scss$/);
    scanDir('ui/src/chrome_extension');
    scanDir('buildtools/typefaces');
    scanDir('buildtools/catapult_trace_viewer');
    compileProtos(); // 编译 Proto 文件为 TS/JS
    genVersion(); // 生成版本信息 TS 文件
    generateStdlibDocs(); // 生成 Perfetto SQL 标准库文档

    // TS 项目编译配置
    const tsProjects = [
      'ui',
      'ui/src/service_worker'
    ];
    if (cfg.bigtrace) tsProjects.push('ui/src/bigtrace'); // bigtrace 专属 TS 项目
    if (cfg.openPerfettoTrace) {
      scanDir('ui/src/open_perfetto_trace');
      tsProjects.push('ui/src/open_perfetto_trace'); // open_perfetto_trace 专属 TS 项目
    }

    // 执行 TS 编译（非 watch 模式）
    for (const prj of tsProjects) {
      transpileTsProject(prj);
    }

    // watch 模式：启动 TS 编译的 watch 进程
    if (cfg.watch) {
      for (const prj of tsProjects) {
        transpileTsProject(prj, {watch: cfg.watch});
      }
    }

    // 执行 JS 打包（rollup）
    bundleJs('rollup.config.js');
    // 生成 ServiceWorker 清单
    genServiceWorkerManifestJson();

    // 监听 dist 目录变化：触发热重载 + 重新生成 ServiceWorker 清单
    scanDir(cfg.outDistRootDir);
  }

  // 6. 等待首次构建完成（--no-build 但产物不全时提示）
  if (args.no_build && !isDistComplete()) {
    console.log('No build was requested, but artifacts are not available.');
    console.log('In case of execution error, re-run without --no-build.');
  }
  if (!args.no_build) {
    const tStart = performance.now();
    while (!isDistComplete()) {
      const secs = Math.ceil((performance.now() - tStart) / 1000);
      process.stdout.write(
          `\t\tWaiting for first build to complete... ${secs} s\r`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (cfg.watch) console.log('\nFirst build completed!');

  // 7. 启动 HTTP 开发服务器（若指定）
  if (cfg.startHttpServer) {
    startServer();
  }
  // 8. 运行单元测试（若指定）
  if (args.run_unittests) {
    runTests('jest.unittest.config.js');
  }
}

// -----------
// 构建规则（核心任务实现）
// -----------

/**
 * 运行 Jest 单元测试
 * @param {string} cfgFile - Jest 配置文件路径（相对 ui/config 目录）
 */
function runTests(cfgFile) {
  const args = [
    '--rootDir',
    cfg.outTscDir, // 测试根目录（TS 编译产物）
    '--verbose', // 详细日志
    '--runInBand', // 串行执行测试（避免并行问题）
    '--detectOpenHandles', // 检测未关闭的句柄
    '--forceExit', // 强制退出（即使有异步任务）
    '--projects',
    pjoin(ROOT_DIR, 'ui/config', cfgFile), // 配置文件路径
  ];
  // 测试过滤（指定正则）
  if (cfg.testFilter.length > 0) {
    args.push('-t', cfg.testFilter);
  }
  // watch 模式：监听测试文件变化
  if (cfg.watch) {
    args.push('--watchAll');
    addTask(execModule, ['jest', args, {async: true}]);
  } else {
    addTask(execModule, ['jest', args]);
  }
}

/**
 * 复制并处理 HTML 文件（注入版本信息）
 * 1. 原样复制到带版本号的 dist 目录（归档用）
 * 2. 注入版本映射到根 dist 目录的 HTML（用于自动更新逻辑）
 * @param {string} src - 源 HTML 文件路径
 * @param {string} filename - 输出文件名
 */
function cpHtml(src, filename) {
  let html = fs.readFileSync(src).toString();
  // 1. 归档版本：原样复制到 dist/v1.2.3/
  fs.writeFileSync(pjoin(cfg.outDistDir, filename), html);

  // 2. 根版本：注入版本映射（当前仅 stable 通道）
  // TODO: 后续支持 --release_map=xxx.json 参数，适配多通道版本
  const versionMap = JSON.stringify({'stable': cfg.version});
  const bodyRegex = /data-perfetto_version='[^']*'/;
  html = html.replace(bodyRegex, `data-perfetto_version='${versionMap}'`);
  fs.writeFileSync(pjoin(cfg.outDistRootDir, filename), html);
}

/**
 * 复制主页面 index.html（入队任务）
 * @param {string} src - 源文件路径
 */
function copyIndexHtml(src) {
  addTask(cpHtml, [src, 'index.html']);
}

/**
 * 复制 bigtrace 页面 HTML（入队任务，仅 bigtrace 模式）
 * @param {string} src - 源文件路径
 */
function copyBigtraceHtml(src) {
  if (cfg.bigtrace) {
    addTask(cpHtml, [src, 'bigtrace.html']);
  }
}

/**
 * 复制 open_perfetto_trace 页面 HTML（入队任务，仅对应模式）
 * @param {string} src - 源文件路径
 */
function copyOpenPerfettoTraceHtml(src) {
  if (cfg.openPerfettoTrace) {
    addTask(cp, [src, pjoin(cfg.outOpenPerfettoTraceDistDir, 'index.html')]);
  }
}

/**
 * 复制静态资源（PNG/字体等，入队任务）
 * @param {string} src - 源文件路径
 * @param {string} dst - 目标相对路径
 */
function copyAssets(src, dst) {
  addTask(cp, [src, pjoin(cfg.outDistDir, 'assets', dst)]);
  // bigtrace 模式：同步复制到 bigtrace 资源目录
  if (cfg.bigtrace) {
    addTask(cp, [src, pjoin(cfg.outBigtraceDistDir, 'assets', dst)]);
  }
}

/**
 * 复制 UI 测试静态资源（入队任务）
 * @param {string} src - 源文件路径
 * @param {string} dst - 目标相对路径
 */
function copyUiTestArtifactsAssets(src, dst) {
  addTask(cp, [src, pjoin(cfg.outUiTestArtifactsDir, dst)]);
}

/**
 * 编译 SCSS 为 CSS（入队任务）
 * 核心逻辑：调用 sass 模块编译 perfetto.scss 为 perfetto.css
 */
function compileScss() {
  const src = pjoin(ROOT_DIR, 'ui/src/assets/perfetto.scss');
  const dst = pjoin(cfg.outDistDir, 'perfetto.css');
  // watch 模式下：SCSS 编译失败不退出（允许临时语法错误）
  const noErrCheck = !!cfg.watch;
  const args = [src, dst];
  if (!cfg.verbose) {
    args.unshift('--quiet'); // 非详细模式：静默输出
  }
  addTask(execModule, ['sass', args, {noErrCheck}]);
  // bigtrace 模式：同步复制 CSS 到 bigtrace 目录
  if (cfg.bigtrace) {
    addTask(cp, [dst, pjoin(cfg.outBigtraceDistDir, 'perfetto.css')]);
  }
}

/**
 * 编译 Proto 文件为 TS/JS（入队任务）
 * 流程：
 * 1. pbjs 编译 proto 为 CommonJS 模块的 JS 文件
 * 2. pbts 从 JS 文件生成 TS 类型声明
 */
function compileProtos() {
  const dstJs = pjoin(cfg.outGenDir, 'protos.js');
  const dstTs = pjoin(cfg.outGenDir, 'protos.d.ts');
  // 需要编译的 Proto 文件列表
  const inputs = [
    'protos/perfetto/ipc/consumer_port.proto',
    'protos/perfetto/ipc/wire_protocol.proto',
    'protos/perfetto/trace/perfetto/perfetto_metatrace.proto',
    'protos/perfetto/perfetto_sql/structured_query.proto',
    'protos/perfetto/trace_processor/trace_processor.proto',
  ];
  // pbjs 编译参数（保留注释，供 pbts 使用）
  const pbjsArgs = [
    '--no-beautify', // 不格式化输出
    '--force-number', // 强制数字类型（避免大数问题）
    '--no-delimited', // 禁用分隔符格式
    '--no-verify', // 不验证输出
    '-t', 'static-module', // 输出静态模块
    '-w', 'commonjs', // 模块格式：CommonJS
    '-p', ROOT_DIR, // Proto 导入路径
    '-o', dstJs, // 输出 JS 文件
  ].concat(inputs);
  addTask(execModule, ['pbjs', pbjsArgs]);

  // pbts 生成 TS 类型声明（注意：pbts 本身不慢，慢的是内部调用的 jsdoc/catharsis）
  const pbtsArgs = ['--no-comments', '-p', ROOT_DIR, '-o', dstTs, dstJs];
  addTask(execModule, ['pbts', pbtsArgs]);
}

/**
 * 生成插件导入文件（入队任务）
 * 作用：自动生成导入所有插件的 TS 文件，避免手动维护导入列表
 * @param {string} dir - 插件目录（相对仓库根）
 * @param {string} name - 输出文件名（无后缀，自动加 .ts）
 */
function generateImports(dir, name) {
  // 注意：使用符号链接 ui/src/gen 而非 cfg.outGenDir，保证相对导入路径正确
  const dstTs = pjoin(ROOT_DIR, 'ui/src/gen', name);
  const inputDir = pjoin(ROOT_DIR, dir);
  const args = [GEN_IMPORTS_SCRIPT, inputDir, '--out', dstTs];
  addTask(exec, ['python3', args]);
}

/**
 * 生成版本信息 TS 文件（入队任务）
 * 作用：输出 VERSION 和 SCM_REVISION 常量到 TS 文件，供 UI 使用
 */
function genVersion() {
  const cmd = 'python3';
  const args =
      [VERSION_SCRIPT, '--ts_out', pjoin(cfg.outGenDir, 'perfetto_version.ts')];
  addTask(exec, [cmd, args]);
}

/**
 * 生成 Perfetto SQL 标准库文档（JSON 格式，入队任务）
 */
function generateStdlibDocs() {
  const cmd = pjoin(ROOT_DIR, 'tools/gen_stdlib_docs_json.py');
  const stdlibDir = pjoin(ROOT_DIR, 'src/trace_processor/perfetto_sql/stdlib');

  // 遍历标准库目录，筛选 .sql 文件
  const stdlibFiles =
    listFilesRecursive(stdlibDir)
    .filter((filePath) => path.extname(filePath) === '.sql');

  // 入队生成任务（输出压缩后的 JSON）
  addTask(exec, [
    cmd,
    [
      '--json-out',
      pjoin(cfg.outDistDir, 'stdlib_docs.json'),
      '--minify', // 压缩 JSON
      ...stdlibFiles,
    ],
  ]);
}

/**
 * 更新构建相关符号链接
 * 作用：
 * 1. ui/out -> out/xxx/ui（简化路径引用）
 * 2. ui/src/gen -> out/ui/tsc/gen（TS 导入路径兼容）
 * 3. out/ui/test/data -> test/data（测试资源引用）
 * 4. out/ui/dist_version -> out/ui/dist/v1.2.3（rollup 无需感知版本号）
 * 5. out/ui/tsc/node_modules -> ui/node_modules（模块解析）
 */
function updateSymlinks() {
  // /ui/out -> /out/ui
  mklink(cfg.outUiDir, pjoin(ROOT_DIR, 'ui/out'));

  // /ui/src/gen -> /out/ui/ui/tsc/gen
  mklink(cfg.outGenDir, pjoin(ROOT_DIR, 'ui/src/gen'));

  // /out/ui/test/data -> /test/data（UI 测试资源）
  mklink(
      pjoin(ROOT_DIR, 'test/data'),
      pjoin(ensureDir(pjoin(cfg.outDir, 'test')), 'data'));

  // out/dist_version -> out/dist/v1.2.3（版本无关路径）
  mklink(
      path.relative(cfg.outUiDir, cfg.outDistDir),
      pjoin(cfg.outUiDir, 'dist_version'));

  // out/ui/tsc/node_modules -> ui/node_modules（TS 编译时模块解析）
  mklink(
      pjoin(ROOT_DIR, 'ui/node_modules'), pjoin(cfg.outTscDir, 'node_modules'));
}

/**
 * 构建 Wasm 模块（入队任务）
 * 流程：
 * 1. 生成 GN 构建参数（debug/ccache 等）
 * 2. 调用 ninja 构建指定的 Wasm 模块
 * 3. 复制 Wasm 产物到对应目录（dist 放 .wasm，tsc 放 .js/.d.ts）
 * @param {boolean} skipWasmBuild - 是否跳过 Wasm 构建
 */
function buildWasm(skipWasmBuild) {
  if (!skipWasmBuild) {
    // 生成 GN 构建参数（非 noOverrideGnArgs 模式）
    if (!cfg.noOverrideGnArgs) {
      let gnVars = `is_debug=${cfg.debug}`;
      // 检测 ccache 并启用（加速编译）
      if (childProcess.spawnSync('which', ['ccache']).status === 0) {
        gnVars += ` cc_wrapper="ccache"`;
      }
      const gnArgs = ['gen', `--args=${gnVars}`, cfg.outDir];
      addTask(exec, [pjoin(ROOT_DIR, 'tools/gn'), gnArgs]);
    }
    // 调用 ninja 构建 Wasm 模块
    const ninjaArgs = ['-C', cfg.outDir];
    ninjaArgs.push(...cfg.wasmModules.map((x) => `${x}_wasm`));
    addTask(exec, [pjoin(ROOT_DIR, 'tools/ninja'), ninjaArgs]);
  }

  // 复制 Wasm 产物到对应目录
  for (const wasmMod of cfg.wasmModules) {
    const isMem64 = wasmMod.endsWith('_memory64');
    const wasmOutDir = pjoin(cfg.outDir, isMem64 ? 'wasm_memory64' : 'wasm');
    // The .wasm file goes directly into the dist dir (also .map in debug)
    for (const ext of ['.wasm'].concat(cfg.debug ? ['.wasm.map'] : [])) {
      const src = `${wasmOutDir}/${wasmMod}${ext}`;
      addTask(cp, [src, pjoin(cfg.outDistDir, wasmMod + ext)]);
    }
    // The .js / .ts go into intermediates, they will be bundled by rollup.
    for (const ext of ['.js', '.d.ts']) {
      const fname = `${wasmMod}${ext}`;
      addTask(cp, [pjoin(wasmOutDir, fname), pjoin(cfg.outGenDir, fname)]);
    }
  }
}

// This transpiles all the sources (frontend, controller, engine, extension) in
// one go. The only project that has a dedicated invocation is service_worker.
function transpileTsProject(project, options) {
  const args = ['--project', pjoin(ROOT_DIR, project)];

  if (options !== undefined && options.watch) {
    args.push('--watch', '--preserveWatchOutput');
    addTask(execModule, ['tsc', args, {async: true}]);
  } else {
    addTask(execModule, ['tsc', args]);
  }
}

// Creates the three {frontend, controller, engine}_bundle.js in one invocation.
function bundleJs(cfgName) {
  const rcfg = pjoin(ROOT_DIR, 'ui/config', cfgName);
  const args = ['-c', rcfg, '--no-indent'];
  if (cfg.bigtrace) {
    args.push('--environment', 'ENABLE_BIGTRACE:true');
  }
  if (cfg.openPerfettoTrace) {
    args.push('--environment', 'ENABLE_OPEN_PERFETTO_TRACE:true');
  }
  if (cfg.minifyJs) {
    args.push('--environment', `MINIFY_JS:${cfg.minifyJs}`);
  }
  if (cfg.onlyWasmMemory64) {
    args.push('--environment', `IS_MEMORY64_ONLY:${cfg.onlyWasmMemory64}`);
  }
  args.push(...(cfg.verbose ? [] : ['--silent']));
  if (cfg.watch) {
    // --waitForBundleInput is sadly quite busted so it is required ts
    // has build at least once before invoking this.
    args.push('--watch', '--no-watch.clearScreen');
    addTask(execModule, ['rollup', args, {async: true}]);
  } else {
    addTask(execModule, ['rollup', args]);
  }
}

function genServiceWorkerManifestJson() {
  function makeManifest() {
    const manifest = {resources: {}};
    // When building the subresource manifest skip source maps, the manifest
    // itself and the copy of the index.html which is copied under /v1.2.3/.
    // The root /index.html will be fetched by service_worker.js separately.
    const skipRegex = /(\.map|manifest\.json|index.html)$/;
    walk(cfg.outDistDir, (absPath) => {
      const contents = fs.readFileSync(absPath);
      const relPath = path.relative(cfg.outDistDir, absPath);
      const b64 = crypto.createHash('sha256').update(contents).digest('base64');
      manifest.resources[relPath] = 'sha256-' + b64;
    }, skipRegex);
    const manifestJson = JSON.stringify(manifest, null, 2);
    fs.writeFileSync(pjoin(cfg.outDistDir, 'manifest.json'), manifestJson);
  }
  addTask(makeManifest, []);
}

function startServer() {
  const host = cfg.httpServerListenHost == '127.0.0.1' ? 'localhost' : cfg.httpServerListenHost;
  console.log(
      'Starting HTTP server on',
      `http://${host}:${cfg.httpServerListenPort}`);
  http.createServer(function(req, res) {
        console.debug(req.method, req.url);
        let uri = req.url.split('?', 1)[0];
        if (uri.endsWith('/')) {
          uri += 'index.html';
        }

        if (uri === '/live_reload') {
          // Implements the Server-Side-Events protocol.
          const head = {
            'Content-Type': 'text/event-stream',
            'Connection': 'keep-alive',
            'Cache-Control': 'no-cache',
          };
          res.writeHead(200, head);
          const arrayIdx = httpWatches.length;
          // We never remove from the array, the delete leaves an undefined item
          // around. It makes keeping track of the index easier at the cost of a
          // small leak.
          httpWatches.push(res);
          req.on('close', () => delete httpWatches[arrayIdx]);
          return;
        }

        let absPath = path.normalize(path.join(cfg.outDistRootDir, uri));
        // We want to be able to use the data in '/test/' for e2e tests.
        // However, we don't want do create a symlink into the 'dist/' dir,
        // because 'dist/' gets shipped on the production server.
        if (uri.startsWith('/test/')) {
          absPath = pjoin(ROOT_DIR, uri);
        }

        // Don't serve contents outside of the project root (b/221101533).
        if (path.relative(ROOT_DIR, absPath).startsWith('..')) {
          res.writeHead(403);
          res.end('403 Forbidden - Request path outside of the repo root');
          return;
        }

        fs.readFile(absPath, function(err, data) {
          if (err) {
            res.writeHead(404);
            res.end(JSON.stringify(err));
            return;
          }

          const mimeMap = {
            'html': 'text/html',
            'css': 'text/css',
            'js': 'application/javascript',
            'wasm': 'application/wasm',
          };
          const ext = uri.split('.').pop();
          const cType = mimeMap[ext] || 'octect/stream';
          const head = {
            'Content-Type': cType,
            'Content-Length': data.length,
            'Last-Modified': fs.statSync(absPath).mtime.toUTCString(),
            'Cache-Control': 'no-cache',
          };
          if (cfg.crossOriginIsolation) {
            head['Cross-Origin-Opener-Policy'] = 'same-origin';
            head['Cross-Origin-Embedder-Policy'] = 'require-corp';
          }
          res.writeHead(200, head);
          res.write(data);
          res.end();
        });
      })
      .listen(cfg.httpServerListenPort, cfg.httpServerListenHost);
}

function isDistComplete() {
  const requiredArtifacts = [
    'frontend_bundle.js',
    'engine_bundle.js',
    'traceconv_bundle.js',
    'perfetto.css',
    ...cfg.wasmModules.map((wasmMod) => `${wasmMod}.wasm`),
  ];
  const relPaths = new Set();
  walk(cfg.outDistDir, (absPath) => {
    relPaths.add(path.relative(cfg.outDistDir, absPath));
  });
  for (const fName of requiredArtifacts) {
    if (!relPaths.has(fName)) return false;
  }
  return true;
}

// Called whenever a change in the out/dist directory is detected. It sends a
// Server-Side-Event to the live_reload.ts script.
function notifyLiveServer(changedFile) {
  for (const cli of httpWatches) {
    if (cli === undefined) continue;
    cli.write(
        'data: ' + path.relative(cfg.outDistRootDir, changedFile) + '\n\n');
  }
}

function copyExtensionAssets() {
  addTask(cp, [
    pjoin(ROOT_DIR, 'ui/src/assets/logo-128.png'),
    pjoin(cfg.outExtDir, 'logo-128.png'),
  ]);
  addTask(cp, [
    pjoin(ROOT_DIR, 'ui/src/chrome_extension/manifest.json'),
    pjoin(cfg.outExtDir, 'manifest.json'),
  ]);
}

// -----------------------
// Task chaining functions
// -----------------------

function addTask(func, args) {
  const task = new Task(func, args);
  for (const t of tasks) {
    if (t.identity === task.identity) {
      return;
    }
  }
  tasks.push(task);
  setTimeout(runTasks, 0);
}

function runTasks() {
  const snapTasks = tasks.splice(0);  // snap = std::move(tasks).
  tasksTot += snapTasks.length;
  for (const task of snapTasks) {
    const DIM = '\u001b[2m';
    const BRT = '\u001b[37m';
    const RST = '\u001b[0m';
    const ms = (performance.now() - tStart) / 1000;;
    const ts = `[${DIM}${ms.toFixed(3)}${RST}]`;
    const descr = task.description.substr(0, 80);
    console.log(`${ts} ${BRT}${++tasksRan}/${tasksTot}${RST}\t${descr}`);
    task.func.apply(/* this=*/ undefined, task.args);
  }
}

// Executes all the RULES that match the given |absPath|.
function scanFile(absPath) {
  console.assert(fs.existsSync(absPath));
  console.assert(path.isAbsolute(absPath));
  const normPath = path.relative(ROOT_DIR, absPath);
  for (const rule of RULES) {
    const match = rule.r.exec(normPath);
    if (!match || match[0] !== normPath) continue;
    const captureGroup = match.length > 1 ? match[1] : undefined;
    rule.f(absPath, captureGroup);
  }
}

// Walks the passed |dir| recursively and, for each file, invokes the matching
// RULES. If --watch is used, it also installs a fswatch() and re-triggers the
// matching RULES on each file change.
function scanDir(dir, regex) {
  const filterFn = regex ? (absPath) => regex.test(absPath) : () => true;
  const absDir = path.isAbsolute(dir) ? dir : pjoin(ROOT_DIR, dir);
  // Add a fs watch if in watch mode.
  if (cfg.watch) {
    fs.watch(absDir, {recursive: true}, (_eventType, relFilePath) => {
      const filePath = pjoin(absDir, relFilePath);
      if (!filterFn(filePath)) return;
      if (cfg.verbose) {
        console.log('File change detected', _eventType, filePath);
      }
      if (fs.existsSync(filePath)) {
        scanFile(filePath, filterFn);
      }
    });
  }
  walk(absDir, (f) => {
    if (filterFn(f)) scanFile(f);
  });
}

function exec(cmd, args, opts) {
  opts = opts || {};
  opts.stdout = opts.stdout || 'inherit';
  if (cfg.verbose) console.log(`${cmd} ${args.join(' ')}\n`);
  const spwOpts = {cwd: cfg.outDir, stdio: ['ignore', opts.stdout, 'inherit']};
  const checkExitCode = (code, signal) => {
    if (signal === 'SIGINT' || signal === 'SIGTERM') return;
    if (code !== 0 && !opts.noErrCheck) {
      console.error(`${cmd} ${args.join(' ')} failed with code ${code}`);
      process.exit(1);
    }
  };
  if (opts.async) {
    const proc = childProcess.spawn(cmd, args, spwOpts);
    const procIndex = subprocesses.length;
    subprocesses.push(proc);
    return new Promise((resolve, _reject) => {
      proc.on('exit', (code, signal) => {
        delete subprocesses[procIndex];
        checkExitCode(code, signal);
        resolve();
      });
    });
  } else {
    const spawnRes = childProcess.spawnSync(cmd, args, spwOpts);
    checkExitCode(spawnRes.status, spawnRes.signal);
    return spawnRes;
  }
}

function execModule(module, args, opts) {
  const modPath = pjoin(ROOT_DIR, 'ui/node_modules/.bin', module);
  return exec(modPath, args || [], opts);
}

// ------------------------------------------
// File system & subprocess utility functions
// ------------------------------------------

class Task {
  constructor(func, args) {
    this.func = func;
    this.args = args || [];
    // |identity| is used to dedupe identical tasks in the queue.
    this.identity = JSON.stringify([this.func.name, this.args]);
  }

  get description() {
    const ret = this.func.name.startsWith('exec') ? [] : [this.func.name];
    const flattenedArgs = [].concat(...this.args);
    for (const arg of flattenedArgs) {
      const argStr = `${arg}`;
      if (argStr.startsWith('/')) {
        ret.push(path.relative(cfg.outDir, arg));
      } else {
        ret.push(argStr);
      }
    }
    return ret.join(' ');
  }
}

function walk(dir, callback, skipRegex) {
  for (const child of fs.readdirSync(dir)) {
    const childPath = pjoin(dir, child);
    const stat = fs.lstatSync(childPath);
    if (skipRegex !== undefined && skipRegex.test(child)) continue;
    if (stat.isDirectory()) {
      walk(childPath, callback, skipRegex);
    } else if (!stat.isSymbolicLink()) {
      callback(childPath);
    }
  }
}

// Recursively build a list of files in a given directory and return a list of
// file paths, similar to `find -type f`.
function listFilesRecursive(dir) {
  const fileList = [];

  walk(dir, (filePath) => {
    fileList.push(filePath);
  });

  return fileList;
}

function ensureDir(dirPath, clean) {
  const exists = fs.existsSync(dirPath);
  if (exists && clean) {
    console.log('rm', dirPath);
    fs.rmSync(dirPath, {recursive: true});
  }
  if (!exists || clean) fs.mkdirSync(dirPath, {recursive: true});
  return dirPath;
}

function cp(src, dst) {
  ensureDir(path.dirname(dst));
  if (cfg.verbose) {
    console.log(
        'cp', path.relative(ROOT_DIR, src), '->', path.relative(ROOT_DIR, dst));
  }
  fs.copyFileSync(src, dst);
}

function mklink(src, dst) {
  // If the symlink already points to the right place don't touch it. This is
  // to avoid changing the mtime of the ui/ dir when unnecessary.
  if (fs.existsSync(dst)) {
    if (fs.lstatSync(dst).isSymbolicLink() && fs.readlinkSync(dst) === src) {
      return;
    } else {
      fs.unlinkSync(dst);
    }
  }
  fs.symlinkSync(src, dst);
}

main();
