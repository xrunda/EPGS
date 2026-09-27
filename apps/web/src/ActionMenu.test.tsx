import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionMenu } from './ActionMenu';

/** 默认的两项菜单，多数用例都用它。 */
function renderMenu(overrides?: { onFirst?: () => void; onSecond?: () => void }) {
  const onFirst = overrides?.onFirst ?? vi.fn();
  const onSecond = overrides?.onSecond ?? vi.fn();
  render(
    <ActionMenu
      label="账号操作"
      items={[
        { label: '修改密码', onSelect: onFirst },
        { label: '退出登录', onSelect: onSecond },
      ]}
    />,
  );
  return { onFirst, onSecond, trigger: screen.getByRole('button', { name: '账号操作' }) };
}

/** 菜单是否展开，以触发按钮的 aria-expanded 为准。 */
const isOpen = (trigger: HTMLElement): boolean => trigger.getAttribute('aria-expanded') === 'true';

describe('ActionMenu「⋯」二级菜单（issue #116）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /*
    收起时菜单项**不在 DOM 里**，而不是被 CSS 藏起来。CSS 隐藏的话 Tab 会摸到一串
    看不见的按钮 —— issue #116 把入口收进二级菜单，键盘可达是硬要求。
  */
  it('收起时没有菜单项，也不占 Tab 位置', () => {
    const { trigger } = renderMenu();

    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(isOpen(trigger)).toBe(false);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  });

  it('点击触发按钮展开，aria-expanded 跟着变，焦点落在第一项', () => {
    const { trigger } = renderMenu();

    fireEvent.click(trigger);

    expect(isOpen(trigger)).toBe(true);
    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['修改密码', '退出登录']);
    expect(document.activeElement).toBe(items[0]);
  });

  it('再次点击触发按钮收起', () => {
    const { trigger } = renderMenu();

    fireEvent.click(trigger);
    fireEvent.click(trigger);

    expect(isOpen(trigger)).toBe(false);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('Esc 收起并把焦点还给触发按钮', () => {
    const { trigger } = renderMenu();
    fireEvent.click(trigger);
    expect(document.activeElement).not.toBe(trigger);

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

    expect(isOpen(trigger)).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  /*
    点外部关闭。用 mousedown 触发：组件监听的就是 mousedown（click 要等按下与抬起
    都完成，拖选文字时松手在菜单外会被误判成「点外部」）。这条同时也钉住「监听的是
    mousedown」—— 换成 click 它就会红。
  */
  it('点在菜单外面收起', () => {
    const { trigger } = renderMenu();
    fireEvent.click(trigger);

    fireEvent.mouseDown(document.body);

    expect(isOpen(trigger)).toBe(false);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('点在菜单里面不收起', () => {
    const { trigger } = renderMenu();
    fireEvent.click(trigger);

    fireEvent.mouseDown(screen.getByRole('menu'));

    expect(isOpen(trigger)).toBe(true);
  });

  it('方向键在项间移动，并在两端回卷', () => {
    const { trigger } = renderMenu();
    fireEvent.click(trigger);
    const items = screen.getAllByRole('menuitem');

    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    // 末项再按 ↓ 回到第一项
    fireEvent.keyDown(items[1], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[1]);
  });

  it('Home / End 跳到首尾两项', () => {
    const { trigger } = renderMenu();
    fireEvent.click(trigger);
    const items = screen.getAllByRole('menuitem');

    fireEvent.keyDown(items[0], { key: 'End' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
  });

  /*
    选中一项：先关菜单，再执行。顺序不能反 —— 选项打开的弹层要拿到一个已经没有
    菜单的页面，否则菜单会残留在弹层底下。
  */
  it('选中一项会先关掉菜单再执行回调', () => {
    const onFirst = vi.fn();
    const { trigger } = renderMenu({ onFirst });
    fireEvent.click(trigger);

    fireEvent.click(screen.getByRole('menuitem', { name: '修改密码' }));

    expect(onFirst).toHaveBeenCalledTimes(1);
    expect(isOpen(trigger)).toBe(false);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('菜单项之间互相独立，点第二项不会碰到第一项', () => {
    const { onFirst, onSecond } = renderMenu();
    fireEvent.click(screen.getByRole('button', { name: '账号操作' }));

    fireEvent.click(screen.getByRole('menuitem', { name: '退出登录' }));

    expect(onSecond).toHaveBeenCalledTimes(1);
    expect(onFirst).not.toHaveBeenCalled();
  });

  /*
    Tab 顺序：菜单项是真 button，所以 Tab 能逐个走到。issue #116 的验收标准要的
    就是「纯键盘（Tab + Enter + Esc）能触达每一项」，所以这条不能用 roving
    tabindex —— 那样只有方向键走得到。
  */
  it('菜单项参与 Tab 顺序，可以逐个走到', () => {
    const { trigger } = renderMenu();
    fireEvent.click(trigger);

    for (const item of screen.getAllByRole('menuitem')) {
      expect(item).toHaveAttribute('type', 'button');
      expect(item.tabIndex).not.toBe(-1);
    }
  });

  /*
    关闭后重新打开，焦点应该回到第一项而不是留在上次那一项 —— 菜单每次打开都是
    一份新的，不该记得上次读到哪。用一个受控外壳把「关闭再打开」串起来。
  */
  it('关闭后重新打开，焦点仍落在第一项', () => {
    function Harness(): JSX.Element {
      const [n, setN] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setN((c) => c + 1)}>
            外部按钮
          </button>
          <ActionMenu
            key={n}
            label="账号操作"
            items={[
              { label: '修改密码', onSelect: vi.fn() },
              { label: '退出登录', onSelect: vi.fn() },
            ]}
          />
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: '账号操作' });

    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getAllByRole('menuitem')[1], { key: 'Escape' });
    fireEvent.click(trigger);

    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[0]);
  });
});
