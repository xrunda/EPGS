import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 原生 radio 必须显式钉死尺寸的回归护栏（issue #141，issue #143 后仍然承重）。
 *
 * 为什么是一个读 CSS 源码的测试：这个缺陷是**少了一条 CSS 声明**造成的 —— 不钉尺寸的
 * `<input type="radio">` 会吃到「表单控件底座」里的 `width: 100%; height: 38px`
 * （底座定义在 `RulesModal.css`，对 `.export-modal` / `.semantic-modal` 等弹层容器生效）。
 * 落到圆点上就是：圆点被撑成 47.5×38 的框，聚焦时 3px 焦点环套在那个框上，看起来是一
 * 个大灰方块。
 *
 * #143 之前这几条是从一组**裸元素选择器**泄漏过来的（全站每个 input 都吃）；#143 把它
 * 收进了容器作用域，但**这两处 radio 所在的弹层正是被收进去的容器**，所以钉尺寸依然必需：
 * 实测把底座与它们打平（`:is()` 那版）时，导出弹层的圆点立刻从 16×16 变成 92.5×38。
 *
 * jsdom 没有布局引擎（vitest 也没开 `css: true`），「被撑开」在单测里测不出来，所以
 * 这里只钉住那几条声明不被删掉，**渲染结果的证据是实测**（浏览器里读计算样式得到
 * 16×16、`accent-color` 为品牌青，见 PR #141 / #142）。
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
 * 全仓所有 `type="radio"` 的宿主 CSS 规则。
 *
 * 目前只有两处 radio；任何一处漏掉尺寸钉死，就会在浏览器里被底座撑成大方框 ——
 * 所以这张表必须覆盖「全部」radio，新增第三处时要一起加进来。下面有一条测试会
 * 拿它和源码里的实际 `type="radio"` 数量对账，加漏了会红。
 */
const RADIOS = [
  {
    label: '数据导出 · 关注等级',
    tsx: 'ExportModal.tsx',
    css: 'ExportModal.css',
    selector: '.export-level input',
    ownedBy: 'issue #141（本护栏就是为它建的）',
  },
  {
    label: 'AI 语义监控 · 关注等级',
    tsx: 'SemanticMonitorModal.tsx',
    css: 'SemanticMonitorModal.css',
    selector: '.semantic-level-picker__option input',
    ownedBy: 'issue #88 —— 它一直是钉着的，是正确写法的参照',
  },
] as const;

describe('原生 radio 钉死了尺寸，不被表单控件底座撑开（issue #141 / #143）', () => {
  for (const { label, css: file, selector, ownedBy } of RADIOS) {
    describe(`${label}（${ownedBy}）`, () => {
      it('宽高都是 16px：底座里的 `width: 100%; height: 38px` 会落上来，不钉就会被撑开', () => {
        const css = read(file);
        expect(declaration(css, selector, 'width')).toBe('16px');
        expect(declaration(css, selector, 'height')).toBe('16px');
      });

      it('圆点是品牌青，不是 Chrome 默认蓝', () => {
        const css = read(file);
        expect(declaration(css, selector, 'accent-color')).toBe('var(--teal-700)');
      });
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

  it('这张表覆盖了全仓所有 radio —— 新增第三处必须一起加进来', () => {
    // 反向兜底：漏钉的那一处不会有任何单测变红，只有人眼在浏览器里发现「怎么是个大方框」。
    // 所以直接把「源码里有几个 radio」和「表里有几条」对账。
    const txFiles = readdirSync(resolve(process.cwd(), 'src')).filter((f) => f.endsWith('.tsx'));
    const withRadio = txFiles.filter((f) =>
      /type="radio"/.test(readFileSync(resolve(process.cwd(), 'src', f), 'utf8')),
    );
    expect(withRadio.sort()).toEqual(RADIOS.map((r) => r.tsx).sort());
  });
});
