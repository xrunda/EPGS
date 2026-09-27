import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MonitorAttentionSourceDto } from '@epgs/shared-types';
import { findingSourceIcons, KEYWORD_SOURCE_ICON, REPORT_SOURCE_ICON } from './findingSource';

const ALL_SOURCES: MonitorAttentionSourceDto[] = ['RULE', 'AI_REPORT', 'BOTH', 'NONE'];

describe('发现来源图标（issue #112）', () => {
  it('四种来源各自映射到正确的图标', () => {
    expect(findingSourceIcons('RULE')).toEqual([KEYWORD_SOURCE_ICON]);
    expect(findingSourceIcons('AI_REPORT')).toEqual([REPORT_SOURCE_ICON]);
    expect(findingSourceIcons('BOTH')).toEqual([KEYWORD_SOURCE_ICON, REPORT_SOURCE_ICON]);
    expect(findingSourceIcons('NONE')).toEqual([]);
  });

  it('BOTH 两枚都给，顺序固定（先命中、后报告）', () => {
    // 顺序固定，列表里两枚图标的左右关系在任何一行都一致；跟着等级排序走会让同一
    // 屏里两枚图标的相对位置变来变去。
    expect(findingSourceIcons('BOTH').map((icon) => icon.alt)).toEqual(['命中', '报告提示']);
  });

  /**
   * Workbench.tsx 用 `attentionSource === 'NONE'` 显式判空、其余一律走 findingSourceIcons。
   * 哪天多出一个「没有图标」的来源值，那一行就会渲染出一个空的图标区 —— 看着像没渲染
   * 出来，而不是「两路都没有」。这条钉住「除 NONE 外至少一枚」，两处不会漂。
   */
  it('除 NONE 外每种来源都至少有一枚图标', () => {
    for (const source of ALL_SOURCES.filter((s) => s !== 'NONE')) {
      expect(findingSourceIcons(source).length, source).toBeGreaterThan(0);
    }
  });

  /**
   * `alt` 是读屏软件唯一拿得到的说明。两处术语扫描盯的是**渲染文本**
   * （container.textContent），属性都不在里面 —— 所以这里单独钉一次。
   */
  it('alt 只用界面里既有的说法，不含任何机制词', () => {
    const alts = [KEYWORD_SOURCE_ICON.alt, REPORT_SOURCE_ICON.alt];
    for (const leak of ['关键词', 'AI', '语义', '判读', '模型', '置信度', '哈希', 'LLM']) {
      for (const alt of alts) expect(alt, alt).not.toContain(leak);
    }
    // 正面控制：确认上面扫的确实是这两个词，而不是空字符串在通过。
    expect(alts).toEqual(['命中', '报告提示']);
  });

  /**
   * 悬停提示（`data-tip`）走另一套说法：跟着设置入口的按钮名（所有者 2026-09-27 定，
   * 对应顶栏的「关键词监控」「AI 语义监控」）。所以这里**故意**含「关键词 / AI / 语义」
   * —— 它们是对外的产品词，不再是禁列；把这条与上一条分开写，就是为了让这个放宽
   * 是显式的、有人看得见的，而不是顺手从禁列里删掉几个词。
   *
   * 实现词（判读 / 模型 / 置信度 …）照旧一个都不许有：提示是医生看得见的渲染文本。
   */
  it('提示词跟设置入口同名，但实现词照旧不许出现', () => {
    const tips = [KEYWORD_SOURCE_ICON.tip, REPORT_SOURCE_ICON.tip];
    // 正面控制：先钉死这两个字符串确实是跟着入口走的那两个词。
    expect(tips).toEqual(['关键词命中', 'AI 语义命中']);
    for (const leak of [
      '判读',
      'Prompt',
      '提示词',
      'LLM',
      '模型',
      '分类器',
      'JSON',
      'Schema',
      '置信度',
      '哈希',
      '大模型',
    ]) {
      for (const tip of tips) expect(tip, tip).not.toContain(leak);
    }
  });

  /**
   * 两枚图标的悬停提示必须不一样，否则鼠标滑过去看不出区别 —— 那正是这枚图标要回答的
   * 问题。`alt` 同理。
   */
  it('两枚图标的提示与 alt 各自不同', () => {
    expect(KEYWORD_SOURCE_ICON.tip).not.toBe(REPORT_SOURCE_ICON.tip);
    expect(KEYWORD_SOURCE_ICON.alt).not.toBe(REPORT_SOURCE_ICON.alt);
    for (const icon of [KEYWORD_SOURCE_ICON, REPORT_SOURCE_ICON]) {
      expect(icon.tip.length).toBeGreaterThan(0);
    }
  });

  it('图标走 public 绝对路径，且两枚不是同一个文件', () => {
    for (const icon of [KEYWORD_SOURCE_ICON, REPORT_SOURCE_ICON]) {
      expect(icon.src.startsWith('/')).toBe(true);
    }
    expect(KEYWORD_SOURCE_ICON.src).not.toBe(REPORT_SOURCE_ICON.src);
  });

  /**
   * 文件真的在 apps/web/public 里。vite 对 public 下的引用不做存在性检查，写错文件名
   * 只会 404 成一张破图 —— 界面照常渲染，没有测试会红，只有人眼能发现。这条把它变成
   * 一个响亮的失败。`process.cwd()` 在 vitest 里就是包根 `apps/web`。
   */
  it('两个图标文件确实存在于 apps/web/public', () => {
    for (const icon of [KEYWORD_SOURCE_ICON, REPORT_SOURCE_ICON]) {
      const file = resolve(process.cwd(), 'public', icon.src.slice(1));
      expect(existsSync(file), `${file} 不存在`).toBe(true);
    }
  });

  /**
   * 同一个悬停气泡画在两处（列表 22px 图标 / 抽屉 24px 图标），字号必须一样大
   * （issue #117）。
   *
   * 这条是真出过问题才补的：第一版两处都写 `font-size: inherit`，想让气泡跟着各自
   * 容器的字号走，列表那边继承 `.workbench__table` 的 13px、抽屉那边一路继承到浏览器
   * 默认的 16px —— 同一个气泡在两处不一样大（所有者 2026-09-27 指出抽屉太大）。CSS 没有
   * 单测，这种漂移只能靠读文件比字符串来钉。两处注释都写了「改一个必须改另一个」，
   * 这条是它的执行版本：只改一处，这里就红。
   */
  it('列表与抽屉的悬停气泡字号相同，且都是列表正文的 13px', () => {
    const fontSizeOf = (cssFile: string, selector: string): string => {
      const css = readFileSync(resolve(process.cwd(), 'src', cssFile), 'utf8');
      const at = css.indexOf(selector);
      expect(at, `${cssFile} 里找不到 ${selector}`).toBeGreaterThan(-1);
      const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
      const declared = body.match(/font-size:\s*([^;]+);/);
      expect(declared, `${selector} 没有声明 font-size`).not.toBeNull();
      return (declared as RegExpMatchArray)[1].trim();
    };

    const listSize = fontSizeOf('Workbench.css', '.workbench__source-tip::after');
    const drawerSize = fontSizeOf('DetailDrawer.css', '.drawer__source-tip::after');

    expect(drawerSize).toBe(listSize);
    // 正面控制：13px 是这次定的口径，不是随手跟着某一处写死的数字 ——
    // 两边一起漂到别的值同样不合格。
    expect(listSize).toBe('13px');
  });
});
