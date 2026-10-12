# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在本仓库工作时提供指导。

## 这是什么

浏览器可直接游玩的《璀璨宝石：宝可梦》网页游戏（2–4 人）：本地热座（pass-and-play）、电脑对手（新手 / 普通 / 高手 / 究极四档，另有实验性 AlphaZero 座位）、以及基于 Cloudflare Workers + Durable Objects 的在线联机（房间码 + 邀请链接）。可选扩展：超级进化（Megas）与 PokéMart 商店。**无构建步骤、无打包器、无 npm 依赖**——`index.html` 按顺序加载普通 script，游戏直接运行；双击 `index.html` 也能玩。

## 命令

```bash
# 本地运行（纯静态）
python -m http.server 8000        # 或: npx serve .

# Node 测试 —— 无测试框架、无 package.json。每个文件独立，自带微型 test() 断言框架：
node test/engine.test.js            # 引擎规则 + 100 局自走（计分/进化/结束/筹码守恒/脱敏）
node test/ai.test.js                # AI 强度（对贪心基线胜率）/ 终局 / 延迟
node test/ai_expansions.test.js     # PokéMart/Mega AI、暗牌公平性、搜索稳定性
node test/rules_conformance.test.js # 逐条对照官方规则书的符合性审计
node test/room.test.js              # 联机房间权威（座位/脱敏/重连/持久化/超时代打）
node test/room_lobby.test.js        # 大厅：电脑补位、改难度、随机座位、房主校验
node test/worker_identity.test.js   # Worker 消息处理器（内存存储 + 模拟 WebSocket 的休眠恢复）
node test/worker_ai.test.js         # DO bot 驱动：alarm 节奏 / 逐回合落盘 / 重试降级
node test/net_identity.test.js      # net.js 纯函数（parseRoomCode 等）
node test/megas.test.js             # 超级进化扩展
node test/pokemart.test.js          # PokéMart 商店扩展
node test/invariants.test.js 400    # 模糊测试：合法性 + 筹码/卡牌守恒（参数 = 局数）
node test/tutorial_layout.test.js   # 教程教练气泡布局（纯函数，headless）

# Python Playwright UX 测试（需先跑: python -m http.server 8765 --bind 127.0.0.1）
python test/mobile_ux_audit.py        # 手机/小屏/横屏 UX 审计（截图存 test/_ux_audit/）
python test/tutorial_mobile.test.py chromium   # 或 webkit；实际触摸、缩小视口、断线重进
python test/tutorial_actions.test.py  # 桌面/手机/横屏的商店教程动作流
python test/ui_names.test.py          # 昵称与日志不会被解析为 HTML

# 部署联机（Workers + Durable Objects + 静态资源）
npx wrangler deploy

# AlphaZero 训练（train/ 下独立 Python 代码库，需 CUDA PyTorch）
cd train && python train.py --smoke    # 30s 流水线自检；--hours 9 / --resume 正式训练
node train/parity_test.js              # JS/Python 引擎与动作编码奇偶校验
```

所有 Node 测试从项目根目录运行。`test/` 下另有一批 **A/B 对战与调参工具**（`tune.js`、`ai_exp_ab.js`、`ultra_ab.js`、`vsearch_mp.js`、`ai_tourney.js`、`splendor_report.js` 等），非常规回归，使用前先读 [docs/AI_STRATEGY.md](docs/AI_STRATEGY.md)。

## 架构

### UMD 双环境模式（核心设计决策）

每个核心模块都是带 UMD 包装的 IIFE，在**浏览器**（`window.Engine`、`window.AI`……）和 **Node**（`module.exports`）中行为完全一致——这正是整个规则栈可以 headless 单测的原因。新的共享逻辑模块必须遵循：

```js
(function (root, factory) {
  const api = factory(/* require 依赖，或读 root.* */);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.X = api;
})(this, function () { ... });
```

`index.html` 的 script 加载顺序不可随意改动：`cards.js` → `megas.js` → `pokemart.js` → `engine.js` → `net.js` → `ai.js` → `vsearch.js` → `azai.js` → `ui.js` → `tutorial.js`。

### 分层

- **[js/engine.js](js/engine.js) —— 纯游戏引擎，无 DOM。** 全部规则：setup、动作（`actionTake` / `actionReserve` / `actionCapture` / `actionEvolve` / `actionDiscard` / `actionPass`，及 Mega/PokéMart 变体）、`legalActions` + `applyAction`（唯一的服务端权威校验入口）、`redactFor(state, seat)`（按座位脱敏——牌堆顺序、对手保留牌永不离开权威）、供 AI 搜索用的 `clone`、可种子化 RNG（mulberry32）。动作返回 `{ok:true}` 或 `{ok:false, error}`，error 为**中文用户可读文案**。
- **卡牌数据库**：`js/cards.js` / `js/megas.js` / `js/pokemart.js` 由 TTS 卡面视觉提取**自动生成——勿手改**。Node 测试读相同的 `data/*.json`，两边必须保持同步。引擎按 `id` 索引卡牌；层级 `stage1/2/3`、`rare`、`legend` + `pmL1/2/3`（PokéMart）+ `mega`。
- **[js/ai.js](js/ai.js) —— 评估式、进化感知的 1-ply 搜索。** 难度配置在 `AI.DIFF`（easy/normal/hard，hard 含阻断与 4 份信息集采样）。评估权重 `DEFAULT_W` 由自对弈 SPSA 调优（`test/tune.js` 会针对当前提交的权重重调）。公开接口：`AI.chooseTurn(state, opts)` / `AI.playTurn`；一份回合计划同时覆盖主动作 + 弃球 + 进化。
- **[js/vsearch.js](js/vsearch.js) —— 「究极」档：单树 determinized 信息集 MCTS（SO-ISMCTS-lite）。仅 2 人局**（3–4 人实测弱于启发式——多人搜索被对手/kingmaker 噪声误导——自动回退 hard）。时间预算制（ui.js `ULTRA_CFG = { timeMs: 900 }`），自带固定 RNG，同局面同配置输出可复现。
- **[js/azai.js](js/azai.js) —— AlphaZero 网络的浏览器推理**（权重 `assets/policy.json`，经 `AZAI.setWeights` 加载）。其 **53 动作编码必须与 `train/engine.py` 保持锁步**；`train/parity_test.js` + `train/parity_states.json` 校验 JS/Python 奇偶性。注意 `assets/policy.json` 被 `.assetsignore` 排除、**不随部署发布**——线上「AlphaZero(实验)」座位实际回退启发式。
- **[js/room.js](js/room.js) —— 联机房间权威，传输无关。** 同一个类既跑在 Durable Object 里，也 headless 跑在测试中。持有规范状态，用 `applyAction` 校验每步（按座位守护所有权），只发送 `redactFor` 输出。身份 = 客户端稳定 `token`（重连回收座位 + 隐藏手牌）；**房主 = `hostToken` 而非座位号**（大厅座位可洗牌/增删，房主换座仍是房主）。AI 座位由权威自己的 `stepAI()` 驱动，客户端无法操纵 bot。Wire 协议完整记录在文件头。
- **[worker/index.js](worker/index.js) —— 仅传输，零规则。** 每房间码一个 Durable Object（`/room/:code/ws`）、WebSocket Hibernation、`MUTATING` 集合内的每条变更消息（join/start/action/name/rematch/takeover/addAI/removeAI/aiLevel/shuffle）都落盘快照。DO alarm 以 1.2s 间隔逐个驱动 bot 回合（无真人连接时暂停，任意入站消息会重新布防丢失的 alarm）。心跳 ping/pong 由 runtime 的 `setWebSocketAutoResponse` 应答，**从不唤醒 DO**——因此空闲大厅几十秒即被驱逐，一切状态变更必须落盘（生产实测过的教训）。
- **[js/net.js](js/net.js) —— 客户端传输（`window.Net`）。** WebSocket、localStorage 每房间 token、自动重连（1.5s）、`parseRoomCode` 能从粘贴的整条邀请链接解析出房间码。不含任何规则。
- **[js/ui.js](js/ui.js) —— 全部 UI/交互。** 究极等重搜索在 Web Worker（[js/ai.worker.js](js/ai.worker.js)）中离主线程运行——worker `importScripts` 同一批引擎/AI 文件，搜索在「思考中」停顿期间并行执行。含旧 Safari 的 WebP→JPEG 探测兜底（`?nowebp=1` 可强制触发）、悔棋、每回合快照存 localStorage（「继续上一局」）、超时代打入口。
- **[js/tutorial.js](js/tutorial.js) —— 三套引导教程**（基础 / Mega / PokéMart）；导出 `placeBubble`（纯布局函数）供 Node 测试。
- **[sw.js](sw.js) —— PWA service worker。** app shell（html/css/js/json）**network-first**，卡图等资产 cache-first。**改任何 shell 文件后必须 bump `VER`**，否则玩家一直拿到旧代码。
- **[train/](train/README.md) —— AlphaZero 训练的独立 Python 代码库**（纯 PyTorch；`engine.py` 是 js/engine.js 的忠实移植）。行为克隆热启动 → MCTS 自对弈 → 训练 → 评估，产物 `ckpt/policy.json` 供前端。

### 状态序列化模式

游戏状态跨边界（WebSocket、worker postMessage、DO 快照）时只传 JSON-safe 的**动态**状态；静态卡牌引用（`cardDB`、`byId`、`megaDB`、`pokemartDB`、`_byName` 缓存）**发送前剥离、接收后重挂**（见 room.js 与 ai.worker.js 的 `reattach`）。`Engine.clone` 刻意共享这些静态引用以省内存。

### 联机请求流

客户端（net.js）⇄ WebSocket ⇄ Worker 默认导出把 `/room/:code/ws` 路由到每房间码一个 Durable Object ⇄ `Room` 权威（room.js）校验 + 脱敏 + 持久化快照。其余路径全部回落静态 ASSETS（仓库根目录；`.assetsignore` 排除 test/train/worker/.wrangler 等）。部署用 SQLite-backed DO（Free plan 可用），自定义域名 `pokemon-splendor.734007.xyz`。

## 约定与坑

- 注释、UI 文案、日志以中文为主；标识符与 wire 协议是英文。跟随所在文件的风格。
- 内部球色代码 `red/blue/black/pink/yellow` + `purple`（= 大师球，万能）只在 UI/i18n 助手（engine.js 的 `zhBall`/`zhTier`）映射成宝可梦球名。
- Rare/Legend 牌堆用固定配色均衡池（`E.CANON_SPECIAL`，每色各 1 张、每张 2 同色折扣）而非完整 10 张池——测试对此有断言。
- `test/*_frozen.js` 及 `test/ai_v1.js` 是**冻结的历史版本快照，专作 A/B 基线对手——勿修改**。A/B 方法论（固定种子、候选轮换全部座位以控制牌序与先后手）见 [docs/AI_STRATEGY.md](docs/AI_STRATEGY.md)，其中还记录了被评测否决的实验——**调 AI 权重前必读**。
- [docs/POKEMART_PLAN.md](docs/POKEMART_PLAN.md) 是 PokéMart 扩展的权威规格；引擎会拒绝捕捉效果不在 `PM_EFFECTS_LIVE` 中的 PokéMart 卡，而不是静默误触。
- 联机超时 3 分钟（room.js `TURN_TIMEOUT_MS`）后，任何在座玩家可发 `takeover` 让 AI 仅凭公共信息代打该人类座位一回合。
- 进化是回合结束的**免费**动作（只看永久折扣，不消耗手中精灵球），每回合至多 1 次——AI 搜索把主动作 + 弃球 + 进化作为一条计划评估，改动时要保持这一点。
