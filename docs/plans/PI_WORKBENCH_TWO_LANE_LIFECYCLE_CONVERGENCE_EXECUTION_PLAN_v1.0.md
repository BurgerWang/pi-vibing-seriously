# Pi Workbench 双通道与生命周期收敛重构执行计划 v1.0

| 元数据 | 值 |
| --- | --- |
| Plan ID | `pi-workbench-two-lane-lifecycle-convergence-v1` |
| 版本 | `1.0` |
| 状态 | **IN_PROGRESS — WP0–WP7 源码与自动化测试已推进；WP8 NEXT** |
| 批准日期 | `2026-08-28` |
| 执行仓库 | `/home/hanbaoji/Projects/pi-vibing-seriously` |
| 基线 HEAD | `main@d003fdf` |
| 产品范围 | Pi Workbench 普通开发通道、严格研究与发布通道、delegation lifecycle、authority/review/repair 收敛、兼容迁移、真实项目回放 |
| 真实回放项目 | `/mnt/tb4/Code/Scalper_V2`、`/mnt/tb4/Code/Mace_h4_v3`、`/mnt/tb4/Code/Onchain_profit` |
| 人类授权 | 用户已批准本计划描述的重构方向，并要求先形成完整执行计划落盘 |
| 权威边界 | 本文件是开发执行合同，不是测试 PASS、Gate PASS、发布或盈利权威 |

本计划不依赖聊天记录才能执行。后续实现、审查、测试、迁移、部署和最终
验收必须引用本文件中的工作包与验收编号。任何未运行检查均为 `NOT_RUN`；
源码测试通过不等于运行中的 Pi 已加载新版本，也不等于外部量化项目 Gate 或
发布已经通过。

---

## 1. 执行结论

本轮不再继续以“发现一个错误、增加一个 recovery 分支”的方式修复。

实施方向是一次减法型重构：

1. 保留现有 `AUDIT / DEV / VERIFY`、ChangeSet、run manifest、B0–B6、
   Q0–Q5 和单写者安全边界。
2. 将产品工作流明确分为：
   - **普通开发通道**：低成本产生稳定 Candidate；
   - **严格研究与发布通道**：对 Candidate/Artifact 执行严格验证和晋级。
3. 将分散在 status、review、repair、successor、project authority、path lane、
   close、quarantine、automatic continuation 中的生命周期语义集中到一个纯、
   确定、穷尽的 resolver。
4. 将历史失败 attempt 从“永久项目级负权威”降为可审计事实；只有当前活跃
   writer、重叠的未收敛 delta、损坏且范围未知的活跃 authority 或当前严格
   Candidate 的失败条件可以阻塞对应动作。
5. 严格性绑定当前 Candidate、研究证据和发布 Artifact，不绑定无限增长的
   repair lineage。

最终用户体验应当是：

```text
普通开发：目标 → 实现 → focused feedback → Candidate → 一次最终验证

严格晋级：Candidate → 冻结身份 → B/Q Gates → 研究接受或发布授权
```

用户不再需要猜测 `review / repair / close / quarantine` 的合法顺序。

---

## 2. 当前实际基线

### 2.1 Workbench 工作树

计划制定时，Workbench 存在一组尚未提交的持续恢复修复：

- 16 个 runtime/core 文件被修改；
- 13 个测试文件被修改；
- tracked diff 约为 `+1507 / -243`；
- `.pi/workbench/delegation-start.lock` 为未跟踪运行时文件；
- 当前 HEAD 为 `d003fdf fix(workbench): close repair successor chains`。

这些修改属于当前恢复候选，任何重构不得覆盖、丢弃、重置或与其混杂提交。
第一工作包必须先审查和收束该候选。

### 2.2 已完成与未完成的减负工作

`.pi/workbench/runs/pi-governance-repair-v1/execution-state.json` 当前记录：

| 工作包 | 状态 |
| --- | --- |
| S1.0–S1.5 | `PASS` |
| S2.0 | `PASS` |
| S2.1 | `PASS` |
| S2.2–S2.6 | `NOT_RUN` |
| Final Exit | `NOT_RUN` |

因此，已完成内容主要是直接低风险写入、正常 delegation 自动 review、部分只读
receipt 减少和 `index.ts` 拆分；上下文减负、验证复用、receipt 完整减负、状态机
ownership、旧治理删除和最终吞吐验收尚未完整关闭。

### 2.3 当前复杂度证据

代码中 authority/review/delegation/repair 相关 core 模块约 44 个、合计约
31,647 行。至少以下位置独立解释 lifecycle 或 next action：

- `delegation-project-authority.ts`
- `delegation-repair-status.ts`
- `delegation-path-lane-admission.ts`
- `delegation-review-v2.ts`
- `exact-repair-authority.ts`
- `exact-repair-service.ts`
- `exact-repair-successor.ts`
- `automatic-delivery-continuation-authority.ts`
- `automatic-delivery-continuation-runtime-controller.ts`
- `delegate-tool-controller.ts`
- `review-tool-controller.ts`

模块拆分降低了 `index.ts` 规模，但没有形成唯一的生命周期 owner。

### 2.4 三个真实项目的只读快照

以下仅是计划制定时由当前源码 reader 得到的瞬时事实，不是后续执行时可复用的
authority，也不得硬编码为 repair 目标：

| 项目 | Repair roots | Lineage records | 当时的解析结果 |
| --- | ---: | ---: | --- |
| Scalper | 4 | 27 | unresolved RUNNING tip，lineage depth 8 |
| Mace | 4 | 17 | unresolved active repair |
| Onchain | 6 | 25 | 当前源码 reader 返回无 blocker |

Onchain 的 source-side reader 返回无 blocker，不证明运行中的 Pi 已加载相同源码。
Scalper 和 Mace 当时存在 start lock/active transaction，不得由测试或迁移脚本擅自
关闭。

---

## 3. 目标与非目标

### 3.1 必须达成的目标

1. 普通开发默认无需手工编排 delegation lifecycle。
2. 严格研究和发布只审查当前 Candidate/Artifact，不审判全部历史开发尝试。
3. 任意合法或兼容历史 authority 快照只能得到一个主动作。
4. status 显示的动作必须与实际 executor 的资格判断来自同一结果。
5. 零差异、已满足合同、已被 successor 接受、父子取代和失效历史记录必须
   确定性收敛，不得生成无限 repair chain。
6. 可读但语义无效的派生 review 与不可解析/损坏 authority 必须分开处理。
7. 真实项目历史必须成为脱敏、可重放、可缩减的回归语料。
8. 运行时版本身份必须在真实 E2E 前校验；loaded/disk 不一致时禁止声明修复
   已生效。
9. 新增抽象必须同步删除旧判断；本轮治理代码必须实现净减法。
10. 保留量化研究中的 point-in-time、survivorship、cost、walk-forward、完整
    folds、artifact provenance 和 fail-closed 发布边界。

### 3.2 明确非目标

- 不修改 Scalper、Mace、Onchain 的业务源码或量化语义。
- 不在外部项目内复制 Workbench 的治理系统。
- 不引入 XState、Temporal、MLflow 作为生产依赖或运行时平台。
- 不创建 shadow authority、第二套 ledger、第二套 progress mirror 或新的通用
  telemetry 数据库。
- 不自动删除历史 delegation、review、run、artifact 或 receipt。
- 不以测试数量证明策略有效、Gate PASS、可发布或可盈利。
- 不扩展到 HFT、L2/LOB、撮合、队列位置或低延迟交易执行。
- 本计划落盘本身不授权 commit、push、release 或修改三个外部项目。

---

## 4. 设计原则与外部最佳实践

### 4.1 确定性、纯状态转换

状态与事件必须确定唯一下一状态；guard 是纯判断，副作用在 transition 决定后
执行。参考：

- XState / Stately, Events and transitions:
  <https://stately.ai/docs/transitions>

Workbench 不引入 XState 依赖，只实现同等的纯 TypeScript reducer 和穷尽类型。

### 4.2 真实历史回放与安全版本演进

持久工作流代码升级必须对旧历史进行 replay testing；运行中的流程必须能识别
其代码版本，避免新代码错误解释旧历史。参考：

- Temporal, Safe deployments and replay testing:
  <https://github.com/temporalio/documentation/blob/main/docs/develop/safe-deployments.mdx>

Workbench 将使用三个真实项目的脱敏历史做 replay fixture，并在真实 E2E 前比较
loaded/disk runtime identity；不引入 Temporal。

### 4.3 模型化与性质测试

测试模型必须比生产实现更简单，命令必须分别定义“当前是否可执行”和“执行后
应满足什么”，并能缩减失败序列。参考：

- fast-check, Model based testing:
  <https://fast-check.dev/docs/advanced/model-based-testing/>

本计划允许新增唯一一个 dev-only 依赖 `fast-check`；若实现阶段能用现有
`node:test` 完成同等的可重放序列生成、缩减和并发调度，可以不新增依赖，但不得
降低验收覆盖。

### 4.4 Candidate 版本与晋级指针分离

不可变 Candidate 版本与可移动 `current/champion/release-candidate` 指针必须分离；
移动指针不能改写旧版本事实。参考：

- MLflow, Model Registry workflows:
  <https://www.mlflow.org/docs/latest/ml/model-registry/workflow/>

Workbench 只借鉴版本/alias 分离，不引入 MLflow，也不将策略等同于 ML model。

### 4.5 时间序列研究边界

严格研究必须保证训练数据早于测试数据，并允许声明 gap/embargo 等隔离。参考：

- scikit-learn, `TimeSeriesSplit`:
  <https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html>

Workbench 仍只验证项目自己的声明和产物，不实现回测或训练引擎。

### 4.6 Artifact-centric provenance

发布证据应绑定 Artifact、源码、构建过程和输入，而不是绑定产生它的全部失败
尝试。参考：

- SLSA v1.2 provenance:
  <https://slsa.dev/spec/v1.2/provenance>

---

## 5. 目标领域模型

### 5.1 Work Attempt

一次 bounded worker 或 direct delivery 的执行事实：

- contract 与 allowed paths；
- before/after identity；
- command effect；
- worker/process identity；
- terminal result；
- optional review/repair decision。

Work Attempt 是审计事实，不自动成为永久项目级 blocker。

### 5.2 Repair Obligation

一个需要通过 review、修复或安全关闭来解决的语义义务：

- `obligation_id` 由首个需要修复的 Candidate/Attempt 决定；
- 多次 retry 是同一 obligation 的 attempts，不通过无限 lineage 表达新义务；
- successor ACCEPT、`SATISFIED_NO_DELTA` 或具名安全关闭终结整个 obligation；
- 旧 repair lineage 只读规范化成一个 obligation 投影，不重写历史。

### 5.3 Candidate

普通开发通道的稳定输出。Candidate identity 至少绑定：

- source HEAD；
- 当前相关 diff/ChangeSet；
- project/profile/recipe/gate 配置 identity；
- 相关数据、参数和 artifact manifest 引用；
- runtime/toolchain identity；
- 创建时间和来源 Work Attempt（仅追溯，不授予权威）。

优先复用现有 ChangeSet、relevance projection、run manifest 和 content hashes；
不得创建重复事实 store。

### 5.4 Promotion

将某个精确 Candidate 晋级为：

- `RESEARCH_ACCEPTED`；或
- `RELEASE_AUTHORIZED`。

Promotion 绑定 Candidate hash、适用 Gate、run/artifact evidence、当前 preflight
和显式用户发布权限。Promotion 不改变 Candidate 内容。

### 5.5 Project Lifecycle Snapshot

resolver 的只读输入，包含：

- 严格解析后的 v1/v2 authority observations；
- active writer/start lock liveness；
- repair obligations 与 attempts；
- current relevant binding；
- requested paths 与 operation intent；
- 当前 runtime identity；
- strict Candidate/Promotion（如有）。

snapshot 本身是可重建投影，不是第二套 authority。

---

## 6. 双通道产品合同

### 6.1 普通开发通道

| 项目 | 合同 |
| --- | --- |
| 入口 | 默认 `DEV`；普通 edit/write 或一次 bounded Luna delivery |
| 用户操作 | 提出目标、查看结果；成功路径不要求手工 review/status/repair |
| 安全边界 | 项目根、realpath/symlink、允许路径、单写者、当前 relevant diff |
| 验证 | 开发中 focused tests；稳定 Candidate 后一次风险相称的最终验证 |
| 历史影响 | terminal 历史不阻塞不相关路径；当前活跃 writer 和真实重叠 delta 仍阻塞 |
| 输出 | Candidate 或明确的当前失败，不产生研究/发布结论 |

普通通道允许内部自动执行无损、确定、幂等的收敛动作，例如关闭已被接受的
ancestor obligation、标记零差异 attempt superseded、重建可重建投影。任何需要
新语义判断、扩大写路径、删除历史或执行发布的动作不得静默完成。

### 6.2 严格研究与发布通道

| 项目 | 合同 |
| --- | --- |
| 入口 | 显式进入 `VERIFY`、运行 Q Gate 或执行发布晋级 |
| 输入 | 一个冻结且 identity 完整的 Candidate |
| 研究验证 | B0–B6、Q0–Q5、当前适用的项目 Gate |
| 发布验证 | Candidate、Artifact、source/build/input provenance、current preflight、显式用户授权 |
| 失败影响 | 阻止该 Candidate 晋级；不冻结后续普通开发 |
| 输出 | `RESEARCH_ACCEPTED`、`RELEASE_AUTHORIZED` 或带唯一下一动作的失败 |

严格通道不能从 worker prose、旧 Gate PASS、缓存命中、历史 alias 或收益更高自动
推导成功。外部资源、数据 freshness、生产 preflight 和发布目标必须按当前状态
重新检查。

### 6.3 通道间转换

```text
DEV work
   │
   ├─ incomplete/failed → resolve current attempt only
   │
   └─ stable Candidate ── explicit promotion ──> VERIFY / B+Q Gates
                                                  │
                                                  ├─ FAIL/BLOCKED: Candidate retained; DEV remains available
                                                  └─ PASS: research accepted or release authorized
```

严格结果不能回写为某次 Work Attempt 的成功；普通开发也不能继承严格通道的
release authority。

---

## 7. 唯一生命周期 Resolver

### 7.1 模块边界

拟新增：

- `extensions/workbench-runtime/core/delegation-lifecycle-resolver.ts`
- `tests/delegation-lifecycle-resolver.test.ts`
- `tests/delegation-lifecycle-model.test.ts`

若实现证明更适合使用现有模块名，可以调整文件名，但必须保持一个 owner、纯
输入输出和单一决策来源。

resolver 不读取文件、不执行 Git、不启动 worker、不写 sidecar。I/O reader 先构建
snapshot，resolver 决定一个 typed action，effect executor 再根据 snapshot hash
执行并严格回读。

### 7.2 Canonical lifecycle states

原始 transaction 状态继续兼容：`PREPARED`、`RUNNING`、`COMMITTING`、
`FINISHED`、`PENDING_REVIEW`、`INTERRUPTED`、`REVIEWED`、`FAILED`、
`ABORTED`、`RECOVERY_REQUIRED`。

resolver 将其与 committed generation、review、lock、binding 和 lineage 组合后，
规范化为以下语义状态：

- `ACTIVE`
- `AWAITING_REVIEW`
- `REPAIRABLE`
- `SATISFIED_NO_DELTA`
- `ACCEPTED`
- `SUPERSEDED`
- `TERMINAL_NON_BLOCKING`
- `INVALID_DERIVED_EVIDENCE`
- `CORRUPT_AUTHORITY`
- `BINDING_CONFLICT`
- `PROMOTION_READY`
- `PROMOTION_BLOCKED`

### 7.3 Typed primary actions

- `CONTINUE_DEVELOPMENT`
- `WAIT_FOR_ACTIVE_WRITER`
- `REVIEW_CANDIDATE`
- `EXECUTE_EXACT_REPAIR`
- `CLOSE_SATISFIED_NO_DELTA`
- `SUPERSEDE_EMPTY_ATTEMPT`
- `CLOSE_ACCEPTED_OBLIGATION`
- `REGENERATE_DERIVED_REVIEW`
- `QUARANTINE_CORRUPT_AUTHORITY`
- `REBASE_CURRENT_BINDING`
- `BLOCK_OVERLAPPING_PATHS`
- `RECLAIM_STALE_LOCK`
- `PROMOTE_CANDIDATE`
- `BLOCK_PROMOTION`
- `REPORT_STORAGE_FAILURE`

每个 action 必须携带：

- reason code；
- authority/snapshot hash；
- exact target id；
- exact affected paths 或范围未知事实；
- 是否自动安全执行；
- 是否需要用户授权；
- 成功后的期望状态。

命令文本、UI footer 和 model tool result 只能渲染 typed action，不得自行推导下一步。

### 7.4 状态—动作矩阵

| 观察条件 | Canonical state | 唯一主动作 | 对普通开发的影响 | 对严格晋级的影响 |
| --- | --- | --- | --- | --- |
| live writer 且锁身份有效 | `ACTIVE` | `WAIT_FOR_ACTIVE_WRITER` | 保持单写者 | 阻塞当前 Candidate 冻结 |
| stale lock，无有效 owner | `TERMINAL_NON_BLOCKING` | `RECLAIM_STALE_LOCK` | 自动恢复后继续 | 重新探测后决定 |
| 完整 current delta，未审查 | `AWAITING_REVIEW` | `REVIEW_CANDIDATE` | 只影响相关 Candidate | 必须 review |
| immutable REPAIR decision 可执行 | `REPAIRABLE` | `EXECUTE_EXACT_REPAIR` | 只阻塞重叠路径 | 阻塞该 Candidate |
| repair attempt 零新 delta，当前合同已满足 | `SATISFIED_NO_DELTA` | `CLOSE_SATISFIED_NO_DELTA` | 自动关闭并继续 | 可重新冻结 Candidate |
| 空 attempt 被更新 attempt 取代 | `SUPERSEDED` | `SUPERSEDE_EMPTY_ATTEMPT` | 自动关闭并继续 | 无影响 |
| successor 已语义 ACCEPT | `ACCEPTED` | `CLOSE_ACCEPTED_OBLIGATION` | ancestor 不再阻塞 | 接受当前 Candidate binding |
| review 可读但派生内容无效 | `INVALID_DERIVED_EVIDENCE` | `REGENERATE_DERIVED_REVIEW` | 不要求 quarantine | 重新生成后再审查 |
| transaction/generation 不可解析或 hash 冲突 | `CORRUPT_AUTHORITY` | `QUARANTINE_CORRUPT_AUTHORITY` | terminal 且可证明 inactive 时隔离；active/范围未知时 fail-closed | 阻塞相关 Candidate |
| current binding 可安全重建 | `BINDING_CONFLICT` | `REBASE_CURRENT_BINDING` | under-lock 重建 Candidate | 旧 promotion 失效 |
| current binding 有真实路径重叠 | `BINDING_CONFLICT` | `BLOCK_OVERLAPPING_PATHS` | 仅阻塞重叠范围 | 阻塞 Candidate |
| Candidate 完整且所有适用 Gate 可运行 | `PROMOTION_READY` | `PROMOTE_CANDIDATE` | DEV 不受影响 | 运行严格验证 |
| Gate/preflight/evidence 不满足 | `PROMOTION_BLOCKED` | `BLOCK_PROMOTION` | DEV 不受影响 | fail-closed |

### 7.5 总函数与穷尽规则

`resolveLifecycle(snapshot, event)` 必须是 total function：

1. 所有已知 schema/status/event 组合必须返回一个结果；
2. 未知 schema 或数据损坏返回具名 fail-closed action，不能抛出无动作错误；
3. TypeScript discriminated union 使用 `never` 穷尽检查；
4. 相同输入重复解析结果必须 byte-canonical；
5. resolver 结果必须可序列化、可哈希、可重放；
6. executor 必须验证 snapshot hash，防止 status 后发生 TOCTOU；
7. executor 的成功严格回读必须得到 resolver 声明的 expected state。

---

## 8. 当前反复故障的统一关闭规则

### 8.1 `CURRENT_BINDING_CHANGED`

根因：动作资格与执行读取了不同时间、不同范围或不同 reader 的 binding。

修复合同：

- 获取共享 writer lock 后重新构建 snapshot；
- exact current binding 与 action 的 snapshot hash 相同才执行；
- 无真实路径重叠时创建新 Candidate/rebase projection；
- 真实重叠时只返回 `BLOCK_OVERLAPPING_PATHS`；
- 不生成新的 repair child 来表达一次普通 rebase。

### 8.2 `DURABLE_REVIEW_INVALID` / readable but invalid

根因：可读的派生 review 被同时当作不可用 authority 和不可 quarantine authority。

修复合同：

- transaction/generation 完整时，review 是可重建派生证据；
- 旧无效 review 保留历史，不原地改写；
- 从 committed generation 生成新 review generation/record；
- quarantine 只处理不可解析、hash/identity 损坏的底层 authority；
- status 与 executor 均返回 `REGENERATE_DERIVED_REVIEW`。

### 8.3 terminal-negative sidecar 循环

根因：review 要 sidecar、repair 要 sidecar、quarantine 又认为记录可读。

修复合同：

- terminal-negative eligibility 由 resolver 一次决定；
- sidecar 是执行产物，不是判断该动作可执行的循环前置条件；
- eligible 时唯一动作是生成/执行严格 terminal decision；
- ineligible 时给出其他唯一 action，不允许 review/repair 相互指向。

### 8.4 零差异与 `IMPLEMENTATION_DELTA_REQUIRED`

根因：修复成果已在工作区，但 retry 被错误要求必须产生新的文件差异。

修复合同：

- 区分 `no effect` 与 `already satisfied`；
- current content 满足 immutable contract 且验证通过时使用
  `SATISFIED_NO_DELTA`；
- 不启动新 worker，不增加 lineage depth；
- 验证失败时仍保持原 obligation，返回真实失败，不伪装成功。

### 8.5 accepted successor 未取代父负权威

根因：按单条 transaction status 扫描 blocker，而不是按 obligation 的最终 tip
与 Candidate binding 决定。

修复合同：

- successor ACCEPT 关闭整个 obligation；
- ancestor `FAILED/INTERRUPTED/REPAIR_REQUIRED` 保留为历史事实；
- ancestor 不再进入当前 blocker 集合；
- path lane、status、Gate、commit、automatic continuation 使用相同 closure。

### 8.6 truncated/compact dependency packet

根因：只读依赖内容进入 semantic packet，却没有完整分页能力，形成无法 ACCEPT
也无法 REPAIR 的状态。

修复合同：

- changed path 的语义内容必须完整或可分页；
- 只读依赖默认只携带路径、类型、完整 digest、大小和引用；
- reviewer 需要读取依赖内容时走同一有界分页协议；
- presentation truncation 不能改变 authority 分类；
- incomplete packet 的唯一动作是继续分页/重建 packet，不是 repair implementation。

### 8.7 command failure 与 workspace mutation 混淆

根因：命令执行失败被解释为 workspace drift 或 implementation delta 缺失。

修复合同：

- `command outcome` 与 `mutation attribution` 为正交维度；
- CLEAN command failure 不创造虚假路径冲突；
- 有已归因 delta 时保留真实 delta 并进入 review/repair；
- 无 delta 且合同未满足时终止 attempt，但不制造无限 repair；
- 真实 drift/unknown origin 继续 fail-closed。

### 8.8 start lock 与 runtime identity

修复合同：

- lock liveness 使用 boot ID、PID、process start ticks 和 owner identity；
- live lock 不得回收；
- stale lock 通过一个幂等动作回收；
- runtime doctor 比较 loaded hash、disk hash、dependency version 和 project root；
- hash 不一致时真实 E2E 为 `BLOCKED_RELOAD_REQUIRED`，不得报告产品修复成功。

---

## 9. 工作包与执行顺序

### 9.1 当前推进快照（2026-08-28）

下表记录仓库开发进度，不替代运行中的 Pi runtime identity、真实 Candidate Gate、
外部项目 canary 或发布授权：

| 工作包 | 当前源码推进状态 | 当前证据 |
| --- | --- | --- |
| WP0 | 已收束并提交 | `3fce7db`，原 29 个 tracked 修改独立收束 |
| WP1 | 已实现并提交 | `5c3bb7b`，三项目脱敏 fixtures 与 replay tests |
| WP2 | 已实现并提交 | `5552222`，canonical lifecycle resolver 与矩阵测试 |
| WP3 | 已分阶段实现并提交 | `513d9b7` 至 `357f84b`，统一 effect/review/status/continuation 收敛 |
| WP4 | 已实现、测试并提交 | `7391000`，普通开发通道与回归测试 |
| WP5 | 已实现并提交 | Candidate identity/version/alias、Candidate-bound Gates、research/release promotion、Q4 机验、release provenance、report/compare |
| WP6 | 已实现、测试并提交 | `b8a4ad2`，10,000 个固定 seed 模型序列、缩减/replay、review/repair/lock 调度、逐 publish boundary 故障注入、三项目兼容零写入回放 |
| WP7 | 已实现、测试并提交 | `a625af2`，唯一 resolver/action owner、status 纯投影、v1 writer fail-closed、六份最终行为文档与结构回归 |
| WP8 | 实机部署与普通 canary 已完成；strict Candidate 出口按当前证据 `BLOCKED/NOT_RUN` | `9b911b8`，三项目当前 runtime、status、DEV canary、B6 与 restart 证据；没有可冻结的 evidence-complete Candidate |

WP6 验证证据为 lifecycle focused 组 160/160 PASS；WP7 focused lifecycle、兼容、
回放、打包组 244/244 PASS。WP8 最终候选 focused 170/170 PASS，release/package/
stable compatibility 83/83 PASS，最新 `npm run check` PASS，其中 typecheck PASS、全量
测试 3101 项（3100 PASS、1 项按普通测试合同 SKIP）且 `git diff --check` PASS。
模型测试覆盖 10,000 个固定 seed 序列、全部 37 个模型
命令、15 个主动作和 12 个 canonical state；失败输出携带 seed、完整 replay 序列和
缩减结果。三项目实机结果见 WP8；release 授权、push 和 publish 均为 `NOT_RUN`。
由于 `S2.2–S2.6` 仍缺少可比的前后吞吐/持久化基线，且三个项目当前没有可冻结的
evidence-complete Candidate，本计划仍为 `IN_PROGRESS`，不得标记 `COMPLETE`。

### WP0 — 收束现有恢复候选

**目标：** 在重构前建立可信基线，避免把当前未提交修复丢失或混入结构重构。

**主要输入：** 当前 29 个 tracked 修改、现有 focused tests、三个项目当前 authority。

**执行：**

1. 审查当前 diff，按根因归类每处修改和测试。
2. 检查是否存在相互重复或相反的 classification。
3. 运行受影响 focused suites、typecheck、`git diff --check`。
4. 候选稳定后运行一次 `npm run check`。
5. 用当前源码 reader 只读解析三个真实项目。
6. 在不修改项目业务文件的前提下运行 runtime identity 检查。
7. 形成一个独立、可回滚的当前修复提交；是否 commit 仍以用户当时授权为准。

**影响文件：** 仅当前已修改文件和必要的同根因测试；禁止顺手开始 WP2 架构改造。

**验收：**

- `WP0-AC01` 当前 diff 中每个生产分支有对应失败场景。
- `WP0-AC02` focused tests PASS。
- `WP0-AC03` typecheck PASS。
- `WP0-AC04` full check PASS。
- `WP0-AC05` 三项目 source-side read 不再出现 reader 异常。
- `WP0-AC06` 没有覆盖或清理用户/项目脏工作树。

**Rollback：** 回退本独立候选提交；不删除任何外部项目 authority。

### WP1 — 真实历史脱敏回放语料

**目标：** 将反复故障从聊天文本转化为可重复的产品测试输入。

**拟新增：**

- `tests/fixtures/delegation-history-replay/scalper/`
- `tests/fixtures/delegation-history-replay/mace/`
- `tests/fixtures/delegation-history-replay/onchain/`
- `tests/delegation-history-replay.test.ts`
- 可选的脱敏/验证脚本，必须位于 `scripts/` 且只生成测试 fixture。

**脱敏规则：**

- 保留 schema、status、parent/child、hash、path relationship、timestamps ordering、
  sidecar presence 和错误码；
- 项目绝对路径映射为 synthetic root；
- 文件内容替换为固定 fixture bytes，但重新计算内部一致 hash；
- 删除 prompt、worker prose、账户、secret、真实策略内容和大体积 artifact；
- fixture inventory 记录来源项目、采集时间、脱敏版本和覆盖故障，不记录敏感内容。

**验收：**

- `WP1-AC01` 每个已知反复错误至少有一个最小 fixture。
- `WP1-AC02` fixture 可在临时目录独立重放。
- `WP1-AC03` fixture 不含原项目源码、密钥或自然语言历史。
- `WP1-AC04` 当前生产 reader 对 fixture 的结果与采集时分类一致。
- `WP1-AC05` 至少保留一份多 root、多 lineage、深度大于 5 的真实形状。

### WP2 — Canonical lifecycle resolver

**目标：** 建立唯一状态和动作语义。

**执行：**

1. 定义 snapshot、canonical state、typed action、reason registry。
2. 将现有 v1/v2 reader 输出规范化为 snapshot。
3. 实现 pure `resolveLifecycle(snapshot, event)`。
4. 对所有 union 分支执行 TypeScript `never` 穷尽。
5. 实现 canonical serialization/hash。
6. 为状态—动作矩阵编写 table-driven tests。
7. 先让旧入口以 read-only 方式调用 resolver 并比较内部结果；该比较只存在于测试，
   不持久化 shadow authority。

**验收：**

- `WP2-AC01` 任意已知状态返回 exactly one primary action。
- `WP2-AC02` 相同输入输出 byte-deterministic。
- `WP2-AC03` 未知/损坏输入返回具名 fail-closed action，不抛无动作异常。
- `WP2-AC04` 三项目 fixture 全部得到预期唯一 action。
- `WP2-AC05` resolver 无 fs/git/model/runtime side effect。
- `WP2-AC06` 未新增第二套持久 authority 或 progress store。

### WP3 — 统一 effect executor 与恢复收敛

**目标：** status、review、repair、close、quarantine 和 automatic continuation
消费同一个 resolver action，并保证幂等与有界收敛。

**主要影响文件：**

- `delegation-project-authority.ts`
- `delegation-repair-status.ts`
- `delegation-path-lane-admission.ts`
- `delegation-review-v2.ts`
- `exact-repair-authority.ts`
- `exact-repair-service.ts`
- `exact-repair-successor.ts`
- `automatic-delivery-continuation-authority.ts`
- `automatic-delivery-continuation-runtime-controller.ts`
- `delegate-tool-controller.ts`
- `review-tool-controller.ts`
- `delegation-execution-v2.ts`
- `delegation-transaction-storage.ts`
- 对应测试

**执行：**

1. 建立一个 effect boundary，输入 typed action + expected snapshot hash。
2. 在 writer lock 下重新构建 snapshot 并执行 CAS 检查。
3. 实现安全自动动作和需要显式权限的动作区分。
4. 将现有 public commands/tools 改为 resolver/action adapter。
5. 删除入口自身的 repair/review eligibility 判断。
6. 将旧 lineage 规范化为 obligation，保留只读兼容。
7. 加入 recovery rank：无新 delta 的动作必须严格降低未解决义务数。
8. 重复同一 action 必须得到 replayed success 或相同拒绝，不能产生第二 successor。

**验收：**

- `WP3-AC01` 0 个 status/action eligibility 矛盾。
- `WP3-AC02` 零差异 repair 不增加 lineage。
- `WP3-AC03` successor ACCEPT 关闭祖先 obligation。
- `WP3-AC04` readable invalid review 可重建，不错误要求 quarantine。
- `WP3-AC05` corrupt authority 可隔离且不删除历史。
- `WP3-AC06` current binding 变化可 rebase 或返回唯一重叠冲突。
- `WP3-AC07` 同一 repair 并发执行最多产生一个 durable successor。
- `WP3-AC08` 三项目历史均能收敛或给出一个真实外部 blocker。

### WP4 — 普通开发通道

**目标：** 让普通开发只承担与当前修改风险相称的成本。

**主要影响域：**

- `mode-policy.ts`
- direct write / write authority
- default delivery
- delegation admission
- focused/final verification routing
- status/footer 文案

**执行：**

1. 保留 DEV 作为默认开发入口，不新增 lane store。
2. direct low/medium-risk write 使用当前路径/realpath/单写者边界。
3. 需要 worker 时执行一次 coherent delegation，成功后自动形成 Candidate。
4. terminal 历史只影响其仍未收敛且真实重叠的范围。
5. 普通成功路径自动执行安全 closure，不显示 lifecycle choreography。
6. focused tests 在开发循环内运行；Candidate 不变时禁止重复 full check。
7. 高风险路径仍需 bounded lease/worker，不因“普通通道”降级。

**验收：**

- `WP4-AC01` 普通小改手工 governance 调用数为 0。
- `WP4-AC02` 普通跨文件 coherent change 不要求用户串联 review/status/repair。
- `WP4-AC03` 历史 terminal blocker 不阻塞不重叠开发。
- `WP4-AC04` live shared-checkout writer 仍保持 one-at-a-time。
- `WP4-AC05` 权限、安全、依赖、迁移、release 和 Pi-control 路径不可降级。
- `WP4-AC06` Candidate 未变化时重复完整验证次数为 0。
- `WP4-AC07` 普通通道不能产生 research/release/profit authority。

### WP5 — 严格研究与发布通道

**目标：** 将严格性集中到当前 Candidate 的研究结论和发布 Artifact。

**主要影响域：**

- `mode-policy.ts` 的 VERIFY 行为
- gate catalog/schema/engine/controllers
- quant result 与 cache contracts
- run/artifact manifest
- reviewed local commit/release boundary
- report/compare 输出

**执行：**

1. 用现有 ChangeSet/run manifest 组合 Candidate identity，不复制事实。
2. 显式 promotion 冻结 Candidate。
3. B0–B6 与 Q0–Q5 只消费同一 Candidate 的 evidence。
4. Q4 增加可机读的 time order、fold、gap/embargo（如适用）和参数稳定性引用；
   无法机验的内容继续标为 manual evidence，不伪装 PASS。
5. 发布 provenance 绑定 source、candidate、recipes/toolchain、resolved inputs 和
   artifacts。
6. `current/champion/release-candidate` 只做可移动引用，目标版本不可改写。
7. Gate/Promotion 失败只阻止该 Candidate，不冻结 DEV。
8. release/push/publish 保持显式用户授权。

**验收：**

- `WP5-AC01` 没有完整 Candidate identity 时 promotion 为 BLOCKED。
- `WP5-AC02` required `NOT_RUN` 永远不能升级 Gate PASS。
- `WP5-AC03` Q0–Q5 全部绑定当前 Candidate 和 run artifacts。
- `WP5-AC04` time-ordered split 不允许训练未来、测试过去。
- `WP5-AC05` failed folds 不得从结果中删除。
- `WP5-AC06` higher return 不自动产生 better/profitable verdict。
- `WP5-AC07` release artifact 可追溯到精确 source/build/input identity。
- `WP5-AC08` promotion 失败后普通 DEV 可继续产生新 Candidate。

### WP6 — 模型化、并发与故障注入测试

**目标：** 证明状态机整体收敛，而不是只证明已知例子。

**测试命令模型：**

- prepare/start/write/commit；
- worker success/failure/interruption/abort；
- review accept/repair/incomplete/corrupt；
- exact repair/replay/lost response；
- zero delta/satisfied/no effect；
- external drift/rebase；
- close/quarantine/supersede；
- lock acquire/release/crash/reclaim；
- Candidate freeze/Gate/promotion；
- session reload/runtime version change。

**性质：**

1. Safety：不允许越权写入、伪 ACCEPT、伪 Gate PASS、双 successor。
2. Determinism：相同历史和事件得到相同 action/state。
3. Idempotency：重复动作不重复副作用。
4. Convergence：没有新 delta 时 recovery rank 严格下降。
5. Isolation：不重叠历史不阻塞普通开发。
6. Promotion strictness：当前 Candidate 缺证据时严格阻塞。
7. Compatibility：v1/旧 v2 只读可解释，不被新 writer 改写。
8. Crash consistency：partial generation/sidecar/lock 不被消费为成功。

**验收：**

- `WP6-AC01` 状态—动作表全覆盖。
- `WP6-AC02` 至少 10,000 个固定 seed 的生成序列通过，失败可重放和缩减。
- `WP6-AC03` scheduled async 序列覆盖 repair/review/lock 竞争。
- `WP6-AC04` 所有三个真实项目 fixture 通过。
- `WP6-AC05` storage fault injection 覆盖每个 durable publish boundary。
- `WP6-AC06` 对旧历史的兼容 replay 不产生新的持久文件。

**当前完成证据（2026-08-28）：** 状态—动作 table test 与生成序列共同覆盖全部
canonical state/action；10,000 个固定 seed 序列逐步验证 safety、determinism、
idempotency、recovery rank、历史隔离和 promotion strictness，并提供已自测的
delta-debugging 缩减器；review/repair 的全部三任务排列在共享 writer lock 下只产生
一次 effect 与一次 replay，注入首次 lock crash 后队列仍收敛且 successor 唯一；
Scalper/Mace/Onchain 脱敏 fixture 均通过，v1/旧 v2 兼容 replay 前后目录、文件大小与
SHA-256 完全一致；transaction、review、semantic migration、semantic repair 与
terminal-negative sidecar 的全部已声明 storage fault point 均实际注入并 fail-closed。

### WP7 — 删除旧治理与兼容收口

**目标：** 防止 resolver 成为第八个判断器。

**执行：**

1. 删除或降级所有旧 classification functions；兼容导出只能转调 resolver。
2. 删除重复 next-action 文本构造。
3. 删除不再使用的 sidecar eligibility 分支和旧 status mirror 语义。
4. 历史 reader 保留，历史 writer 禁止。
5. 更新 README、architecture、worker delegation、security、compatibility 和
   quant profile，只描述最终行为。
6. 更新 S2.2–S2.6 状态必须由实际指标支持；未达到则保持 NOT_RUN/FAIL。

**验收：**

- `WP7-AC01` 生产生命周期 owner 只有一个。
- `WP7-AC02` 新增 resolver 同步带来旧判断净删除。
- `WP7-AC03` 只读/status 不新增 durable receipt。
- `WP7-AC04` 文档不再要求用户手工生命周期编排。
- `WP7-AC05` v1 public compatibility 与当前工具合同无非预期破坏。
- `WP7-AC06` 不存在 shadow/parallel authority。

**当前完成证据（2026-08-28）：** `delegation-lifecycle-resolver.ts` 是唯一导出的
生产 resolver；旧 repair-status 与 exact-successor classification 导出仅保留兼容
shape，并把动作选择转交 resolver。next-action 的机器命令和人类说明集中于
`agent-next-action.ts`；status 只读观察 live binding，不再 reconcile/persist session
mirror、append entry 或生成 receipt。历史 schema-v1 reader 继续可读，生产
create/finish export 均固定 fail-closed；旧记录只由 test-only fixture 构造。
`tests/delegation-lifecycle-ownership.test.ts` 固化唯一 owner、status 零写入、单一
action 文本 owner 和 v1 writer 禁止，`delegation-v2-wiring` 另以实际目录/entry
断言 status 前后无 transaction rewrite、session append 或 receipt。六份指定文档均
已更新为普通开发零手工 lifecycle choreography。当前生产 runtime/core 受影响文件
为 `+411/-435`，净删除 24 行；focused 244/244 PASS，最新 `npm run check` PASS。
`S2.2–S2.6` 没有本轮实际基线/吞吐指标，继续保持 `NOT_RUN`；这也不证明 runtime
reload、三个外部项目 canary、Gate、release、push 或 publish，均留给 WP8。

### WP8 — 三项目部署与最终出口

**目标：** 用实际运行证明修复，而不是以 Workbench 自测代替。

**执行顺序：**

1. Workbench typecheck。
2. affected focused suites。
3. full `npm run check`，稳定 Candidate 只运行一次。
4. release-assets/package/compatibility checks。
5. 构建并记录 runtime source hash。
6. 分别在 Scalper、Mace、Onchain 执行 runtime doctor。
7. loaded/disk hash 不同则 reload；reload 后重新 doctor。
8. 分别运行只读 authority replay/status。
9. 对每个项目运行一个普通开发 canary。
10. 对每个量化项目运行一个 Candidate→strict Gate canary；只使用项目已有安全
    测试/配置，不修改业务语义。
11. 检查 restart 后结果仍一致。
12. 生成最终对比报告并由人工审查实际 diff、运行输出和遗留风险。

**验收：**

- `WP8-AC01` loaded runtime hash 与已验证源码 hash 一致。
- `WP8-AC02` Scalper 历史不再产生深度增长或互相矛盾动作。
- `WP8-AC03` Mace review/repair/status 使用同一 action 并可收敛。
- `WP8-AC04` Onchain accepted successor 持续关闭 ancestor authority。
- `WP8-AC05` 三项目普通开发 canary 不被无关历史阻塞。
- `WP8-AC06` 三项目严格 Candidate 在证据缺失时 fail-closed，在证据完整时可运行
  Gate；测试不替代 Gate verdict。
- `WP8-AC07` restart/reload 后结果保持一致。
- `WP8-AC08` 无项目业务文件被 Workbench 迁移脚本改写。

**当前执行证据（2026-08-28）：**

- 最终 Workbench runtime source 为
  `sha256:5a21e90bb756bd37b9c7ff94c520d5670afaae499a498eb34c8eee882de65a7e`；
  Scalper、Mace、Onchain 的两个独立新进程轮次均报告 loaded/disk `CURRENT`，旧的
  三个交互 Pi PID 已退出，因此没有遗留的已知 stale live process。
- 实机 status canary 发现并修复两处旧 mirror 泄漏：`/q-status` 现在直接渲染 durable
  canonical projection；semantic REPAIR status 会严格恢复 review authority，并返回
  `EXECUTE_EXACT_REPAIR`；`/q-mode-verify` 的阻塞理由也消费同一 resolver action，
  不再把 Scalper 的 durable `FAILED` 错写成 `PENDING_REVIEW`。
- 普通 DEV diagnosis canary 均以零业务 delta 收敛：Scalper
  `20260828-195149-av5j`、Mace `20260828-195235-t5a8`、Onchain
  `20260828-195405-o136`。Onchain 的第一次探针 `20260828-195312-wmwg` 指向不存在
  的 `AGENTS.md`，虽安全零差异关闭但不计入验收，随后使用现有 `spec/README.md`
  重跑成功。
- Scalper canary 前后原 repair tip 保持 `20260828-145820-71ji`、depth 10、
  `EXECUTE_EXACT_REPAIR`，没有 lineage 增长或矛盾动作；严格 VERIFY 正确
  fail-closed，未运行 Gate。Mace 的不重叠 canary 后为 `FINISHED /
  CONTINUE_DEVELOPMENT`；Onchain 的 accepted ancestor 后新 canary 同样为
  `FINISHED / CONTINUE_DEVELOPMENT`。
- Mace B6 run `20260828-200401-up8n` 与 Onchain B6 run
  `20260828-200406-najn` 在 VERIFY、最终 runtime hash 下均 PASS；两者持久 manifest
  的 `candidate_binding` 都是 `null`，因此只算 Development Safety Gate，不算
  Candidate-bound Gate，也不授予 research、release、production 或 profitability
  authority。
- Mace 当前 `git-diff-check` run `20260828-200526-yfka` 与 Onchain 当前
  `m1-verify-uv-lock` run `20260828-200530-eupp` 均 PASS，但项目 recipe 没有单次完整
  `typecheck + unit-test + whitespace` validation components，Candidate projection 为
  unavailable；三个项目也都没有 candidate version/alias。因此 strict Candidate→Gate
  的真实状态为 Scalper `BLOCKED`、Mace/Onchain `NOT_RUN (CANDIDATE_INCOMPLETE)`，
  没有伪造 candidate id 或扩大项目配置范围。
- 所有外部项目命令前后业务工作树摘要完全一致：Scalper status/tracked/untracked
  为 `a43aa9c1/6172301a/912e49c5`，Mace 为
  `6e30f360/026b1c70/b460de11`，Onchain 为
  `11aded00/2f92a7b5/08233597`；只有 `.pi/workbench` 下的授权 canary 与 Gate/run
  元数据按预期新增。没有改写或删除历史 authority，没有 push、release 或 publish。

因此 WP8 的部署、普通 DEV、fail-closed 严格入口、restart 和零业务改写证据已经
完成；evidence-complete Candidate-bound Gate 与 `S2.2–S2.6` 实际前后效率指标仍为
计划级出口 blocker，保持 `BLOCKED/NOT_RUN`，不得把两个未绑定 Candidate 的 B6
PASS 写成最终 Gate 或计划完成。

---

## 10. 依赖关系与提交边界

```text
WP0 current-candidate closure
  ↓
WP1 real-history fixtures
  ↓
WP2 canonical resolver
  ↓
WP3 effect executor + recovery convergence
  ├─→ WP4 ordinary development lane
  └─→ WP5 strict research/release lane
          ↓
       WP6 model/fault tests
          ↓
       WP7 deletion/compat closure
          ↓
       WP8 three-project rollout/final exit
```

提交必须按行为边界组织，不按两文件小切片组织：

1. 当前恢复候选；
2. fixtures/characterization；
3. resolver + table tests；
4. executor + 所有入口迁移 + 删除重复判断；
5. 普通开发通道；
6. 严格研究/发布通道；
7. model/fault tests；
8. 文档/兼容/最终删除；
9. 如用户授权，最终发布提交。

每个提交只 stage 计划内文件，不使用 `git add -A`，不夹带外部项目或运行时 lock。
未经用户明确要求不 push、不发布、不创建 PR。

---

## 11. 兼容与迁移策略

### 11.1 读取兼容

- v1 与旧 v2 transaction/generation/review 保持只读解析；
- 旧 lineage 被规范化为 obligation projection，不重写原文件；
- 未知 schema、partial generation、identity conflict 继续 fail-closed；
- 可读派生 review 无效不等于底层 transaction 损坏。

### 11.2 新写语义

- 新 attempt 不再用无限 lineage depth 表达重试；
- 新 Candidate/Promotion 优先复用现有 manifest 与 hash；
- 若必须增加 schema 字段，采用 additive versioned field，并有旧 reader fixture；
- 不自动迁移或删除历史文件。

### 11.3 Quarantine

- quarantine 是可逆的 authority isolation，不是删除；
- 只允许精确 ID、精确 record hash、明确原因；
- readable derived review 不能使用 quarantine；
- active 或范围未知 authority 必须先证明 inactive/lost owner；
- quarantine 后重新扫描必须得到确定结果。

### 11.4 Rollback

- resolver/executor 变更以提交边界回退；
- 新 reader 能看到的新记录必须带 schema/version，旧 reader 不得误判成功；
- rollback 不能删除新记录，只能将其视为 unknown/non-authoritative；
- Candidate/Promotion 引用不可在 rollback 中重定向到旧 PASS。

---

## 12. 测试矩阵

| 层级 | 必须覆盖 |
| --- | --- |
| Pure unit | resolver、state/action table、reason registry、rank、canonical hash |
| Reader | v1/v2、partial/corrupt、review/generation/closure、legacy lineage normalization |
| Executor | CAS、idempotency、lost response、successor uniqueness、strict readback |
| Controller | slash/tool/status/footer 全部渲染同一 typed action |
| Concurrency | writer lock、two-session repair、review/repair race、crash recovery |
| Model-based | 随机合法/非法事件序列、缩减和 replay |
| Real-history | Scalper/Mace/Onchain 脱敏 authority trees |
| Lane E2E | ordinary DEV、Candidate freeze、VERIFY/Gate、promotion failure isolation |
| Quant | point-in-time、survivorship、cost、time split、folds、artifact lineage |
| Deployment | runtime hash、reload、restart、environment-local canary |

任何 focused PASS 只作为开发反馈。最终候选需要一次完整 `npm run check` 和实际
Pi E2E；三个外部项目必须分别验证，不能从一个项目推断另外两个项目。

---

## 13. 可量化出口指标

### 13.1 正确性

- 状态—动作组合覆盖率：100%。
- `status says X but executor refuses X`：0。
- 同一 idempotency key 多 successor：0。
- successor ACCEPT 后 ancestor blocker：0。
- zero-delta 导致 lineage 增长：0。
- partial/corrupt evidence 被消费为成功：0。
- runtime identity 未确认却声明生效：0。

### 13.2 收敛性

- 无新 delta 的 recovery：最多一次持久收敛动作。
- 有一个真实 repair delta：最多一次 implementation attempt + 一次 review；失败
  后保留一个 obligation，不自动无限重试。
- 真实项目 replay：全部到达 terminal/non-blocking，或返回一个无法由 Workbench
  自行解决的真实外部 blocker。

### 13.3 开发效率

- 普通小改手工 lifecycle 调用数：0。
- 相同 Candidate 的重复 full check：0。
- replay-safe read/status 新 receipt：0。
- 普通任务首次有效写入延迟相对 S2.0 基线下降至少 50%。
- 普通任务 governance 持久化文件/字节相对基线下降至少 80%。
- 同一任务重复 orientation bytes/tokens 下降至少 50%。

### 13.4 结构减负

- 生命周期决策 owner：1。
- 新增持久 authority/store：0（除非后续发现不可替代事实并另行批准）。
- 新 resolver 落地增量必须删除旧 predicates/next-action 分支。
- `index.ts` 保持 composition root，不重新吸收业务状态机。

---

## 14. 风险、停止条件与升级规则

### 14.1 必须停止并重新审查

- 新 resolver 与旧入口需要长期双写或持久 shadow comparison；
- 为兼容一个 fixture 又增加新的 authority 类型但没有删除旧类型；
- 需要自动删除历史文件才能收敛；
- 需要修改三个项目业务源码才能让 Workbench reader 通过；
- 普通通道降低权限、安全、迁移或 release 边界；
- Candidate identity 无法从现有 ChangeSet/run/artifact facts 推导，却准备新建通用
  store；
- 两个连续增量只有治理元数据增长，没有用户可见行为、测试能力或删除；
- 当前未提交修复与重构无法安全分离。

### 14.2 可降级但必须显式

- 无法机器验证的量化语义保留 manual evidence，不伪装 PASS；
- 真实项目存在 active writer 时等待，不回收 live lock；
- runtime 无法 reload 时部署验收为 `BLOCKED_RELOAD_REQUIRED`；
- 外部数据或服务不可用时严格 Gate 为 BLOCKED，普通 DEV 仍可继续不依赖该资源的
  工作。

### 14.3 不得接受的“完成”声明

- 只有单元测试 PASS；
- 只有一个项目恢复；
- source hash 已改变但 running Pi 未 reload；
- status 文案已改变但实际 action 仍拒绝；
- repair chain 暂时停在新 tip；
- Candidate 形成但 Q Gate/发布未运行；
- Gate PASS 被描述为盈利证明。

---

## 15. 最终 Definition of Done

只有以下条件全部满足，本计划才能标记 `COMPLETE`：

1. WP0–WP8 全部验收条件有当前证据。
2. 当前 Workbench diff 已由人工审查，目标文件外无夹带修改。
3. typecheck、focused、full check、release-assets 与 diff check 全部 PASS。
4. 唯一 lifecycle resolver 已替代所有生产 classification owner。
5. 三个真实项目历史 fixture 全部 replay PASS。
6. Scalper、Mace、Onchain 运行环境的 loaded/disk runtime identity 一致。
7. 三项目普通开发 canary 均不会被无关历史阻塞。
8. 三项目严格 Candidate/Gate canary 均按证据正确 PASS/FAIL/BLOCKED/NOT_RUN。
9. restart/reload 后结果稳定，重复 action 幂等。
10. 零差异 retry、accepted successor、readable invalid review、truncated packet、
    binding change、stale lock 等已知故障均有固定回归覆盖。
11. 没有自动删除或改写外部项目历史 authority。
12. 开发效率和持久化减负指标完成实际前后对比。
13. 文档准确区分开发完成、Candidate、研究接受、Gate、发布授权和盈利能力。
14. 未经用户授权没有 push、release 或 PR。

最终报告必须分别列出：

- 实际修改；
- 删除的旧治理；
- 运行的测试；
- 三项目实际结果；
- loaded runtime identity；
- Candidate/Gate/发布状态；
- 未完成或仍有风险的项目。

不得用计划状态、测试数量或自然语言总结替代上述证据。
