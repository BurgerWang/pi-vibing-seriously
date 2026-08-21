# Pi 治理框架两阶段修复执行规格 v1.0

| 元数据 | 值 |
| --- | --- |
| 版本 | `1.0` |
| 状态 | **FROZEN** |
| Program ID | `pi-governance-repair-v1` |
| 冻结日期 | `2026-08-17` |
| 冻结基线 | `main` @ `afca84f` |
| 执行仓库 | `pi-dev-workbench` |
| 人类授权 | 用户已批准本规格描述的两阶段修复方案及计划落地 |
| 决策权 | Sol 拥有需求、跨模块架构、范围、验收标准、最终审查与阶段判定权 |
| 写入权 | 依照当前 worker-first 合同，由新鲜、边界明确的 worker 执行常规源码、测试、文档和配置写入 |

本文件是 `pi-governance-repair-v1` 的完整、持久、可独立执行的规格，
不依赖任何聊天记录作为权威来源。后续实现、审查、验证、迁移与回滚
必须引用本文件中的工作包编号和验收条件编号。机器进度镜像位于
`.pi/workbench/runs/pi-governance-repair-v1/execution-state.json`；该镜像只记录
进度，不能代替本规格、真实 diff、测试证据或 Sol 的验收判定。

本规格冻结后不得为了记录微步骤而反复改写。架构、范围或验收条件发生
实质变化时，必须由 Sol 提出版本化 amendment，经用户批准后形成新版本；
状态、delegation ID、run ID 和证据路径只进入机器进度镜像或工作台 ledger。

---

## 1. 目标

本计划在不削弱正式发布安全边界的前提下，完成以下目标：

1. 关闭审计确认的全部 P0 正确性缺陷：空 SUCCESS、非事务 ledger、
   大文件 diff 漏检、artifact/run/gate 假 PASS。
2. 关闭审计确认的全部 P1 效率与状态治理缺陷：无关变化触发 STALE、
   session/project authority 分叉、低风险修改成本过高、重复 orientation、
   重复完整验证、人工 gate 泛化、receipt 持续膨胀。
3. 将 `extensions/workbench-runtime/index.ts` 从承载多套业务状态机的单体
   重构为仅负责依赖装配、事件注册和生命周期入口的 composition root，
   目标规模约 1,500–2,000 行。
4. 建立两条清晰而可审计的路径：低成本、增量、按真实变更失效的开发
   路径，以及严格、完整、绑定当前状态的正式验证路径。
5. 用事务、可验证身份和故障注入提高可靠性，而不是通过增加人工步骤
   获得表面上的治理强度。

## 2. 范围与非目标

### 2.1 纳入范围

- Delegation lifecycle、ledger、task kind、worker finish、review 与 diff identity。
- Worker write journal、完整内容哈希、workspace drift 与 change attribution。
- 项目级 authority、session 镜像、启动对账与恢复。
- Recipe schema、artifact contract、run record、gate evidence 与外部产物根。
- v1 记录兼容读取、v2 新写入、partial record 隔离和显式恢复。
- 风险分层执行通道、严格受限 mechanical lane 和 worker orientation capsule。
- Validation evidence graph、人工 gate 适用性和重复验证消除。
- Tool-result receipt 的事务存储、容量、保留和 legacy 只读兼容。
- Runtime controller 解耦和 `index.ts` composition-root 化。
- 里程碑文档简化、观测指标、迁移、回滚与真实 Pi 端到端验证。

### 2.2 非目标

- 不重写外部项目自己的 source-content、successor、production pin 或业务
  authority 规则。
- 不更换 worker 模型或 provider。
- 不把 Pi workbench 声称为操作系统级安全沙箱。
- 不处理与本计划无关的代码清理、格式化或产品功能。
- 不自动删除任何历史 delegation、run、receipt、artifact 或 authority 记录。
- 不在没有用户请求时 commit、push、发布或创建 PR。

### 2.3 路径记法

各工作包“影响文件”中的 `core/*`、`worker/*`、`runtime/*` 分别解析为
`extensions/workbench-runtime/core/*`、`extensions/workbench-runtime/worker/*`、
`extensions/workbench-runtime/runtime/*`；`tests/*` 和 `docs/*` 均相对仓库根。
“拟新增”文件名是架构边界，不是允许 worker 自行扩张路径的授权；每次实际
delegation 仍必须由 Sol 给出精确的 project-relative path scope。

## 3. 必须保持的安全不变量

以下不变量在两个阶段中始终有效：

1. Worker 报告、退出码或自然语言 SUCCESS 永远不是验收证据。
2. 所有写入必须通过项目根、realpath、symlink 和批准路径约束。
3. 安全、权限、治理策略、持久化 schema、破坏性迁移、正式 authority 与
   release 路径继续使用严格 worker-first。
4. 已消费 nonce、corpus、production authority 和不可变正式证据不得复用。
5. 正式发布 preflight 必须检查当前可见状态；缓存不能代替当前探测。
6. 缺失、损坏、身份冲突、来源不明和状态分叉必须 fail-closed。
7. 缓存命中不是 PASS；只有可验证、完整且仍有效的 evidence attestation
   才能被 gate 消费。
8. 历史记录不自动删除；任何清理必须先 dry-run，并另行取得用户授权。
9. 计划中尚未运行的检查只能标记为 `NOT_RUN`，不得推断为 PASS。
10. Worker 写入报告不构成 acceptance；只有 Sol 能把证据映射到验收条件。

## 4. 术语与判定语义

| 术语 | 定义 |
| --- | --- |
| transaction | 包含业务动作、完整持久化、严格回读和 commit marker 的原子生命周期 |
| committed generation | 已完整写入、严格校验并通过唯一 commit marker 发布的一代记录 |
| worker delta | 被 worker write journal 归因、具有完整 before/after identity 的变更集合 |
| workspace drift | 未被当前 worker journal 归因的并发或既有工作区变化 |
| current evidence | 在 gate 执行时重新探测当前可见状态所得证据 |
| immutable snapshot | 内容寻址、身份固定且验证完整的不可变证据副本 |
| progress mirror | 可丢弃并可从权威数据重建的机器进度视图，不拥有验收权 |
| composition root | 只装配依赖、注册入口和管理生命周期，不直接实现业务状态机的入口模块 |

所有工作包、阶段门和验证项只能使用以下状态：

- `PASS`：所列验收条件全部由当前、可复核证据满足，且由 Sol 判定。
- `FAIL`：至少一项验收条件被证据证明不满足。
- `BLOCKED`：存在明确外部阻断，无法安全继续；必须记录阻断条件和恢复入口。
- `NOT_RUN`：尚未执行、证据不完整或尚未由 Sol 判定。

`SUCCESS` 只用于描述运行或事务自身的结果，不得替代上述验收判定。

`NOT_APPLICABLE` 只是一项带条件检查的适用性结果，不是第五种工作包、阶段门、
验证项或总体验收状态。只有在当前证据证明该检查不适用时，才能将它从该 gate
的 applicable required-check set 中移除，并保留适用性判定证据；它不得被呈现、
计数或升级为 `PASS`。移除不适用检查后，包含它的 gate 仍只能使用 `PASS`、
`FAIL`、`BLOCKED`、`NOT_RUN` 四种判定状态。

## 5. 审计问题与工作包追踪

| ID | 严重度 | 问题 | 关闭工作包 |
| --- | --- | --- | --- |
| P0-01 | P0 | implementation worker 可退出成功但没有真实 diff | S1.1 |
| P0-02 | P0 | delegation ledger 多文件写入非事务化，缺失 manifest 仍可能完成 | S1.1 |
| P0-03 | P0 | 大于 4 MiB 文件仅使用前缀加大小，可能漏掉同尺寸尾部修改 | S1.2 |
| P0-04 | P0 | recipe 退出 0 不要求必需 artifact，gate 可相信失效路径或失败 run | S1.4 |
| P1-01 | P1 | 全脏工作区重复扫描，成本不与实际 touched paths 成正比 | S1.2、S2.0 |
| P1-02 | P1 | review 绑定整工作区哈希，无关变化导致 STALE | S1.2 |
| P1-03 | P1 | session/project authority 分叉或 session 切换后丢失阻塞状态 | S1.3 |
| P1-04 | P1 | 所有修改统一支付完整 worker-first 成本 | S2.1 |
| P1-05 | P1 | fresh worker 重复读取相同规格与仓库背景 | S2.2 |
| P1-06 | P1 | 相同状态下重复执行完整 typecheck/unit/check | S2.3 |
| P1-07 | P1 | 人工 gate 无适用性与精确失效条件 | S2.3 |
| P1-08 | P1 | 每个工具调用都持久化文件对，receipt 持续增长 | S2.4 |
| P1-09 | P1 | ledger/run/receipt 缺少统一容量和保留治理 | S1.5、S2.4 |
| P1-10 | P1 | `index.ts` 超过 6,000 行且耦合多个状态机 | S2.5 |
| P1-11 | P1 | 微步骤、ID 和主文档同步成本过高 | S2.6 |

## 6. 两阶段依赖图与硬边界

```text
Stage 1 — 正确性与事务基础
S1.0 → S1.1 → S1.2 → S1.3 → S1.4 → S1.5 → Stage-1 Exit Gate
                                                        |
                                                        | 全部 PASS 才可进入
                                                        v
Stage 2 — 效率、存储与架构解耦
S2.0 → S2.1 → S2.2 → S2.3 → S2.4 → S2.5 → S2.6 → Final Exit Gate
```

- 任一 Stage 1 exit criterion 不是 `PASS` 时，禁止进入 Stage 2。
- 禁止在 Stage 1 事务语义尚未稳定时先启用 fast lane 或大规模拆分 `index.ts`。
- S2.5 必须逐 controller 提取，禁止 big-bang `index.ts` 重构。
- 同一 worker slice 不得跨越工作包边界，除非本规格明确将其定义为单一原子迁移。

## 7. 当前 worker-first 执行协议

每个工作包按以下协议执行：

1. Sol 先确认前置条件、风险等级、批准路径和验收 ID。
2. 每个常规写入切片交给一个新鲜 bounded worker；任务合同必须引用本规格
   的工作包和具体 acceptance ID。
3. Worker 只拥有合同列出的路径，不得顺手重构或清理相邻代码。
4. Worker 必须同时提交行为实现、相应测试和必要文档，不得使用 stub/TODO。
5. Worker 运行工作包要求的 focused recipe，只报告命令与观察结果，不宣告验收。
6. Sol 使用实际 diff 和 ledger 审查，不接受 worker prose 替代证据。
7. 发现缺陷时，Sol 固定根因和修复边界后交给新的 repair worker。
8. 工作包退出由 Sol 映射全部 acceptance ID；任何未验证项保持 `NOT_RUN`。
9. 每阶段末运行完整验证矩阵和真实 Pi E2E，再作阶段判定。
10. 没有用户明确请求时，不 commit、不 push、不发布。

---

# Stage 1：P0 正确性与事务基础

## 8. Stage 1 Entry Gate

进入 Stage 1 前必须确认：

- `main` 基线为 `afca84f`，或由 Sol 记录并批准新的等价基线。
- 工作区状态已记录，不能覆盖用户已有改动。
- 本规格状态为 `FROZEN`，机器状态指向 `S1.0`。
- 现有 public tool/schema 行为尚未被未知改动改变。

初始状态：`NOT_RUN`。

## 9. S1.0 — 基线冻结与兼容合同

### 目的与依赖

为后续所有事务和重构建立可复核的 v1 行为、schema、存储与性能基线。
依赖 Stage 1 Entry Gate，不依赖其他工作包。

### 设计与步骤

1. 枚举 delegation、run、gate、receipt、validation evidence 的当前 schema。
2. 固化 public tool 名称、参数、返回结构、错误码和恢复语义。
3. 为每类 v1 记录建立合法、缺失字段、损坏、部分写入和身份冲突 fixtures。
4. 记录当前存储数量、字节、最大记录和读取/写入时间基线。
5. 增加 characterization tests，区分“必须保持的外部合同”和“将被修正的缺陷”。
6. 决定每类 v1 证据能否只读展示、恢复，或参与当前正式 gate；默认不得
   将不完整 v1 记录升级为当前正式证据。

### 影响文件

- 现有：`core/delegation-ledger.ts`、`core/delegation-state.ts`、
  `core/recipe-runner.ts`、`core/gate-engine.ts`、`core/tool-result-recovery.ts`、
  `core/validation-evidence.ts`、`core/tool-catalog.ts`、相关 tests/docs。
- 拟新增：`tests/fixtures/governance-v1/**`、schema/contract fixture helpers。

### 验收条件

- `S1.0-AC01`：所有 v1 权威记录类型都有合法与故障 fixture。
- `S1.0-AC02`：public tool 输入输出和错误语义有 characterization 快照。
- `S1.0-AC03`：v1→v2 兼容矩阵明确区分 read、recover、gate-eligible。
- `S1.0-AC04`：存储与运行成本基线可复算，记录命令、commit 和时间。
- `S1.0-AC05`：本工作包不改变生产运行语义。

### 测试要求

- 正向：每类合法 v1 fixture 可按合同读取。
- 负向：缺失、截断、错误 ID、错误 schema version 不得被视为完整记录。
- 故障注入：逐文件缺失和解析失败产生稳定、可分类错误，不发生写入。

### 证据输出

兼容矩阵、fixture inventory、public contract snapshot、存储/性能基线、
focused test run IDs、Sol diff review。

### 兼容与回滚

本包只新增测试、fixture 和说明，不迁移生产数据。回滚只移除新增测试资产，
不得改写任何历史记录。

### 退出条件

`S1.0-AC01` 至 `S1.0-AC05` 全部 PASS，且 focused tests PASS。

## 10. S1.1 — Delegation Transaction v2

### 目的与依赖

使 delegation SUCCESS 同时代表 worker 运行、真实行为、完整持久化和项目
authority 均已原子完成。依赖 S1.0 PASS。

### 设计与步骤

1. 引入 `task_kind: implementation | diagnosis | mechanical`；Stage 1 仅启用
   `implementation` 和 `diagnosis`，`mechanical` 保持不可选择。
2. 状态机固定为 `PREPARED → RUNNING → COMMITTING → FINISHED/PENDING_REVIEW
   → REVIEWED`，失败分支为 `FAILED | ABORTED | RECOVERY_REQUIRED`。
3. Worker 启动前提交可恢复的 PREPARED/RUNNING 身份。
4. finish 将 report、usage、before、after、summary、scope、identity 和 review
   placeholder 写入唯一 staging generation。
5. 严格回读 delegation ID、task kind、worker identity、文件集合、记录数和
   内容哈希，最后以 commit marker 或原子目录提交发布。
6. 任意记录缺失、损坏或身份不匹配时返回 transaction/storage failure，
   保留可诊断 partial generation，但不得返回 SUCCESS。
7. implementation 要求非空真实 delta 且所有路径在 scope 内；diagnosis 要求
   零 delta、零成功写入、零被拒绝越权写尝试。

### 影响文件

- 现有：`core/delegation-ledger.ts`、`core/delegation-state.ts`、
  `core/tool-catalog.ts`、`worker/runner.ts`、`worker/handoff.ts`、`index.ts`、
  delegation/runner/wiring tests、`docs/worker-delegation.md`。
- 拟新增：`core/delegation-transaction.ts`、v2 schema/types、fault-injection
  storage adapter 和 fixtures。

### 验收条件

- `S1.1-AC01`：implementation 零 delta 永远不能 SUCCESS。
- `S1.1-AC02`：diagnosis 仅在零写入且报告完整时成功。
- `S1.1-AC03`：只有完整 committed generation 能进入 PENDING_REVIEW。
- `S1.1-AC04`：实际 changed paths 全部受批准 scope 约束。
- `S1.1-AC05`：重复 finish、并发 finish、错误 ID 和身份冲突均 fail-closed。
- `S1.1-AC06`：任一持久化步骤失败都不会产生 finished transaction。
- `S1.1-AC07`：worker prose、退出码和 provider success 不能绕过后置条件。

### 测试要求

- 正向：implementation 非空范围内 delta；diagnosis 零写入；正常 review 转移。
- 负向：零 diff implementation、diagnosis 写入、越界路径、错误 worker/model、
  重复/并发 finish、错误 delegation ID。
- 故障注入：manifest/report/usage/before/after/summary/commit marker 每一步的
  写失败、重命名失败、回读失败、截断和损坏。

### 证据输出

状态机测试、逐步骤 fault matrix、transaction directory inventory、真实 worker
run ID、worker delta、Sol review 和 focused recipe 结果。

### 兼容与回滚

v1 ledger 只读可见；所有新 delegation 在 feature wiring 生效后写 v2。
代码回滚不得删除 v2 generation，旧版本必须至少识别“存在未知高版本记录”
并 fail-closed。

### 退出条件

`S1.1-AC01` 至 `S1.1-AC07` 全部 PASS，所有 fault points 被覆盖，真实 child
worker 成功与失败路径均已演练。

## 11. S1.2 — ChangeSet v2

### 目的与依赖

建立准确、增量、可归因的 worker delta，消除 4 MiB 前缀身份和整棵脏工作区
重复扫描。依赖 S1.1 PASS。

### 设计与步骤

1. 在现有 edit/write guard 中记录 worker write journal。
2. 首次触碰路径时捕获完整 before identity；结束时流式计算完整 SHA-256。
3. Git status 用于交叉核验，不再作为 worker 归因的唯一来源。
4. journal 外变化标记为 `workspace drift`；worker 路径同时被外部进程修改时
   标记 conflict，禁止自动归因。
5. 分离 `worker_delta_hash` 和 `workspace_guard_hash`。
6. review scope、patch 和 acceptance 绑定 worker delta；只有 worker 路径、
   明确依赖闭包、相关 recipe/policy/schema 变化或来源不明时才 STALE。
7. changed-path 数量和读取字节设硬上限；达到上限 fail-closed，不允许截断
   后继续成功。

### 影响文件

- 现有：`core/delegation-ledger.ts`、`core/diff-review.ts`、
  `core/delegation-state.ts`、`worker/path-scope.ts`、`index.ts`、diff/delegation
  tests。
- 拟新增：`core/change-set.ts`、`core/write-journal.ts`、streaming identity helper。

### 验收条件

- `S1.2-AC01`：大于 4 MiB 文件的同尺寸尾部修改被检测。
- `S1.2-AC02`：已脏文件的本轮变更可准确归因。
- `S1.2-AC03`：无关 artifact/report 漂移不令已审查 source delta STALE。
- `S1.2-AC04`：worker 路径并发外部修改产生 conflict。
- `S1.2-AC05`：小修改读取量与 touched paths 成正比。
- `S1.2-AC06`：超过路径/字节边界时明确失败，不截断、不漏报。

### 测试要求

- 正向：新建、修改、删除、rename、已脏文件、多路径、Unicode 路径。
- 负向：symlink 逃逸、越界路径、unknown origin、依赖闭包变化、上限溢出。
- 故障注入：文件在 hash 前后变化、读失败、写 journal 失败、Git status 与
  journal 不一致、并发修改。

### 证据输出

完整 hash vectors、并发测试记录、扫描字节/耗时前后对比、diff-review run、
workspace drift 示例和 Sol review。

### 兼容与回滚

旧 hash 只能用于展示，不能升级为 v2 worker identity。切换前保留旧路径；
回滚时若发现 v2 journal，必须阻止把它解释为旧完整 snapshot。

### 退出条件

`S1.2-AC01` 至 `S1.2-AC06` 全部 PASS，完整 hash 与 split-hash review 在真实
dirty-worktree 场景通过。

## 12. S1.3 — Project Authority Store 与 session 对账

### 目的与依赖

使项目磁盘记录成为 delegation/review 权威，session entry 仅作为可重建镜像。
依赖 S1.2 PASS。

### 设计与步骤

1. 建立项目级 current authority：delegation ID、lifecycle、generation/hash、
   worker delta hash、review 状态、schema version 和更新时间。
2. authority 更新与 delegation transaction commit 使用同一事务边界或可证明
   原子的 commit protocol。
3. session_start 读取最新 committed project authority，再读取 session entry，
   执行 identity/state reconciliation。
4. session 缺失而项目记录完整时从项目恢复；session 损坏不能清除项目阻塞。
5. 两者冲突或项目记录损坏时进入 RECOVERY_REQUIRED，阻塞新 delegation 与
   VERIFY，并提供只读 diagnose 和显式 reconcile。

### 影响文件

- 现有：`core/delegation-state.ts`、`core/state.ts`、
  `core/milestone-handoff.ts`、`index.ts`、session/delegation tests。
- 拟新增：`core/project-authority-store.ts`、reconciliation tests/fixtures。

### 验收条件

- `S1.3-AC01`：新 session 能发现项目中未审查 delegation。
- `S1.3-AC02`：session append 失败不丢失项目阻塞状态。
- `S1.3-AC03`：损坏 session 不覆盖完整项目 authority。
- `S1.3-AC04`：损坏项目 authority 不自动采用乐观 session 状态。
- `S1.3-AC05`：冲突进入 RECOVERY_REQUIRED 且恢复操作可审计。
- `S1.3-AC06`：diagnose/reconcile 不修改源文件或历史 transaction。

### 测试要求

- 正向：session restart、`/new`、正常 review 恢复、镜像重建。
- 负向：旧 session、新项目 generation、错误 hash、双 current pointer。
- 故障注入：authority commit、session append、reconcile 中断和读损坏。

### 证据输出

reconciliation truth table、restart E2E、故障注入矩阵、authority snapshots、
focused run IDs 和 Sol review。

### 兼容与回滚

session entry 保留但降级为镜像。v1 无项目 pointer 时只读发现最新合法记录，
不得猜测 REVIEWED。回滚不得清除 v2 authority。

### 退出条件

`S1.3-AC01` 至 `S1.3-AC06` 全部 PASS，restart/recovery 真实 Pi E2E 通过。

## 13. S1.4 — Artifact/Run/Gate Transaction v2

### 目的与依赖

使 recipe/gate SUCCESS 必须绑定成功进程、完整 run transaction 和满足合同的
实际 artifact。依赖 S1.3 PASS。

### 设计与步骤

1. artifact schema 从字符串升级为对象，支持 `required`、`min_count`、
   `max_count`、`type`、`min_bytes`、`max_bytes`、`sha256`、
   `freshness: current | immutable-snapshot`、`snapshot` 和
   `root: project | authorized-external`。
2. Recipe SUCCESS 定义为：进程成功 + run transaction committed + 所有必需
   artifact 存在且身份有效 + freshness/snapshot policy 满足。
3. manifest、command、environment、stdout、stderr、summary、artifact manifest
   全部写入 staging，严格回读后一次提交。
4. `listRuns` 与 gate 只消费 committed run；partial run 可诊断但不可进入 gate。
5. content-addressed snapshot 覆盖所有声明为 immutable 的 authority artifact，
   不再限制为小型 JSON。
6. `current` artifact 在 gate 时重新 stat/hash；不得只相信历史路径列表。
7. 外部根必须显式配置、realpath 授权、防 symlink 逃逸，并执行
   `produce → 独立新进程 current-state probe → validate → READY commit`。
8. 错误分类至少包括 `PROCESS_FAILED`、`RUN_RECORD_COMMIT_FAILED`、
   `REQUIRED_ARTIFACT_MISSING`、`ARTIFACT_IDENTITY_FAILED`、
   `EXTERNAL_ROOT_UNAUTHORIZED`。

### 影响文件

- 现有：`core/recipe-schema.ts`、`core/recipe-runner.ts`、`core/runs.ts`、
  `core/run-result.ts`、`core/gate-schema.ts`、`core/gate-engine.ts`、
  `core/validation-evidence.ts`、recipes/gates config、相关 tests/docs。
- 拟新增：`core/run-transaction.ts`、`core/artifact-contract.ts`、
  `core/artifact-snapshot-store.ts`、external-root probe helper。

### 验收条件

- `S1.4-AC01`：退出 0 但缺失必需 artifact 的 recipe 失败。
- `S1.4-AC02`：gate 不能使用失败、partial、身份失效或非 committed run。
- `S1.4-AC03`：current artifact 在 gate 时重新验证当前状态。
- `S1.4-AC04`：immutable snapshot 内容寻址且能检测替换/损坏。
- `S1.4-AC05`：外部根必须显式授权并通过独立新进程 probe。
- `S1.4-AC06`：run/gate 任一持久化失败都不能产生可消费 SUCCESS。
- `S1.4-AC07`：同名较新失败 run 不得回退到不明确的乐观选择。

### 测试要求

- 正向：可选/必需 artifact、多个匹配、current/snapshot、授权外部根。
- 负向：退出 0 无 artifact、退出非零留 artifact、run 后删除/替换、同路径
  不同内容、未授权外部根、symlink 逃逸、零字节/错误类型/数量不符。
- 故障注入：run/gate 各文件写失败、回读失败、rename 失败、probe 后变化、
  snapshot 损坏、并发 run。

### 证据输出

artifact contract fixtures、fault matrix、current-vs-snapshot E2E、外部根 probe
记录、run/gate IDs、Sol review 和 focused recipe 结果。

### 兼容与回滚

v1 string glob 可只读转换为明确的 legacy optional contract，但不得自动获得
`required` 或正式 authority。所有新正式 recipe 必须使用 v2。回滚不得删除
CAS/snapshot；旧版本遇到 v2 READY 必须 fail-closed。

### 退出条件

`S1.4-AC01` 至 `S1.4-AC07` 全部 PASS，失败 run 残留 artifact、当前文件替换
和外部根消失的真实 E2E 均正确失败。

## 14. S1.5 — v1 迁移、恢复与 Stage 1 集成

### 目的与依赖

在不改写或删除历史记录的情况下启用 v2 新写入，并证明整体恢复和回滚路径。
依赖 S1.1–S1.4 全部 PASS。

### 设计与步骤

1. 保持 v1 delegation/run/gate/receipt 只读可见。
2. 新 transaction 统一写 v2；不对历史记录原地升级。
3. 建立 legacy index/quarantine，区分 valid、partial、corrupt、unknown-version。
4. 提供 dry-run inventory 与 reconcile 计划；迁移不得自动删除历史记录。
5. 通过单独 wiring slice 激活 v2，确保可回退且数据保持向前可识别。
6. 执行 Stage 1 全部 focused recipes、完整 `check` 和真实 Pi E2E。

### 影响文件

- 现有：S1.1–S1.4 所列模块、`index.ts`、README/docs、release/migration tests。
- 拟新增：legacy reader/index、quarantine metadata、migration inventory command。

### 验收条件

- `S1.5-AC01`：v1 合法记录仍可只读检查，partial 不可参与当前 gate。
- `S1.5-AC02`：所有新 delegation/run 使用 v2 committed transaction。
- `S1.5-AC03`：迁移过程零自动删除、零历史原地改写。
- `S1.5-AC04`：代码回滚不误读 v2 为“无权威”或 v1 SUCCESS。
- `S1.5-AC05`：Stage 1 验证矩阵与 Pi E2E 全部通过。
- `S1.5-AC06`：恢复文档包含诊断、显式 reconcile 和停止条件。

### 测试要求

- 正向：v1/v2 混合读取、新写 v2、restart、review、artifact gate。
- 负向：partial legacy、未知高版本、双 pointer、旧代码读取新数据。
- 故障注入：激活中断、inventory 中断、reconcile 失败、磁盘容量不足。

### 证据输出

dry-run inventory、compatibility matrix、migration/recovery rehearsal、完整 run IDs、
Pi E2E transcript、Sol final Stage 1 review。

### 兼容与回滚

激活必须是单独 wiring slice；回滚只回退 wiring，不删除 v2 数据。若旧代码
不能安全识别 v2，则回滚被阻止并进入 RECOVERY_REQUIRED。

### 退出条件

`S1.5-AC01` 至 `S1.5-AC06` 全部 PASS，并满足 Stage 1 Exit Gate。

## 15. Stage 1 Exit Gate

只有以下条件全部 PASS 才能进入 Stage 2：

- S1.0–S1.5 的每个 acceptance ID 均为 PASS。
- 零-diff implementation、ledger/run/gate fault-injection、4 MiB 尾部修改、
  session restart、artifact current-state failure 均有当前证据。
- v1 compatibility、v2 new-write 和 rollback rehearsal 通过。
- `worker-efficiency-test`、`diff-review-efficiency-test`、
  `gate-preflight-test`、`runtime-core-test`、`typecheck`、`unit-test`、`check`
  按验证矩阵运行并 PASS。
- Sol 已审查全部真实 diff，且没有未处置的 P0/P1-stage-1 缺陷。

初始状态：`NOT_RUN`。禁止以“基本完成”“测试大多通过”或 worker SUCCESS
替代本阶段出口。

---

# Stage 2：P1 效率治理、Receipt Store 与架构解耦

## 16. Stage 2 Entry Gate

Stage 2 Entry Gate 的唯一入口是 Stage 1 Exit Gate 全部 PASS。任何 Stage 1
项目处于 FAIL、BLOCKED 或 NOT_RUN 时，本 gate 必须保持 NOT_RUN/BLOCKED，
不得开始 fast lane、evidence reuse 或 `index.ts` 拆分。

## 17. S2.0 — 性能与浪费观测基线

### 目的与依赖

建立可重复的端到端性能基线，保证“提速”由数据而不是主观感受证明。
依赖 Stage 2 Entry Gate PASS。

### 设计与步骤

记录 delegation 启动、orientation turns/tokens、首次写入延迟、changed paths、
读取字节、transaction 提交时间、review/STALE 原因、recipe 执行与复用、完整
测试重复次数、receipt 写入和因持久化失败重派次数。定义固定的机械修改、
普通 implementation、高风险修改和 artifact failure benchmark 场景。

### 影响文件

- 现有：`core/output-control-telemetry.ts`、`core/report.ts`、delegation/run/receipt
  controllers 与 tests/docs。
- 拟新增：`core/governance-telemetry.ts`、benchmark fixtures/report schema。

### 验收条件

- `S2.0-AC01`：每项指标有单位、起止点、采集源和隐私边界。
- `S2.0-AC02`：固定场景可重复运行并绑定 commit/config/toolchain。
- `S2.0-AC03`：指标不记录 prompt、文件内容、secret 或用户数据。
- `S2.0-AC04`：基线和回归阈值形成可机读报告。

### 测试要求

- 正向：完整/缺失可选指标、跨 session 聚合。
- 负向：非数值、负数、时钟回拨、重复事件。
- 故障注入：telemetry 写失败不得改变业务事务结果，但必须可观测。

### 证据、兼容、回滚与退出

输出基线报告、schema tests 和固定 benchmark run IDs。新增 telemetry 默认有界，
可关闭且不改变 authority。`S2.0-AC01` 至 `S2.0-AC04` 全部 PASS 后退出。

## 18. S2.1 — 风险分层执行通道

### 目的与依赖

为确定性低风险修改提供严格受限 mechanical lane，同时保留普通 worker 和
高风险/formal lane。依赖 S2.0 PASS 和 ChangeSet v2。

### 设计与步骤

1. Mechanical lane 只接受 Sol 已确定的 exact patch、路径、文件数、diff 行数
   和字节上限，使用确定性 patch executor 与 ChangeSet v2 transaction。
2. 禁止二进制、symlink、生成目录、安全/权限/治理/生产配置、依赖锁、schema
   migration、破坏性操作和无法分类路径。
3. Mechanical 仍要求 actual-diff review 和受影响测试，不得绕过 authority。
4. 普通 implementation lane 允许一个 coherent slice 同时包含 source/tests/docs，
   不再把同一功能的微文档拆成独立 worker。
5. 高风险/formal lane 保持严格 worker-first 和完整 gate。
6. 分类规则由受信策略决定，项目 prompt 或普通 worker 不能自行降级。

### 影响文件

- 现有：`core/write-authority.ts`、`core/worker-policy.ts`、`core/path-policy.ts`、
  `core/tool-catalog.ts`、`index.ts`、write-authority tests/docs。
- 拟新增：`core/risk-lane-policy.ts`、`core/mechanical-patch-executor.ts`。

### 验收条件

- `S2.1-AC01`：合法一行机械修改不启动 LLM worker。
- `S2.1-AC02`：mechanical lane 无法修改任何高风险或未批准路径。
- `S2.1-AC03`：mechanical 仍生成完整 transaction、delta、review 和测试证据。
- `S2.1-AC04`：无法分类时默认进入严格 lane。
- `S2.1-AC05`：项目 prompt/worker 不能改变风险等级。
- `S2.1-AC06`：coherent slice 不得成为无界批量修改通道。

### 测试要求

- 正向：单文件小补丁、有限 docs/tests patch、普通 implementation、高风险 lane。
- 负向：lockfile、policy、security、symlink、二进制、超行数/字节、范围外路径。
- 故障注入：patch 部分应用、文件并发改变、review/测试失败，必须原子失败。

### 证据、兼容、回滚与退出

输出 lane decision records、边界测试和基线对比。feature wiring 可关闭并回退到
严格 worker-first；不得回退 ChangeSet v2。`S2.1-AC01` 至 `S2.1-AC06` 全部
PASS 后退出。

## 19. S2.2 — Orientation Capsule

### 目的与依赖

复用版本化、内容绑定的仓库背景，而不复用 worker session。依赖 S2.1 PASS。

### 设计与步骤

1. 每 milestone 生成有界 capsule：HEAD、dirty baseline、AGENTS/policy hashes、
   任务、acceptance IDs、批准路径、入口/调用者/测试、recipe 名称、架构决策、
   已知根因、schema/hash/时间。
2. Worker 默认只读 AGENTS、capsule 和 capsule 列出的源码/测试/文档。
3. 发现 capsule 与实际状态冲突时，worker 必须停止写入、扩大只读诊断并报告。
4. policy、批准路径、相关入口/依赖图、任务、验收或 baseline 超限变化都会失效。
5. repair worker 继承结构化 root-cause capsule，但仍使用新 session。

### 影响文件

- 现有：`core/worker-policy.ts`、`worker/runner.ts`、`core/milestone-handoff.ts`、
  `core/prompt-cache-breakpoints.ts`、worker tests/docs。
- 拟新增：`core/orientation-capsule.ts`、schema/cache/invalidation tests。

### 验收条件

- `S2.2-AC01`：同 milestone worker 不重复全量读取大型规格。
- `S2.2-AC02`：capsule 完整绑定内容和 policy identity。
- `S2.2-AC03`：过期或冲突 capsule fail-closed。
- `S2.2-AC04`：repair worker 获得根因证据但不继承旧 session。
- `S2.2-AC05`：首次写入 turns/tokens 相对 S2.0 基线显著下降。

### 测试要求

- 正向：生成、复用、repair capsule、相关文件读取。
- 负向：AGENTS、task、scope、HEAD、dependency 或 schema 改变。
- 故障注入：cache 丢失、capsule 截断、hash 冲突、并发 baseline 变化。

### 证据、兼容、回滚与退出

输出 capsule fixtures、失效矩阵和前后 benchmark。capsule 是可重建缓存，回滚
只会恢复完整 orientation，不影响 authority。`S2.2-AC01` 至 `S2.2-AC05`
全部 PASS 后退出。

## 20. S2.3 — Validation Evidence Graph 与人工适用性

### 目的与依赖

使 formal gate 可以消费与当前状态精确绑定的组件证据，避免同状态重复执行
完整 typecheck/unit/check，同时保持 current preflight。依赖 S2.2 PASS。

### 设计与步骤

1. 每个 attestation 绑定 source/input hashes、recipe definition hash、toolchain、
   environment allowlist、HEAD/relevant delta、test config、结果和完整性状态。
2. typecheck、unit-test、whitespace 独立失效；aggregate `check` 可发布组件证明。
3. Formal gate 仍执行，但可消费 identity 完全一致的证明；cache hit 本身不是证据。
4. production/current-state preflight 和声明为 current 的 probe 不可复用历史结果。
5. Manual check 增加 `applicability`、`applies_when`、`invalidated_by`、允许时的
   `evidence_ttl` 和可替代 machine recipe。
6. 不适用检查必须显示 `NOT_APPLICABLE` 适用性结果并保留判定证据；该检查从
   applicable required-check set 中移除，不得伪装成 PASS，包含它的 gate 仍只
   使用 `PASS | FAIL | BLOCKED | NOT_RUN`。

### 影响文件

- 现有：`core/validation-evidence.ts`、`core/gate-engine.ts`、
  `core/gate-catalog.ts`、`core/recipe-runner.ts`、recipe cache docs/config/tests。
- 拟新增：`core/validation-evidence-graph.ts`、attestation schema/store。

### 验收条件

- `S2.3-AC01`：最终 `check` 后 formal gate 不重复相同 typecheck/unit。
- `S2.3-AC02`：无关文档变化不使 unit attestation 失效。
- `S2.3-AC03`：recipe/toolchain/test input 变化必然失效。
- `S2.3-AC04`：current preflight 始终重新运行。
- `S2.3-AC05`：manual check 有适用性、来源和精确失效条件。
- `S2.3-AC06`：cache hit、过期证明和部分证明不能升级为 PASS。

### 测试要求

- 正向：check 发布组件证明、formal gate 精确复用、NOT_APPLICABLE。
- 负向：source/recipe/toolchain/env/config 变化、证据缺组件、过期/损坏证明。
- 故障注入：attestation 写入中断、图循环、并发 evidence、current probe 失败。

### 证据、兼容、回滚与退出

输出 evidence graph、执行次数对比、manual applicability matrix。关闭复用功能后
必须退回实际执行而非乐观 PASS。`S2.3-AC01` 至 `S2.3-AC06` 全部 PASS 后退出。

## 21. S2.4 — Receipt Store v2

### 目的与依赖

消除所有只读工具都写 started/finalized 文件对的固定成本，并为有副作用工具
提供有界、事务化、可恢复 receipt。依赖 S2.3 PASS。

### 设计与步骤

1. 有副作用工具必须持久化 receipt；普通只读、可安全重放查询只使用 session
   内 idempotency，不再写文件对。
2. 使用单一事务日志或 SQLite/WAL，使 started/finalized 在事务中更新。
3. 保留 identity conflict、redaction、恢复和 side-effect replay 防护。
4. 定义容量、年龄、总字节、压实和 formal-vs-development 分级保留策略。
5. incomplete receipt 优先保留并可恢复；达到容量边界时给出明确停止/恢复路径。
6. legacy 文件 receipt 保持只读恢复能力；只提供 dry-run inventory/compact，
   不自动删除任何历史记录。

### 影响文件

- 现有：`core/tool-result-recovery.ts`、`core/trusted-recovery-authority.ts`、
  `core/tool-result-ingress-projection.ts`、`index.ts`、receipt tests/docs。
- 拟新增：`core/receipt-store.ts`、SQLite/WAL 或 journal adapter、retention planner。

### 验收条件

- `S2.4-AC01`：只读 inspect/list/read 不再创建持久化 receipt 文件对。
- `S2.4-AC02`：副作用工具仍防止相同 identity 重放。
- `S2.4-AC03`：storage failure 不被误报为业务 SUCCESS。
- `S2.4-AC04`：容量边界可观测、可恢复且不永久阻塞无关只读操作。
- `S2.4-AC05`：legacy receipt 可只读检查/恢复，迁移零自动删除。
- `S2.4-AC06`：redaction 与隐私合同不退化。

### 测试要求

- 正向：side-effect lifecycle、只读调用、restart recovery、legacy read。
- 负向：identity conflict、重复 finalize、未知版本、容量超限。
- 故障注入：WAL/事务中断、磁盘满、锁竞争、损坏页/记录、压实失败。

### 证据、兼容、回滚与退出

输出 legacy inventory、transaction tests、容量/压实 dry-run 和 I/O 前后对比。
旧文件保留；回滚时 v2 receipt 不得被误判为可重放。`S2.4-AC01` 至
`S2.4-AC06` 全部 PASS 后退出。

## 22. S2.5 — Runtime Decomposition 与 `index.ts` composition root

### 目的与依赖

在事务和接口稳定后拆解单体入口，降低耦合与回归范围。依赖 S2.4 PASS。

### 设计与步骤

禁止 big-bang。每次先补 characterization tests，再只提取一个 controller，
不得在代码移动 slice 同时改变业务语义。建议顺序：

1. `runtime/receipt-controller.ts`
2. `runtime/session-controller.ts` 与 authority reconciliation
3. `runtime/recipe-gate-controller.ts`
4. `runtime/delegation-controller.ts`
5. `runtime/write-authority-controller.ts`
6. `runtime/output-controller.ts`
7. `runtime/status-controller.ts`
8. `runtime/runtime-context.ts`、`runtime/bootstrap.ts` 和最终注册表

`index.ts` 最终只创建 context、装配 dependencies、注册 commands/tools/events、
调用 controller，并负责统一启动/停止。它不得直接实现 ledger、diff、run/gate、
receipt、session authority、output budget 或 write-authority 状态机。

### 影响文件

- 现有：`extensions/workbench-runtime/index.ts`、相关 core modules、所有 wiring
  和 characterization tests。
- 拟新增：上述 `extensions/workbench-runtime/runtime/*.ts` controller/context/
  bootstrap 文件及其独立 tests。

### 验收条件

- `S2.5-AC01`：`index.ts` 仅为 composition root，目标 1,500–2,000 行。
- `S2.5-AC02`：核心流程可脱离 Pi runtime 独立单元测试。
- `S2.5-AC03`：controller 不通过可变全局状态隐式通信且无循环依赖。
- `S2.5-AC04`：storage、clock、exec、session、UI 通过接口注入。
- `S2.5-AC05`：public tool/command/event 合同无非预期变化。
- `S2.5-AC06`：每次提取都是小型、可审查、行为保持的 worker slice。
- `S2.5-AC07`：行数下降不是唯一证据，状态机 ownership 与测试边界清晰。

### 测试要求

- 正向：每个 controller 的 isolated tests、原始 wiring E2E、启动/停止生命周期。
- 负向：依赖缺失、controller 抛错、注册冲突、session/receipt 恢复失败。
- 故障注入：初始化中断、部分 controller 可用、shutdown 中断、event 重放。

### 证据、兼容、回滚与退出

每次提取输出 before/after contract snapshot、dependency graph、focused run 和
Sol diff review。每个 slice 可单独回退；不得回退已稳定的 v2 transaction。
`S2.5-AC01` 至 `S2.5-AC07` 全部 PASS 后退出。

## 23. S2.6 — 文档与里程碑治理简化

### 目的与依赖

让机器 ledger 管理 ID/hash/run 状态，人类文档只表达决策、风险和里程碑。
依赖 S2.5 PASS。

### 设计与步骤

1. Task/delegation/run/review ID 自动进入机器 ledger。
2. DEVELOPMENT_MASTER 类文档只在 milestone 更新，不为每个微步骤同步。
3. milestone 报告从机器 ledger 生成，标明来源、schema 和生成版本。
4. 人类文档落后时显示 stale，但不能改变机器 authority。
5. 本冻结规格仅通过版本化 amendment 变更，不作为进度日志。

### 影响文件

- 现有：`core/milestone-handoff.ts`、`core/report.ts`、相关 docs/templates/tests。
- 拟新增：milestone report generator、machine-ledger projection schema。

### 验收条件

- `S2.6-AC01`：功能切片内不要求为每个微步骤改写主文档。
- `S2.6-AC02`：ID/hash/run 状态以机器 ledger 为权威。
- `S2.6-AC03`：里程碑报告可从 committed records 重建。
- `S2.6-AC04`：stale 文档被明确标记且不能提升 authority。
- `S2.6-AC05`：生成报告不泄露 secret 或无界复制 worker 输出。

### 测试要求

- 正向：里程碑生成、重建、stale 标记、bounded projection。
- 负向：缺失/损坏 ledger、未知版本、未提交记录、超大 worker report。
- 故障注入：生成中断、部分数据、输出存储失败。

### 证据、兼容、回滚与退出

输出生成报告 fixtures、projection bounds 和文档流程对比。旧文档保留，不自动
删除；关闭 generator 不影响 authority。`S2.6-AC01` 至 `S2.6-AC05` 全部
PASS 后退出。

## 24. Final Exit Gate

Final Exit Gate 必须满足：

- S1.0–S1.5、S2.0–S2.6 的全部 acceptance ID 均为 PASS。
- P0/P1 追踪表中的每一项都有当前代码、测试和真实 Pi 证据。
- mechanical/implementation/high-risk 三条 lane 边界均通过攻击性负面测试。
- orientation、扫描字节、首次写入、重复验证和 receipt I/O 相对 S2.0 基线
  有可复算改善，且无安全不变量退化。
- Receipt Store v2 可恢复、有界、legacy 只读且没有自动删除历史数据。
- `index.ts` 满足 composition-root ownership；所有 controller 可独立测试。
- 完整验证矩阵与真实 Pi E2E 全部 PASS。
- Sol 审查全部最终 diff、迁移/回滚证据和风险处置，给出最终判定。

初始状态：`NOT_RUN`。

---

## 25. Worker 切片顺序

默认顺序如下；每个编号代表独立 bounded delegation，缺陷使用新的 repair worker：

1. S1.0 fixtures/characterization。
2. S1.1 v2 schema 与纯状态机。
3. S1.1 transactional storage 与 fault adapter。
4. S1.1 runner/index wiring。
5. S1.2 write journal 与完整 identity。
6. S1.2 review split hashes 与 drift/conflict。
7. S1.3 project authority store。
8. S1.3 session reconciliation 与 recovery。
9. S1.4 artifact schema/contract。
10. S1.4 run transaction/snapshot/external probe。
11. S1.4 gate selection/current validation。
12. S1.5 legacy reader/inventory 与 activation wiring。
13. Stage 1 integration、E2E、final gates。
14. S2.0 telemetry baseline。
15. S2.1 risk policy 与 mechanical executor。
16. S2.2 orientation capsule。
17. S2.3 evidence graph 与 manual applicability。
18. S2.4 receipt store、legacy adapter、retention dry-run。
19. S2.5 controller extraction，严格按 §22 的八个顺序逐项执行。
20. S2.6 milestone projection/doc simplification。
21. Stage 2 integration、性能对比、真实 Pi E2E、final gates。

若某个切片超过批准路径、验收范围或 worker hard budget，必须停止并重新切分，
不得以同一 delegation 扩张范围。

## 26. 验证矩阵

所有状态初始均为 `NOT_RUN`。只能通过 `.pi/workbench/recipes.yaml` 中声明的
recipe 运行项目验证；VERIFY 模式不得临时拼装命令。

| 验证项 | S1.0 | S1.1 | S1.2 | S1.3 | S1.4 | S1.5 | S2.0–S2.4 | S2.5 | S2.6/Final | 初始状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `worker-efficiency-test` | 需要 | 必需 | 必需 | 必需 | 需要 | 必需 | 必需 | 必需 | 必需 | NOT_RUN |
| `diff-review-efficiency-test` | 需要 | 必需 | 必需 | 必需 | 需要 | 必需 | 必需 | 必需 | 必需 | NOT_RUN |
| `gate-preflight-test` | 需要 | 需要 | 需要 | 需要 | 必需 | 必需 | 必需 | 必需 | 必需 | NOT_RUN |
| `runtime-core-test` | 必需 | 必需 | 必需 | 必需 | 必需 | 必需 | 必需 | 必需 | 必需 | NOT_RUN |
| `typecheck` | 必需 | 必需 | 必需 | 必需 | 必需 | 必需 | 必需 | 每次提取必需 | 必需 | NOT_RUN |
| `unit-test` | 阶段末 | 阶段末 | 阶段末 | 阶段末 | 阶段末 | 必需 | 阶段末 | 阶段末 | 必需 | NOT_RUN |
| `check` | 阶段末 | 阶段末 | 阶段末 | 阶段末 | 阶段末 | 必需且无缓存 | 阶段末 | 阶段末 | 必需且无缓存 | NOT_RUN |

“需要”由 Sol 根据实际影响选择并记录；“必需”不可省略。Focused recipe PASS
不替代阶段末 `check`，但 S2.3 完成后 formal gate 可按精确 identity 消费
`check` 发布的组件 attestation，避免同状态重复执行。

## 27. 真实 Pi E2E 场景

阶段门必须在真实 Pi runtime 中覆盖：

1. implementation worker：合法非空 delta → PENDING_REVIEW → REVIEWED。
2. implementation worker：退出 0、零 delta → 明确失败。
3. diagnosis worker：零写入成功；任意写尝试失败。
4. ledger 任一步失败 → partial 可诊断但不可成功。
5. 大文件 4 MiB 后同尺寸修改被捕获。
6. 无关 workspace drift 不让 worker review STALE；worker 路径漂移必须 STALE/conflict。
7. session restart/`/new` 恢复未审查 authority；冲突进入 RECOVERY_REQUIRED。
8. 必需 artifact 缺失、失败 run 残留、current artifact 被替换均不能通过 gate。
9. 授权外部根正常；缺失、越界、symlink 和 probe 后变化均失败。
10. mechanical patch 合法成功；高风险/超界 patch 被拒绝。
11. orientation capsule 复用与过期失效。
12. `check` 组件证明被 formal gate 精确复用，current preflight 仍重跑。
13. 只读工具不写持久 receipt；副作用工具可重启恢复且防重放。
14. legacy v1 记录只读检查、v2 新写、代码回滚识别高版本。

## 28. 迁移与回滚总策略

- 采用 expand → dual-read/legacy-read → v2-new-write → verify → retire-old-write
  的渐进迁移，不做 big-bang schema 替换。
- 历史 v1 记录始终只读保留；unknown/partial 进入 quarantine index。
- 每个 wiring 激活单独成 slice，可回退代码但不删除新数据。
- 旧代码不能安全识别新记录时禁止回滚并进入 RECOVERY_REQUIRED。
- 数据迁移、receipt 压实和历史清理先生成 dry-run inventory；删除必须另行
  获得用户明确授权。
- `index.ts` 每个 controller 提取都可单独回退，不与事务语义变更混合。
- 回滚不得把失败、partial、过期或未知记录解释为 PASS。

## 29. 观测指标与目标

| 指标 | 基线来源 | 目标/判定 |
| --- | --- | --- |
| worker 启动至首次写入 turns/tokens | S2.0 固定场景 | S2.2 后显著下降，阈值由基线报告冻结 |
| touched-path 扫描字节 | ChangeSet benchmark | 近似随 touched paths 增长，不随全部 dirty paths 增长 |
| 零-diff SUCCESS 数 | v2 transaction ledger | 必须为 0 |
| partial transaction 被消费数 | fault suite/ledger | 必须为 0 |
| 无关 drift 导致 STALE 数 | review telemetry | 必须为 0 |
| 同 identity 完整验证重复执行数 | evidence graph | 必须为 0，current probe 除外 |
| 只读工具持久 receipt 文件数 | receipt telemetry | S2.4 后必须为 0 |
| 持久化失败导致重派数 | transaction telemetry | 可观测并显著下降，不允许静默 |
| `index.ts` 行数 | repository | 目标 1,500–2,000，且 ownership 条件同时满足 |

性能目标不能凌驾于正确性；若提速导致任一安全不变量退化，则相关工作包 FAIL。

## 30. 停止条件

发生下列任一情况必须停止当前写入，保持证据并由 Sol重新定界：

- 工作区出现无法归因或与用户改动重叠的变化。
- worker 需要修改批准路径之外的文件。
- transaction、authority、run、gate 或 receipt 出现无法解释的身份冲突。
- 任一 fault-injection 暴露 partial record 可被消费为 SUCCESS/PASS。
- migration/rollback 可能删除或不可逆覆盖历史数据。
- Stage 1 尚未全部 PASS，却需要启用 Stage 2 行为。
- `index.ts` 提取需要同时改变业务语义或形成无法独立审查的大 diff。
- formal/current preflight 被缓存、旧证据或 worker prose 替代。
- declared recipe/gate 不存在、无法运行或证据无法严格加载。
- 需要 commit、push、发布、外部写入或历史清理，但用户未明确授权。

## 31. 风险登记

| 风险 | 可能性/影响 | 缓解措施 | 触发后的判定 |
| --- | --- | --- | --- |
| v2 schema 破坏 legacy 恢复 | 中/高 | fixtures、dual reader、unknown-version fail-closed | BLOCKED/FAIL |
| 原子目录语义受文件系统差异影响 | 中/高 | storage adapter、fsync/rename fault tests、能力探测 | BLOCKED |
| write journal 漏掉外部写入 | 中/高 | Git cross-check、workspace drift、conflict | FAIL |
| 完整 hash 增加大文件 I/O | 中/中 | 只 hash touched paths、流式/有界并发、指标 | FAIL if regression |
| evidence reuse 产生假 PASS | 低/极高 | 精确 identity、current probe 禁复用、攻击性测试 | FAIL |
| mechanical lane 权限扩大 | 低/极高 | 受信分类、denylist、硬边界、默认严格 | FAIL |
| receipt store 损坏或锁竞争 | 中/高 | WAL/transaction、recovery、capacity stop | BLOCKED/FAIL |
| controller 拆分改变行为 | 中/高 | characterization-first、逐个提取、可回退 | FAIL |
| telemetry 泄露内容/secret | 低/高 | 仅数值、redaction tests、bounded schema | FAIL |
| 计划执行漂移 | 中/高 | FROZEN spec、acceptance IDs、progress mirror | BLOCKED |

## 32. Definition of Done

本 program 只有在以下所有条件同时成立时才完成：

1. S1.0–S1.5、S2.0–S2.6 全部 acceptance ID 为 PASS。
2. P0/P1 追踪表无未关闭项，每项都有当前实现、负面/故障测试和 E2E 证据。
3. Stage 1 Exit Gate 与 Final Exit Gate 均由 Sol 判定 PASS。
4. 完整声明 recipe 矩阵和真实 Pi E2E 全部通过，没有将 NOT_RUN 升级为 PASS。
5. migration、restart、recovery、rollback 和 unknown-version 场景已演练。
6. 正式安全不变量全部保持，current preflight 未被复用替代。
7. 性能改善由 S2.0 基线与最终报告可复算证明。
8. Receipt Store v2 有界、可恢复、legacy 只读，且没有自动删除历史记录。
9. `index.ts` 成为 composition root，目标约 1,500–2,000 行，核心 controller
   ownership、依赖注入和独立测试均满足。
10. 文档、迁移说明、风险处置和 deliberate non-goals 完整。
11. Sol 已审查最终真实 diff，并明确记录仍存风险与未做事项。
12. 若用户没有另行要求，仓库保持未 commit、未 push、未发布状态。

## 33. 初始执行状态

本规格落地时仅代表计划已冻结，不代表任何实现或验收已经完成：

- Stage 1 Entry Gate：`NOT_RUN`
- S1.0–S1.5：`NOT_RUN`
- Stage 1 Exit Gate：`NOT_RUN`
- Stage 2 Entry Gate：`NOT_RUN`
- S2.0–S2.6：`NOT_RUN`
- Final Exit Gate：`NOT_RUN`
- 全部 recipes、fault-injection 和 Pi E2E：`NOT_RUN`

下一动作是开始 S1.0 基线冻结与兼容合同；在其证据被 Sol 验收前，不能开始
S1.1，更不能提前执行 Stage 2。
