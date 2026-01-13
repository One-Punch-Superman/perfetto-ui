// Copyright (C) 2018 The Android Open Source Project
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

// ===================== 核心依赖导入区 =====================
// 保持该导入在首位，确保zod校验库优先加载
import z from 'zod'; // 类型校验库，用于配置项/参数的schema验证
import '../base/disposable_polyfill'; // 一次性对象Polyfill，兼容不同环境
import '../base/static_initializers'; // 静态初始化逻辑（如全局变量、基础配置）
import NON_CORE_PLUGINS from '../gen/all_plugins'; // 非核心插件列表（自动生成）
import CORE_PLUGINS from '../gen/all_core_plugins'; // 核心插件列表（自动生成）
import m from 'mithril'; // Mithril框架，轻量级前端MVVM库，用于UI渲染
import {defer} from '../base/deferred'; // 延迟执行/异步操作封装工具
import {addErrorHandler, reportError} from '../base/logging'; // 错误处理/上报工具
import {featureFlags} from '../core/feature_flags'; // 功能开关管理
import {initLiveReload} from '../core/live_reload'; // 开发环境热重载初始化
import {raf} from '../core/raf_scheduler'; // requestAnimationFrame调度器，优化UI渲染性能
import {warmupWasmWorker} from '../trace_processor/wasm_engine_proxy'; // Wasm引擎预热，提升trace处理速度
import {UiMain} from './ui_main'; // 主UI组件
import {registerDebugGlobals} from './debug'; // 注册调试全局变量
import {maybeShowErrorDialog} from './error_dialog'; // 错误弹窗展示逻辑
import {installFileDropHandler} from './file_drop_handler'; // 文件拖放功能注册
import {tryLoadIsInternalUserScript} from './is_internal_user_script_loader'; // 检测是否为内部用户（Google员工）
import {HomePage} from './home_page'; // 首页组件
import {postMessageHandler} from './post_message_handler'; // 跨窗口/iframe消息处理
import {Route, Router} from '../core/router'; // 路由管理
import {checkHttpRpcConnection} from './rpc_http_dialog'; // 检查HTTP RPC连接状态
import {maybeOpenTraceFromRoute} from './trace_url_handler'; // 从路由参数加载trace文件
// 时间轴页面相关常量（轨道最小高度）
import {
  DEFAULT_TRACK_MIN_HEIGHT_PX,
  MINIMUM_TRACK_MIN_HEIGHT_PX,
  TRACK_MIN_HEIGHT_SETTING,
} from './timeline_page/track_view';
import {renderTimelinePage} from './timeline_page/timeline_page'; // 时间轴页面渲染函数
import {HttpRpcEngine} from '../trace_processor/http_rpc_engine'; // HTTP RPC引擎，用于远程trace处理
import {showModal} from '../widgets/modal'; // 模态框工具
import {IdleDetector} from './idle_detector'; // 应用空闲状态检测
import {IdleDetectorWindow} from './idle_detector_interface'; // 空闲检测类型定义
import {AppImpl} from '../core/app_impl'; // 应用核心实现类
// 扩展组件注册
import {addLegacyTableTab} from '../components/details/sql_table_tab'; // 旧版SQL表格标签
import {configureExtensions} from '../components/extensions'; // 扩展配置
import {addDebugCounterTrack, addDebugSliceTrack} from '../components/tracks/debug_tracks'; // 调试轨道注册
import {addVisualizedArgTracks} from '../components/tracks/visualized_args_tracks'; // 可视化参数轨道
import {addQueryResultsTab} from '../components/query_table/query_result_tab'; // 查询结果标签
import {assetSrc, initAssets} from '../base/assets'; // 静态资源路径处理
// 配置管理相关
import {
  PERFETTO_SETTINGS_STORAGE_KEY,
  SettingsManagerImpl,
} from '../core/settings_manager';
import {LocalStorage} from '../core/local_storage'; // 本地存储封装
// 时间格式相关类型
import {DurationPrecision, TimestampFormat} from '../public/timeline';
import {timezoneOffsetMap} from '../base/time'; // 时区偏移映射表
import {ThemeProvider} from './theme_provider'; // 主题提供者（暗黑/亮色模式）
import {OverlayContainer} from '../widgets/overlay_container'; // 浮层容器组件
import {JsonSettingsEditor} from '../components/json_settings_editor'; // JSON配置编辑器
// 命令管理相关
import {
  CommandInvocation,
  commandInvocationArraySchema,
} from '../core/command_manager';
import {HotkeyConfig, HotkeyContext} from '../widgets/hotkey_context'; // 快捷键配置
import {sleepMs} from '../base/utils'; // 延迟函数（毫秒）

// =============================================================================
// UI INITIALIZATION STAGES
// =============================================================================
//
// 该文件编排Perfetto UI的启动流程，分为三个核心阶段：
//
//   时间轴 ───────────────────────────────────────────────────────────────────>
//
//   [模块加载]
//        │
//        ├─► main() ───────────────────────────────────────────────────────┐
//        │    ├─ 配置内容安全策略(CSP)                                      │
//        │    ├─ 初始化配置 & 应用实例                                       │
//        │    ├─ 启动CSS加载（异步） ──────┐                                │
//        │    ├─ 配置错误处理器            │                               │
//        │    └─ 注册window.onload事件 ───────┼──────────┐                │
//        │                                     │          │                │
//        │    [用户看到空白/加载页面]         │          │                │
//        │                                     ↓          │                │
//        │                                 CSS加载完成     |                │
//        │                                     │          │                │
//        │                        onCssLoaded() ◄──────┘  │                │
//        │                          ├─ 挂载Mithril UI      │                │
//        │                          ├─ 注册路由            │                │
//        │                          ├─ 初始化插件          │                │
//        │                          └─ 检查RPC连接         │                │
//        │                                                │                │
//        │    [用户看到可交互的UI]                        │                │
//        │                                                ↓                │
//        │                          所有资源加载完成（字体、图片）           │
//        │                                                │                │
//        │                        onWindowLoaded() ◄──────┘                │
//        │                          ├─ 预热Wasm引擎(engine_bundle.js)      │
//        │                          └─ 安装Service Worker                  │
//        │                                                                 │
//        └─────────────────────────────────────────────────────────────────┘
//
// =============================================================================

/**
 * 功能开关：放宽Websocket端口的内容安全策略限制
 * 用途：允许同时使用多个trace_processor_shell实例（不同端口）
 */
const CSP_WS_PERMISSIVE_PORT = featureFlags.register({
  id: 'cspAllowAnyWebsocketPort',
  name: 'Relax Content Security Policy for 127.0.0.1:*',
  description:
    'Allows simultaneous usage of several trace_processor_shell ' +
    '-D --http-port 1234 by opening ' +
    'https://ui.perfetto.dev/#!/?rpc_port=1234',
  defaultValue: false,
});

/**
 * 路由变更处理函数
 * @param route - 当前路由对象
 * 功能：
 *  1. 触发UI全量重绘
 *  2. 如果路由包含锚点，滚动到对应元素
 *  3. 尝试从路由参数加载trace文件
 */
function routeChange(route: Route) {
  raf.scheduleFullRedraw(() => {
    if (route.fragment) {
      // 需在下次重绘后执行（setTimeout(0)可能早于重绘）
      const e = document.getElementById(route.fragment);
      if (e) {
        e.scrollIntoView(); // 滚动到锚点元素
      }
    }
  });
  maybeOpenTraceFromRoute(route); // 从路由加载trace
}

/**
 * 配置内容安全策略(CSP)
 * 作用：限制资源加载来源，防止XSS等安全漏洞
 * 注意：self/sha-xxx需加引号，data:/blob:等URL无需引号
 */
function setupContentSecurityPolicy() {
  // 基础RPC策略（默认端口）
  let rpcPolicy = [
    'http://127.0.0.1:9001', // trace_processor_shell --httpd 默认端口
    'ws://127.0.0.1:9001', // 对应WebSocket端口
    'ws://127.0.0.1:9167', // Web Device Proxy端口
  ];
  
  // 如果开启了"放宽WS端口限制"功能，动态适配路由中的rpc_port参数
  if (CSP_WS_PERMISSIVE_PORT.get()) {
    const route = Router.parseUrl(window.location.href);
    if (/^\d+$/.exec(route.args.rpc_port ?? '')) {
      rpcPolicy = [
        `http://127.0.0.1:${route.args.rpc_port}`,
        `ws://127.0.0.1:${route.args.rpc_port}`,
      ];
    }
  }

  // CSP策略配置项
  const policy = {
    'default-src': [ // 默认资源加载策略
      `'self'`,
      // Google Tag Manager 启动脚本哈希值
      `'sha256-LirUKeorCU4uRNtNzr8tlB11uy8rzrdmqHCX38JSwHY='`,
    ],
    'script-src': [ // 脚本加载策略
      `'self'`,
      // TODO(b/201596551): Wasm兼容临时配置，后续替换为'wasm-unsafe-eval'
      `'unsafe-eval'`,
      'https://*.google.com',
      'https://*.googleusercontent.com',
      'https://www.googletagmanager.com',
      'https://*.google-analytics.com',
    ],
    'object-src': ['none'], // 禁止object标签加载资源
    'connect-src': [ // 网络请求策略（XHR/Fetch/WebSocket）
      `'self'`,
      'ws://127.0.0.1:8037', // adb websocket服务器端口
      'https://*.google-analytics.com',
      'https://*.googleapis.com', // Google云存储
      'blob:',
      'data:',
    ].concat(rpcPolicy), // 拼接RPC相关策略
    'img-src': [ // 图片加载策略
      `'self'`,
      'data:',
      'blob:',
      'https://*.google-analytics.com',
      'https://www.googletagmanager.com',
      'https://*.googleapis.com',
    ],
    'style-src': [`'self'`, `'unsafe-inline'`], // 样式加载策略（允许内联）
    'navigate-to': ['https://*.perfetto.dev', 'self'], // 导航目标限制
  };

  // 创建meta标签注入CSP策略
  const meta = document.createElement('meta');
  meta.httpEquiv = 'Content-Security-Policy';
  let policyStr = '';
  for (const [key, list] of Object.entries(policy)) {
    policyStr += `${key} ${list.join(' ')}; `;
  }
  meta.content = policyStr;
  document.head.appendChild(meta);
}

/**
 * 应用入口函数
 * 执行顺序：
 *  1. 配置CSP（最高优先级）
 *  2. 初始化静态资源
 *  3. 创建配置管理器
 *  4. 注册核心配置项
 *  5. 初始化应用实例
 *  6. 加载CSS（异步）
 *  7. 配置错误处理器
 *  8. 注册调试全局变量
 *  9. 禁用捏合缩放
 *  10. 注册CSS加载完成/窗口加载完成回调
 */
function main() {
  // 优先配置内容安全策略
  setupContentSecurityPolicy();
  initAssets(); // 初始化静态资源路径

  // 创建配置管理器（基于本地存储）
  const settingsManager = new SettingsManagerImpl(
    new LocalStorage(PERFETTO_SETTINGS_STORAGE_KEY),
  );

  // 注册核心配置项 - 时间戳格式
  const timestampFormatSetting = settingsManager.register({
    id: 'timestampFormat',
    name: 'Timestamp format',
    description: 'The format of timestamps throughout Perfetto.',
    schema: z.nativeEnum(TimestampFormat), // Zod校验：枚举类型
    defaultValue: TimestampFormat.Timecode,
  });

  // 注册核心配置项 - 时区覆盖
  const timezoneOverrideSetting = settingsManager.register({
    id: 'timezoneOverride',
    name: 'Timezone Override',
    description:
      "When 'Timestamp Format' is set to 'CustomTimezone', this setting controls which timezone is used.",
    schema: z.enum(Object.keys(timezoneOffsetMap) as [string, ...string[]]),
    defaultValue: '(UTC+00:00) London, Dublin, Lisbon, Casablanca', // 默认UTC
  });

  // 注册核心配置项 - 时长精度
  const durationPrecisionSetting = settingsManager.register({
    id: 'durationPrecision',
    name: 'Duration precision',
    description: 'The precision of durations throughout Perfetto.',
    schema: z.nativeEnum(DurationPrecision),
    defaultValue: DurationPrecision.Full,
  });

  // 注册核心配置项 - 分析数据采集开关
  const analyticsSetting = settingsManager.register({
    id: 'analyticsEnable',
    name: 'Enable UI telemetry',
    description: `
      This setting controls whether the Perfetto UI logs coarse-grained
      information about your usage of the UI and any errors encountered. This
      information helps us understand how the UI is being used and allows us to
      better prioritise features and fix bugs. If this option is disabled,
      no information will be logged.

      Note: even if this option is enabled, information about the *contents* of
      traces is *not* logged.

      Note: this setting only has an effect on the ui.perfetto.dev and localhost
      origins: all other origins do not log telemetry even if this option is
      enabled.
    `,
    schema: z.boolean(),
    defaultValue: true,
    requiresReload: true, // 修改后需重载生效
  });

  // 创建启动命令JSON编辑器（用于配置自动执行的命令）
  const startupCommandsEditor = new JsonSettingsEditor<CommandInvocation[]>({
    schema: commandInvocationArraySchema,
  });

  // 注册核心配置项 - 启动命令
  const startupCommandsSetting = settingsManager.register({
    id: 'startupCommands',
    name: 'Startup Commands',
    description: `
      Commands to run automatically after a trace loads and any saved state is
      restored. These commands execute as if a user manually invoked them after
      the trace is fully ready, making them ideal for automating common
      post-load actions like running queries, expanding tracks, or setting up
      custom views.
    `,
    schema: commandInvocationArraySchema,
    defaultValue: [],
    render: (setting) => startupCommandsEditor.render(setting), // 自定义渲染组件
  });

  // 注册核心配置项 - 启动命令白名单校验
  const enforceStartupCommandAllowlistSetting = settingsManager.register({
    id: 'enforceStartupCommandAllowlist',
    name: 'Enforce Startup Command Allowlist',
    description: `
      When enabled, only commands in the predefined allowlist can be executed
      as startup commands. When disabled, all startup commands will be
      executed without filtering.

      The command allowlist encodes the set of commands which Perfetto UI
      maintainers expect to maintain backwards compatibility for the forseeable\
      future.

      WARNING: if this setting is disabled, any command outside the allowlist
      has *no* backwards compatibility guarantees and is can change without
      warning at any time.
    `,
    schema: z.boolean(),
    defaultValue: true,
  });

  // 初始化应用核心实例
  AppImpl.initialize({
    initialRouteArgs: Router.parseUrl(window.location.href).args, // 初始路由参数
    settingsManager, // 配置管理器
    timestampFormatSetting, // 时间戳格式配置
    durationPrecisionSetting, // 时长精度配置
    timezoneOverrideSetting, // 时区覆盖配置
    analyticsSetting, // 分析数据采集配置
    startupCommandsSetting, // 启动命令配置
    enforceStartupCommandAllowlistSetting, // 启动命令白名单配置
  });

  // 异步加载CSS（加载完成前UI处于未就绪状态）
  const cssLoadPromise = defer<void>();
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = assetSrc('perfetto.css'); // 获取CSS资源路径
  css.onload = () => cssLoadPromise.resolve(); // 加载完成回调
  css.onerror = (err) => cssLoadPromise.reject(err); // 加载失败回调
  
  // 替换favicon图标
  const favicon = document.head.querySelector('#favicon');
  if (favicon instanceof HTMLLinkElement) {
    favicon.href = assetSrc('assets/favicon.png');
  }
  
  // 添加字体加载中样式类
  document.body.classList.add('pf-fonts-loading');
  document.head.append(css);

  // 等待字体加载完成（超时15秒强制移除加载状态）
  Promise.race([document.fonts.ready, sleepMs(15000)]).then(() => {
    document.body.classList.remove('pf-fonts-loading');
  });

  // 加载内部用户检测脚本，并初始化分析工具
  const app = AppImpl.instance;
  tryLoadIsInternalUserScript(app).then(() => {
    app.analytics.initialize(app.isInternalUser); // 初始化分析工具
    app.notifyOnExtrasLoadingCompleted(); // 通知额外资源加载完成
  });

  // 注册错误处理器：同时展示弹窗 & 上报分析数据
  addErrorHandler(maybeShowErrorDialog);
  addErrorHandler((e) => AppImpl.instance.analytics.logError(e));

  // 全局错误监听：JS执行错误 & Promise未捕获异常
  window.addEventListener('error', (e) => reportError(e));
  window.addEventListener('unhandledrejection', (e) => reportError(e));

  // 注册调试全局变量（方便开发者调试）
  registerDebugGlobals();

  // 禁用Ctrl+滚轮捏合缩放（避免干扰UI操作）
  document.body.addEventListener(
    'wheel',
    (e: MouseEvent) => {
      if (e.ctrlKey) e.preventDefault();
    },
    {passive: false}, // 需阻止默认行为，故passive为false
  );

  // CSS加载完成后执行UI挂载逻辑
  cssLoadPromise.then(() => onCssLoaded());

  // 暴露空闲检测方法到全局窗口（供测试/调试使用）
  (window as {} as IdleDetectorWindow).waitForPerfettoIdle = (ms?: number) => {
    return new IdleDetector().waitForPerfettoIdle(ms);
  };

  // 窗口加载完成后执行最终初始化（已完成则立即执行）
  if (document.readyState === 'complete') {
    onWindowLoaded();
  } else {
    window.addEventListener('load', () => onWindowLoaded());
  }
}

/**
 * CSS加载完成后的初始化逻辑
 * 核心操作：
 *  1. 清空初始页面内容，挂载Mithril根组件
 *  2. 注册路由页面（首页/时间轴页）
 *  3. 注册主题/轨道高度等配置项
 *  4. 初始化快捷键 & 浮层容器
 *  5. 开发环境初始化热重载
 *  6. 检查RPC连接，初始化文件拖放/跨窗口消息处理
 */
function onCssLoaded() {
  // 清空初始页面内容（如加载中的pre标签/错误提示）
  document.body.innerHTML = '';

  // 获取应用页面管理器，注册核心页面路由
  const pages = AppImpl.instance.pages;
  pages.registerPage({route: '/', render: () => m(HomePage)}); // 首页
  pages.registerPage({route: '/viewer', render: () => renderTimelinePage()}); // 时间轴页
  
  // 初始化路由并注册路由变更回调
  const router = new Router();
  router.onRouteChanged = routeChange;

  // 注册主题配置项（实验性：暗黑/亮色模式）
  const themeSetting = AppImpl.instance.settings.register({
    id: 'theme',
    name: '[Experimental] UI Theme',
    description: 'Warning: Dark mode is not fully supported yet.',
    schema: z.enum(['dark', 'light']),
    defaultValue: 'light',
  } as const);

  // 注册轨道最小高度配置项
  AppImpl.instance.settings.register({
    id: TRACK_MIN_HEIGHT_SETTING,
    name: 'Track Height',
    description:
      'Minimum height of tracks in the trace viewer page, in pixels.',
    schema: z.number().int().min(MINIMUM_TRACK_MIN_HEIGHT_PX), // 整数 & 最小高度限制
    defaultValue: DEFAULT_TRACK_MIN_HEIGHT_PX,
  });

  // 注册主题切换命令（实验性）
  AppImpl.instance.commands.registerCommand({
    id: 'dev.perfetto.ToggleTheme',
    name: '[Experimental] Toggle UI Theme',
    callback: () => {
      const currentTheme = themeSetting.get();
      themeSetting.set(currentTheme === 'dark' ? 'light' : 'dark'); // 切换主题
    },
  });

  // 挂载Mithril根组件（强制同步渲染）
  raf.mount(document.body, {
    view: () => {
      const app = AppImpl.instance;
      const commands = app.commands;
      const hotkeys: HotkeyConfig[] = [];
      
      // 遍历所有命令，注册默认快捷键
      for (const {id, defaultHotkey} of commands.commands) {
        if (defaultHotkey) {
          hotkeys.push({
            callback: () => commands.runCommand(id),
            hotkey: defaultHotkey,
          });
        }
      }

      // 禁用Mod+P默认打印行为（避免与插件快捷键冲突）
      hotkeys.push({
        hotkey: 'Mod+P',
        callback: () => {},
      });

      // 当前trace ID（无trace时为'no-trace'）
      const currentTraceId = app.trace?.engine.engineId ?? 'no-trace';

      // 关键优化：
      // 1. trace变更时强制重挂载整个UI树（避免缓存脏数据）
      // 2. 主题变更时强制重挂载（确保CSS变量生效）
      const uiMainKey = `${currentTraceId}-${themeSetting.get()}`;

      // 渲染根组件树：主题提供者 → 快捷键上下文 → 浮层容器 → 主UI
      return m(ThemeProvider, {theme: themeSetting.get()}, [
        m(
          HotkeyContext,
          {
            hotkeys, // 快捷键配置
            fillHeight: true, // 填满高度
            focusable: false, // 非聚焦态（独立模式下绑定到document）
          },
          m(OverlayContainer, {fillHeight: true}, m(UiMain, {key: uiMainKey})),
        ),
      ]);
    },
  });

  // 开发环境初始化热重载（本地/127.0.0.1环境，非嵌入/测试模式）
  if (
    (location.origin.startsWith('http://localhost:') ||
      location.origin.startsWith('http://127.0.0.1:')) &&
    !AppImpl.instance.embeddedMode &&
    !AppImpl.instance.testingMode
  ) {
    initLiveReload();
  }

  // 从URL锚点更新RPC端口，并检查RPC连接状态
  // 注：RPC连接确认前不加载trace，避免覆盖已有trace处理器状态
  maybeChangeRpcPortFromFragment();
  checkHttpRpcConnection().then(() => {
    const route = Router.parseUrl(window.location.href);
    
    // 非嵌入模式下安装文件拖放处理器
    if (!AppImpl.instance.embeddedMode) {
      installFileDropHandler();
    }

    // 如果当前trace来自HTTP RPC，跳过postMessage/trace路由加载（避免冲突）
    const traceSource = AppImpl.instance.trace?.traceInfo.source;
    if (traceSource && traceSource.type === 'HTTP_RPC') {
      return;
    }

    // 注册跨窗口消息处理器（支持从其他窗口加载trace）
    window.addEventListener('message', postMessageHandler, {passive: true});

    // 处理初始路由参数（local_cache_key/s/permalink/url等）
    routeChange(route);
  });

  // 初始化插件（核心+非核心）
  // 注册并激活插件 （根据URL参数覆盖激活列表）
  const pluginManager = AppImpl.instance.plugins;
  CORE_PLUGINS.forEach((p) => pluginManager.registerPlugin(p, true));
  NON_CORE_PLUGINS.forEach((p) => pluginManager.registerPlugin(p, false));
  const route = Router.parseUrl(window.location.href);
  const overrides = (route.args.enablePlugins ?? '').split(',');
  pluginManager.activatePlugins(AppImpl.instance, overrides);
}

/** 窗口加载完成后的最终初始化逻辑
 * 核心操作：
 *  1. 安装Service Worker
 *  2. 预热Wasm引擎（提升trace处理速度）
 */
function onWindowLoaded() {
  // These two functions cause large network fetches and are not load bearing.
  AppImpl.instance.serviceWorkerController.install();
  warmupWasmWorker();
}

/** 根据URL片段参数动态修改RPC端口
 * 功能：
 *  1. 解析当前URL，检查是否包含rpc_port参数
 *  2. 如果包含且CSP允许，更新HttpRpcEngine的rpcPort
 *  3. 如果不允许，展示提示模态框，引导用户修改配置
 */   
function maybeChangeRpcPortFromFragment() {
  const route = Router.parseUrl(window.location.href);
  if (route.args.rpc_port !== undefined) {
    if (!CSP_WS_PERMISSIVE_PORT.get()) {
      showModal({
        title: 'Using a different port requires a flag change',
        content: m(
          'div',
          m(
            'span',
            'For security reasons before connecting to a non-standard ' +
              'TraceProcessor port you need to manually enable the flag to ' +
              'relax the Content Security Policy and restart the UI.',
          ),
        ),
        buttons: [
          {
            text: 'Take me to the flags page',
            primary: true,
            action: () => Router.navigate('#!/flags/cspAllowAnyWebsocketPort'),
          },
        ],
      });
    } else {
      HttpRpcEngine.rpcPort = route.args.rpc_port;
    }
  }
}

// ==================== 扩展组件注册区 =====================
configureExtensions({
  addDebugCounterTrack,
  addDebugSliceTrack,
  addVisualizedArgTracks,
  addLegacySqlTableTab: addLegacyTableTab,
  addQueryResultsTab,
});
// ==================== 启动应用入口 =====================
main(); 