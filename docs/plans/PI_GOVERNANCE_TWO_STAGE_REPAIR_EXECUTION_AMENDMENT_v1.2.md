# Pi 两阶段修复执行修正案 v1.2：开发优先、净治理减法

| 元数据 | 值 |
| --- | --- |
| 版本 | `1.2` |
| 状态 | **ACTIVE** |
| 生效日期 | `2026-08-20` |
| 基础规格 | `PI_GOVERNANCE_TWO_STAGE_REPAIR_EXECUTION_SPEC_v1.0.md` |
| 前一修正案 | `PI_GOVERNANCE_TWO_STAGE_REPAIR_EXECUTION_AMENDMENT_v1.1.md` |
| 核心方向 | 以完成开发和缩短反馈周期为默认，以治理为受限的安全支撑 |

本修正案在 v1.1 已完成的“Pi 产品治理不得编排 Codex 开发”边界上，继续
修正两阶段方案本身。它不降低 P0 正确性、事务完整性、真实状态绑定、兼容、
回滚和发布验证要求；它取消把这些要求实现成更多人工步骤、更多独立治理
子系统和更多持久化记录的默认倾向。

发生冲突时，本修正案取代基础规格第 6、7、16 至 26 节及 v1.1 第 2、3 节的
执行方式。基础规格 S1.0 至 S1.5 的产品正确性目标和现有 AC 编号继续保留；
Stage 2 的旧 AC 编号用于追踪对应结果，但必须按本文的开发优先语义实现，
不得以完成旧设计中预设的 schema、store 或 lane 数量作为验收条件。

## 1. 本轮过重开发暴露的问题

### 1.1 把手段变成了目标

- 为证明 delegation 安全，开发过程反复创建 delegation、worker slice、repair
  slice、review 和状态迁移，形成自举循环。
- “真实 diff、当前状态、测试结果”本来是验收依据，却被扩张成必须维护的
  evidence bundle、progress mirror、run ID 和多份交接文案。
- 计划原意是减少重复工作，执行中却把每个小缺陷都当成新的完整生命周期。

### 1.2 切片粒度错误

- 同一根因被拆成 source、storage、wiring、fixture、docs、state 等多个两文件
  切片，每个切片都重复定向、类型检查、聚焦测试和交接。
- fresh worker 和 fresh repair worker 丢失局部上下文，重复读取同一规格、接口
  和失败证据，交接成本高于实现成本。
- 文件边界代替了行为边界，导致跨文件的一个完整功能被人为拆断。

### 1.3 验证被当作循环内步骤

- 同一候选反复运行 typecheck、focused matrix、完整 unit/check 和正式 recipe。
- 环境型失败与真实回归没有先聚类，出现对同一已知环境症状的重复复现和解释。
- ignored evidence 或测试夹具变化也触发大范围重新验证，缺少“候选输入是否变化”
  的简单判断。

### 1.4 用新的治理基础设施解决治理过重

- 原 S2.1 mechanical lane 仍要求完整 transaction、delta、review 和测试证据，
  因而低风险路径并不低成本。
- 原 S2.2 orientation capsule 新增 schema、cache 和 invalidation，可能把阅读成本
  转换成维护缓存系统的成本。
- 原 S2.3 evidence graph 新增 attestation graph/store，可能为了避免一次重复测试
  而引入长期的数据一致性问题。
- 原 S2.4 预设 SQLite/WAL，而不是先删除只读 receipt 和测量剩余写入量。
- `index.ts` 解耦被排在这些治理设施之后，使 6,000 行单体继续放大每次修改的
  理解与回归范围。

### 1.5 阶段门过度串行

- Stage 2 的全部工作包被设计成单链依赖，即使它们可以独立交付。
- 每个 AC、ID、状态和文档更新都被当成推进前置条件，实际功能完成反而成为
  次要事件。
- “全部材料齐备”代替了“用户可见开发路径已变快且没有安全退化”。

## 2. 不再妥协的开发优先原则

1. **先产生可工作的行为增量。** 一个工作单元必须以可运行代码、明确删除、
   可观察性能改善或可复现缺陷关闭为主要输出；纯状态搬运不是进展。
2. **一个根因，一个连贯改动。** source、tests、wiring 和必要文档在同一工作
   单元完成。不得以固定文件数拆分，不要求 fresh worker 修每个缺陷。
3. **默认路径必须短。** 普通开发任务的用户视角只包含：提出目标、执行开发、
   查看结果。范围确认、事务和测试可以自动完成，但不得要求用户手工串联
   delegate、review、status 和 gate。
4. **治理必须是净减法。** 新增任何 schema、store、cache、ledger、gate 或
   controller 前，必须指出它替代和删除的既有步骤；没有净减少就不实现。
5. **验证集中在稳定候选。** 开发中运行受影响测试；候选稳定后运行一次与风险
   相称的最终验证；未改变候选输入不得重复运行完整矩阵。
6. **安全强度按风险使用。** release、权限、安全、迁移、破坏性操作和生产
   authority 保持严格；普通源码/测试/文档开发不继承 release 级仪式。
7. **现有数据优先。** 能从 transaction、Git、测试输出和现有 telemetry 推导的
   信息不得再复制到新 evidence layer。
8. **删除优先于抽象。** 先删除无用 receipt、重复检查、重复状态和旧 wiring，
   只有确有剩余复杂性时才增加抽象。

## 3. 两阶段新结构

```text
Stage 1：可靠性底座
  S1.0/S1.1（已完成）
       ↓
  S1.2 ChangeSet 与相关 diff identity
       ↓
  S1.3 项目 authority / session 恢复
       +
  S1.4 run / artifact / gate 完整性
       ↓
  S1.5 一次集成、兼容和回滚验证

Stage 2：开发吞吐与结构减负
  S2.0 轻量基线 ─┬─ S2.1 默认交付路径减负
                  ├─ S2.3 验证去重
                  ├─ S2.4 receipt 删除与压缩
                  └─ S2.5 index.ts 持续拆分
  S2.2 上下文减负贯穿上述工作，不建设 capsule 平台
  S2.6 持续删除旧治理与文档，最后只做一次出口验证
```

Stage 1 仍先于 Stage 2 激活，但 Stage 2 内不再是 S2.0→S2.1→…→S2.6 的强制
串行链。共享接口稳定后，各项可以按用户价值和阻塞关系推进。进度以可合并的
行为增量衡量，不以创建了多少治理组件衡量。

## 4. Stage 1：只完成可靠性底座

### 4.1 保留内容

- delegation 的原子提交、真实 worker identity、完整文件 identity 和 fail-closed。
- worker delta、workspace drift、dependency/sensitive relevance 的正确区分。
- project authority 优先于易丢失的 session 镜像，且恢复不会乐观吞掉冲突。
- recipe/run/gate 不能把退出 0、partial artifact 或过期路径误判为 PASS。
- v1 只读兼容、v2 新写、零自动删除和可回滚 wiring。

### 4.2 执行减负

- 当前 S1.2 作为一个完整候选收尾，不再拆成新的 source/storage/review/docs/state
  子切片。发现多个失败时先形成一个失败集合，再按根因族直接修复。
- S1.3 与 S1.4 只有真实接口依赖才串行；能独立实现和测试的部分不等待对方的
  文档或进度镜像。
- 每个工作包最多有一次稳定候选最终验证。Stage 1 结束时才集中运行完整矩阵和
  真实 Pi E2E；之前的 focused tests 只作为开发反馈。
- 进度镜像只在工作包完成或明确阻塞时更新一次，不记录微步骤、worker、repair
  或每次测试运行。
- `index.ts` 在 Stage 1 不再增加新的业务状态机；必要 wiring 保持薄，新增逻辑
  必须进入可独立测试模块。

### 4.3 Stage 1 出口

Stage 1 出口只回答五个问题：

1. 真实实现变更是否被可靠归因且不会漏掉大文件尾部修改？
2. transaction/run/artifact 是否只有完整提交后才可消费？
3. session 重启、并发变化和损坏记录是否 fail-closed 且可恢复？
4. v1 历史是否只读可见、v2 是否成为新写路径且可回滚？
5. 一次完整验证和具名真实 Pi E2E 是否通过？

五项全部有当前证据即可进入 Stage 2。不得要求额外的 worker 报告、重复 recipe、
微步骤 ledger 或文档同步来延迟出口。

## 5. Stage 2：开发吞吐与结构减负

### 5.1 S2.0 — 轻量基线，不建设 telemetry 平台

- 只复用现有 transaction、test output、Git 和已有 telemetry，记录：用户操作数、
  首次有效写入时间、总耗时、完整验证次数、持久化文件数/字节、读取字节和
  `index.ts` 行数。
- 基线只需覆盖普通小改、跨文件功能、高风险变更和只读查询四类场景。
- 不新增通用 schema/store；只有现有数据无法回答一个退出指标时，才允许增加
  一个有界字段。
- 原 `S2.0-AC01..04` 按“指标可解释、可重复、不泄密、可比较”验收，不以是否
  创建 `governance-telemetry.ts` 或报告 schema 验收。

### 5.2 S2.1 — 默认交付路径，而不是新的 lane 系统

- 普通开发为默认：一次任务合同、一个连贯实现、受影响测试、一个最终结果。
- Pi 可在内部使用 worker，但不得要求用户手工完成 delegate→review→status→gate
  流程；正常成功路径自动收束 transaction 和 review。
- 低风险确定性修改直接执行已有 patch/write 能力，不新增 mechanical executor、
  lane decision store 或另一套 transaction。
- 高风险路径仅在权限、安全、生产配置、依赖/数据迁移、破坏性操作或 release
  authority 时启用额外确认和完整 gate。
- 无法分类时可以升级风险，但升级必须说明具体风险；不得用“治理相关”作为
  泛化理由。
- 原 `S2.1-AC01..06` 改为验收：低风险无需 LLM/人工编排、高风险不可降级、
  普通任务保持有界、所有路径仍由同一 ChangeSet 安全底座保护。

### 5.3 S2.2 — 上下文减负，不建设 Orientation Capsule

- 删除强制 fresh worker 和 repair worker 后，大部分重复 orientation 自然消失。
- 同一任务连续开发复用当前上下文；跨任务只传递短任务摘要、相关入口、测试和
  已知根因，不持久化完整仓库 capsule。
- 只有真实测量显示跨 session 重读仍是主要瓶颈时，才考虑一个可丢弃的只读
  缓存；不得预先建设 schema、store、失效图和 repair capsule。
- 原 `S2.2-AC01..05` 按首次写入延迟、重复读取字节和上下文 token 的实际下降
  验收，不以 capsule 文件存在验收。

### 5.4 S2.3 — 简单验证复用，不建设 Evidence Graph

- focused tests 在开发中按受影响范围运行；稳定候选只运行一次最终 check。
- 对未变化的候选，复用现有 run manifest 中的源码、配置、工具链和测试输入
  identity；任一输入变化只失效受影响组件。
- current-state probe、生产 preflight 和外部资源状态永远重新检查。
- 不新增 graph database、循环检测、TTL 网络或第二套 authority。若现有 run
  manifest 无法表达 exact key，先在原记录增加最小字段。
- 原 `S2.3-AC01..06` 按“无重复完整验证、精确失效、current probe 不缓存、
  partial/过期结果不冒充 PASS”验收。

### 5.5 S2.4 — Receipt 删除优先，存储升级后置

- 只读、无副作用、可安全重放的工具不创建持久化 receipt。
- 同一任务的内部工具调用不逐次生成 started/finalized 文件对；副作用边界只保留
  一份任务级 transaction 和必要幂等键。
- 先测量删除后的剩余写入量。只有文件式存储仍造成实际锁、恢复或容量问题时，
  才评估单日志或 SQLite/WAL；技术选型不是预设验收项。
- legacy receipt 只读保留；压实只提供显式 dry-run 和授权执行，不自动删除。
- 原 `S2.4-AC01..06` 继续验证只读零写入、副作用防重放、失败不冒充成功、容量
  可恢复、legacy 可读和脱敏，但不要求实现 `receipt-store.ts`。

### 5.6 S2.5 — `index.ts` 解耦前移并持续进行

- Stage 1 接口稳定后立即开始，不等待 S2.1 至 S2.4 全部完成。
- 新业务逻辑禁止写入 `index.ts`；入口只允许薄 wiring、注册和生命周期装配。
- 按真实变更热点提取 controller，每次提取一个完整行为域并携带现有测试，不为
  代码移动创建独立治理流程。
- 优先顺序：delegation/review、session/authority、run/gate、receipt、output、
  status、bootstrap/context。若耦合证据显示不同顺序更小，可直接调整并记录原因。
- 目标仍为 1,500–2,000 行，但更重要的是业务状态机全部具有明确 owner 和独立
  单元测试。Stage 2 开始后，除薄 wiring 外不得让 `index.ts` 净增长。
- 原 `S2.5-AC01..07` 保留行为目标；`worker slice` 改为“可独立审查的行为增量”。

### 5.7 S2.6 — 持续删除治理，不建设报告生成器

- 从 Stage 2 第一个增量起删除过时 worker-first 文案、重复状态、旧 receipts、
  无消费者 schema 和仅为微步骤存在的文档。
- 人类文档只保留当前架构、用户流程、风险边界和里程碑结论；不记录每个 run ID。
- 状态可从真实 transaction/run 推导时，不再维护独立 progress mirror 字段。
- 不新增 milestone report generator；先用现有数据生成一次简单摘要，只有重复人工
  生成确实成为瓶颈时才产品化。
- 原 `S2.6-AC01..05` 按“微步骤零文档同步、来源可追溯、旧文档不拥有 authority、
  输出有界不泄密”验收。

## 6. 硬性治理负担上限

以下是产品和后续开发都必须遵守的 stop rules：

1. **零自举编排：** Codex 开发 Pi 时不得使用 Pi delegation/gate/state 来取得
   写入权或验收自己的代码；真实 Pi 调用只发生在明确的产品测试/E2E。
2. **零微切片默认：** 同一根因不得仅因文件类型不同拆分。固定“两文件切片”、
   “每个缺陷 fresh worker”及“每个 wiring 单独 delegation”均已废止。
3. **零重复全验：** 候选输入未变化时，完整 typecheck/unit/check/recipe 矩阵
   最多运行一次；环境型失败先归类，不重复证明同一环境症状。
4. **零只读持久化：** 普通 inspect/list/read/status 不得创建 durable receipt、
   evidence 或 progress 记录。
5. **零预防性平台：** 没有当前测量和具体失败，不得新增通用 schema、store、
   cache、graph、generator 或数据库。
6. **净删除门：** 新治理组件必须在同一增量中删除或替代至少一个既有强制步骤，
   并证明用户操作数、I/O 或等待时间净下降；否则停止实现。
7. **生产代码优先：** 连续两个开发迭代若只有 docs/state/evidence 变化而没有生产
   行为、测试能力或实际删除，必须暂停治理工作并回到功能实现。
8. **25% 复核线：** 一个普通功能增量中，专用于治理元数据的新增代码若超过
   生产行为代码的 25%，必须说明不可替代的安全原因；否则删减设计。
9. **一次状态更新：** 工作包只在完成或真实阻塞时更新一次进度；中间 checkpoint
   留在开发对话或普通日志，不进入产品 authority。
10. **入口不再膨胀：** Stage 2 后任何把业务状态机继续写入 `index.ts` 的方案
    直接停止，先提取 owner 模块。

## 7. 可量化出口指标

与 S2.0 基线相比，Final Exit 至少满足：

- 普通小改的手工治理调用数减少到 `0`；用户不需要串联 workbench 工具。
- 相同候选的重复完整验证次数为 `0`。
- 只读工作流新增持久化 receipt 文件数为 `0`。
- 普通开发的首次有效写入中位延迟降低至少 `50%`。
- 普通任务的治理持久化写入文件数和字节数降低至少 `80%`。
- 同一任务因重复 orientation 读取的字节或 token 降低至少 `50%`。
- `index.ts` 降至 1,500–2,000 行，且不再拥有业务状态机。
- P0 transaction、identity、artifact/run/gate、兼容和 fail-closed 测试零退化。

若某项基线无法可靠测量，允许使用直接可观察的替代指标，但必须说明替代关系；
不得为获得指标而先建设新的 telemetry 平台。

## 8. 从当前状态继续

1. 保留 S1.0、S1.1 已完成结果，不重新执行、不重建证据。
2. 直接收束 S1.2 当前候选：完成剩余产品 E2E，按 AC01..06 一次映射；若发现
   缺陷，集中成根因集合后直接修复。
3. 用同样的连贯工作包方式完成 S1.3、S1.4；不创建微切片或新的治理层。
4. S1.5 只做一次兼容、回滚、完整验证和真实 Pi E2E，然后进入 Stage 2。
5. Stage 2 优先落地默认交付路径减负和 `index.ts` 解耦；验证/receipt 简化并行
   推进；context 和文档以删除为主。
6. 当前机器进度镜像无需为本修正案单独迁移；在下一个自然工作包完成时一次性
   记录本文版本即可，避免再次为计划调整制造状态工作。

## 9. Final Exit 判定

最终不再以“所有预设治理组件均已建成”判定完成，而以以下结果判定：

- P0/P1 正确性缺陷关闭，兼容和回滚有效。
- 普通开发默认路径确实更短、更少写入、更少等待、更少重复验证。
- 高风险和发布路径仍然 fail-closed，没有把速度建立在乐观 PASS 上。
- `index.ts` 成为 composition root，核心行为可以独立测试和维护。
- 没有为了满足计划而保留无消费者的 capsule、evidence graph、lane store、
  receipt database 或 milestone generator。
- 一次最终验证矩阵和具名真实 Pi E2E 通过。

任何方案如果提高了治理记录数量、人工步骤或等待时间，即使形式上完成旧 AC，
也不得判定本两阶段优化完成。
