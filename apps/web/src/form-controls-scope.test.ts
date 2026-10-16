import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 表单控件底座必须留在容器作用域内（issue #143）。
 *
 * 为什么是一个读 CSS 源码的测试：这个缺陷是**选择器写宽了**造成的。`RulesModal.css`
 * 里原本有一组裸元素选择器：
 *
 *   input, select, textarea { width: 100%; border: …; outline: none }
 *   input, select           { height: 38px; padding: 0 11px }
 *   input:focus, …          { border-color: …; box-shadow: var(--shadow-focus) }
 *
 * Vite 把全仓 CSS 打进同一张样式表，**组件级 CSS 文件不构成作用域**，于是这几条对页面上
 * 每一个表单控件生效。后果是 issue #141 那个真实缺陷（导出弹层的原生 radio 被
 * `width: 100%; height: 38px` 撑成 47.5×38 的灰方块），以及「六个弹层的输入框到底长什么样
 * 只能靠浏览器翻计算样式才知道」。
 *
 * 这份护栏管两件事：
 *   1. **裸选择器不许回来** —— 任何 CSS 文件里，只要一条规则的选择器完全由元素名
 *      （+伪类）构成、且声明了会改变外观的属性，就判为违规。只声明 font/cursor/
 *      box-sizing 这类不改变外观的白名单属性才允许。
 *   2. **底座的作用域列表必须自洽** —— 它用 `:where()`（特异性 0）而不是 `:is()`，
 *      这样组件自己的「类+元素」规则永远赢，不受打包顺序影响；列表里的容器类也必须在
 *      某个 CSS 文件里真的定义过。
 *
 * 管不到的：**「新弹层忘了加进列表」**。漏了不会让任何单测变红，只有人眼在浏览器里
 * 看见「这个输入框怎么是浏览器默认样式」。这一半靠评审，另一条线索是
 * `native-input-size.test.ts` 里那张 radio 对账表。
 *
 * 同类做法见 `modal-header-sticky.test.ts`（issue #133）、`button-text-wrap.test.ts`
 * （issue #110）。
 */

const SRC = resolve(process.cwd(), 'src');
const CSS_FILES = readdirSync(SRC).filter((f) => f.endsWith('.css'));

/** 允许出现在裸元素选择器里的属性：不改变控件的尺寸与外观。 */
const BENIGN = new Set(['font', 'font-family', 'font-size', 'font-weight', 'cursor', 'box-sizing']);

const FORM_TAGS = new Set(['input', 'select', 'textarea']);

/** 拆出 `选择器 { 声明 }` 对。先把注释与 @media 前奏去掉，剩下按 `}` 切段即可。 */
function rules(css: string): Array<{ selector: string; body: string }> {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, ' ');
  const out: Array<{ selector: string; body: string }> = [];
  for (const chunk of flat.split('}')) {
    const at = chunk.lastIndexOf('{');
    if (at === -1) continue;
    out.push({ selector: chunk.slice(0, at).trim(), body: chunk.slice(at + 1) });
  }
  return out;
}

/** 按**括号深度 0** 的逗号切选择器列表：`:where(input, select, textarea)` 里的逗号不算分隔符。 */
function splitSelectors(selectorList: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of selectorList) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') out.push(current.trim());
  return out;
}

/** 这条选择器是不是「裸的表单控件选择器」：去掉伪类后只剩一个元素名，没有类/ID/属性/组合器。 */
function isBareFormControl(selector: string): boolean {
  const s = selector.trim();
  if (s === '' || /[.#[\]>+~*]/.test(s)) return false;
  const base = s.replace(/::?[a-z-]+(\([^)]*\))?/gi, '').trim();
  if (base === '' || /\s/.test(base)) return false;
  return FORM_TAGS.has(base.toLowerCase());
}

/** 一条规则里的声明属性名（`border: 1px solid` 取 `border`；跳过自定义属性与空声明）。 */
function properties(body: string): string[] {
  return body
    .split(';')
    .map((d) => d.split(':')[0]?.trim().toLowerCase() ?? '')
    .filter((p) => p !== '' && !p.startsWith('--') && !p.startsWith('/*'));
}

const read = (name: string): string => readFileSync(resolve(SRC, name), 'utf8');

/** 底座的容器列表：改动这里必须是**有意的**（新弹层要加进来，见 RulesModal.css 的注释）。 */
const BASE_CONTAINERS = [
  '.rules-modal',
  '.export-modal',
  '.semantic-modal',
  '.notification-modal',
  '.users-modal',
  '.level-conflict-modal',
];

describe('表单控件底座留在容器作用域内（issue #143）', () => {
  it('全仓没有裸的表单控件选择器带着会改变外观的声明', () => {
    const violations: string[] = [];
    for (const file of CSS_FILES) {
      for (const { selector, body } of rules(read(file))) {
        const formSelectors = splitSelectors(selector).filter(isBareFormControl);
        if (formSelectors.length === 0) continue;
        const offenders = properties(body).filter((p) => !BENIGN.has(p));
        if (offenders.length > 0) {
          violations.push(
            `${file}: \`${selector}\` 声明了 ${offenders.join(', ')} —— 组件级 CSS 文件不是作用域，` +
              `这会落到全站每个 ${formSelectors.join('/')} 上。请把容器加进 RulesModal.css 的底座列表。`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('白名单不是废纸：确实还有裸选择器只声明 font（`font: inherit` 是既有的全局重置）', () => {
    // 这条同时说明上一条不是「碰巧没扫到」：扫描器确实会命中裸选择器，只是放过了白名单属性。
    const bare = CSS_FILES.flatMap((file) =>
      rules(read(file))
        .filter((r) => splitSelectors(r.selector).some(isBareFormControl))
        .map((r) => ({ file, selector: r.selector, props: properties(r.body) })),
    );
    expect(bare.length).toBeGreaterThan(0);
    expect(bare.every((r) => r.props.every((p) => BENIGN.has(p)))).toBe(true);
  });

  it('底座用 :where()（特异性 0）而不是 :is()：组件规则必须永远赢，不靠打包顺序', () => {
    const css = read('RulesModal.css');
    expect(css).not.toMatch(/:is\(input/);
    const scoped = rules(css)
      .map((r) => r.selector)
      .filter((s) => s.includes(':where(input, select, textarea)'));
    expect(scoped.length).toBeGreaterThan(0);
  });

  it('底座列表与 BASE_CONTAINERS 一致 —— 改列表必须是有意的', () => {
    const css = read('RulesModal.css');
    const containers = new Set<string>();
    for (const { selector } of rules(css)) {
      for (const s of splitSelectors(selector)) {
        if (!s.includes(':where(input, select, textarea)')) continue;
        const [head] = s.split(' ');
        if (head?.startsWith('.')) containers.add(head);
      }
    }
    expect([...containers].sort()).toEqual([...BASE_CONTAINERS].sort());
  });

  it('列表里每个容器类都在某个 CSS 文件里定义过（防拼写错误与陈旧条目）', () => {
    const defined = new Set<string>();
    for (const file of CSS_FILES) {
      for (const { selector } of rules(read(file))) {
        for (const one of splitSelectors(selector)) if (one.startsWith('.')) defined.add(one);
      }
    }
    expect(BASE_CONTAINERS.filter((c) => !defined.has(c))).toEqual([]);
  });

  it('泄漏源不在了：RulesModal.css 里剩下的裸表单控件规则只声明白名单属性', () => {
    // 上一版护栏（#141）是钉住「泄漏源仍在」这个前提；#143 修掉之后，前提反过来：
    // 那个文件里还可以有裸选择器，但只能是 `button, input, select, textarea { font: inherit }`
    // 这条既有的全局重置 —— 谁把它再写回 `width/border/height/…`，这条就红。
    const css = read('RulesModal.css');
    const offenders = rules(css).flatMap((r) =>
      splitSelectors(r.selector)
        .filter(isBareFormControl)
        .flatMap((s) =>
          properties(r.body)
            .filter((p) => !BENIGN.has(p))
            .map((p) => `${s} { ${p} }`),
        ),
    );
    expect(offenders).toEqual([]);
  });
});
