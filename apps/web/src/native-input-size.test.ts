import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 原生 radio / checkbox 必须显式钉死尺寸的回归护栏（issue #141，issue #143 后仍然承重，
 * #145 把导出弹层从 radio 换成 checkbox 时扩到两种类型）。
 *
 * 为什么是一个读 CSS 源码的测试：这个缺陷是**少了一条 CSS 声明**造成的 —— 不钉尺寸的
 * 原生控件会吃到「表单控件底座」里的 `width: 100%; height: 38px`（底座定义在
 * `RulesModal.css`，对 `.export-modal` / `.semantic-modal` / `.rules-modal` /
 * `.users-modal` 等弹层容器生效）。落到 16px 的圆点/勾选框上就是：控件被撑成
 * 47.5×38 的框，聚焦时 3px 焦点环套在那个框上，看起来就是一个大灰方块。
 *
 * #143 之前这几条是从一组**裸元素选择器**泄漏过来的（全站每个 input 都吃）；#143 把它
 * 收进了容器作用域，但**这些控件所在的弹层正是被收进去的容器**，所以钉尺寸依然必需：
 * 实测把底座与它们打平（`:is()` 那版）时，导出弹层的控件立刻从 16×16 变成 92.5×38。
 *
 * jsdom 没有布局引擎（vitest 也没开 `css: true`），「被撑开」在单测里测不出来，所以
 * 这里只钉住那几条声明不被删掉，**渲染结果的证据是实测**（浏览器里读计算样式得到
 * 16×16 / 18×18、`accent-color` 为品牌青，见 PR #141 / #142 / #144）。
 *
 * 同类做法见 `modal-header-sticky.test.ts`（issue #133）、`button-text-wrap.test.ts`
 * （issue #110）与 `form-controls-scope.test.ts`（issue #143）—— 都是「读源码、防止某条
 * 声明或某个作用域被悄悄改掉」。
 */

/*
  用 process.cwd() 定位而不是 import.meta.url（同 button-text-wrap.test.ts）：
  vitest 里模块由 Vite 通过 HTTP 提供，`import.meta.url` 是 http 协议；`?raw` 导入也
  不行（没开 `test.css`）。vitest 的 cwd 就是包根（apps/web），定位不到会直接 ENOENT
  报错，不会变成一条静默通过的假绿。
*/
const read = (name: string): string =>
  readFileSync(resolve(process.cwd(), 'src', name), 'utf8')
    // 先去注释再解析：下面这些规则的说明里会出现 `}` 与 `input`，不去注释会被注释里的
    // 花括号截断，也可能让下面的断言误判。
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // 把跨行的选择器组收成一行：`input,\nselect {` 是 RulesModal.css 里的实际写法，
    // 不收就匹配不到（ruleBody 是「从行首的选择器找到 {」）。
    .replace(/,\s*\n\s*/g, ', ');

const escape = (selector: string): string => selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 取出 `selector {` 到配对 `}` 之间的声明文本。缩进在 @media 里的同名规则匹配不到。 */
function ruleBody(css: string, selector: string): string | null {
  const match = new RegExp(`^${escape(selector)}\\s*\\{`, 'm').exec(css);
  if (!match) return null;
  const from = match.index + match[0].length;
  const to = css.indexOf('}', from);
  return to === -1 ? null : css.slice(from, to);
}

/** 取某条规则里某个属性的声明值；`width` 不会误配 `min-width`（正则要求前面是 `;` 或 `{`）。 */
function declaration(css: string, selector: string, property: string): string | null {
  const body = ruleBody(css, selector);
  if (body === null) return null;
  const match = new RegExp(`(?:^|[;{])\\s*${escape(property)}\\s*:\\s*([^;]+)`).exec(body);
  return match ? match[1].trim() : null;
}

/**
 * 全仓所有原生 radio / checkbox 的宿主 CSS 规则，含被钉死的宽高。
 *
 * 尺寸不是统一的 16px（`.switch-row` 是 18px），所以每个条目自己带期望值 —— 断言写成
 * 「等于 16」会让 `.switch-row` 只能靠不写进来「通过」。
 *
 * `accentColor` 为 null 表示**该规则确实没有**这一条：`.switch-row input` 走的是 Chrome
 * 默认蓝，是 #145 之前就存在的现状。这里如实记录而不是顺手补上 —— 补一次会同时改动八个
 * 勾选框的观感，那是另一个决定（属视觉调整，不在本 Issue 范围）。反过来，一旦有人给它
 * 加了 accent-color，这条断言会提醒他这是个有意的改动。
 *
 * `hosts` 是「哪些 .tsx 里会出现这个控件」，下面有一条测试拿它和源码对账：漏钉的那一处
 * 不会有任何单测变红，只有人眼在浏览器里发现「怎么是个大方框」，所以必须直接对账。
 */
const NATIVE_CONTROLS = [
  {
    label: '数据导出 · 关注等级',
    type: 'checkbox',
    css: 'ExportModal.css',
    selector: '.export-level input',
    size: '16px',
    accentColor: 'var(--teal-700)',
    hosts: ['ExportModal.tsx'],
    ownedBy: 'issue #141 建的护栏；#145 把这里从 radio 改成 checkbox',
  },
  {
    label: 'AI 语义监控 · 关注等级',
    type: 'radio',
    css: 'SemanticMonitorModal.css',
    selector: '.semantic-level-picker__option input',
    size: '16px',
    accentColor: 'var(--teal-700)',
    hosts: ['SemanticMonitorModal.tsx'],
    ownedBy: 'issue #88 —— 它一直是钉着的，是正确写法的参照',
  },
  {
    label: '开关行（各面板与弹层的布尔开关）',
    type: 'checkbox',
    css: 'RulesModal.css',
    selector: '.switch-row input',
    size: '18px',
    accentColor: null,
    hosts: [
      'ChannelPanel.tsx',
      'RulesModal.tsx',
      'RulesPanel.tsx',
      'TemplatePanel.tsx',
      'UsersModal.tsx',
      'SemanticMonitorModal.tsx',
    ],
    ownedBy: 'issue #141 之前的既有写法；宽高与其它处不同，一并纳入这张表',
  },
  {
    label: '推送渠道多选（通知设置）',
    type: 'checkbox',
    css: 'NotificationModal.css',
    selector: '.notification-channel-option input',
    size: '16px',
    accentColor: 'var(--teal-700)',
    hosts: ['RulesPanel.tsx'],
    ownedBy: 'issue #135 —— 多选渠道，本来就是钉着的',
  },
] as const;

describe('原生 radio / checkbox 钉死了尺寸，不被表单控件底座撑开（issue #141 / #143 / #145）', () => {
  for (const { label, css: file, selector, size, accentColor, ownedBy } of NATIVE_CONTROLS) {
    describe(`${label}（${ownedBy}）`, () => {
      it(`宽高都是 ${size}：底座里的 \`width: 100%; height: 38px\` 会落上来，不钉就会被撑开`, () => {
        const css = read(file);
        expect(declaration(css, selector, 'width')).toBe(size);
        expect(declaration(css, selector, 'height')).toBe(size);
      });

      if (accentColor) {
        it('控件是品牌青，不是 Chrome 默认蓝', () => {
          expect(declaration(read(file), selector, 'accent-color')).toBe(accentColor);
        });
      }
    });
  }

  it('导出弹层额外把 margin/padding 也归了零', () => {
    // 这两条**不是**那 16px 的必要条件：#143 实测 Chrome 对 native appearance 的控件
    // 不套用 author 的 padding/border/background（裸 checkbox 400×38 但 padding 0、
    // border 0），所以不写也还是 16×16。这里只钉住「写了」这件事别被当成冗余删掉 ——
    // 它的作用是别去依赖那条实测行为，顺带把 flex 容器里的外边距归零。
    expect(declaration(read('ExportModal.css'), '.export-level input', 'padding')).toBe('0');
    expect(declaration(read('ExportModal.css'), '.export-level input', 'margin')).toBe('0');
  });

  it('导出弹层的焦点环在整行上，控件自己那条方角环被压掉（#145 实测）', () => {
    // 为什么这里钉的不是一个 `border-radius`：Chrome 对 native appearance 的勾选框
    // **强制**计算 `border-radius` 为 0（与它强制 padding/border/background 同类，
    // #143 已实测；本次复测：写 8px 仍读回 0px，加 `appearance: none` 才生效）。
    // 所以给控件写圆角是**空操作**，方角阴影照旧 —— 一个钉住空声明的测试只会让人
    // 以为修好了。真正的修法是把环挪到圆角真实存在的 `.export-level` 上，并压掉控件
    // 自己那条；这两条必须成对出现，少任何一条都退回灰方块：只加 `:focus-within`
    // 是两条环叠在一起，只加 `box-shadow: none` 则一条环都没有。
    const css = read('ExportModal.css');
    expect(declaration(css, '.export-level input:focus', 'box-shadow')).toBe('none');
    expect(declaration(css, '.export-level:focus-within', 'box-shadow')).toBe(
      'var(--shadow-focus)',
    );
  });

  it('这张表覆盖了全仓所有原生 radio 与 checkbox —— 新增一处必须一起加进来', () => {
    const txFiles = readdirSync(resolve(process.cwd(), 'src')).filter((f) => f.endsWith('.tsx'));
    const withNative = txFiles
      .filter((f) =>
        /type="(?:radio|checkbox)"/.test(readFileSync(resolve(process.cwd(), 'src', f), 'utf8')),
      )
      .sort();
    const declared = [...new Set(NATIVE_CONTROLS.flatMap((c) => [...c.hosts]))].sort();
    expect(withNative).toEqual(declared);
  });

  it('表里第一处（导出弹层）确实是 checkbox，防止有人改回 radio 而不动这张表', () => {
    // 表里的 `type` 不是装饰：#145 之前这里是 radio，形状与语义都不同。改回去必须
    // 显式改这一行，而不是让护栏悄悄继续声称自己覆盖着一个已经不存在的控件。
    const tsx = read('ExportModal.tsx');
    expect(tsx).toContain('type="checkbox"');
    expect(tsx).not.toContain('type="radio"');
  });
});
