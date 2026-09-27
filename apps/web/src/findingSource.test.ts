import { existsSync } from 'node:fs';
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
   * `alt` 是读屏软件唯一拿得到的说明，也是这两枚图标在无障碍树里的「词」。两处术语
   * 扫描盯的是**渲染文本**（container.textContent），`alt` 不在里面 —— 所以这里单独
   * 钉一次，防止有人顺手把「关键词命中」「AI 语义」写进去、绕过了那两道闸门。
   */
  it('alt 只用界面里既有的说法，不含任何机制词', () => {
    const alts = [KEYWORD_SOURCE_ICON.alt, REPORT_SOURCE_ICON.alt];
    for (const leak of ['关键词', 'AI', '语义', '判读', '模型', '置信度', '哈希', 'LLM']) {
      for (const alt of alts) expect(alt, alt).not.toContain(leak);
    }
    // 正面控制：确认上面扫的确实是这两个词，而不是空字符串在通过。
    expect(alts).toEqual(['命中', '报告提示']);
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
});
