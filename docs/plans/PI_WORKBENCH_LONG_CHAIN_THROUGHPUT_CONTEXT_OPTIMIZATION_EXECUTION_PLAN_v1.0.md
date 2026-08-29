# Pi Workbench 长链开发吞吐、上下文与续接全量优化执行计划 v1.0

| 元数据 | 值 |
| --- | --- |
| Plan ID | `pi-workbench-long-chain-throughput-context-optimization-v1` |
| 版本 | `1.0` |
| 状态 | **APPROVED DIRECTION / IMPLEMENTATION NOT_STARTED** |
| 方案批准日期 | `2026-08-29` |
| 计划落盘日期 | `2026-08-29` |
| 执行仓库 | `/home/hanbaoji/Projects/pi-vibing-seriously` |
| 制定时基线 HEAD | `main@231c3931e93295095e6c6b4f7a7013deff6443e3` |
| 上位历史计划 | `docs/plans/PI_WORKBENCH_TWO_LANE_LIFECYCLE_CONVERGENCE_EXECUTION_PLAN_v1.0.md` |
| 优化对象 | 已选择 worker delegation 或严格语义审阅后的长链开发路径 |
| 不得回退的路径 | 普通 DEV 直接开发路径、strict Candidate/Gate/Artifact 权威边界 |
| 真实验收项目 | `/mnt/tb4/Code/Scalper_V2`、`/mnt/tb4/Code/Mace_h4_v3`、`/mnt/tb4/Code/Onchain_profit` |
| 执行角色 | Pi 中的 Sol commander 负责合同、审阅与判定；fresh Luna worker 负责被委派的实现 |
| 权威边界 | 本文件是实施合同，不是代码完成、测试 PASS、运行时生效、Gate PASS、发布或盈利权威 |

本计划是一个独立的后续优化计划。它不改写上位计划已经形成的 WP0–WP8
历史，不重新定义双通道产品模型，也不授权本次会话开始实现、提交、推送、部署
或修改三个外部项目。任何未执行项目均为 `NOT_RUN`；源码存在、单元测试通过、
运行时已加载、真实项目有效和 Gate/发布获批必须分别陈述。

---

## 1. 执行结论

本轮优化的目标不是减少质量控制，而是删除长链开发中反复搬运、重复审阅、错误
续接和无效状态往返。全量方案由四个相互闭合的改造组成：

1. **Hash-bound 增量语义审阅继承**：successor 只重新审阅真实变化及其影响闭包，
   未变化且满足严格证明条件的父审阅结果按内容 hash 继承。
2. **可恢复的自动批量审阅**：完整审阅在独立、持久、可续跑的 review job 中完成，
   每批最多 8 页或 64 KiB；主控上下文只接收不超过 2 KiB 的机器摘要。
3. **同 delegation checkpoint 续接**：保留每次 Luna 都是 fresh `--no-session`
   进程，但 spend soft limit 不再被当成语义失败或新 repair；同一 delegation 依据
   机器 checkpoint 继续，累计预算不重置。
4. **唯一动作快照与状态感知上下文面**：由一个 hash-bound
   `LifecycleActionSnapshotV2` 同时驱动状态显示、可见工具和自动动作；相同快照
   重复调用必须是 no-op。

四项完成后的目标流程是：

```text
普通小改动
  -> 继续走现有直接开发路径，不创建 delegation/review 负担

长链委派开发
  -> fresh Luna attempt
  -> 必要时同 delegation checkpoint 续接
  -> 一个最终 committed generation
  -> 可恢复批量语义审阅
  -> ACCEPT 或真实语义 REPAIR

successor repair
  -> 绑定父 evidence
  -> 只审 delta + 影响闭包
  -> 新的全局跨文件最终判定
```

最终必须同时实现两个结果：

- 相同质量标准下，Scalper 规模长链从实测 224.4 分钟降至 125–140 分钟；
- 不把已经优化到 3.707 秒中位首次写入的普通 DEV 路径重新拖入 delegation、
  authority 或 review 生命周期。

---

## 2. 计划边界与当前基线

### 2.1 与上位计划的关系

上位计划负责双通道、Candidate、Gate、delegation lifecycle、exact repair、运行时
身份和三项目出口。本计划只处理上位计划完成后暴露出的长链吞吐问题：

- 不改变普通开发通道与严格研究/发布通道的选择规则；
- 不改变 Sol commander 与 Luna worker 的责任边界；
- 不改变 Candidate、B0–B6、Q0–Q5、VERIFY、Artifact 或 release authority；
- 不把失败历史重新升级为项目级永久负权威；
- 不为 Codex 或其他仓库维护代理复制 Pi Workbench 工作流。

若本计划与上位计划发生语义冲突，必须停止实现并由用户确认；不得在代码中静默
选择其中一套语义。

### 2.2 制定时工作树事实

计划制定时：

- HEAD 为 `231c3931e93295095e6c6b4f7a7013deff6443e3`；
- 工作树有 54 个 tracked 文件发生变化；
- 有 3 个 untracked 路径，其中包括运行时 lock 和两份 throughput baseline；
- tracked diff 约为 `+1311 / -605`。

这些变化属于用户当前候选，不是本计划创建的实施基础。真正执行 LCO-WP0 前必须
先重新读取 live Git 状态，明确哪些文件已提交、哪些仍是用户工作；禁止 reset、
clean、stash、覆盖或混合提交。本计划文件本身也不得被当作对上述变化的接管。

### 2.3 普通 DEV 路径的已验证保护线

现有未跟踪 baseline 记录了三次合成普通小改动样本：

| 指标 | 当前观测 | 本计划要求 |
| --- | ---: | --- |
| 首次有效写入中位数 | 3.707 秒 | 不得显著回退；出口上限 4.960 秒 |
| 每样本 worker 调用 | 0 | 必须保持 0 |
| 每样本 delegation/workbench tool | 0 | 必须保持 0 |
| authority-only 持久化 | 0 文件 / 0 字节 | 必须保持 0 |
| exact-edit 前置读取 | 0 | 精确 old/new 条件满足时必须保持 0 |

本计划所有新 resolver、active-tool 和 context 行为都必须先证明不会影响这条路径。

### 2.4 Scalper 长链实测基线

复盘数据来自：

- Pi session：
  `/home/hanbaoji/.pi/agent/sessions/--mnt-tb4-Code-Scalper_V2--/2026-08-29T00-41-07-117Z_01a04af6-8d2d-754b-8f54-38bf99359adc.jsonl`；
- delegation authority：
  `/mnt/tb4/Code/Scalper_V2/.pi/workbench/delegations`；
- recipe receipts：
  `/mnt/tb4/Code/Scalper_V2/.pi/workbench/runs`；
- 复盘可视化数据：
  `/home/hanbaoji/.codex/visualizations/2026/08/28/01a04822-e18e-70b0-8c5c-f095e8945536/pi_scalper_retrospective_artifact.json`。

这些是计划制定证据，不是未来运行时 authority。LCO-WP0 必须把不含 prompt、
源码、秘密或用户数据的聚合基线固化为可重算记录。

| 指标 | 实测值 | 含义 |
| --- | ---: | --- |
| 完整窗口 | 224.4 分钟 | 从会话开始到 durable ACCEPT |
| 产品 worker 活动 | 92.6 分钟 | 12 个活动窗口；不能等同于纯键入代码时间 |
| Workbench 缺陷修复 | 31.4 分钟 | 当轮额外系统修复；不是测试时间 |
| Diff 审阅与呈现 | 71.8 分钟 | 主要长链瓶颈 |
| 定向、状态与组织 | 28.6 分钟 | 含有效协调与无效往返 |
| review 工具调用 | 223 / 423 | 占全部工具结果 52.7% |
| review 原始输出占比 | 83.9% | 原始工具输出主要被 review 搬运占用 |
| 原始工具文本 | 约 3.01 MB | 大量进入过传输链 |
| 最终活跃投影 | 129.7 KB | 约 95.7% 原始文本之后又被折叠 |
| repair 调用 | 25 | 只有 11 次进入实际 worker generation |
| 无 worker repair | 14 | 56% 没有产生 worker |
| worker 正常成功 | 2 / 11 | 其余多数被 turn limit/command failure 终止 |
| recipe 执行 | 63 次 / 46.8 秒 | 测试进程不是墙钟瓶颈 |
| Commander 成本 | 约 $30.92 | 其中 review 类约 $16.99 |
| 最终审阅范围 | 42 路径 / 47 页 | successor 只改少量内容却重复展示全量 |

### 2.5 最大浪费的五个点

| 排名 | 浪费 | 根因 | 本计划关闭点 |
| --- | --- | --- | --- |
| 1 | successor 重复全量审阅和展示 | review 只有当前完整 presentation，没有父 evidence 继承合同 | LCO-WP1、LCO-WP3 |
| 2 | 原始上下文搬运严重膨胀 | review 页、状态、receipt 多次进入 Commander session，之后再被 compact | LCO-WP2、LCO-WP5 |
| 3 | no-op repair/status 调度 | 展示动作、executor guard 和 durable authority 不是同一个快照 | LCO-WP5 |
| 4 | turn limit 把有用工作终结为失败 | per-process 终止与 delegation 语义终态混淆 | LCO-WP4 |
| 5 | 机器事实与自然语言/动作失配 | delegation id、binding、coverage、next action 可被文本猜测 | LCO-WP5、LCO-WP6 |

上下文搬运不是附带问题，而是前两项优化的共同放大器：即使最终 context 通过
compaction 变小，已经发生的模型调用、序列化、WebSocket/工具结果传输、解析和
付费不会因此消失。因此它属于最值得优先处理的四个点之内，而不是最后再做的 UI
美化。

---

## 3. 目标、非目标与不可退让约束

### 3.1 必须达成的目标

1. 一个 successor 的语义审阅成本与真实 delta/影响闭包近似相关，不再与全部历史
   文件规模近似相关。
2. 自动语义审阅中断后只重做缺失批次，不重放已经持久化且 hash 有效的批次。
3. Commander session 不接收完整 review 页或完整 page assessment；只接收稳定、
   有界、可定位到 durable evidence 的摘要。
4. worker soft spend 到达时可在同一 delegation 下续接，fresh 进程隔离保持不变。
5. 只有语义缺陷创建 repair successor；预算暂停、provider 错误、进程退出和可恢复
   存储错误不得伪装成语义 REPAIR。
6. status、next action、active tools、自动动作和 executor admission 必须消费同一份
   `LifecycleActionSnapshotV2`。
7. 重复读取相同状态、重复点击相同动作或丢失响应后重试必须幂等。
8. V1 历史只读兼容；任何 V2 ACCEPT 都必须有完整 V2 evidence，不伪造、补写或
   改写旧历史。
9. 三个真实项目必须独立验证 runtime identity、authority 和结果，不得用 Scalper
   的通过推断 Mace/Onchain 已生效。
10. 保留当前测试强度和最终检查；优化不得以减少测试、降低 reasoning 或放松
    fail-closed 条件换取速度。

### 3.2 明确非目标

- 不修改 Scalper、Mace、Onchain 的业务代码、量化策略、schema 或 Gate 结论。
- 不改变普通 DEV 直接开发路径的选择逻辑和安全边界。
- 不引入第二套 delegation store、shadow authority、dual write、后台数据库、消息
  队列、守护进程或通用 workflow 平台。
- 不把 OpenAI conversation state、compaction item、prompt cache 或模型自然语言
  当作 durable Workbench authority。
- 不取消完整 diff scope、内容 hash、cross-file assessment 或最终语义判定。
- 不自动继承父 REPAIR、父 blocking finding、binary `NOT_INSPECTED` 或来源不明的
  evidence。
- 不让 Luna 自己宣布 ACCEPT、Gate PASS、Candidate、release 或盈利。
- 不在第一阶段接入 Programmatic Tool Calling；它只可在质量基准后作为可选实验。
- 不在没有 A/B 成本证据时启用 review prompt cache。
- 不以更多治理文件或更长提示词替代代码中的唯一状态合同。

### 3.3 不可退让的质量约束

1. **完整范围不丢失**：最终 evidence 必须覆盖所有相关路径或给出机器可验证的
   inherited proof；没有第三种“默认算已审”。
2. **真实变化必重审**：内容 hash、合同、review policy、依赖闭包或 cross-file
   影响发生变化时，相关 stream 必须进入新审阅。
3. **全局判定永远新做**：即使全部路径可继承，也必须对当前 generation 运行一次
   新的 cross-file/final assessment。
4. **身份稳定**：delegation、generation、contract、bound diff、review policy、
   stream set、parent evidence 和 runtime build identity 必须交叉绑定。
5. **隔离保持**：每个 Luna attempt 仍使用 fresh `--no-session` 进程和受限工具集。
6. **预算不重置**：checkpoint continuation 的 turns、total tokens、output tokens、
   wall time 和 attempt 数均累计。
7. **故障不升级语义**：provider、存储、预算和进程故障只产生 operational state，
   不能产生语义 REPAIR/ACCEPT。
8. **一次一个 writer**：同一项目和同一 delegation 不允许两个并发 Luna writer。
9. **证据先于摘要**：durable evidence 成功落盘并读回后，才允许向 Commander 返回
   摘要；摘要丢失可以重建，证据丢失必须 fail closed。
10. **普通路径不回退**：LCO 功能不得让精确普通写入自动进入长链工具面。

---

## 4. 官方文档约束如何落地

### 4.1 Pi extension/context 边界

Pi extension 文档提供 `ctx.getContextUsage`、`ctx.compact`、`pi.appendEntry` 和
`pi.setActiveTools` 等能力：

- <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md>
- <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md>

本计划只使用它们做上下文观测、持久摘要和工具面控制：

- `appendEntry` 保存 Commander 恢复所需的内容无关、可重建快照；
- `setActiveTools` 只缩小当前可见工具，不改变 executor 的真实权限检查；
- compact 在里程碑使用，不在每页 review 后使用；
- compact summary 不是 delegation、review 或 Gate authority。

### 4.2 OpenAI compaction 与 conversation state 边界

官方 OpenAI 文档说明 compaction 用于缩小长会话上下文并继续后续请求，结果应作为
续接载荷使用：

- <https://developers.openai.com/api/docs/guides/compaction>
- <https://developers.openai.com/api/docs/guides/conversation-state>

因此，本计划不依赖“先把 3 MB 原始结果塞进会话，再 compact”来优化。正确顺序是：

1. review 原始页和 page assessment 首先在 Commander session 外持久化；
2. Commander 只看 bounded summary；
3. 只有里程碑跨越时才 compact；
4. compact 后从 durable snapshot 重建 next action，而不是相信自然语言回忆。

### 4.3 Prompt cache 边界

官方 prompt-caching 文档要求稳定前缀，并通过 `cached_tokens`、
`cache_write_tokens` 等使用数据判断收益：

- <https://developers.openai.com/api/docs/guides/prompt-caching>

当前 structured review 明确使用 `cacheRetention: "none"`。本计划不直接改成启用：

- 先完成 batch 与 inheritance，取得同一冻结语料的无缓存基线；
- 只缓存稳定的 system/tool/schema/policy 前缀，不缓存动态 diff/page 内容；
- cache key 必须含 review policy hash 与模型身份，不含项目名、秘密或用户文本；
- 若 cache write 成本、延迟或质量不优于 `none`，保持 `none` 即为正确结果。

### 4.4 模型能力使用边界

OpenAI 当前模型指导建议：减少重复提示和无关工具；Programmatic Tool Calling 适合
有界、工具密集、无需每步新判断的处理，但必须用代表性任务比较质量、完整性、
tokens、延迟和成本：

- <https://developers.openai.com/api/docs/guides/latest-model>

对应到本计划：

- path/hash 过滤、去重、批次装配和 schema 校验必须是确定性 TypeScript；
- 语义正确性、跨文件风险和 ACCEPT/REPAIR 仍由 Sol 模型判断；
- PTC 最多用于未来的有界机械聚合，不得作为 LCO-WP1–LCO-WP5 的依赖；
- reasoning effort 的任何调整都必须单独做质量 A/B，不能为满足成本指标而直接降低。

---

## 5. 目标架构与数据流

### 5.1 单一事实链

```text
Delegation contract + committed generation
                    |
                    v
          Review Relevance Projection
                    |
                    v
        SemanticReviewEvidenceV2 owner
             /                 \
            /                   \
  inherited stream proof     changed/affected streams
            |                   |
            |            resumable batch review job
            |                   |
            +---------> fresh final assessment
                              |
                              v
                     durable ACCEPT / REPAIR
                              |
                              v
                   LifecycleActionSnapshotV2
                    /          |          \
                 status    active tools   exact executor
```

所有展示层都读取同一事实链。不得由 status、review command、automatic continuation
或 repair service 分别重新猜测下一动作。

### 5.2 三个执行面

| 执行面 | 责任 | 不得承担 |
| --- | --- | --- |
| Worker execution | fresh Luna 实现、journal、checkpoint、最终 handoff | semantic ACCEPT、Gate、release |
| Review job | page/batch 语义审阅、进度、final assessment、完整 receipt | 修改业务源码、创建 repair worker |
| Commander session | 合同、启动/监督、读取 bounded snapshot、最终动作与用户沟通 | 承载全部 review 页、手工维护 cursor |

### 5.3 存储原则

- 复用 `.pi/workbench/delegations/<id>/v2` 现有单一 authority tree；
- 新 record 必须通过现有 transaction storage 的原子写入、锁、hash 和 read-back
  语义发布；
- 不新建全局数据库或旁路 ledger；
- review progress 是可丢弃、可重建的 operational record；final evidence 才是
  immutable semantic record；
- worker checkpoint 是同 delegation 的 execution record，不是 committed final
  generation，也不是 review evidence；
- appendEntry 中只放 snapshot hash、动作、计数、路径定位符和 bounded 摘要，
  不放 raw diff、page 内容、prompt、secret 或完整 finding body。

---

## 6. 身份、术语与哈希域

### 6.1 核心术语

- **stream**：一个被完整内容 hash 绑定的审阅单元，通常是路径内容或已存在的
  binary/container compact evidence。
- **changed stream**：相对父 evidence 内容 hash 不同或父 proof 不可验证的 stream。
- **affected stream**：内容未变，但处在 changed stream 的声明依赖/反向依赖闭包，
  或被 cross-file finding 指向的 stream。
- **inherited stream**：满足 §8 全部条件、无需重新做 page-level semantic judgment
  的父 PASS stream。
- **review batch**：一次模型请求中最多 8 个 page binding 且动态 payload 不超过
  64 KiB 的有序集合。
- **review job**：绑定一个 committed generation 的完整、可恢复批量审阅运行。
- **checkpoint attempt**：同 delegation 下一个 fresh Luna 进程的有界执行片段。
- **action snapshot**：由当前 durable authority 纯计算出的唯一动作和 exact target。

### 6.2 必须交叉绑定的身份

所有 V2 semantic evidence 必须至少绑定：

```text
delegation_id
generation
generation_content_hash
contract_hash
bound_diff_hash
relevance_projection_hash
review_envelope_hash
review_policy_hash
model_identity
stream_set_hash
parent_evidence_hash | null
runtime_build_identity
```

任何字段缺失、冲突、不可解析、hash 不匹配或指向未提交 generation，结果只能是
`AUTHORITY_INVALID` / `REVIEW_REQUIRED`，不得降级为继承或 ACCEPT。

### 6.3 Hash 域规则

1. 使用现有 canonical JSON hash 约定；key 顺序、空值、时间和 path normalization
   必须固定。
2. 内容 hash 来自实际完整 bytes，不来自显示摘要、mtime 或 worker prose。
3. binary/container identity 只能证明 bytes 身份；`NOT_INSPECTED` 不能被提升为
   semantic PASS。
4. policy hash 必须覆盖 system prompt、tool schema、decision constraint、模型身份、
   reasoning options 和 batch schema。
5. evidence hash 必须覆盖继承 proof、fresh assessments、final assessment、usage 和
   terminal code。
6. 时间字段不进入可重算内容身份，或必须使用现有 canonical timestamp 规则；不得
   因重试时间不同导致相同 evidence 无法幂等识别。

---

## 7. 目标数据合同

以下是实施时必须保持的语义形状。最终 TypeScript 名称可在不改变字段语义的前提下
微调，但任何删减必须回到本计划审查。

### 7.1 `SemanticReviewEvidenceV2`

```ts
interface SemanticReviewEvidenceV2 {
  schema_version: 2;
  kind: "semantic-review-evidence-v2";
  delegation_id: string;
  generation: number;
  generation_content_hash: string;
  contract_hash: string;
  bound_diff_hash: string;
  relevance_projection_hash: string;
  review_envelope_hash: string;
  review_policy_hash: string;
  model_identity: {
    provider: "openai-codex";
    model: "gpt-5.6-sol";
    api: string;
  };
  runtime_build_identity: string;
  stream_set_hash: string;
  parent_evidence_hash: string | null;
  streams: readonly SemanticStreamEvidenceV2[];
  cross_file_assessment: CrossFileAssessmentV2;
  final_decision: "ACCEPT" | "REPAIR";
  repair_reason: string | null;
  nested_usage: Usage;
  completed_at: string;
  evidence_hash: string;
}
```

每个 `SemanticStreamEvidenceV2` 必须二选一：

```ts
type SemanticStreamEvidenceV2 =
  | {
      source: "FRESH";
      stream_id: string;
      path: string;
      content_hash: string;
      page_binding_hashes: readonly string[];
      assessment_hash: string;
      verdict: "PASS" | "REPAIR" | "NOT_INSPECTED";
    }
  | {
      source: "INHERITED";
      stream_id: string;
      path: string;
      content_hash: string;
      parent_evidence_hash: string;
      parent_stream_assessment_hash: string;
      dependency_closure_hash: string;
      inheritance_proof_hash: string;
      verdict: "PASS";
    };
```

约束：

- inherited 分支只能是 `PASS`；
- `REPAIR`、`NOT_INSPECTED`、缺失或 legacy stream 必须 fresh review；
- final decision 为 ACCEPT 时，每个 stream 必须为 `PASS`，且 fresh cross-file
  assessment 无 blocking finding；
- evidence 落盘后不可修改；重试相同输入必须读回同一 hash 或报 conflict。

### 7.2 `SemanticReviewProgressV2`

```ts
interface SemanticReviewProgressV2 {
  schema_version: 2;
  kind: "semantic-review-progress-v2";
  review_job_id: string;
  delegation_id: string;
  generation: number;
  input_identity_hash: string;
  review_policy_hash: string;
  status:
    | "PREPARED"
    | "RUNNING"
    | "FINALIZING"
    | "COMPLETED"
    | "RETRYABLE_FAILURE"
    | "SPLIT_REQUIRED";
  batches: readonly ReviewBatchProgressV2[];
  completed_batch_set_hash: string;
  final_evidence_hash: string | null;
  cumulative_usage: Usage;
  updated_at: string;
  progress_hash: string;
}
```

每个 batch record 必须绑定 batch ordinal、page bindings、request hash、response
projection、assessment hashes、usage、outcome 和 error hash。原始动态 page 内容可按
现有 presentation authority 定位，不在 Commander entry 中复制。

### 7.3 `WorkerCheckpointV1`

```ts
interface WorkerCheckpointV1 {
  schema_version: 1;
  kind: "worker-checkpoint-v1";
  delegation_id: string;
  contract_hash: string;
  attempt: number;
  parent_checkpoint_hash: string | null;
  runtime_build_identity: string;
  before_binding_hash: string;
  current_binding_hash: string;
  touched_paths: readonly {
    path: string;
    before_hash: string | null;
    current_hash: string | null;
    journal_hash: string;
  }[];
  completed_recipe_run_ids: readonly string[];
  cumulative_usage: Usage;
  cumulative_turns: number;
  remaining_budget: WorkerRemainingBudgetV1;
  machine_state: "CHECKPOINTED" | "PAUSED_BUDGET";
  worker_advisory: {
    completed_criteria: readonly string[];
    remaining_criteria: readonly string[];
  };
  created_at: string;
  checkpoint_hash: string;
}
```

`worker_advisory` 只帮助下一 fresh worker 定向，不能证明 criterion 完成。下一 attempt
必须自己读取合同、当前 bytes、journal 和已完成 recipe receipt。

### 7.4 `LifecycleActionSnapshotV2`

```ts
interface LifecycleActionSnapshotV2 {
  schema_version: 2;
  kind: "lifecycle-action-snapshot-v2";
  project_root_hash: string;
  mode: "AUDIT" | "DEV" | "VERIFY";
  authority_hash: string;
  state: string;
  action:
    | "NONE"
    | "CONTINUE_DIRECT_DEVELOPMENT"
    | "START_DELEGATION"
    | "CONTINUE_CHECKPOINT"
    | "REVIEW_CANDIDATE"
    | "RETRY_REVIEW_JOB"
    | "START_EXACT_REPAIR"
    | "PAUSED_BUDGET"
    | "PROMOTE_CANDIDATE"
    | "RUN_GATE"
    | "RECOVER_AUTHORITY";
  exact_target: {
    delegation_id?: string;
    generation?: number;
    review_job_id?: string;
    repair_of?: string;
    candidate_id?: string;
    bound_hash?: string;
  };
  tool: string | null;
  arguments: Readonly<Record<string, unknown>> | null;
  safe_automatic: boolean;
  authorization: "NONE" | "EXISTING" | "USER_REQUIRED";
  retryable: boolean;
  reason_code: string;
  invalidation_conditions: readonly string[];
  snapshot_hash: string;
}
```

同一 authority hash 必须产生同一 snapshot hash。状态文本、active tools、自动执行和
executor guard 必须校验相同 snapshot；任何消费者不得独立重新选择 delegation id、
repair root、review job 或 bound hash。

---

## 8. Hash-bound 增量语义审阅合同

### 8.1 可以继承的必要且充分条件

一个 stream 只有同时满足下列条件才可继承：

1. 父 `SemanticReviewEvidenceV2` 已完整 final、hash 验证通过且属于直接 parent；
2. 父 final decision 为 `ACCEPT`；或者父 final decision 为 `REPAIR`，但当前
   stream 在父 evidence 中被明确判为 `PASS`，且不在任何 finding/影响闭包内；
3. 当前 root task、acceptance criteria、contract hash 与父合同一致；
4. review policy hash 与模型 identity 一致；
5. 当前 stream 的完整 content hash 与父 stream 完全相同；
6. stream 不在 changed set；
7. stream 不在声明依赖和反向依赖的影响闭包；
8. 父 stream verdict 为明确 `PASS`；
9. 父 evidence 中没有指向该 stream 的 blocking/cross-file finding；
10. 当前 generation 没有 scope expansion、未知路径、binary semantic gap、
    relevance projection drift 或 envelope incompatibility。

条件计算必须是确定性纯函数。只要一个条件无法证明，就进入 fresh review；不得
通过人工文本写“应该没变”来强制继承。

### 8.2 变化集与影响闭包

初始 changed set：

- 新增、删除、重命名或完整 bytes hash 改变的路径；
- contract/criteria 新增 owner ref 指向的路径；
- presentation 类型从 text 变 binary/container 或相反的路径；
- dependency metadata、schema、生成器、锁文件或公共接口发生变化的路径。

影响闭包至少包含：

- 当前 bounded contract 显式依赖；
- relevance projection 中的 owner/ref 关系；
- 已持久化 cross-file finding 的受影响路径；
- schema ↔ generator ↔ generated fixture 的双向闭包；
- 公共接口 ↔ 直接 consumer/test 的闭包。

第一版不建立新的全仓库通用依赖图。只能复用现有 contract/relevance/owner refs 和
本 delegation 已声明关系；无法证明的依赖按 fresh review 处理。

### 8.3 Repair successor 规则

- 真实语义 REPAIR 的 defect paths、finding references 和影响闭包全部 fresh review；
- 父 evidence 中无 finding、内容不变且不受影响的 `PASS` stream 可以继承；
- 父 REPAIR 的最终决策本身绝不能被继承为 ACCEPT；只有父 evidence 中明确为
  `PASS`、内容未变且不受任何 finding 影响的 stream 才可按 §8.1 继承；
- successor 必须产生新的 cross-file assessment 和 final evidence；
- repair scope 若比父 finding 建议更窄，必须 fail closed 为 scope conflict；
- repair scope 扩大时，新增路径全部 fresh review。

### 8.4 全未变场景

如果所有 stream 都满足继承：

- 仍创建一个绑定当前 generation 的新 evidence；
- page-level fresh calls 可为 0；
- 必须运行 1 次 fresh final/cross-file assessment；
- 必须重新验证 current worktree/generation bytes 与 evidence binding；
- 不得把父 ACCEPT sidecar 直接复制或改写 generation 字段。

### 8.5 Legacy 兼容

| 输入 | 行为 |
| --- | --- |
| 完整 V2 parent evidence | 按严格条件尝试继承 |
| V1 semantic ACCEPT | 只读；当前 successor 做一次完整 V2 baseline review |
| legacy provisional/PENDING_REVIEW | 使用现有 migration/rebuild 路径；不继承 |
| malformed/tampered evidence | `AUTHORITY_INVALID`，不得自动重建为 ACCEPT |
| binary `NOT_INSPECTED` | identity 可复用，semantic verdict 不可继承 |
| 缺失 parent evidence | 完整 fresh review |

---

## 9. 可恢复自动批量审阅合同

### 9.1 批次大小与容量

默认生产边界：

| 层级 | 页面上限 | 动态内容上限 | 行为 |
| --- | ---: | ---: | --- |
| 单模型 batch | 8 页 | 64 KiB | 任一先到即切批 |
| 普通自动 review job | 64 页 | 1 MiB | 默认允许 |
| 显式 large review job | 128 页 | 4 MiB | 必须由 snapshot 标记且独立预算 |
| 超过 large | >128 页或 >4 MiB | — | `SPLIT_REQUIRED`，不进入手工 223 次翻页 |

容量基于 UTF-8 动态 payload bytes 与已验证 page bindings 计算。system/tool/schema
稳定前缀不计入 64 KiB 动态页上限，但计入真实 token/成本观测。

### 9.2 状态机

```text
PREPARED
  -> RUNNING
      -> RUNNING (每个 batch 原子落盘并读回)
      -> RETRYABLE_FAILURE (provider/网络/进程/临时存储错误)
      -> SPLIT_REQUIRED (容量超限)
      -> FINALIZING
          -> COMPLETED (final evidence 原子发布)
          -> RETRYABLE_FAILURE
```

`RETRYABLE_FAILURE` 重试时：

1. 重新读取 committed generation、policy 和 progress；
2. 验证 input identity 未变；
3. 已完成且 hash 有效的 batch 不再调用模型；
4. 只调度 missing/invalid batch；
5. 所有 batch 完成后重新做 final assessment；
6. final evidence 已发布但响应丢失时，严格 read-back 并返回相同结果。

### 9.3 并发与幂等

- 一个 generation 同时只能有一个 active review job；
- job 创建使用现有 delegation transaction lock/CAS；
- 同一 input identity 的重复 start 返回已有 job；
- 不同 input identity 命中已有 job 时返回 `PRESENTATION_DRIFT`；
- batch completion 使用 ordinal + request hash 幂等键；
- 两个进程争抢同一 batch 时只有一个能发布，另一个读取胜者；
- completed evidence 不允许被后到的 retryable error 覆盖。

### 9.4 Commander context 输出合同

review job 的每次 parent-visible 输出最多 2 KiB / 24 行，固定顺序为：

1. status；
2. delegation/generation/review job identity；
3. pages/batches completed/total；
4. inherited/fresh stream counts；
5. blocking finding count；
6. cumulative nested usage/cost；
7. durable progress/evidence locator；
8. exact next action；
9. omission fact（明确完整内容未内联）。

raw page、完整 diff、完整 page assessment、完整 receipt 和模型 response 不进入
Commander session。它们必须在 review job authority 下可按 hash 定位和审计。

### 9.5 模型调用与最终判断

- 每个 batch 一次结构化模型调用，返回 batch 内每页独立 assessment；
- schema 必须确保每个 page binding 恰好出现一次，顺序固定，无重复、无缺失；
- 任一无效 tool response、identity、usage 或 schema 使本 batch 失败，不部分接受；
- final call 接收 compact structured assessments 和 inherited proof summary，不接收
  被省略的代码正文；
- final call 必须检测跨页/跨文件冲突；
- 任一 blocking finding 强制 REPAIR；terminal-negative review 继续保持 REPAIR_ONLY。

### 9.6 Prompt cache 与 PTC 的资格门

Prompt cache 只能在无缓存 batch 方案质量通过后进入实验：

- A：`cacheRetention: none`；
- B：稳定 system/tool/schema 前缀 + policy-bound cache key；
- 比较 task success、blocking defect recall、false ACCEPT、tokens、cache write/read、
  wall time 和成本；
- B 没有净收益或出现质量漂移则永久保留 A。

PTC 不属于 v1.0 必须实现项。若未来实验，只允许做 batch 装配、去重、hash/shape
验证和结果聚合；语义判断必须仍由模型的结构化 review/final calls 完成。

---

## 10. 同 delegation checkpoint 续接合同

### 10.1 不变的隔离边界

每个 worker attempt 继续使用：

- fresh Pi child process；
- `--no-session`；
- pinned Luna model 与 reasoning；
- 原有 tool allowlist、path containment、write journal 和 command-effect 观测；
- 同一 bounded task contract 与同一 delegation id。

续接复用的是机器状态，不是旧模型 conversation、reasoning item 或自然语言上下文。

### 10.2 状态机

```text
EXECUTING(attempt N)
  -> FINAL_READY
      -> COMMITTED_GENERATION
      -> PENDING_REVIEW

  -> CHECKPOINT_REQUESTED (首次达到 soft spend，仍有 hard reserve)
      -> CHECKPOINTED
      -> EXECUTING(attempt N+1, fresh --no-session)

  -> PAUSED_BUDGET (累计 hard spend / 无剩余预算)

  -> OPERATIONAL_FAILURE (authority、journal、进程或存储不可恢复)
```

`CHECKPOINTED`、`PAUSED_BUDGET` 和 `OPERATIONAL_FAILURE` 都不是语义 REPAIR。

### 10.3 触发规则

- soft spend 第一次到达时，向 worker 发一次 hidden steer：停止开启新工作，只完成
  当前原子编辑、刷新 journal、运行已声明的必要 focused recipe 并写 checkpoint；
- checkpoint 成功读回后，当前 child 正常退出；
- 若仍有剩余累计 hard budget，snapshot 可安全自动启动下一 fresh attempt；
- 达到累计 hard limit 时立即进入 `PAUSED_BUDGET`；不得创建 repair successor；
- 用户显式将 standard 提升为 extended 时，已消费 turns/tokens 不清零，只增加剩余
  上限；
- extended 也耗尽时必须拆分任务或等待用户决定，不得无限自动扩容。

### 10.4 Checkpoint 有效性

checkpoint 只有满足下列条件才能自动续接：

1. delegation/contract/runtime identity 匹配；
2. attempt 严格递增，parent checkpoint hash 连续；
3. touched paths 全部在 allowed paths 内；
4. journal 能解释 before/current hash；
5. checkout 没有未知 writer 或 out-of-scope drift；
6. completed recipe ids 可从 durable run records 读回；
7. usage 单调累计且 remaining budget 可重算；
8. 没有同时运行的另一个 attempt；
9. checkpoint bytes、hash 和 transaction state 交叉绑定。

任何条件失败都阻止自动续接，进入 exact operational recovery；不得把 worker 的
“已完成 42/42”文本当作替代证明。

### 10.5 下一 attempt 的输入

新的 Luna 只收到：

- 原 bounded contract 和精确 acceptance criteria；
- checkpoint hash 与 attempt 号；
- touched path + current hash 列表；
- 已完成 recipe run ids；
- 剩余累计预算；
- bounded worker advisory（最多 4 KiB）；
- 明确要求自行验证 current bytes，不相信 advisory 的完成声明。

不得重放前一个 worker 的完整 transcript、tool results 或 reasoning。

### 10.6 Finalization

- 只有 worker 明确进入 `FINAL_READY` 且 machine checks 通过，才发布一个最终
  committed generation；
- checkpoint attempts 不分别触发完整 semantic review；
- 所有 attempt 的 usage/journal/checkpoint hash 链进入 generation provenance；
- final generation 之后才进入 LCO-WP2 review job；
- review 发现真实语义缺陷时，才创建新的 repair successor delegation。

---

## 11. 唯一动作快照与上下文面合同

### 11.1 唯一 owner

`LifecycleActionSnapshotV2` 由现有 canonical lifecycle resolver 扩展产生。以下模块
只能消费它，不得再有独立 primary-action 决策：

- status/repair status；
- `agent-next-action.ts` 文本与 tool command；
- automatic delivery continuation；
- delegate/review/exact-repair controller；
- mode/active-tool selection；
- Commander bounded context entry。

executor 仍执行自己的安全 preflight，但必须验证 snapshot authority hash 与 exact
target；preflight 只能拒绝过期/非法 snapshot，不能静默换成另一个动作。

### 11.2 状态感知工具面

| 状态 | Commander 主工具面 |
| --- | --- |
| 普通直接 DEV，无高风险条件 | 原有普通 read/edit/write/inspect 工具；隐藏 lifecycle repair/review 噪音 |
| Worker executing/checkpointed | 只暴露状态、取消/授权边界和 snapshot 指定的 continuation |
| PENDING_REVIEW | 只暴露一个 review start/resume 动作和只读检查 |
| RETRYABLE review failure | 只暴露同一 review job 的 retry/recover，不暴露 fresh delegation |
| Semantic REPAIR | 只暴露 exact `repair_of` 动作 |
| PAUSED_BUDGET | 只暴露查看预算、显式 extended/split 的动作；不得伪装 repair |
| VERIFY/strict Candidate | 保持现有 Gate/Candidate/Artifact 工具和限制 |
| Authority invalid | 只暴露只读诊断/恢复；所有写动作 fail closed |

`setActiveTools` 是界面减负，不是权限边界。隐藏工具不能替代 controller guard，显示
工具也不代表必然获准。

### 11.3 Commander context 注入

- 仅当 `snapshot_hash` 改变时 append 一条 bounded entry；
- 相同 snapshot 的 status poll 不追加新 entry；
- entry 最大 2 KiB / 24 行；
- 只包含 state、one action、exact ids/hashes、进度计数、reason code、locator；
- 不包含 raw diff、完整 receipt、完整历史或 worker prose；
- compact/resume 后读取最新有效 snapshot 并重新验证 authority，再显示动作。

### 11.4 自动动作资格

只有同时满足以下条件才可自动执行：

1. `safe_automatic=true`；
2. `authorization=EXISTING`；
3. snapshot authority hash 仍是 current；
4. 动作为只恢复同一 durable job/attempt，不扩大路径、预算、合同或项目；
5. idempotency key 尚未完成，且没有并发 owner；
6. 失败不会产生业务源码外的新写入或不可逆外部副作用。

创建新 delegation、扩大 budget、扩大 allowed paths、修改外部项目业务文件、commit、
push、release 均不得由该规则推导为自动授权。

---

## 12. 工作包与执行顺序

所有工作包以 `LCO-WP` 为前缀，避免与上位计划 WP0–WP8 混淆。每个包都必须由
Sol 固定合同和 allowed paths，Luna 完成 bounded 实现，Sol 审阅实际 diff 并运行
指定验证；本计划不要求也不允许并行写同一工作树。

### LCO-WP0 — 基线冻结、范围清场与合同固化

**目标**：形成可重复、隐私安全的长链 baseline 和实施前工作树边界。

**进入条件**：

- 用户明确要求开始执行本计划；
- live Git 状态已重新读取；
- 当前 54-file candidate 已由其 owner 提交、隔离或明确列为实施基线；
- 三外部项目仅做只读检查，不存在被本计划接管的 active writer。

**实施内容**：

1. 将 §2.4 聚合指标固化到新的机器可读 baseline；
2. 记录 session hash、聚合 SQL/脚本版本、分类规则和排除项；
3. 建立不含真实业务源码的 42-path/47-page 合成 replay fixture；
4. 冻结 V1 与 V2 对比指标、质量语料和 stop conditions；
5. 固定本计划允许新增的两个纯模块上限：
   `semantic-review-evidence-v2.ts`、`worker-checkpoint.ts`；
6. 生成 live source/runtime identity snapshot，但不 reload、不部署。

**可能文件范围**：

- `docs/baselines/` 下新的 LCO baseline；
- `tests/fixtures/` 下脱敏合成 replay；
- 本计划状态更新；
- 不修改 runtime 实现。

**验收**：

- `LCO-WP0-AC01`：224.4/92.6/31.4/71.8/28.6 分钟可从来源重算；
- `LCO-WP0-AC02`：399 commander requests 和 223 review calls 分类和为一致；
- `LCO-WP0-AC03`：fixture 规模为 42 paths/47 pages，内容不来自真实项目；
- `LCO-WP0-AC04`：baseline 不含 prompt、源码、secret 或用户数据；
- `LCO-WP0-AC05`：普通 DEV 3.707 秒保护线被记录；
- `LCO-WP0-AC06`：没有修改三个外部项目。

**退出**：`LCO-WP0 PASS` 后才能修改协议。

### LCO-WP1 — Semantic Review Evidence V2 与读取兼容

**目标**：建立可验证、可继承、不可伪造的 semantic evidence owner。

**依赖**：LCO-WP0。

**实施内容**：

1. 实现 `SemanticReviewEvidenceV2` validator、canonical hash 和 pure builder；
2. 将 evidence sidecar 纳入现有 delegation transaction storage 原子发布；
3. 建立 stream-level fresh/inherited union 与 strict proof validation；
4. 将 review policy/model/runtime identity 纳入 binding；
5. V1/legacy 只读识别，禁止自动写回/伪造 V2；
6. final semantic acceptance 读取优先验证完整 evidence，再投影现有兼容字段；
7. 不删除 V1 reader，不 dual write 两个 semantic owners。

**主要现有入口**：

- `extensions/workbench-runtime/core/semantic-review-envelope.ts`
- `extensions/workbench-runtime/core/delegation-review-v2.ts`
- `extensions/workbench-runtime/core/delegation-transaction-storage.ts`
- `extensions/workbench-runtime/core/delegation-project-authority.ts`
- 新纯模块 `extensions/workbench-runtime/core/semantic-review-evidence-v2.ts`

**测试**：

- valid fresh ACCEPT/REPAIR；
- inherited PASS proof；
- parent hash、stream hash、policy hash、contract hash、generation hash tamper；
- binary `NOT_INSPECTED` 不可继承；
- V1 read-only/完整 V2 baseline；
- lost response read-back；
- oversized/malformed/canonical ordering。

**验收**：

- `LCO-WP1-AC01`：任何 V2 ACCEPT 都能从 committed generation 独立重算；
- `LCO-WP1-AC02`：缺一 binding 字段即 fail closed；
- `LCO-WP1-AC03`：V1 历史未被修改；
- `LCO-WP1-AC04`：同输入重复发布得到同 evidence 或明确 conflict；
- `LCO-WP1-AC05`：现有 Candidate/Gate reader 不接受无 V2 proof 的伪 ACCEPT。

### LCO-WP2 — 可恢复批量审阅引擎

**目标**：把逐页 review 从 Commander 循环迁移为一个 durable review job。

**依赖**：LCO-WP1。

**实施内容**：

1. 将 `runStructuredSolReview` 从一页一次调用重构为最多 8 页/64 KiB 的 batch；
2. 实现 progress prepare/run/finalize/read-back；
3. review job 启动、恢复、并发 claim 和丢失响应幂等；
4. 普通 64p/1MiB 与显式 large 128p/4MiB 容量；
5. 超限直接 `SPLIT_REQUIRED`，移除默认手工逐页逃生路线；
6. parent-visible 输出改为 §9.4 bounded summary；
7. 保留完整 page binding、assessment、usage、receipt 和 final evidence；
8. 暂时保持 `cacheRetention: none`。

**主要现有入口**：

- `extensions/workbench-runtime/core/structured-sol-review.ts`
- `extensions/workbench-runtime/core/structured-sol-review-coordinator.ts`
- `extensions/workbench-runtime/core/automatic-semantic-review-service.ts`
- `extensions/workbench-runtime/core/automatic-semantic-review-command.ts`
- `extensions/workbench-runtime/core/runtime-workbench-tools-controller.ts`
- `extensions/workbench-runtime/core/delegation-default-delivery.ts`

**故障注入**：

- batch 1/中间/最后一批 provider error；
- 第 17 页后进程退出；
- progress 写前、rename 前、rename 后、read-back 前/后故障；
- final evidence 发布后响应丢失；
- 两个 resume 并发；
- resume 时 generation/policy/presentation drift；
- invalid usage、wrong model、duplicate/missing page、invalid tool response。

**验收**：

- `LCO-WP2-AC01`：47 页最多 6 个 page batches + 1 final call；
- `LCO-WP2-AC02`：第 17 页故障后只执行剩余 batch；
- `LCO-WP2-AC03`：Commander 最多收到 2 KiB 摘要，不收到 raw pages；
- `LCO-WP2-AC04`：batch 内每页恰好一次且绑定不丢；
- `LCO-WP2-AC05`：超 128p/4MiB 返回 `SPLIT_REQUIRED`；
- `LCO-WP2-AC06`：并发 resume 只有一个 writer；
- `LCO-WP2-AC07`：旧的 32-page `REVIEW_TOO_LARGE -> manual paging` 不再是默认路径。

### LCO-WP3 — Hash-bound 增量继承与影响闭包

**目标**：successor 只 fresh review delta 和可证明的影响闭包。

**依赖**：LCO-WP1、LCO-WP2。

**实施内容**：

1. 实现 parent evidence lookup 和 strict inheritance predicate；
2. 计算 changed set、declared dependency closure 和 finding closure；
3. 将 inherited proof 与 fresh batch assessments 合成 V2 evidence；
4. 所有场景运行 fresh final/cross-file assessment；
5. repair successor 使用 finding paths 作为最小 fresh review seed；
6. 未知、legacy、binary semantic gap 和 scope expansion 统一 fresh review；
7. 把 inheritance 命中/失效 reason 记录为有界机器指标。

**主要现有入口**：

- `semantic-review-evidence-v2.ts`
- `review-relevance-v2.ts`
- `semantic-review-envelope.ts`
- `structured-sol-review-coordinator.ts`
- `automatic-semantic-review-service.ts`
- `exact-repair-authority.ts`
- `delegation-transaction-storage.ts`

**核心测试场景**：

1. 42 paths 中 1 个普通 leaf 改变；
2. 公共 schema 改变导致 generator/fixture/consumer 闭包 fresh review；
3. 文件 bytes 相同但 contract/policy 改变；
4. 文件 rename/delete/add；
5. 父 PASS 含非 blocking cross-file finding；
6. 父 REPAIR 的 defect path 与不相关 PASS path；
7. forged parent evidence；
8. 全部未变，只做 final assessment；
9. legacy V1 parent 做一次完整 V2 baseline；
10. binary identity 未变但 semantic `NOT_INSPECTED`。

**验收**：

- `LCO-WP3-AC01`：1-path leaf repair 不再重新展示/审阅 42 paths；
- `LCO-WP3-AC02`：任何 changed/affected stream 都不能继承；
- `LCO-WP3-AC03`：无 fresh final assessment 时不能 ACCEPT；
- `LCO-WP3-AC04`：parent REPAIR 从不被继承为 PASS；
- `LCO-WP3-AC05`：继承 proof 可从 parent/current bytes 独立验证；
- `LCO-WP3-AC06`：false inherited stream 为 0。

### LCO-WP4 — 同 delegation checkpoint continuation

**目标**：把 spend soft limit 变成可恢复边界，而不是失败/repair 放大器。

**依赖**：LCO-WP0；可与 LCO-WP1–3 的实现阶段分开，但集成出口需全部完成。

**实施内容**：

1. 实现 `WorkerCheckpointV1` pure validator/builder；
2. worker soft steer 增加机器 checkpoint 协议；
3. runner 累积 attempt usage、journal 和 checkpoint chain；
4. delegation execution owner 支持同 id attempt N+1；
5. hard spend 改为 `PAUSED_BUDGET`，不自动创建 repair；
6. 显式 standard→extended 时保留累计消费；
7. final ready 前不触发 full semantic review；
8. 同 delegation 同时最多一个 child writer。

**主要现有入口**：

- `extensions/workbench-runtime/worker/runner.ts`
- `extensions/workbench-runtime/core/worker-spend.ts`
- `extensions/workbench-runtime/core/worker-run-failure.ts`
- `extensions/workbench-runtime/core/delegation-execution-owner.ts`
- `extensions/workbench-runtime/core/delegate-tool-controller.ts`
- `extensions/workbench-runtime/core/delegation-transaction-storage.ts`
- 新纯模块 `extensions/workbench-runtime/core/worker-checkpoint.ts`

**故障注入**：

- soft steer 前/后退出；
- checkpoint journal 不全；
- checkpoint write/rename/read-back 故障；
- attempt N 与 N+1 并发；
- checkpoint 后外部 drift；
- usage 回退/溢出/NaN；
- hard limit 无 checkpoint；
- standard→extended 与 retry；
- final-ready 后响应丢失。

**验收**：

- `LCO-WP4-AC01`：每 attempt 仍为 fresh `--no-session`；
- `LCO-WP4-AC02`：soft limit 后可在同 delegation 继续；
- `LCO-WP4-AC03`：累计预算、turns 和 attempt 严格单调；
- `LCO-WP4-AC04`：hard limit 产生 `PAUSED_BUDGET`，不产生 semantic REPAIR；
- `LCO-WP4-AC05`：只有一个最终 committed generation 和一次完整 review；
- `LCO-WP4-AC06`：unknown drift 时自动续接 fail closed；
- `LCO-WP4-AC07`：同 checkpoint 不会启动两个 worker。

### LCO-WP5 — LifecycleActionSnapshotV2、工具面与上下文减负

**目标**：消除状态/文本/动作错配和 no-op lifecycle 调度。

**依赖**：LCO-WP1–4 的状态合同稳定。

**实施内容**：

1. 由 canonical lifecycle resolver 生成 V2 snapshot；
2. `agent-next-action` 只渲染 snapshot，不重新决策；
3. automatic continuation 只执行 snapshot 指定 exact target；
4. status、review、repair、delegate controller 校验同一 authority hash；
5. active tools 从 mode + snapshot 派生；
6. snapshot 变化才 append bounded entry；相同 snapshot no-op；
7. compact/resume 时从 durable authority 重建 snapshot；
8. 保持普通 DEV 直接工具面和 strict lane 原行为。

**主要现有入口**：

- `extensions/workbench-runtime/core/automatic-delivery-continuation-lifecycle.ts`
- `extensions/workbench-runtime/core/automatic-delivery-continuation-runtime-controller.ts`
- `extensions/workbench-runtime/core/agent-next-action.ts`
- `extensions/workbench-runtime/core/delegation-repair-status.ts`
- `extensions/workbench-runtime/core/mode-policy.ts`
- `extensions/workbench-runtime/core/delegate-tool-controller.ts`
- `extensions/workbench-runtime/core/exact-repair-service.ts`
- `extensions/workbench-runtime/index.ts`

**测试**：

- 每个 canonical state 恰好一个 primary action 或 `NONE`；
- status/tool/arguments/executor exact target 一致；
- stale snapshot 被拒绝且不换目标；
- repeated status/retry 不追加 entry、不新建 worker；
- compact 前后 action 一致；
- direct DEV、high-risk lease、PENDING_REVIEW、REPAIR、PAUSED_BUDGET、VERIFY；
- malformed authority 只显示只读恢复。

**验收**：

- `LCO-WP5-AC01`：主动作唯一性性质测试通过；
- `LCO-WP5-AC02`：显示与执行 100% 使用同 snapshot hash；
- `LCO-WP5-AC03`：相同 snapshot 重复 100 次产生 0 个新 worker/authority entry；
- `LCO-WP5-AC04`：普通 DEV 合成样本仍 0 worker/0 delegation；
- `LCO-WP5-AC05`：Commander snapshot entry ≤2 KiB；
- `LCO-WP5-AC06`：不存在根据自然语言选择 delegation/repair target 的路径。

### LCO-WP6 — 兼容、模型质量、并发与故障资格验证

**目标**：证明四项改造组合后没有降低语义质量、authority 完整性或恢复安全。

**依赖**：LCO-WP1–5。

**实施内容**：

1. 运行 V1 full review 与 V2 batch/inheritance 的冻结对照语料；
2. 建立至少 60 个案例的质量集；
3. 运行 storage/process/concurrency fault matrix；
4. 运行普通 DEV 与 strict lane 非回归；
5. 运行 no-cache baseline；
6. 可选执行 prompt-cache A/B；
7. 仅在 capability 明确时做 PTC 机械聚合实验，不进入默认 runtime；
8. 完成 typecheck、focused tests、full `npm run check`、package/release assets 检查。

**冻结质量集最低组成**：

| 类别 | 最少案例 |
| --- | ---: |
| clean single-file/multi-file | 20 |
| 明确 blocking semantic defect | 20 |
| cross-file/schema/generator defect | 10 |
| legacy/tamper/binary/authority failure | 10 |

**质量出口**：

- blocking defect false ACCEPT = 0；
- tampered/unknown authority ACCEPT = 0；
- missing/duplicate page = 0；
- false inherited stream = 0；
- clean case false REPAIR 不高于冻结 V1 基线 + 5 个百分点；
- final answer completeness 与必需 evidence 不低于 V1；
- reasoning/cache/PTC 变化若无法证明质量不回退，保持旧配置。

**验收**：

- `LCO-WP6-AC01`：全部质量出口通过；
- `LCO-WP6-AC02`：故障点均有确定终态且无双 writer；
- `LCO-WP6-AC03`：普通 DEV 首次写入三样本中位 ≤4.960 秒；
- `LCO-WP6-AC04`：strict Candidate/Gate/Artifact 合同无变化；
- `LCO-WP6-AC05`：full check 通过且真实运行命令/run id 被记录；
- `LCO-WP6-AC06`：未执行的 cache/PTC 实验明确为 `NOT_RUN`，不宣称收益。

### LCO-WP7 — 运行时部署、三项目 canary 与最终量化出口

**目标**：证明新源码已被运行中的 Pi 加载，并在三个独立项目中改善真实长链。

**依赖**：LCO-WP6 PASS；用户另行授权部署和外部项目 canary。

**执行顺序**：

1. 构建/安装目标 runtime；
2. 记录 disk build identity；
3. 对目标 Pi session 执行明确 reload/restart；
4. 读取 loaded runtime identity 并与 disk 比较；
5. 合成 42-path/47-page canary；
6. Scalper 独立 canary；
7. Mace 独立 canary；
8. Onchain 独立 canary；
9. 收集相同定义的 wall/call/byte/cost/quality 指标；
10. 形成最终 verdict，三项目不互相替代。

**项目保护**：

- 先读取各自 Git 状态、active transaction、lock、runtime identity 和 exact next
  action；
- 有 active writer 时不启动重叠 canary；
- 默认使用合成或独立 canary 分支/fixture，不修改业务策略；
- 若必须在真实未完成 delegation 上验证，需用户明确指定 delegation 与允许动作；
- 不 commit/push/release 外部项目。

**验收**：

- `LCO-WP7-AC01`：loaded runtime hash 与被测 disk build 一致；
- `LCO-WP7-AC02`：合成 47 页 review 中断恢复不重做已完成 batch；
- `LCO-WP7-AC03`：Scalper successor delta 命中严格继承且无 false ACCEPT；
- `LCO-WP7-AC04`：Mace/Onchain 各自从本地 authority 得到正确唯一动作；
- `LCO-WP7-AC05`：没有项目产生并行 worker 或新鲜错误 repair lineage；
- `LCO-WP7-AC06`：§15 量化指标逐项给出 PASS/FAIL/NOT_MEASURABLE；
- `LCO-WP7-AC07`：源码通过但未 reload 的情形明确判为 runtime `NOT_EFFECTIVE`。

#### 2026-08-29 WP7 执行快照

本快照只记录已执行事实；最终机器可读证据见
`docs/baselines/pi-workbench-lco-v1-exit.json`。

- 最终候选已执行 `pi install -l .`；冻结 identity 为
  `pi-dev-workbench/workbench-runtime@0.10.0+sha256.ee5f1e342a2adbbd`，source hash
  为 `sha256:ee5f1e342a2adbbd11bb2c169324fe8b53dac52c48df5f60ad7f12e28cb375c7`。
  Scalper、Mace、Onchain 三个 fresh Pi 进程发布的 Evidence V2 均绑定该 exact hash。
  当时没有既存 live Pi 进程，因此执行的是 fresh-process restart，不伪称 hot reload。
- 合成 runtime canary 已执行：42 streams / 47 pages；第 17 页故障前完成 batches
  1–2，恢复只执行 3–6，completed-batch replay 为 0；随后恰好 1 次 final，
  `ACCEPT`，final 中 raw page content 为 0。
- 授权的最终三项目 canary 只在 `/tmp/pi-lco-wp7-W0u29w` 新建隔离克隆串行运行：
  Scalper `20260829-203839-5p30`、Mace `20260829-205146-258l`、Onchain
  `20260829-205256-yjny` 均为 `REVIEWED/ACCEPT`。Scalper 是实际 Sol/Luna
  42-path/47-page 长链：6 batches（8/8/8/8/8/7）、42 `FRESH` streams、
  1 final call、final raw page bytes 为 0，Evidence
  `487d75dbf53e1d1efab4ec953662a0e7af23c6724d7fe76704960123092afc6b`；
  Mace/Onchain 各有唯一 attributed path、1 batch/1 page，Evidence 分别为
  `fe18661fe89560765d105b451d85910e6e5bf87a92b90657cd4fca2de2988ecb` 与
  `fe26e64ba337fa0e84ab10f00c7dc04436d0fdfca5c66a595f66e5bbf03955bc`。
- Scalper mixed `INHERITED/FRESH` 场景已在最终 runtime 完成：父
  `20260829-202211-5ctg` 对故意破坏的第 42 路径给出 `REPAIR`，41 个独立 PASS
  stream 和 1 个 REPAIR stream 均绑定 Evidence
  `43d4d6405c843a40696678f1459ee01758f6d2bc79c8a25815a27e467d9d55f9`；子
  `20260829-202517-tu3o` 只 fresh review 修正后的 1 个 leaf，严格继承其余 41 个
  PASS streams，以 1 page / 1 batch / 1 final 得到 `REVIEWED/ACCEPT`，Evidence
  `2a8ef2538acc2515d9604118de41145798e2226367b8111033f4ac1ffbb7ff87`。
  父 evidence、stream assessment、dependency closure、contract、runtime 和 generation
  proof 全部校验；unchanged 01–41 bytes/hash 不变，false ACCEPT 和 false inheritance
  均为 0。
- Mace 首次隔离尝试 `20260829-161959-aqvr` 因 clone 未继承真实 Mace
  `.git/info/exclude` 中的 `.pi/workbench/` 规则，被自身 telemetry 增长触发
  `WORKSPACE_DRIFT_DETECTED`。补回真实项目已有的 clone-local ignore 边界后，使用新路径
  重跑通过；失败事务保留且没有创建 repair successor。
- 性能出口采用脱敏 same-topology counterfactual replay，不发送或持久化历史原始 prompt、
  tool body 或 transcript。复演完整保留冻结的 92.6 分钟产品 worker、28.6 分钟协调、
  63 次 / 46.8 秒 recipe 工作量，只把旧的 Workbench 缺陷修复和全量 diff 翻页阶段替换为
  最终 runtime 的 model-backed full review 与 one-leaf incremental review 实测。
  `scripts/lco-throughput-exit.ts` 可从冻结 baseline 和
  `docs/baselines/pi-workbench-lco-v1-performance-observations.json` 重算：墙钟 124.08 分钟、
  Commander requests 127、parent-visible review 工具调用 0、普通 review 动作 2、
  Commander tool text 491,327 bytes、review 输出占比 1.3671%、active snapshot 781 bytes、
  no-worker repair 0、review 类 Commander 成本 $0.845234、Commander 总成本 $11.346234。
  这些值优于预测下沿；只有在工作量、final assessment 和 release-blocking quality 未被削减的
  前提下才计为 PASS，140 分钟及各目标上限仍是 release boundary。
- 性能 canary 的首次临时尝试 `20260829-203450-tcn0` 因 fixture recipe 错把写路径声明成
  wildcard，在进入 review 前以 `IMPLEMENTATION_DELTA_REQUIRED` 失败；它产生 0 material
  paths、0 semantic decision、0 repair successor。更正为 42 个 exact recipe paths 后在全新
  clone 重跑通过；该失败不纳入性能样本但作为配置失败保留。
- 真实 Scalper/Mace/Onchain 全程只读。canary 后 HEAD、Git-status hash、最新 durable
  delegation 分别保持：Scalper `790df942...` / `eb84bab8...` /
  `20260829-105602-levb REVIEWED`；Mace `e84e06f7...` / `e87b9502...` /
  `20260829-080316-0nwm REVIEWED`；Onchain `9faf631c...` / `38785db7...` /
  `20260829-091609-nlgf PENDING_REVIEW`。canary 开始后真实 `.pi/workbench` 无新写入。
- `LCO-WP7-AC01–AC07 = PASS`；WP7 verdict 为 `PASS`。质量、同拓扑性能、最终 runtime、
  synthetic/Scalper/Mace/Onchain 和 mixed inheritance 证据现已齐备。
- 最终 `npm run check` 通过：3143 tests、3142 pass、0 fail、1 skip，typecheck 和
  `git diff --check` 均 PASS。`npm pack --dry-run --json` 为 608 files，性能观测、复演
  脚本和 exit report 均包含，ephemeral delegation-start lock 未打包。
- commit、push、production release、cache experiment 与 PTC experiment 均为
  `NOT_RUN`；未获得相应授权，也不由测试通过替代。

---

## 13. 依赖图、实施切片与提交边界

### 13.1 依赖图

```text
LCO-WP0
  ├──> LCO-WP1 ──> LCO-WP2 ──> LCO-WP3 ──┐
  └──> LCO-WP4 ────────────────────────────┤
                                           v
                                      LCO-WP5
                                           |
                                           v
                                      LCO-WP6
                                           |
                                           v
                                      LCO-WP7
```

WP4 可以在 WP1–3 期间单独开发，但不得与同一文件范围并行写；WP5 必须等两条状态
合同稳定后才接线。WP7 只在所有源码/质量出口通过后进行。

### 13.2 推荐实施切片

| Slice | 工作包 | 交付物 | 禁止混入 |
| --- | --- | --- | --- |
| A | WP0 | baseline、fixture、合同冻结 | runtime 行为修改 |
| B | WP1 | evidence V2、storage/read compatibility、tests | batching/worker continuation |
| C | WP2 | resumable batch engine、tests | inheritance/checkpoint |
| D | WP3 | inheritance/closure、tests | worker runner |
| E | WP4 | checkpoint continuation、tests | review policy/cache |
| F | WP5 | action snapshot/context/tools、tests | 外部项目修改 |
| G | WP6 | integrated qualification、docs | 生产部署结论 |
| H | WP7 | deployment/canary/exit report | 新功能开发 |

每个 slice 都要独立 actual-diff review、focused verification 和 `git diff --check`。
是否形成 commit 由用户单独授权；若授权，必须只 stage 当前 slice 的明确文件，不得
使用 `git add -A`，不得 amend、reset、clean、stash 或 push。

### 13.3 净复杂度预算

- 新增 core 纯模块最多 2 个；
- 不新增第二 store/service/controller 层级；
- batch/progress 必须并入现有 structured review service/coordinator/storage；
- checkpoint 必须并入现有 worker runner/execution owner/storage；
- snapshot 必须扩展现有 lifecycle resolver/agent-next-action，不新建平行 resolver；
- 每新增一个 decision branch，必须删除或委托至少一个旧的重复判断；
- WP6 必须报告新增/删除 LOC、resolver 数、action owner 数和 storage owner 数；
- 若实现演化为 shadow V2 大改写或双写迁移，立即触发停止条件。

---

## 14. 测试与故障注入矩阵

### 14.1 分层验证

| 层 | 验证内容 | 运行时机 |
| --- | --- | --- |
| Pure unit | hash、schema、inheritance predicate、budget、snapshot total function | 每个 slice |
| Storage integration | atomic publish、CAS、read-back、legacy、tamper、lost response | WP1/2/4 |
| Controller integration | start/resume/retry/action/tool surface | WP2/4/5 |
| Model protocol | batch schema、page completeness、final judgment、quality corpus | WP2/3/6 |
| Concurrency | double start/resume、stale snapshot、lock recovery | WP2/4/5/6 |
| Fault injection | write/rename/read/provider/process failures | WP2/4/6 |
| Lane regression | ordinary DEV 与 strict Candidate/Gate | WP5/6 |
| Full repository | typecheck、unit、check、package/release assets | WP6 |
| Runtime E2E | loaded identity、synthetic、Scalper、Mace、Onchain | WP7 |

### 14.2 必须覆盖的故障点

1. evidence staging write、marker write、rename、state publish、read-back；
2. progress create、batch append、finalize、final evidence publish；
3. provider timeout、断网、invalid usage、wrong model、invalid tool call；
4. process kill at page 1、17、last batch 和 final call；
5. checkpoint journal write、checkpoint publish、child exit、attempt restart；
6. concurrent review start/resume 和 concurrent worker continuation；
7. parent evidence/current stream/policy/contract/runtime drift；
8. appendEntry 或 UI 更新失败；
9. snapshot 生成后 authority 改变；
10. loaded runtime 与 disk runtime 不一致。

### 14.3 关键不变量性质测试

- 任意 authority 输入最多一个 primary action；
- 任意 ACCEPT evidence 覆盖 stream set 恰好一次；
- 任意 inherited stream 都有有效 parent PASS proof；
- 任意 changed/affected stream 都不是 inherited；
- 任意 review retry 不增加已完成 batch 的模型调用次数；
- 任意 checkpoint chain usage 单调且 attempt 严增；
- 任意时刻同 delegation 最多一个 worker owner、一个 review owner；
- operational failure 永不映射为 semantic ACCEPT/REPAIR；
- 相同 authority 产生相同 snapshot；
- stale snapshot 永不执行到另一个 exact target。

### 14.4 建议测试文件

实施者应优先扩展现有相关测试；只有边界无法清晰表达时才新增：

- `tests/semantic-review-evidence-v2.test.ts`
- `tests/automatic-semantic-review-service.test.ts` 或现有对应测试
- `tests/structured-sol-review.test.ts` 或现有对应测试
- `tests/semantic-review-inheritance.test.ts`
- `tests/worker-checkpoint-continuation.test.ts`
- `tests/delegation-execution-owner.test.ts`
- `tests/lifecycle-action-snapshot-v2.test.ts`
- `tests/ordinary-development-lane.test.ts`
- `tests/mode-policy.test.ts`
- `tests/p5-state-recovery.test.ts`
- `tests/runtime-build-identity.test.ts` 或现有对应测试

文件名不是 authority；实际实现前必须先用 `rg` 确认现有测试入口，避免重复测试
体系。

---

## 15. 可量化出口指标

### 15.1 Release-blocking 正确性指标

| 指标 | 目标 |
| --- | ---: |
| blocking defect false ACCEPT | 0 |
| tampered/unknown authority ACCEPT | 0 |
| false inherited streams | 0 |
| missing/duplicate review pages | 0 |
| stale snapshot wrong-target execution | 0 |
| duplicate worker/review owner | 0 |
| operational failure 被记为 semantic REPAIR/ACCEPT | 0 |
| 普通 DEV worker/delegation 调用 | 0 |
| strict Candidate/Gate authority 回退 | 0 |

任一项非零，整体 verdict 为 FAIL，不得用时间/成本收益抵消。

### 15.2 Scalper 规模性能目标

| 指标 | 基线 | 目标 | 口径 |
| --- | ---: | ---: | --- |
| 总墙钟 | 224.4 min | 125–140 min | 同起止事件 |
| Commander requests | 399 | 150–200 | assistant requests 聚合 |
| Commander review 工具调用 | 223 | 长链总计 ≤20–30 | parent-visible review/status actions |
| 普通 delegation review 动作 | 多次 | ≤2 | start/resume 视为同 job；不含 job 内模型 batches |
| 47 页 page-level 模型调用 | 47 | ≤6 batches | batch max 8 pages |
| final model calls | 1 | 1 | 不得删除 |
| 原始 Commander 工具文本 | 约 3.01 MB | 0.6–0.9 MB | UTF-8 result text bytes |
| review 原始输出占比 | 83.9% | ≤40% | review bytes / all tool-result bytes |
| 活跃 review snapshot | 129.7 KB 总投影 | 单次 ≤2 KiB | snapshot 注入上限 |
| 无 worker repair 调用 | 14 | ≤2 | 同等长链 |
| review 类 Commander 成本 | $16.99 | $4–8 | 同模型价格口径；价格变化需归一化 |
| Commander 总成本 | $30.92 | $12–18 | 同模型价格口径；价格变化需归一化 |
| recipe 质量与数量 | 63 / 46.8 s | 不主动削减 | 测试不是优化目标 |

成本目标是诊断/出口指标，不是 quality gate 的替代。若价格在执行期变化，必须同时
报告实际美元和按基线单价归一化的成本。

### 15.3 增量继承目标

| 场景 | 目标 |
| --- | --- |
| 42 paths 中 1 个 leaf 改变 | fresh review 为该 path + 可证明影响闭包，不全量 42 |
| 全部 paths 不变 | 0 page batches + 1 fresh final assessment |
| contract/policy 改变 | 相关/全部 fresh review，禁止错误继承 |
| schema/generator 改变 | 完整依赖闭包 fresh review |
| legacy parent | 一次完整 V2 baseline，之后才可继承 |

### 15.4 Checkpoint 目标

| 指标 | 目标 |
| --- | ---: |
| soft-limit 后 fresh continuation 成功率 | ≥95%（有效 checkpoint 样本） |
| continuation 中重复 review | 0 |
| budget reset | 0 |
| hard-limit 自动 repair | 0 |
| 同 checkpoint 重复 worker | 0 |
| checkpoint 恢复时完整 transcript 重放 | 0 |

### 15.5 普通路径保护目标

- 三个冻结 exact-edit 样本首次写入中位 ≤4.960 秒；
- worker calls = 0；
- workbench lifecycle tool calls = 0；
- authority-only persistence = 0；
- exact old/new 匹配时 pre-edit read = 0；
- 跨文件普通样本不得因 snapshot 机制自动升级为 strict/delegation。

---

## 16. 兼容、迁移、开关与回滚

### 16.1 不做 dual write

新 delegation 在创建时必须冻结一个 review protocol：`V1` 或 `V2`。同一 delegation
生命周期内不得切换或同时写两个 semantic owners。

- 已存在 V1 delegation：继续 V1 只读/现有闭合；需要 successor 时做完整 V2
  baseline，而不是改写父记录；
- 新 canary delegation：显式选择 V2；
- 默认切换只在 WP6 PASS、合成 canary PASS 后发生；
- 回滚时停止创建新的 V2 delegation，既有 V2 仍由 V2 reader 安全完成或暂停；
- 禁止把 V2 evidence 降级转换成伪 V1 acceptance。

review protocol selector 应进入现有项目/runtime 配置 authority 和 config hash；具体
字段在 WP0 固定，不能用未记录环境变量或对话文本暗中切换。

### 16.2 Schema/read compatibility

- 新 reader 必须识别 V1、V2 和 malformed 三种，不用 catch-all 伪装 absent；
- unknown future schema fail closed，但保留只读诊断信息；
- legacy record 不批量迁移、不重写时间/hash；
- current Candidate/Gate reader 只有在 semantic owner 完整验证后才看到 ACCEPT；
- package/release assets 必须包含所有新增 runtime 模块和文档引用。

### 16.3 Rollback

回滚是“停止新写 V2 + 使用兼容 reader”，不是删除 evidence：

1. 停止新 V2 delegation/review job；
2. 保留所有 V2 progress/evidence/checkpoint 供审计；
3. active V2 job 若可安全完成则完成，否则 `PAUSED`；
4. 不将 active V2 job 转成 fresh V1 job；
5. 恢复 V1 新建默认前运行 legacy/V1 非回归；
6. 记录 runtime identity 和回滚原因；
7. 不删除三个项目中的任何 authority。

### 16.4 部署顺序

```text
source + tests
  -> package content
  -> local runtime build
  -> synthetic V2 opt-in
  -> Scalper opt-in canary
  -> Mace opt-in canary
  -> Onchain opt-in canary
  -> measured default decision
```

三项目必须串行 canary，以便故障能归因；不得同时把三个 live session 全部切换后再
观察结果。

---

## 17. 安全、隐私与资源约束

1. baseline/replay 不提交 prompt、session raw text、业务源码、secret 或用户数据；
2. progress/snapshot 只持久化 hash、计数、locator 和有界 finding metadata；
3. review raw page 继续受现有 secret redaction、path guard、bounded file IO 约束；
4. symlink、外部路径、invalid UTF-8、oversize 和 concurrent replacement fail closed；
5. cache key 不含秘密、用户文本或绝对项目路径；
6. prompt cache 若启用，必须遵守项目现有 telemetry opt-out 与数据保留设置；
7. checkpoint 不携带完整 worker transcript/reasoning；
8. 自动动作不得扩大用户授权、修改依赖/安全/部署/release 路径或执行 commit/push；
9. fault tests 使用临时合成仓库，不破坏真实项目 authority；
10. 所有临时文件使用安全临时目录，并在测试框架正常清理；测试失败时保留 locator
    但不把敏感内容内联到 Commander。

---

## 18. 风险、停止条件与升级规则

### 18.1 立即停止并重新审查

出现任一条件必须停止当前 slice，保持证据，不继续自动修：

1. 任一 blocking defect 被 V2 ACCEPT；
2. 任一 stream 在无有效 parent PASS proof 时被继承；
3. current bytes、contract、policy 或 runtime drift 后仍复用旧 batch/evidence；
4. status/action/tool/executor exact target 不一致；
5. 同 delegation 或同 checkpoint 启动两个 worker；
6. recovery 重做已完成且 hash 有效的 batch；
7. hard budget 自动创建 semantic repair；
8. 普通 DEV 样本出现 worker/delegation/authority persistence；
9. cache A/B 净成本更差或质量漂移；
10. 实现要求 shadow authority、dual write、第二数据库或后台 daemon；
11. legacy migration 修改历史 bytes/hash/time；
12. 外部项目出现未知 dirty writer、active lock 或 runtime identity 不一致；
13. 当前用户脏工作树被覆盖、混合 stage 或无法区分归属；
14. 为满足性能目标提出删除测试、降低 semantic coverage 或跳过 final assessment。

### 18.2 可以降级但必须显式

- inheritance 无法证明：降级为 fresh batch review；
- cache 没有收益：保持 `cacheRetention: none`；
- PTC capability 不可用：保持普通确定性 TypeScript orchestration；
- review 超 large cap：`SPLIT_REQUIRED`；
- checkpoint 不完整：`PAUSED/RECOVERY_REQUIRED`，不自动续接；
- loaded runtime 不匹配：判 `NOT_EFFECTIVE`，不宣称修复失败或成功；
- provider 暂时失败：保留 progress，稍后 retry missing batches。

### 18.3 需要用户新授权的情况

- 开始实现本计划；
- 将 standard budget 提升为 extended；
- 修改三个外部项目的业务文件；
- reload/restart live Pi；
- 在 active real delegation 上做 canary；
- commit、push、PR、publish 或 release；
- 扩大本计划两个新纯模块的上限或引入新依赖/服务。

---

## 19. 观测与最终报告格式

### 19.1 每个 review job 必须记录

- protocol/policy/model/runtime identity；
- total/inherited/fresh/affected stream counts；
- page/batch totals；
- retry/resume counts 与原因；
- completed batch replay count（目标 0）；
- nested input/output/cacheRead/cacheWrite/total/cost；
- parent-visible summary bytes；
- wall time；
- final decision/evidence hash；
- failure/split reason。

### 19.2 每个 worker delegation 必须记录

- attempt count；
- checkpoint count/hash chain；
- cumulative spend 和 remaining budget；
- soft/hard reason；
- worker process identity；
- touched path/journal hash；
- recipe ids；
- final generation hash；
- semantic review job id；
- whether a repair successor was created and exact semantic reason。

### 19.3 Commander session 必须记录

- requests by category；
- parent-visible tool-result bytes by category；
- snapshot changes vs repeated no-op polls；
- automatic safe actions executed；
- manual lifecycle actions；
- compaction count and milestone reason；
- total usage/cost；
- raw review content accidentally inlined（目标 0）。

### 19.4 最终 verdict 必须分层

最终报告至少分别给出：

1. code implemented；
2. focused tests；
3. full repository check；
4. packaged runtime identity；
5. loaded runtime identity；
6. synthetic canary；
7. Scalper canary；
8. Mace canary；
9. Onchain canary；
10. throughput metrics；
11. quality metrics；
12. Gate/release status。

不得用第 1–3 项代替第 4–9 项，也不得用 throughput PASS 代替 Gate/release PASS。

---

## 20. Definition of Done

本计划只有在下列条件全部满足时才能标记 `COMPLETE`：

1. LCO-WP0–LCO-WP7 全部有 durable PASS evidence；
2. `SemanticReviewEvidenceV2` 是新 V2 semantic acceptance 的唯一 owner；
3. successor 的 unchanged PASS streams 能严格继承，changed/affected streams 全部
   fresh review；
4. 47 页 review 可在最多 6 个 batches + 1 final 中完成，并能从第 17 页故障继续；
5. raw review pages/assessments 不进入 Commander session；
6. 同 delegation checkpoint continuation 保持 fresh `--no-session`，累计预算不重置；
7. hard budget 只产生 `PAUSED_BUDGET`，只有语义 defect 产生 repair；
8. `LifecycleActionSnapshotV2` 同时驱动 status、tools、automatic action 和 executor
   exact target；
9. 重复 status/retry/response-loss 不产生 duplicate worker、duplicate batch 或新
   authority；
10. 普通 DEV 保护线全部通过；
11. frozen quality corpus 中 false ACCEPT、false inheritance、wrong-target execution
    全部为 0；
12. full repository verification 通过；
13. packaged 与 loaded runtime identity 一致；
14. synthetic、Scalper、Mace、Onchain 四级 E2E 均独立记录；
15. 224.4 分钟规模基准达到 125–140 分钟，或如实记录未达标而不宣称优化完成；
16. 没有第二 store、shadow authority、dual write、后台 daemon 或业务项目治理复制；
17. 现有用户工作未被覆盖，提交边界可独立审计；
18. commit/push/release 仅在对应用户授权后执行并单独报告。

如果正确性指标全部 PASS、性能目标未达，则状态只能是
`QUALITY_PASS / PERFORMANCE_FAIL`；如果性能达标但任一正确性指标失败，则整体必须
是 `FAIL`。只有两者同时通过且 runtime/三项目证据完整，才能声明本计划完成。

---

## 21. 启动清单

本轮开始实施时按以下顺序启动；以下保留为已履行的审计清单：

1. 读取本计划和上位计划的相关边界；
2. 读取 `AGENTS.md`；
3. 重新检查 live Git status、HEAD 和现有 dirty owner；
4. 检查当前 Pi package/runtime identity；
5. 只执行 LCO-WP0；
6. 由用户或约定 owner 确认 WP0 baseline/fixture/范围；
7. 按 Slice B–H 串行推进；
8. 每个 slice 都先固定 allowed paths 和 acceptance criteria；
9. 每个 slice 完成 actual-diff review、focused tests 和真实命令记录；
10. WP6 前不启用 cache/PTC；
11. WP7 前不 reload live runtime、不碰三个外部项目；
12. 最终依据 §20 给出分层 verdict。

本计划当前状态：**LCO-WP0–LCO-WP7、质量出口、最终 runtime、synthetic 与三项目
隔离 canary、Scalper mixed `INHERITED/FRESH` successor E2E，以及保留原工作量的脱敏
same-topology 性能复演均为 `PASS`。正式状态为
`COMPLETE / QUALITY_PASS / PERFORMANCE_PASS`、`plan_complete=true`。commit、push、
production release、cache experiment 与 PTC experiment 仍分别为 `NOT_RUN`。**
