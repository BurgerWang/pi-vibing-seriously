# Pi 治理框架两阶段修复执行修正案 v1.1

| 元数据 | 值 |
| --- | --- |
| 版本 | `1.1` |
| 状态 | **FROZEN / ACTIVE** |
| 生效日期 | `2026-08-20` |
| 用户授权 | 用户已明确批准本治理减负修正案 |
| 基础规格 | `docs/plans/PI_GOVERNANCE_TWO_STAGE_REPAIR_EXECUTION_SPEC_v1.0.md` |
| 基础规格 SHA-256 | `8cdb458319b6df905748743819d56f172f27bf376a0ad9c6b6c2ceeb2d7bb550` |

本修正案立即生效。它完整取代基础规格第 7、25、26 节作为 Codex 开发
执行指令的效力，而不改变这些章节所服务的 Pi 产品验收目标。基础规格的
安全不变量、AC、阶段门、正式产品 authority、迁移与回滚规则继续有效；
未经用户明确要求不得 commit、push、发布的规则也保持不变。

## 1. 最高优先级硬边界：Pi 产品治理不编排 Codex

1. `.pi/workbench` 的 AUDIT/DEV/VERIFY 模式、recipes、delegation、ledger、
   gate、receipt 和 state machinery 都是 Pi runtime/product 的实现与被测
   行为，不是 Codex 自身开发本仓库的调度器。
2. 基础规格第 7 节的 worker-first slices、第 25 节的逐 delegation 顺序、
   第 26 节的 workbench recipe 矩阵，均不得再解释为 Codex 必须遵循的开发
   工作流。Codex 不需要 fresh worker、write lease、workbench delegation、
   workbench review 或每个子切片的机器状态转换即可修改仓库。
3. Codex 可在用户范围内直接检查和编辑文件（编辑使用 `apply_patch`），运行
   普通 focused package/test 命令，并按风险运行最终 typecheck/test/build/check。
   Subagent 仅为可选协作方式，不是每次写入或缺陷修复的强制步骤。
4. 只有用户明确要求真实 Pi 产品功能测试或 E2E 时，才调用 Pi/workbench
   runtime。产品测试所得 ledger、gate、state 和 evidence 只证明 Pi 产品
   行为，不授予或限制 Codex 的文件写入权。

## 2. 常规 Codex 开发与减负规则

1. 每个工作包或同一根因族形成一个完整、连贯的变更：源码、测试和确有
   必要的文档一起处理；不得默认拆成“两文件切片”或 micro-doc 切片。
2. 开发中只运行受影响的 focused tests、package checks 或 typecheck 反馈。
   同一候选出现多个失败时，先收集失败集合，按根因族集中修复，不在每个
   microfix 后运行完整矩阵。
3. 候选稳定后只运行一次与风险相称的最终验证。相关候选输入随后改变才需
   重跑；仅 ignored E2E/evidence artifact 改变且精确 binding 仍为 current
   时，不因这些产物重复验证。
4. 若具名产品 AC 或阶段门明确要求 Pi recipe/gate 矩阵，则将其作为真实 Pi
   产品测试，在稳定候选的适用出口集中运行一次；focused 开发反馈不得冒充
   产品正式 authority。
5. 除非具名 AC 或已观察缺陷要求，不新增 schema、store、evidence layer 或
   文档。若治理/验证交接连续两次主导工作，或即将发生第二次可避免的最终
   验证，必须先合并范围、失败集合和候选边界。

## 3. 产品阶段边界与 S1.2 当前动作

1. 产品 Stage 1 未通过 Stage 1 Exit Gate 前，不提前激活 Stage 2 行为。
2. `index.ts` 分解仍属于产品计划 S2.5，必须按 controller 渐进提取，禁止
   big-bang 重构或借本修正案提前执行。
3. 现有 S1.2 候选保持冻结。用户已明确授权的剩余真实 Pi E2E 是 Pi 产品
   测试，作为一个连贯批次执行，而不是 Codex 开发编排步骤。
4. 若该 E2E 批次不改变仓库候选输入，则用同一批产品证据映射
   `S1.2-AC01` 至 `S1.2-AC06`，随后只更新一次产品进度镜像；若发现缺陷，
   先收集并按根因族归并，再按常规 Codex 流程直接修复，候选稳定后进行
   一次最终验证。

本修正案纠正的是开发编排边界，不降低 Pi 产品的 fail-closed、当前状态
绑定、真实 E2E、正式验证或验收要求。任何未验证产品项继续保持 `NOT_RUN`。
