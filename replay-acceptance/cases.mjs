/**
 * EPGS 回放验收数据集 —— 50 例虚构内镜报告（Issue 后续：真实病例回放验收方法验证）
 *
 * 这是什么
 *   一批**完全虚构**的内镜检查报告 + 每一例的「设计者预期答案」，用来比较
 *   「原关键词监控」与「关键词 + AI 语义监控」两条路径的差异。
 *
 * 不是什么
 *   - 不是真实患者数据。姓名一律 `回放测试NN`，检查号一律 `TEST-REPLAY-NNN`，
 *     正文由本文件手写，不含任何真实病历内容。
 *   - 不是医学金标准。下面的 expected 是**数据集设计者的答案**，用来衡量系统是否
 *     按设计意图工作，不是临床诊断依据。任何以它为「正确答案」去评价模型医学水平
 *     的用法都超出了本数据集的适用范围。
 *   - 不是生产数据。本目录不参与构建、迁移、seed、部署或启动流程；载入脚本必须
 *     由人显式执行，且只允许写入名字匹配 `epgs_replay*` 的本地库。
 *
 * 本文件是唯一事实来源；`reports.replay.csv` 与 `expected.replay.csv` 由
 * `build-dataset.mjs` 从它生成，不要手改那两个 CSV。
 *
 * 关键词避免是**刻意设计**的：B / E / F 三组的报告文本必须不触发 30 条种子规则中的
 * 任何一条（含大小写不敏感的 Ca / NEN / SMT 子串），否则「关键词没发现、语义发现了」
 * 就无从谈起。`build-dataset.mjs` 会用真实的 packages/matching-engine 逐例校验这一点。
 */

/** 场景分组。ID 段与场景一一对应，便于一眼看出某条属于哪组。 */
export const SCENARIOS = {
  A: { range: '001-012', label: '关键词明显命中，语义也应关注', goal: '验证升级后不会把原本可靠发现的患者搞丢' },
  B: { range: '013-024', label: '关键词不命中，整份报告语义应关注', goal: '验证 AI 语义路径能否找到关键词漏掉的人（最重要的一组）' },
  C: { range: '025-032', label: '关键词命中，但上下文是否定/排除', goal: '验证 #87 语义校验能否减少关键词机械命中的假阳性' },
  D: { range: '033-036', label: '关键词命中，但属于既往史', goal: '区分 HISTORY 与本次发现' },
  // 037 从 D 组独立出来：它不只是 HISTORY，而是**两条 AI 路径同时参与**的组合病例。
  // 组键用 CROSS_PATH 而非单字母 —— 它的语义无法用 A~F 里任何一个字母表达，且
  // 「CROSS_PATH」这个词本身在报告与评审记录里都是自解释的。
  CROSS_PATH: {
    range: '037',
    label: '组合路径：既往史命中应被 #87 过滤，本次真异常应由 #88 独立发现',
    goal: '验证 #87 与 #88 同时参与时各自做对：历史信息里的关键词命中被过滤掉，而同一次检查中真正值得关注的异常仍能被报告级语义监控独立发现',
  },
  E: { range: '038-043', label: '模糊/疑似/不确定表达', goal: '观察 SUSPECTED / UNCERTAIN 的处理' },
  F: { range: '044-050', label: '普通、低风险、基本正常', goal: '对照组：观察 AI 是否无故升级。044 / 048 / 049 为困难阴性：局部含容易引起风险联想的措辞（渗血、粗糙、红斑、边界、色泽），但完整上下文给出良性解释，设计预期仍是 NO / NONE' },
};

/**
 * 一例病例。
 *
 * @typedef {object} ReplayCase
 * @property {string} id            TEST-REPLAY-NNN，同时是 CSV 的 sourceRecordId
 * @property {'A'|'B'|'C'|'D'|'CROSS_PATH'|'E'|'F'} scenario
 * @property {string} expected.attention  YES / NO —— 这一例在临床上是否真的需要医生优先关注
 * @property {'RED'|'YELLOW'|'GREEN'|'NONE'} expected.level
 *   正确判读下 monitor_record.current_level 应呈现的最终等级（关键词有效命中 ∪ AI 等级 取最大；
 *   NONE 即 UNCLASSIFIED）。注意它描述的是「系统应当输出的等级」，不等于「临床严重程度」。
 * @property {'HIT'|'NO_HIT'|'FALSE_POSITIVE_RISK'} expected.keyword
 *   HIT                   关键词路径应当命中
 *   NO_HIT                关键词路径应当完全不命中
 *   FALSE_POSITIVE_RISK   关键词会命中，但该命中不反映本次真实情况（否定、既往史），需要被纠正
 * @property {'SHOULD_FIND'|'SHOULD_FILTER'|'SHOULD_NOT_FIND'|'SHOULD_FILTER_AND_FIND'|'UNCERTAIN'} expected.ai
 *   SHOULD_FIND      AI 语义路径应当发现并给出关注等级（#88）
 *   SHOULD_FILTER    AI 语义路径应当把上面那个关键词命中判为不成立（#87）
 *   SHOULD_NOT_FIND  AI 语义路径不应当新增任何关注（对照组）
 *   SHOULD_FILTER_AND_FIND
 *                    **两条路径都要做对**：命中校验（#87）应把历史信息里的关键词命中
 *                    过滤掉，同时报告级分类（#88）应独立发现同一份报告里本次的真实异常。
 *                    仅 CROSS_PATH 组使用；此时 expected.level 是**两条路径都做对之后**
 *                    的最终等级，而库里的 current_level 在仅跑关键词时会更低。
 *   UNCERTAIN        设计上就存在分歧，记录观察值即可，不作对错判定
 *   （SHOULD_NOT_FIND 与 SHOULD_FILTER_AND_FIND 是在 Issue 给出的三个示例之外补充的
 *   取值，见 README）
 * @property {string} expected.rationale 一句中文说明为什么这样设计
 */

/** @type {ReplayCase[]} */
export const CASES = [
  // ==========================================================================
  // A 组（001-012）关键词明显命中，语义也应关注
  // 目的：升级后这些患者必须仍然被可靠发现 —— 一条都不能丢。
  // ==========================================================================
  {
    id: 'TEST-REPLAY-001', scenario: 'A',
    patientName: '回放测试01', patientRegistrationNo: 'TEST-REG-R001', department: '脾胃病一科',
    bedNo: '12', patientTypeCode: 'I', patientTypeName: '住院',
    examItem: '（无痛）电子胃镜检查', examDate: '2026-09-08', examTime: '09:15:00',
    reportContent: '胃体小弯侧见菜花样肿物，约3.0×2.5cm，表面溃破覆污苔，质脆，触之易出血，周围黏膜皱襞中断。',
    diagnosis: '胃癌（进展期）。',
    expected: {
      attention: 'YES', level: 'RED', keyword: 'HIT', ai: 'SHOULD_FIND',
      rationale: '菜花样肿物 + 诊断明确写癌，关键词与语义都应当发现，是升级后绝不能丢的典型病例。',
    },
  },
  {
    id: 'TEST-REPLAY-002', scenario: 'A',
    patientName: '回放测试02', patientRegistrationNo: 'TEST-REG-R002', department: '脾胃病二科',
    bedNo: '8', patientTypeCode: 'I', patientTypeName: '住院',
    examItem: '电子胃镜检查', examDate: '2026-09-08', examTime: '10:40:00',
    reportContent: '食管中段见环周浸润性改变，黏膜表面粗糙不平，管壁僵硬，蠕动消失，内镜通过时阻力明显增大，管腔狭窄处约0.8cm。',
    diagnosis: '食管恶性肿瘤。',
    reportNote: '',
    expected: {
      attention: 'YES', level: 'RED', keyword: 'HIT', ai: 'SHOULD_FIND',
      rationale: '环周浸润、管壁僵硬、管腔狭窄三条红色规则同时命中，诊断亦明确，是最不该被漏掉的一类。',
    },
  },
  {
    id: 'TEST-REPLAY-003', scenario: 'A',
    patientName: '回放测试03', patientRegistrationNo: 'TEST-REG-R003', department: '脾胃病三科门诊',
    bedNo: '', patientTypeCode: 'O', patientTypeName: '门诊',
    examItem: '（无痛）电子胃镜检查', examDate: '2026-09-09', examTime: '08:50:00',
    reportContent: '贲门口松弛，食管体部明显扩张，可见大量食物潴留，镜身通过贲门时阻力明显，贲门开闭不协调。',
    diagnosis: '贲门失弛缓症。',
    expected: {
      attention: 'YES', level: 'RED', keyword: 'HIT', ai: 'SHOULD_FIND',
      rationale: '贲门失弛缓症是种子规则里的红色关键词，命中即应红色，语义路径读到的也是同一结论。',
    },
  },
  {
    id: 'TEST-REPLAY-004', scenario: 'A',
    patientName: '回放测试04', patientRegistrationNo: 'TEST-REG-R004', department: '脾胃病一科',
    bedNo: '5', patientTypeCode: 'I', patientTypeName: '住院',
    examItem: '电子胃镜检查', examDate: '2026-09-09', examTime: '14:20:00',
    reportContent: '食管下段及贲门上方见橘红色黏膜，齿状线上移约2cm，贲门口松弛，局部疝囊形成，反流明显。',
    diagnosis: '食管裂孔疝；反流性食管炎。',
    expected: {
      attention: 'YES', level: 'RED', keyword: 'HIT', ai: 'SHOULD_FIND',
      rationale: '食管裂孔疝为红色关键词；齿状线上移同时命中黄色规则，取最大等级应为红色。',
    },
  },
  {
    id: 'TEST-REPLAY-005', scenario: 'A',
    patientName: '回放测试05', patientRegistrationNo: 'TEST-REG-R005', department: '脾胃病二科',
    bedNo: '21', patientTypeCode: 'I', patientTypeName: '住院',
    examItem: '（无痛）电子胃镜检查', examDate: '2026-09-10', examTime: '09:05:00',
    reportContent: '胃窦后壁见约2.5cm溃疡，边缘不规则隆起，底部覆厚白苔，周围黏膜皱襞纠集，质脆易出血。',
    diagnosis: '胃窦占位，性质待病理。',
    expected: {
      attention: 'YES', level: 'RED', keyword: 'HIT', ai: 'SHOULD_FIND',
      rationale: '溃疡为黄色规则、占位为红色规则，诊断写「性质待病理」并不能降低等级，最大等级为红色。',
    },
  },
  {
    id: 'TEST-REPLAY-006', scenario: 'A',
    patientName: '回放测试06', patientRegistrationNo: 'TEST-REG-R006', department: '肛肠一科（大学路）',
    bedNo: '3', patientTypeCode: 'I', patientTypeName: '住院',
    examItem: '（无痛）电子结肠镜检查', examDate: '2026-09-10', examTime: '15:30:00',
    reportContent: '升结肠见菜花样肿物，约占管腔2/3周，表面溃破，质脆，触之易出血，内镜通过困难。',
    diagnosis: '结肠肿物，考虑恶性，待病理。',
    expected: {
      attention: 'YES', level: 'RED', keyword: 'HIT', ai: 'SHOULD_FIND',
      rationale: '菜花样肿物为红色规则；注意「内镜通过困难」并不等于关键词「内镜无法通过」，此处红色来自菜花样肿物。',
    },
  },
  {
    id: 'TEST-REPLAY-007', scenario: 'A',
    patientName: '回放测试07', patientRegistrationNo: 'TEST-REG-R007', department: '脾胃病三科',
    bedNo: '16', patientTypeCode: 'I', patientTypeName: '住院',
    examItem: '电子胃镜检查', examDate: '2026-09-11', examTime: '08:30:00',
    reportContent: '胃角及胃窦部管壁僵硬，蠕动消失，注气后形态固定，管腔狭窄，进镜尚可通过。',
    diagnosis: '胃癌。',
    expected: {
      attention: 'YES', level: 'RED', keyword: 'HIT', ai: 'SHOULD_FIND',
      rationale: '管壁僵硬与管腔狭窄均为红色规则，诊断明确写癌；「进镜尚可通过」不构成否定。',
    },
  },
  {
    id: 'TEST-REPLAY-008', scenario: 'A',
    patientName: '回放测试08', patientRegistrationNo: 'TEST-REG-R008', department: '脾胃病一科门诊',
    bedNo: '', patientTypeCode: 'O', patientTypeName: '门诊',
    examItem: '（无痛）电子胃镜检查', examDate: '2026-09-11', examTime: '11:10:00',
    reportContent: '胃底见黏膜下隆起约2.0cm，表面黏膜光滑，色泽正常，质韧，活动度可，未见表面凹陷。',
    diagnosis: '胃底间质瘤可能。',
    expected: {
      attention: 'YES', level: 'RED', keyword: 'HIT', ai: 'SHOULD_FIND',
      rationale: '间质瘤为红色关键词；表面光滑并不降低等级，因为该规则盯的就是黏膜下肿物本身。',
    },
  },
  {
    id: 'TEST-REPLAY-009', scenario: 'A',
    patientName: '回放测试09', patientRegistrationNo: 'TEST-REG-R009', department: '脾胃病二科',
    bedNo: '9', patientTypeCode: 'I', patientTypeName: '住院',
    examItem: '电子胃镜检查', examDate: '2026-09-12', examTime: '09:45:00',
    reportContent: '胃体大弯侧见黏膜下肿物约1.5cm，表面黏膜色泽正常，未见糜烂，质中。',
    diagnosis: '胃体神经内分泌瘤可能。',
    expected: {
      attention: 'YES', level: 'YELLOW', keyword: 'HIT', ai: 'SHOULD_FIND',
      rationale: '肿物与神经内分泌瘤都是黄色规则，本组中属于中等关注；语义路径读到的风险与其一致。',
    },
  },
  {
    id: 'TEST-REPLAY-010', scenario: 'A',
    patientName: '回放测试10', patientRegistrationNo: 'TEST-REG-R010', department: '脾胃病三科',
    bedNo: '14', patientTypeCode: 'I', patientTypeName: '住院',
    examItem: '电子胃镜检查', examDate: '2026-09-12', examTime: '14:05:00',
    reportContent: '胃大部切除术后改变，吻合口见狭窄，镜身通过受阻，吻合口黏膜充血水肿。',
    diagnosis: '吻合口狭窄。',
    expected: {
      attention: 'YES', level: 'YELLOW', keyword: 'HIT', ai: 'SHOULD_FIND',
      rationale: '吻合口狭窄为黄色规则，是需要内镜干预的术后并发症线索，属于应被看到的病例。',
    },
  },
  {
    id: 'TEST-REPLAY-011', scenario: 'A',
    patientName: '回放测试11', patientRegistrationNo: 'TEST-REG-R011', department: '脾胃病一科门诊',
    bedNo: '', patientTypeCode: 'O', patientTypeName: '门诊',
    examItem: '电子胃镜检查', examDate: '2026-09-13', examTime: '10:00:00',
    reportContent: '食管下段黏膜充血，齿状线上方见条状糜烂带，贲门口松弛，反流明显。',
    diagnosis: '胃食管反流病四级。',
    expected: {
      attention: 'YES', level: 'RED', keyword: 'HIT', ai: 'SHOULD_FIND',
      rationale: '胃食管反流病四级为红色规则、糜烂带为黄色规则，取最大等级应为红色。',
    },
  },
  {
    id: 'TEST-REPLAY-012', scenario: 'A',
    patientName: '回放测试12', patientRegistrationNo: 'TEST-REG-R012', department: '脾胃病二科门诊',
    bedNo: '', patientTypeCode: 'O', patientTypeName: '门诊',
    examItem: '（无痛）电子胃镜检查', examDate: '2026-09-13', examTime: '15:50:00',
    reportContent: '胃窦及胃体见多发息肉样隆起，最大约0.8cm，表面光滑，予以钳除。',
    diagnosis: '胃多发息肉。',
    expected: {
      attention: 'YES', level: 'YELLOW', keyword: 'HIT', ai: 'SHOULD_FIND',
      rationale: '息肉为黄色规则，已钳除但仍应出现在名单上；这一例同时是「黄色也可能需要关注」的样本。',
    },
  },

  // ==========================================================================
  // B 组（013-024）关键词不命中，但整份报告语义应关注
  // 本组是最重要的一组：报告刻意不使用癌/肿瘤/肿物/占位等规则词，
  // 改用真实报告里描述恶性风险的说法（不规则隆起、质脆易出血、皱襞中断、
  // 微血管结构紊乱、边界欠清、伸展性差等），全部 30 条种子规则一条都不命中。
  // ==========================================================================
  {
    id: 'TEST-REPLAY-013', scenario: 'B',
    patientName: '回放测试13', patientRegistrationNo: 'TEST-REG-R013', department: '脾胃病一科',
    bedNo: '7', patientTypeCode: 'I', patientTypeName: '住院',
    examItem: '（无痛）电子胃镜检查', examDate: '2026-09-14', examTime: '09:20:00',
    reportContent: '胃体后壁见黏膜粗糙不平区，范围约2.5×2.0cm，表面微血管结构紊乱，局部凹陷覆厚白苔，边缘不规则呈堤状隆起，质脆，触之易出血。',
    diagnosis: '胃体黏膜改变，考虑恶性可能，待病理。',
    expected: {
      attention: 'YES', level: 'RED', keyword: 'NO_HIT', ai: 'SHOULD_FIND',
      rationale: '通篇没有一个规则词，但堤状隆起、微血管紊乱、质脆易出血合起来指向恶性，是「关键词漏掉、语义应找到」的代表。',
    },
  },
  {
    id: 'TEST-REPLAY-014', scenario: 'B',
    patientName: '回放测试14', patientRegistrationNo: 'TEST-REG-R014', department: '脾胃病二科',
    bedNo: '11', patientTypeCode: 'I', patientTypeName: '住院',
    examItem: '电子胃镜检查', examDate: '2026-09-14', examTime: '11:35:00',
    reportContent: '食管下段黏膜表面粗糙，皱襞中断、纠集，局部色泽发红，接触后出血，管壁伸展性差，注气后形态固定。',
    diagnosis: '食管下段黏膜改变，需病理明确。',
    expected: {
      attention: 'YES', level: 'RED', keyword: 'NO_HIT', ai: 'SHOULD_FIND',
      rationale: '皱襞中断纠集 + 接触后出血 + 伸展性差，是食管早癌的常见内镜描述，规则词一个都没有。',
    },
  },
  {
    id: 'TEST-REPLAY-015', scenario: 'B',
    patientName: '回放测试15', patientRegistrationNo: 'TEST-REG-R015', department: '脾胃病三科',
    bedNo: '19', patientTypeCode: 'I', patientTypeName: '住院',
    examItem: '（无痛）电子胃镜检查', examDate: '2026-09-15', examTime: '08:45:00',
    reportContent: '胃窦见环形不规则隆起，表面凹凸不平，边界欠清，注气后形态固定，蠕动减弱，周围黏膜色泽发红。',
    diagnosis: '胃窦异常所见，考虑恶性倾向，建议活检。',
    expected: {
      attention: 'YES', level: 'RED', keyword: 'NO_HIT', ai: 'SHOULD_FIND',
      rationale: '用「环形」而非规则词「环周浸润」，用「异常所见」而非「病变」，边界欠清 + 形态固定仍应触发语义关注。',
    },
  },
  {
    id: 'TEST-REPLAY-016', scenario: 'B',
    patientName: '回放测试16', patientRegistrationNo: 'TEST-REG-R016', department: '肛肠二科（大学路）',
    bedNo: '6', patientTypeCode: 'I', patientTypeName: '住院',
    examItem: '（无痛）电子结肠镜检查', examDate: '2026-09-15', examTime: '14:40:00',
    reportContent: '距肛门约8cm见黏膜不规则凹陷，周边黏膜纠集，质脆易出血，肠腔轻度变形，退镜时接触出血明显。',
    diagnosis: '直肠黏膜改变，待病理。',
    expected: {
      attention: 'YES', level: 'RED', keyword: 'NO_HIT', ai: 'SHOULD_FIND',
      rationale: '直肠不规则凹陷伴周边纠集与质脆，是直肠癌的典型描述；关键词路径完全不响。',
    },
  },
  {
    id: 'TEST-REPLAY-017', scenario: 'B',
    patientName: '回放测试17', patientRegistrationNo: 'TEST-REG-R017', department: '脾胃病一科',
    bedNo: '22', patientTypeCode: 'I', patientTypeName: '住院',
    examItem: '电子胃镜检查', examDate: '2026-09-16', examTime: '09:55:00',
    reportContent: '贲门下方黏膜见片状发红，表面不平，范围约1.5cm，局部质硬，活动度减低，活检时组织脆性大。',
    diagnosis: '贲门区黏膜改变，建议超声内镜进一步评估。',
    expected: {
      attention: 'YES', level: 'RED', keyword: 'NO_HIT', ai: 'SHOULD_FIND',
      rationale: '「贲门下方」「贲门区」都不会命中规则词「贲门失弛缓症」，但质硬、活动度减低指向深层受累。',
    },
  },
  {
    id: 'TEST-REPLAY-018', scenario: 'B',
    patientName: '回放测试18', patientRegistrationNo: 'TEST-REG-R018', department: '脾胃病二科门诊',
    bedNo: '', patientTypeCode: 'O', patientTypeName: '门诊',
    examItem: '（无痛）电子胃镜检查', examDate: '2026-09-16', examTime: '15:15:00',
    reportContent: '十二指肠球部见黏膜皱襞集中、中断，中央凹陷覆白苔，边缘稍隆起，质脆，周围黏膜充血。',
    diagnosis: '球部黏膜改变，待病理。',
    expected: {
      attention: 'YES', level: 'RED', keyword: 'NO_HIT', ai: 'SHOULD_FIND',
      rationale: '刻意不写「溃疡」（否则命中黄色规则），改为「中央凹陷覆白苔 + 皱襞集中中断」，语义上仍是不应忽视的病灶。',
    },
  },
  {
    id: 'TEST-REPLAY-019', scenario: 'B',
    patientName: '回放测试19', patientRegistrationNo: 'TEST-REG-R019', department: '脾胃病三科门诊',
    bedNo: '', patientTypeCode: 'O', patientTypeName: '门诊',
    examItem: '电子胃镜检查', examDate: '2026-09-17', examTime: '10:25:00',
    reportContent: '胃体黏膜表面粗糙，见散在点状发红及糜烂，局部黏膜脆弱，触碰后渗血，周围黏膜色泽不均。',
    diagnosis: '胃体黏膜改变，建议活检明确性质。',
    expected: {
      attention: 'YES', level: 'YELLOW', keyword: 'NO_HIT', ai: 'SHOULD_FIND',
      rationale: '只有「糜烂」没有「糜烂带」，规则不命中；范围较广的黏膜脆弱渗血应落到黄色而非红色。',
    },
  },
  {
    id: 'TEST-REPLAY-020', scenario: 'B',
    patientName: '回放测试20', patientRegistrationNo: 'TEST-REG-R020', department: '肛肠一科（大学路）',
    bedNo: '2', patientTypeCode: 'I', patientTypeName: '住院',
    examItem: '（无痛）电子结肠镜检查', examDate: '2026-09-17', examTime: '14:10:00',
    reportContent: '乙状结肠见黏膜不规则增厚，表面结节样凹凸，肠腔变形，进镜时阻力较大但仍可通过。',
    diagnosis: '乙状结肠黏膜改变，考虑恶性可能，建议活检。',
    expected: {
      attention: 'YES', level: 'RED', keyword: 'NO_HIT', ai: 'SHOULD_FIND',
      rationale: '「内镜通过时阻力较大」不等于规则词「内镜无法通过」；不规则增厚与结节样凹凸本身即应被语义捕捉。',
    },
  },
  {
    id: 'TEST-REPLAY-021', scenario: 'B',
    patientName: '回放测试21', patientRegistrationNo: 'TEST-REG-R021', department: '脾胃病一科',
    bedNo: '18', patientTypeCode: 'I', patientTypeName: '住院',
    examItem: '（无痛）电子胃镜检查', examDate: '2026-09-18', examTime: '09:10:00',
    reportContent: '胃角见局部黏膜纠集，中央稍凹陷，周边黏膜粗糙发红，范围约1.0cm，质稍脆。',
    diagnosis: '胃角黏膜改变，待病理。',
    expected: {
      attention: 'YES', level: 'YELLOW', keyword: 'NO_HIT', ai: 'SHOULD_FIND',
      rationale: '范围小、描述轻，设计上落在黄色；用来确认语义路径不是「一有可疑就报红」。',
    },
  },
  {
    id: 'TEST-REPLAY-022', scenario: 'B',
    patientName: '回放测试22', patientRegistrationNo: 'TEST-REG-R022', department: '脾胃病二科',
    bedNo: '13', patientTypeCode: 'I', patientTypeName: '住院',
    examItem: '电子胃镜检查', examDate: '2026-09-18', examTime: '11:20:00',
    reportContent: '食管中段黏膜表面不平，见片状糜烂及白苔，边缘欠清，管壁活动度减低。',
    diagnosis: '食管中段黏膜改变，建议活检。',
    expected: {
      attention: 'YES', level: 'YELLOW', keyword: 'NO_HIT', ai: 'SHOULD_FIND',
      rationale: '糜烂伴白苔、边缘欠清但范围局限，属于「需要进一步明确」的黄色档，用来观察分级是否过冲。',
    },
  },
  {
    id: 'TEST-REPLAY-023', scenario: 'B',
    patientName: '回放测试23', patientRegistrationNo: 'TEST-REG-R023', department: '脾胃病三科',
    bedNo: '10', patientTypeCode: 'I', patientTypeName: '住院',
    examItem: '（无痛）电子胃镜检查', examDate: '2026-09-19', examTime: '08:35:00',
    reportContent: '胃窦后壁见黏膜粗糙、色泽发红，局部微微隆起，边界不清，范围约2.0cm，质脆，周围皱襞变浅。',
    diagnosis: '胃窦黏膜改变，考虑上皮内改变，待病理。',
    expected: {
      attention: 'YES', level: 'RED', keyword: 'NO_HIT', ai: 'SHOULD_FIND',
      rationale: '「上皮内改变」刻意避开规则词「高级别上皮内瘤变」，但边界不清 + 质脆 + 皱襞变浅指向高风险。',
    },
  },
  {
    id: 'TEST-REPLAY-024', scenario: 'B',
    patientName: '回放测试24', patientRegistrationNo: 'TEST-REG-R024', department: '肛肠二科（大学路）',
    bedNo: '4', patientTypeCode: 'I', patientTypeName: '住院',
    examItem: '（无痛）电子结肠镜检查', examDate: '2026-09-19', examTime: '14:55:00',
    reportContent: '直肠黏膜见不规则凹陷，周围黏膜呈堤状隆起，质脆，触之易出血，肠腔轻度变形。',
    diagnosis: '直肠黏膜改变，考虑恶性可能，待病理。',
    expected: {
      attention: 'YES', level: 'RED', keyword: 'NO_HIT', ai: 'SHOULD_FIND',
      rationale: '直肠堤状隆起伴质脆易出血，是典型的恶性征象组合，全部用规则词之外的表达写出。',
    },
  },

  // ==========================================================================
  // C 组（025-032）关键词命中，但上下文是否定/排除
  // 目的：这批是关键词路径的假阳性来源，应由 #87 语义校验纠正。
  // 注意：种子规则默认没有 semantic_intent，因此在本数据集默认配置下 #87 不会
  // 真的过滤它们 —— 这一点在 README 与最终报告中都单独写明。
  // ==========================================================================
  {
    id: 'TEST-REPLAY-025', scenario: 'C',
    patientName: '回放测试25', patientRegistrationNo: 'TEST-REG-R025', department: '脾胃病一科门诊',
    bedNo: '', patientTypeCode: 'O', patientTypeName: '门诊',
    examItem: '电子胃镜检查', examDate: '2026-09-20', examTime: '09:30:00',
    reportContent: '胃底、胃体黏膜光滑，色泽正常，未见肿物，皱襞走行规整。',
    diagnosis: '慢性胃炎。',
    expected: {
      attention: 'NO', level: 'NONE', keyword: 'FALSE_POSITIVE_RISK', ai: 'SHOULD_FILTER',
      rationale: '「未见肿物」仍会命中黄色规则「肿物」，但语义是否定，不应对本次检查产生关注。',
    },
  },
  {
    id: 'TEST-REPLAY-026', scenario: 'C',
    patientName: '回放测试26', patientRegistrationNo: 'TEST-REG-R026', department: '脾胃病二科门诊',
    bedNo: '', patientTypeCode: 'O', patientTypeName: '门诊',
    examItem: '电子胃镜检查', examDate: '2026-09-20', examTime: '10:50:00',
    reportContent: '胃窦黏膜光滑，未见明显占位及溃疡，幽门圆，开闭良好。',
    diagnosis: '慢性非萎缩性胃炎。',
    expected: {
      attention: 'NO', level: 'NONE', keyword: 'FALSE_POSITIVE_RISK', ai: 'SHOULD_FILTER',
      rationale: '同时命中红色「占位」与黄色「溃疡」，但两者都被否定；这是本组里等级最高的假阳性，纠正后应为无关注。',
    },
  },
  {
    id: 'TEST-REPLAY-027', scenario: 'C',
    patientName: '回放测试27', patientRegistrationNo: 'TEST-REG-R027', department: '肛肠一科（大学路）',
    bedNo: '', patientTypeCode: 'O', patientTypeName: '门诊',
    examItem: '（无痛）电子结肠镜检查', examDate: '2026-09-21', examTime: '08:40:00',
    reportContent: '循腔进镜达回盲部，全结肠黏膜光滑，未见肿物及息肉，退镜观察未见异常。',
    diagnosis: '结肠未见明显异常。',
    expected: {
      attention: 'NO', level: 'NONE', keyword: 'FALSE_POSITIVE_RISK', ai: 'SHOULD_FILTER',
      rationale: '「未见肿物及息肉」一次触发两条黄色规则，是阴性报告被误报的常见形态。',
    },
  },
  {
    id: 'TEST-REPLAY-028', scenario: 'C',
    patientName: '回放测试28', patientRegistrationNo: 'TEST-REG-R028', department: '脾胃病三科门诊',
    bedNo: '', patientTypeCode: 'O', patientTypeName: '门诊',
    examItem: '电子胃镜检查', examDate: '2026-09-21', examTime: '11:15:00',
    reportContent: '胃角原溃疡处已愈合，局部黏膜光滑，瘢痕形成，未见活动性改变。',
    diagnosis: '胃角溃疡愈合期。',
    expected: {
      attention: 'NO', level: 'NONE', keyword: 'FALSE_POSITIVE_RISK', ai: 'SHOULD_FILTER',
      rationale: '溃疡已愈合是好转而非新风险，「溃疡」二字仍会命中黄色规则，属于典型的机械命中。',
    },
  },
  {
    id: 'TEST-REPLAY-029', scenario: 'C',
    patientName: '回放测试29', patientRegistrationNo: 'TEST-REG-R029', department: '脾胃病一科',
    bedNo: '15', patientTypeCode: 'I', patientTypeName: '住院',
    examItem: '（无痛）电子胃镜检查', examDate: '2026-09-22', examTime: '09:25:00',
    reportContent: '食管、贲门及胃底黏膜光滑，血管纹理清晰，未见恶性肿瘤征象，未见浸润表现。',
    diagnosis: '反流性食管炎。',
    expected: {
      attention: 'NO', level: 'NONE', keyword: 'FALSE_POSITIVE_RISK', ai: 'SHOULD_FILTER',
      rationale: '「未见恶性肿瘤征象」会命中两条红色规则（恶性肿瘤、肿瘤），是全组里最容易误报红色的一例。',
    },
  },
  {
    id: 'TEST-REPLAY-030', scenario: 'C',
    patientName: '回放测试30', patientRegistrationNo: 'TEST-REG-R030', department: '脾胃病二科',
    bedNo: '20', patientTypeCode: 'I', patientTypeName: '住院',
    examItem: '电子胃镜检查', examDate: '2026-09-22', examTime: '14:30:00',
    reportContent: '胃体、胃窦黏膜光滑，未见溃疡及肿物，幽门螺杆菌检测阴性。',
    diagnosis: '慢性胃炎。',
    expected: {
      attention: 'NO', level: 'NONE', keyword: 'FALSE_POSITIVE_RISK', ai: 'SHOULD_FILTER',
      rationale: '两条黄色规则被同时否定；与 A 组形成对照，同样的词在否定语境下不应产生关注。',
    },
  },
  {
    id: 'TEST-REPLAY-031', scenario: 'C',
    patientName: '回放测试31', patientRegistrationNo: 'TEST-REG-R031', department: '脾胃病三科门诊',
    bedNo: '', patientTypeCode: 'O', patientTypeName: '门诊',
    examItem: '（无痛）电子胃镜检查', examDate: '2026-09-23', examTime: '10:05:00',
    reportContent: '十二指肠球部未见溃疡，球腔无变形，黏膜光滑，降部未见异常。',
    diagnosis: '十二指肠球部未见异常。',
    expected: {
      attention: 'NO', level: 'NONE', keyword: 'FALSE_POSITIVE_RISK', ai: 'SHOULD_FILTER',
      rationale: '阴性描述中带「溃疡」二字；球腔无变形进一步说明是否定，应被语义校验识别。',
    },
  },
  {
    id: 'TEST-REPLAY-032', scenario: 'C',
    patientName: '回放测试32', patientRegistrationNo: 'TEST-REG-R032', department: '肛肠二科（大学路）',
    bedNo: '', patientTypeCode: 'O', patientTypeName: '门诊',
    examItem: '（无痛）电子结肠镜检查', examDate: '2026-09-23', examTime: '15:40:00',
    reportContent: '回盲部未见占位性改变，阑尾开口形态正常，回盲瓣开闭良好。',
    diagnosis: '回盲部未见异常。',
    expected: {
      attention: 'NO', level: 'NONE', keyword: 'FALSE_POSITIVE_RISK', ai: 'SHOULD_FILTER',
      rationale: '「未见占位性改变」命中红色「占位」；否定词在前，语义上不成立。',
    },
  },

  // ==========================================================================
  // D 组（033-037）关键词命中，但属于既往史
  // 当前系统没有 HIS/跨次病史能力，所以既往信息必须直接写在本次报告文本里。
  // ==========================================================================
  {
    id: 'TEST-REPLAY-033', scenario: 'D',
    patientName: '回放测试33', patientRegistrationNo: 'TEST-REG-R033', department: '脾胃病一科',
    bedNo: '17', patientTypeCode: 'I', patientTypeName: '住院',
    examItem: '（无痛）电子胃镜检查', examDate: '2026-09-24', examTime: '08:55:00',
    reportContent: '既往外院胃镜提示胃体腺癌，已行手术及化疗；本次复查胃体黏膜光滑，原病灶处未见异常，吻合口通畅。',
    diagnosis: '胃癌术后复查。',
    expected: {
      attention: 'NO', level: 'NONE', keyword: 'FALSE_POSITIVE_RISK', ai: 'SHOULD_FILTER',
      rationale: '「癌」出现在既往史里，本次检查是阴性；若不过滤会把术后复查者长期误标为红色。',
    },
  },
  {
    id: 'TEST-REPLAY-034', scenario: 'D',
    patientName: '回放测试34', patientRegistrationNo: 'TEST-REG-R034', department: '肛肠一科（大学路）',
    bedNo: '1', patientTypeCode: 'I', patientTypeName: '住院',
    examItem: '（无痛）电子结肠镜检查', examDate: '2026-09-24', examTime: '10:30:00',
    reportContent: '患者3年前因结肠肿瘤行右半结肠切除术，本次复查吻合口通畅，余结肠黏膜光滑，未见异常。',
    diagnosis: '结肠肿瘤术后复查。',
    expected: {
      attention: 'NO', level: 'NONE', keyword: 'FALSE_POSITIVE_RISK', ai: 'SHOULD_FILTER',
      rationale: '「肿瘤」来自手术史，本次为阴性复查；注意「吻合口通畅」不会命中「吻合口狭窄」。',
    },
  },
  {
    id: 'TEST-REPLAY-035', scenario: 'D',
    patientName: '回放测试35', patientRegistrationNo: 'TEST-REG-R035', department: '脾胃病二科门诊',
    bedNo: '', patientTypeCode: 'O', patientTypeName: '门诊',
    examItem: '电子胃镜检查', examDate: '2026-09-25', examTime: '09:00:00',
    reportContent: '既往有胃溃疡病史，曾规律服药治疗；本次胃窦黏膜光滑，未见活动性改变，瘢痕平整。',
    diagnosis: '既往胃溃疡病史，本次复查未见活动性改变。',
    expected: {
      attention: 'NO', level: 'NONE', keyword: 'FALSE_POSITIVE_RISK', ai: 'SHOULD_FILTER',
      rationale: '病史里的「溃疡」命中黄色规则，本次是愈合后复查，不应作为本次关注理由。',
    },
  },
  {
    id: 'TEST-REPLAY-036', scenario: 'D',
    patientName: '回放测试36', patientRegistrationNo: 'TEST-REG-R036', department: '脾胃病三科',
    bedNo: '23', patientTypeCode: 'I', patientTypeName: '住院',
    examItem: '电子胃镜检查', examDate: '2026-09-25', examTime: '11:45:00',
    reportContent: '外院曾诊断食管恶性肿瘤，已行放化疗；本次食管黏膜光滑，原狭窄段已改善，未见复发征象。',
    diagnosis: '食管恶性肿瘤治疗后复查。',
    expected: {
      attention: 'NO', level: 'NONE', keyword: 'FALSE_POSITIVE_RISK', ai: 'SHOULD_FILTER',
      rationale: '两条红色规则都因既往诊断而命中，本次是治疗后好转；这是 HISTORY 需要被区分开的原因。',
    },
  },
  {
    // CROSS_PATH：报告正文**不得修改**。它的价值不在「既往史」这一点上，而在于
    // 两条 AI 路径必须同时做对、且互不干扰 —— 只测其中一条，这例就退化成普通 D 组。
    id: 'TEST-REPLAY-037', scenario: 'CROSS_PATH',
    patientName: '回放测试37', patientRegistrationNo: 'TEST-REG-R037', department: '脾胃病一科',
    bedNo: '6', patientTypeCode: 'I', patientTypeName: '住院',
    examItem: '（无痛）电子胃镜检查', examDate: '2026-09-25', examTime: '15:20:00',
    reportContent: '既往有胃溃疡病史；本次胃窦见不规则凹陷，覆白苔，边缘稍隆起，质脆，触之易出血，周围黏膜纠集。',
    diagnosis: '胃窦黏膜改变，考虑恶性可能，待病理；既往胃溃疡病史。',
    expected: {
      attention: 'YES', level: 'RED', keyword: 'FALSE_POSITIVE_RISK', ai: 'SHOULD_FILTER_AND_FIND',
      rationale:
        '组合路径病例：此例用于验证 #87 与 #88 同时参与时，历史关键词命中可以被过滤，但本次真正异常仍能由报告级语义监控独立发现。' +
        '路径为：历史信息中的「溃疡」命中黄色规则 → #87 应识别这是既往史并过滤掉该命中 → 同一份本次报告又存在真正值得关注的异常（不规则凹陷、覆白苔、边缘隆起、质脆、触之易出血、周围黏膜纠集）→ #88 独立读取完整报告 → 应重新发现本次风险 → 最终等级 RED。' +
        '两条路径缺一不可：只过滤不发现会漏掉这位患者，只发现不过滤则无法证明 #87 在组合场景下没有失效。',
    },
  },

  // ==========================================================================
  // E 组（038-043）模糊 / 疑似 / 不确定表达
  // ==========================================================================
  {
    id: 'TEST-REPLAY-038', scenario: 'E',
    patientName: '回放测试38', patientRegistrationNo: 'TEST-REG-R038', department: '脾胃病二科门诊',
    bedNo: '', patientTypeCode: 'O', patientTypeName: '门诊',
    examItem: '电子胃镜检查', examDate: '2026-09-24', examTime: '14:15:00',
    reportContent: '胃窦见局部黏膜稍粗糙，表面色泽轻度不均，性质待定，未见明确凹陷，建议随访复查。',
    diagnosis: '胃窦所见，性质待定，建议3-6个月复查。',
    expected: {
      attention: 'YES', level: 'YELLOW', keyword: 'NO_HIT', ai: 'SHOULD_FIND',
      rationale: '「性质待定、需短期复查」是预设的黄色关注语义之一，属于应当被看到但不必报红的形态。',
    },
  },
  {
    id: 'TEST-REPLAY-039', scenario: 'E',
    patientName: '回放测试39', patientRegistrationNo: 'TEST-REG-R039', department: '脾胃病一科',
    bedNo: '9', patientTypeCode: 'I', patientTypeName: '住院',
    examItem: '（无痛）电子胃镜检查', examDate: '2026-09-23', examTime: '09:40:00',
    reportContent: '食管中段黏膜表面略不平，血管纹理欠清晰，可见片状色泽改变，不除外早期恶变，建议活检。',
    diagnosis: '食管黏膜改变，不除外早期恶变，建议病理。',
    expected: {
      attention: 'YES', level: 'RED', keyword: 'NO_HIT', ai: 'SHOULD_FIND',
      rationale: '「不除外早期恶变」是疑似而非否定；按 #87 的判定表，SUSPECTED 一律保留，不应被当成否定过滤掉。',
    },
  },
  {
    id: 'TEST-REPLAY-040', scenario: 'E',
    patientName: '回放测试40', patientRegistrationNo: 'TEST-REG-R040', department: '脾胃病三科',
    bedNo: '12', patientTypeCode: 'I', patientTypeName: '住院',
    examItem: '电子胃镜检查', examDate: '2026-09-22', examTime: '10:20:00',
    reportContent: '胃角见凹陷性改变，表面覆白苔，周围黏膜稍纠集，考虑良性可能大，但不除外恶性，建议活检。',
    diagnosis: '胃角凹陷性改变，性质待病理，不除外恶性。',
    expected: {
      attention: 'YES', level: 'RED', keyword: 'NO_HIT', ai: 'SHOULD_FIND',
      rationale: '「考虑良性可能大」与「不除外恶性」并存：可以争论粗细，但不应因为前半句就把整条判为阴性。',
    },
  },
  {
    id: 'TEST-REPLAY-041', scenario: 'E',
    patientName: '回放测试41', patientRegistrationNo: 'TEST-REG-R041', department: '脾胃病一科门诊',
    bedNo: '', patientTypeCode: 'O', patientTypeName: '门诊',
    examItem: '（无痛）电子胃镜检查', examDate: '2026-09-21', examTime: '15:05:00',
    reportContent: '胃窦见黏膜粗糙不平，范围约1.2cm，表面稍凹陷，性质待定，建议活检明确。',
    diagnosis: '胃窦黏膜改变，性质待定，建议病理。',
    expected: {
      attention: 'YES', level: 'YELLOW', keyword: 'NO_HIT', ai: 'SHOULD_FIND',
      rationale: '与 038 同类但黏膜改变更明显，仍然落在「性质待定」的黄色档，用来观察语义路径是否稳定。',
    },
  },
  {
    id: 'TEST-REPLAY-042', scenario: 'E',
    patientName: '回放测试42', patientRegistrationNo: 'TEST-REG-R042', department: '脾胃病二科',
    bedNo: '18', patientTypeCode: 'I', patientTypeName: '住院',
    examItem: '电子胃镜检查', examDate: '2026-09-20', examTime: '09:35:00',
    reportContent: '食管中段碘染后见片状淡染区，边界欠清，表面稍不平，不除外早期恶变，建议病理。',
    diagnosis: '食管黏膜改变，不除外早期恶变。',
    expected: {
      attention: 'YES', level: 'RED', keyword: 'NO_HIT', ai: 'SHOULD_FIND',
      rationale: '碘染淡染区 + 边界欠清是内镜下早癌筛查的典型线索，「恶变」二字不触发任何规则词。',
    },
  },
  {
    id: 'TEST-REPLAY-043', scenario: 'E',
    patientName: '回放测试43', patientRegistrationNo: 'TEST-REG-R043', department: '肛肠一科（大学路）',
    bedNo: '', patientTypeCode: 'O', patientTypeName: '门诊',
    examItem: '（无痛）电子结肠镜检查', examDate: '2026-09-19', examTime: '16:10:00',
    reportContent: '乙状结肠见一处黏膜稍隆起，表面光滑，色泽正常，考虑良性可能性大，建议随诊。',
    diagnosis: '乙状结肠隆起，考虑良性，建议随诊。',
    expected: {
      attention: 'NO', level: 'NONE', keyword: 'NO_HIT', ai: 'UNCERTAIN',
      rationale: '措辞含糊但整体良性倾向明确；设计上不判定对错，用来观察系统会不会把「隆起」一律上调等级。',
    },
  },

  // ==========================================================================
  // F 组（044-050）对照组：普通、低风险、基本正常
  // 全部刻意不含任何规则词，因此这一组出现的任何非 NONE 等级，都只能来自 AI 语义路径，
  // 是「AI 是否无故升级」最干净的对照。
  // ==========================================================================
  {
    id: 'TEST-REPLAY-044', scenario: 'F',
    patientName: '回放测试44', patientRegistrationNo: 'TEST-REG-R044', department: '脾胃病一科门诊',
    bedNo: '', patientTypeCode: 'O', patientTypeName: '门诊',
    examItem: '电子胃镜检查', examDate: '2026-09-18', examTime: '08:25:00',
    // 困难阴性（F 组 3 例之一）：局部有危险联想词，句内即给出良性解释。
    reportContent: '胃窦黏膜充血水肿，散在点状发红，局部黏膜粗糙，触碰后少量渗血，考虑检查操作刺激所致；余黏膜未见明显异常，蠕动正常。',
    diagnosis: '慢性非萎缩性胃炎。',
    expected: {
      attention: 'NO', level: 'NONE', keyword: 'NO_HIT', ai: 'SHOULD_NOT_FIND',
      rationale: '困难阴性：「粗糙」「渗血」都容易引起风险联想，但同一句里给出了良性归因（操作刺激所致），整体仍是门诊最常见的胃炎。用来观察 #88 会不会只抓到危险词、没有读完整句子的因果关系。',
    },
  },
  {
    id: 'TEST-REPLAY-045', scenario: 'F',
    patientName: '回放测试45', patientRegistrationNo: 'TEST-REG-R045', department: '脾胃病二科门诊',
    bedNo: '', patientTypeCode: 'O', patientTypeName: '门诊',
    examItem: '（无痛）电子胃镜检查', examDate: '2026-09-17', examTime: '10:45:00',
    reportContent: '食管黏膜光滑，贲门开闭良好；胃底、胃体、胃角黏膜光滑，胃窦黏膜稍充血，十二指肠球部未见异常。',
    diagnosis: '慢性胃炎。',
    expected: {
      attention: 'NO', level: 'NONE', keyword: 'NO_HIT', ai: 'SHOULD_NOT_FIND',
      rationale: '通篇「光滑/未见异常」，是阴性报告的典型写法，也是误报的高发形态（描述长、听起来全）。',
    },
  },
  {
    id: 'TEST-REPLAY-046', scenario: 'F',
    patientName: '回放测试46', patientRegistrationNo: 'TEST-REG-R046', department: '肛肠二科（大学路）',
    bedNo: '', patientTypeCode: 'O', patientTypeName: '门诊',
    examItem: '（无痛）电子结肠镜检查', examDate: '2026-09-16', examTime: '14:35:00',
    reportContent: '循腔进镜达回盲部，全结肠黏膜光滑，血管纹理清晰，退镜观察未见异常。',
    diagnosis: '结肠未见明显异常。',
    expected: {
      attention: 'NO', level: 'NONE', keyword: 'NO_HIT', ai: 'SHOULD_NOT_FIND',
      rationale: '完全阴性的肠镜，与 C 组 027 的区别在于这里连「未见肿物」这类否定式规则词都没出现。',
    },
  },
  {
    id: 'TEST-REPLAY-047', scenario: 'F',
    patientName: '回放测试47', patientRegistrationNo: 'TEST-REG-R047', department: '脾胃病三科门诊',
    bedNo: '', patientTypeCode: 'O', patientTypeName: '门诊',
    examItem: '电子胃镜检查', examDate: '2026-09-15', examTime: '11:05:00',
    reportContent: '十二指肠球部黏膜光滑，降部未见异常，乳头形态正常。',
    diagnosis: '十二指肠球部未见异常。',
    expected: {
      attention: 'NO', level: 'NONE', keyword: 'NO_HIT', ai: 'SHOULD_NOT_FIND',
      rationale: '短报告对照组：文字少、信息少，用来确认语义路径不会因为「信息不足」而乱报。',
    },
  },
  {
    id: 'TEST-REPLAY-048', scenario: 'F',
    patientName: '回放测试48', patientRegistrationNo: 'TEST-REG-R048', department: '肛肠一科（大学路）',
    bedNo: '', patientTypeCode: 'O', patientTypeName: '门诊',
    examItem: '（无痛）电子结肠镜检查', examDate: '2026-09-14', examTime: '15:25:00',
    // 困难阴性（F 组 3 例之一）：把 044 的形态搬到肠镜上，确认这不是胃镜特有的现象。
    reportContent: '结肠镜检查顺利，达回盲部，阑尾开口形态正常；乙状结肠黏膜散在充血，局部黏膜粗糙，边界尚清，触碰后少量渗血，考虑肠道准备及操作刺激所致；退镜观察余结肠黏膜光滑。',
    diagnosis: '乙状结肠轻度炎症，余结肠未见明显异常。',
    expected: {
      attention: 'NO', level: 'NONE', keyword: 'NO_HIT', ai: 'SHOULD_NOT_FIND',
      rationale: '困难阴性：局部描述听起来可疑（充血、粗糙、边界、渗血），但句内给出了良性归因（肠道准备及操作刺激），整体仍是低风险。用来观察 #88 在肠镜报告上是否同样只看危险词。',
    },
  },
  {
    id: 'TEST-REPLAY-049', scenario: 'F',
    patientName: '回放测试49', patientRegistrationNo: 'TEST-REG-R049', department: '脾胃病一科门诊',
    bedNo: '', patientTypeCode: 'O', patientTypeName: '门诊',
    examItem: '电子胃镜检查', examDate: '2026-09-12', examTime: '09:50:00',
    // 困难阴性（F 组 3 例之一）：通篇是「异常外观」，但结论是炎症。
    reportContent: '胃体黏膜粗糙，可见散在红斑，色泽略不均，边界清楚，考虑炎症性改变；蠕动正常，幽门圆，开闭良好。',
    diagnosis: '慢性浅表性胃炎。',
    expected: {
      attention: 'NO', level: 'NONE', keyword: 'NO_HIT', ai: 'SHOULD_NOT_FIND',
      rationale: '困难阴性：「粗糙」「红斑」「色泽不均」「边界」都会被语义路径当作异常信号，但句内即给出良性判断（考虑炎症性改变），且全文没有隆起、没有溃疡、没有出血。用来观察 #88 能否区分「外观描述异常」与「需要关注」。',
    },
  },
  {
    id: 'TEST-REPLAY-050', scenario: 'F',
    patientName: '回放测试50', patientRegistrationNo: 'TEST-REG-R050', department: '脾胃病二科门诊',
    bedNo: '', patientTypeCode: 'O', patientTypeName: '门诊',
    examItem: '（无痛）电子胃镜检查', examDate: '2026-09-11', examTime: '16:20:00',
    reportContent: '食管下段黏膜光滑，齿状线清晰，贲门开闭良好，胃内未见异常。',
    diagnosis: '未见明显异常。',
    expected: {
      attention: 'NO', level: 'NONE', keyword: 'NO_HIT', ai: 'SHOULD_NOT_FIND',
      rationale: '写到了「齿状线清晰」以确认它不会被规则词「齿状线上移」误伤，是规则边界的一个定点样本。',
    },
  },
];

/** 与期望答案无关、仅供人工阅读的补充说明。 */
export const CASE_NOTES = Object.freeze({
  disclaimer:
    'expected 各列是本数据集设计者给出的预期，用于衡量系统是否按设计意图工作，不是医学金标准，也不是临床诊断依据。',
});
